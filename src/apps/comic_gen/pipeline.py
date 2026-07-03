from typing import Dict, Any, List, Optional, Tuple
from ...utils.storage import SQLiteStorageBackend
import json
import os
import re
import time
import uuid
import subprocess
import threading
import platform
from urllib.parse import quote
from .models import Script, GenerationStatus, VideoTask, Character, Scene, Prop, StoryboardFrame, Series, PromptConfig, ArtDirection, AssetStage, ImageVariant
from .llm import ScriptProcessor
from .assets import AssetGenerator, SCENE_REFERENCE_NEGATIVE_PROMPT, PROP_REFERENCE_NEGATIVE_PROMPT
from .storyboard import StoryboardGenerator
from .video import VideoGenerator
from .audio import AudioGenerator
from .export import ExportManager
from ...utils import get_logger
from ...utils.oss_utils import is_object_key
from ...utils.provider_registry import resolve_provider_backend
from ...utils.system_check import get_ffmpeg_path, get_ffmpeg_install_instructions

logger = get_logger(__name__)

# --- Security helpers ---

# Allowed pattern for IDs used in file paths (UUID hex + hyphens)
_SAFE_ID_RE = re.compile(r'^[a-zA-Z0-9_\-]+$')


def _validate_safe_id(value: str, label: str = "id") -> str:
    """Ensure a value is safe to embed in file paths / command args (UUID-like)."""
    if not value or not _SAFE_ID_RE.match(value):
        raise ValueError(f"Invalid {label}: contains unsafe characters")
    return value


def _safe_resolve_path(base_dir: str, untrusted_rel: str) -> str:
    """Resolve *untrusted_rel* under *base_dir* and ensure the result stays inside it.

    Prevents path-traversal attacks (e.g. ``../../etc/passwd``).
    Returns the resolved absolute path; raises ValueError on escape attempts.
    """
    base = os.path.realpath(base_dir)
    resolved = os.path.realpath(os.path.join(base, untrusted_rel))
    if not resolved.startswith(base + os.sep) and resolved != base:
        raise ValueError(f"Path escapes base directory: {untrusted_rel}")
    return resolved

class ComicGenPipeline:
    VIDEO_NO_BGM_INSTRUCTION = (
        "Audio policy: do not generate background music, BGM, music score, theme music, "
        "songs, jingles, or musical accompaniment. If the model produces audio, keep it "
        "limited to diegetic ambience and necessary sound effects only; leave dialogue "
        "and music beds for post-production."
    )
    VIDEO_NO_BGM_NEGATIVE = (
        "background music, bgm, music, soundtrack, music score, theme music, song, singing, "
        "jingle, musical accompaniment, non-diegetic music, 配乐, 背景音乐, 音乐, 歌声, 歌曲"
    )

    @classmethod
    def _ensure_video_no_bgm_prompt(cls, prompt: Optional[str]) -> str:
        prompt_text = (prompt or "").strip()
        if cls.VIDEO_NO_BGM_INSTRUCTION.lower() in prompt_text.lower():
            return prompt_text
        return f"{prompt_text}\n\n{cls.VIDEO_NO_BGM_INSTRUCTION}".strip()

    @classmethod
    def _ensure_video_no_bgm_negative_prompt(cls, negative_prompt: Optional[str]) -> str:
        negative_text = (negative_prompt or "").strip()
        existing = negative_text.lower()
        terms = [
            term.strip()
            for term in cls.VIDEO_NO_BGM_NEGATIVE.split(",")
            if term.strip()
        ]
        missing = [term for term in terms if term.lower() not in existing]
        if not negative_text:
            return ", ".join(terms)
        if not missing:
            return negative_text
        return f"{negative_text}, {', '.join(missing)}"

    @classmethod
    def _apply_video_audio_policy(cls, task: VideoTask) -> None:
        task.prompt = cls._ensure_video_no_bgm_prompt(task.prompt)
        task.negative_prompt = cls._ensure_video_no_bgm_negative_prompt(task.negative_prompt)

    def __init__(self, config: Dict[str, Any] = None, db_path: str = "output/lumenx.db"):
        self.config = config or {}
        self.script_processor = ScriptProcessor()
        self.asset_generator = AssetGenerator(self.config.get('assets'))
        self.storyboard_generator = StoryboardGenerator(self.config.get('storyboard'))
        self.video_generator = VideoGenerator(self.config.get('video'))
        self.audio_generator = AudioGenerator(self.config.get('audio'))
        self.export_manager = ExportManager(self.config.get('export'))
        
        # SQLite storage (replaces JSON files with transactional guarantees)
        self._storage = SQLiteStorageBackend(db_path)
        self._save_lock = threading.RLock()
        
        # Auto-migrate from legacy JSON files on first run
        if db_path == "output/lumenx.db" and self._storage.needs_migration():
            self._storage.migrate_from_json()
        
        self.scripts: Dict[str, Script] = self._load_data()
        self.series_store: Dict[str, Series] = self._load_series_data()
        self._repair_series_bindings()

        # Extraction preview cache: {project_id: (timestamp, Script)}
        self._extraction_cache: Dict[str, tuple] = {}

        # Task management for async asset generation
        # Format: { task_id: { status: str, progress: int, error: str, script_id: str, asset_id: str, created_at: float } }
        self.asset_generation_tasks: Dict[str, Dict[str, Any]] = {}
        self.video_generation_tasks: Dict[str, Dict[str, Any]] = {}
        self._refine_batch_lock = threading.RLock()
        self._refine_batch_status: Dict[str, Dict[str, Any]] = {}
        self._render_batch_lock = threading.RLock()
        self._render_batch_status: Dict[str, Dict[str, Any]] = {}
        # Temporary cache for file import previews (import_id -> text)
        self._import_cache: Dict[str, str] = {}
        # Cached model instances for Kling/Vidu (lazily initialized)
        self._kling_model = None
        self._vidu_model = None
        self._openai_video_model = None

        # Pre-download Demucs model in background so first dub request is fast
        self._demucs_ready = threading.Event()
        self._demucs_error: Optional[str] = None
        threading.Thread(target=self._warmup_demucs_model, daemon=True).start()

        # Recover orphan async tasks. FastAPI BackgroundTasks live in
        # process memory — any restart between submit + execute leaves
        # them permanently `pending` (or `processing` if interrupted
        # mid-call) on disk. We mark such tasks `failed` with a clear
        # reason so the user sees a Retry affordance instead of an
        # eternal spinner. We do NOT auto-resume because re-running a
        # half-completed video task could double-charge providers.
        try:
            self._recover_orphan_tasks()
        except Exception as exc:  # pragma: no cover — defensive
            logger.warning("Orphan task recovery failed: %s", exc)

    _ORPHAN_RECOVERY_REASON = (
        "Backend was restarted while this task was running. Click Retry to run it again."
    )

    def get_refine_batch_status(self, script_id: str) -> Dict[str, Any]:
        """Return in-memory batch-refine progress for a project.

        Batch storyboard refinement is a long synchronous SSE workflow, not a
        persisted background task. This status gives the frontend enough truth
        after refresh to avoid duplicate submissions and show live progress.
        """
        with self._refine_batch_lock:
            status = self._refine_batch_status.get(script_id)
            if status:
                return dict(status)
        script = self.scripts.get(script_id)
        frames = script.frames if script else []
        refined = sum(1 for f in frames if f.assembled_prompt and f.visual_description)
        return {
            "running": False,
            "total": len(frames),
            "completed": refined,
            "success": refined,
            "failed": 0,
            "skipped": 0,
            "remaining": max(0, len(frames) - refined),
        }

    def get_render_batch_status(self, script_id: str) -> Dict[str, Any]:
        """Return in-memory batch storyboard-image progress for a project."""
        with self._render_batch_lock:
            status = self._render_batch_status.get(script_id)
            if status:
                return dict(status)
        script = self.scripts.get(script_id)
        frames = script.frames if script else []
        completed = sum(1 for f in frames if self._frame_has_t2i_image(f))
        failed = sum(1 for f in frames if f.status == GenerationStatus.FAILED and not self._frame_has_t2i_image(f))
        return {
            "running": False,
            "total": len(frames),
            "completed": completed,
            "success": completed,
            "failed": failed,
            "skipped": 0,
            "remaining": max(0, len(frames) - completed),
        }

    def _recover_orphan_tasks(self) -> None:
        """Sweep persisted state for video tasks left in pending/processing.

        FastAPI's BackgroundTasks queue lives entirely in process memory:
        if uvicorn restarts (dev --reload, OOM, OS reboot, ctrl-C) every
        queued processor is gone but the task records on disk still say
        "pending" or "processing". The frontend then shows an eternal
        spinner and the user has no recovery path.

        Strategy: on boot, find every such record and stamp it `failed`
        with a clear, user-readable reason so the existing Retry button
        becomes usable. Auto-resume is intentionally NOT done — a
        half-run video generation may have already incurred provider
        cost and re-running could double-charge.

        Image asset tasks use the asset's persisted `status` field as the
        recovery marker: a `processing` asset means a generation task was
        submitted before the process died.
        """
        STUCK = ("pending", "processing")
        recovered = 0

        for script in self.scripts.values():
            tasks = getattr(script, "video_tasks", None) or []
            for task in tasks:
                if getattr(task, "status", None) in STUCK:
                    task.status = "failed"
                    if not getattr(task, "error", None):
                        try:
                            task.error = self._ORPHAN_RECOVERY_REASON
                        except Exception:
                            pass
                    recovered += 1

        asset_recovered = self._recover_orphan_image_assets() or 0

        if recovered > 0 or asset_recovered > 0:
            try:
                self._save_data()
                self._save_series_data()
            except Exception:
                logger.warning("Orphan recovery: failed to persist sweep")
            logger.warning(
                "Orphan task recovery: marked %d video task(s) and %d image asset(s) as failed.",
                recovered,
                asset_recovered,
            )
        else:
            logger.debug("Orphan task recovery: no stuck tasks found.")

    def _asset_has_image(self, asset: Any, asset_type: str) -> bool:
        """Return whether an asset already has at least one persisted image."""
        if asset_type == "character":
            containers = [
                getattr(asset, "reference_sheet", None),
                getattr(asset, "full_body", None),
                getattr(asset, "full_body_asset", None),
                getattr(asset, "three_view_asset", None),
                getattr(asset, "headshot_asset", None),
            ]
            if any(getattr(c, "image_variants", None) for c in containers):
                return True
            if any(getattr(c, "variants", None) for c in containers):
                return True
            return bool(
                getattr(asset, "full_body_image_url", None)
                or getattr(asset, "three_view_image_url", None)
                or getattr(asset, "headshot_image_url", None)
                or getattr(asset, "image_url", None)
                or getattr(asset, "avatar_url", None)
            )

        image_asset = getattr(asset, "image_asset", None)
        return bool(getattr(image_asset, "variants", None) or getattr(asset, "image_url", None))

    def _recover_orphan_image_assets(self) -> int:
        """Mark image assets left in `processing` by a backend restart as failed."""
        recovered = 0

        def sweep_pool(pool: List[Any], asset_type: str) -> int:
            count = 0
            for asset in pool or []:
                if getattr(asset, "status", None) == GenerationStatus.PROCESSING:
                    asset.status = (
                        GenerationStatus.COMPLETED
                        if self._asset_has_image(asset, asset_type)
                        else GenerationStatus.FAILED
                    )
                    count += 1
            return count

        for script in self.scripts.values():
            recovered += sweep_pool(getattr(script, "characters", []), "character")
            recovered += sweep_pool(getattr(script, "scenes", []), "scene")
            recovered += sweep_pool(getattr(script, "props", []), "prop")

        for series in self.series_store.values():
            recovered += sweep_pool(getattr(series, "characters", []), "character")
            recovered += sweep_pool(getattr(series, "scenes", []), "scene")
            recovered += sweep_pool(getattr(series, "props", []), "prop")
    def _fast_parse_entities(self, text: str, title: str) -> Optional[Script]:
        """Try to extract characters/scenes/props from structured sections.
        Returns a Script object when structured data is found, None otherwise.

        Supports multiple formats:

        **Key:value lines** (compact):
          ## 角色
          老赵：35-40岁，普通身材，黑色短发凌乱
          
          ## 场景
          原始森林上空：晨雾笼罩的原始森林鸟瞰

        **List tables** (multi-row, one entity per row):
          ## 场景环境
          | 场景 | 出现镜头 | 说明 |
          |------|---------|------|
          | 原始森林上空 | 01 | 晨雾笼罩的原始森林鸟瞰 |
          
          ## 道具物品
          | 道具 | 出现镜头 | 说明 |
          |------|---------|------|
          | 行李箱 | 03/04 | 弹开状态 |

        **Profile tables** (single-entity, key-value rows):
          ## 角色定妆参考
          | 项目 | 描述 |
          |------|------|
          | 姓名 | 老赵 |
          | 年龄 | 35-40岁 |

        Section header matching is flexible — '角色', '角色定妆参考', '场景',
        '场景环境', '道具', '道具物品' are all recognized.
        """
        from .models import Script, Character, Scene, Prop
        import re as _re

        entities = {"characters": [], "scenes": [], "props": []}
        found_any = False

        def _parse_table(section_text: str) -> list:
            """Parse a markdown table and return list of dicts with column headers as keys."""
            lines = [l for l in section_text.strip().split('\n') if l.strip().startswith('|')]
            if len(lines) < 3:
                return []  # need header + separator + at least 1 data row
            
            # Parse header
            headers = [h.strip() for h in lines[0].split('|') if h.strip()]
            if not headers:
                return []
            
            # Data rows (skip separator line at index 1)
            rows = []
            for line in lines[2:]:
                cells = [c.strip() for c in line.split('|') if c.strip()]
                if len(cells) >= len(headers):
                    row = {headers[i]: cells[i] for i in range(len(headers))}
                    rows.append(row)
                elif len(cells) == 1 and len(headers) >= 2:
                    # Single cell — treat as name with empty description
                    rows.append({headers[0]: cells[0], headers[1]: ""})
            return rows

        def _is_profile_table(rows: list) -> bool:
            """Detect if a table is a profile (key-value rows) vs a list (one entity per row).
            Profile tables have headers like ['项目', '描述'] and rows like [{'项目': '姓名', '描述': '老赵'}]."""
            if not rows:
                return False
            headers = list(rows[0].keys())
            # Profile pattern: first column is attribute name like "姓名", "年龄"
            first_vals = [r[headers[0]] for r in rows if r.get(headers[0])]
            attr_keywords = {'姓名', '年龄', '体型', '发型', '面容', '服装', '特征', '气质', '项目'}
            if any(v in attr_keywords for v in first_vals):
                return True
            return False

        def _build_character_from_profile(rows: list) -> dict:
            """Build a single character dict from profile table rows."""
            char = {"name": "", "description": "", "age": "", "gender": "", "clothing": ""}
            attr_map = {
                '姓名': 'name', '年龄': 'age', '性别': 'gender', '体型': 'description',
                '发型': 'description', '面容': 'description', '服装': 'clothing',
                '特征': 'description', '气质': 'description',
            }
            for row in rows:
                vals = list(row.values())
                if len(vals) >= 2:
                    key = vals[0].strip()
                    val = vals[1].strip()
                    target = attr_map.get(key)
                    if target == 'description':
                        if char['description']:
                            char['description'] += '，' + val
                        else:
                            char['description'] = val
                    elif target:
                        char[target] = val
            return char

        # Section header recognition
        section_map = {
            '角色': 'characters', '角色定妆参考': 'characters',
            '场景': 'scenes', '场景环境': 'scenes',
            '道具': 'props', '道具物品': 'props',
        }

        # Split text and find sections
        lines = text.split('\n')
        current_section = None
        current_lines = []

        for line in lines:
            header_match = _re.match(r'#{1,3}\s*(.+?)\s*$', line.strip())
            if header_match:
                raw_header = header_match.group(1).strip()
                # Try to match section name
                matched_key = None
                for key, value in section_map.items():
                    if key in raw_header or raw_header in key:
                        matched_key = value
                        break
                
                if matched_key:
                    # Flush previous
                    if current_section and current_lines:
                        section_text = '\n'.join(current_lines)
                        table_rows = _parse_table(section_text)
                        
                        if table_rows:
                            if current_section == 'characters' and _is_profile_table(table_rows):
                                # Single character profile
                                char = _build_character_from_profile(table_rows)
                                if char['name']:
                                    entities['characters'].append(char)
                                    found_any = True
                            else:
                                # List table: one entity per row
                                headers = list(table_rows[0].keys())
                                name_col = headers[0]
                                desc_col = headers[1] if len(headers) >= 2 else None
                                for row in table_rows:
                                    name = row.get(name_col, "").strip()
                                    desc = row.get(desc_col, "").strip() if desc_col else ""
                                    if name and name not in ("场景", "道具", "项目", "描述", "场景名"):
                                        entities[current_section].append({"name": name, "description": desc})
                                        found_any = True
                        else:
                            # Try key:value line format
                            for l in section_text.strip().split('\n'):
                                ll = l.strip()
                                if not ll or ll.startswith('#') or ll.startswith('>') or ll.startswith('---'):
                                    continue
                                kv = _re.match(r'([^：:]+)[：:]\s*(.*)', ll)
                                if kv:
                                    name = kv.group(1).strip()
                                    desc = kv.group(2).strip()
                                    if name:
                                        entities[current_section].append({"name": name, "description": desc})
                                        found_any = True
                    
                    current_section = matched_key
                    current_lines = []
                else:
                    # Non-matching header closes current section
                    if current_section and current_lines:
                        section_text = '\n'.join(current_lines)
                        table_rows = _parse_table(section_text)
                        
                        if table_rows:
                            if current_section == 'characters' and _is_profile_table(table_rows):
                                char = _build_character_from_profile(table_rows)
                                if char['name']:
                                    entities['characters'].append(char)
                                    found_any = True
                            else:
                                headers = list(table_rows[0].keys())
                                name_col = headers[0]
                                desc_col = headers[1] if len(headers) >= 2 else None
                                for row in table_rows:
                                    name = row.get(name_col, "").strip()
                                    desc = row.get(desc_col, "").strip() if desc_col else ""
                                    if name and name not in ("场景", "道具", "项目", "描述", "场景名"):
                                        entities[current_section].append({"name": name, "description": desc})
                                        found_any = True
                        else:
                            for l in section_text.strip().split('\n'):
                                ll = l.strip()
                                if not ll or ll.startswith('#') or ll.startswith('>') or ll.startswith('---'):
                                    continue
                                kv = _re.match(r'([^：:]+)[：:]\s*(.*)', ll)
                                if kv:
                                    name = kv.group(1).strip()
                                    desc = kv.group(2).strip()
                                    if name:
                                        entities[current_section].append({"name": name, "description": desc})
                                        found_any = True
                    current_section = None
                    current_lines = []
            elif current_section:
                current_lines.append(line)

        # Flush last section
        if current_section and current_lines:
            section_text = '\n'.join(current_lines)
            table_rows = _parse_table(section_text)
            
            if table_rows:
                if current_section == 'characters' and _is_profile_table(table_rows):
                    char = _build_character_from_profile(table_rows)
                    if char['name']:
                        entities['characters'].append(char)
                        found_any = True
                else:
                    headers = list(table_rows[0].keys())
                    name_col = headers[0]
                    desc_col = headers[1] if len(headers) >= 2 else None
                    for row in table_rows:
                        name = row.get(name_col, "").strip()
                        desc = row.get(desc_col, "").strip() if desc_col else ""
                        if name and name not in ("场景", "道具", "项目", "描述", "场景名"):
                            entities[current_section].append({"name": name, "description": desc})
                            found_any = True
            else:
                for l in section_text.strip().split('\n'):
                    ll = l.strip()
                    if not ll or ll.startswith('#') or ll.startswith('>') or ll.startswith('---'):
                        continue
                    kv = _re.match(r'([^：:]+)[：:]\s*(.*)', ll)
                    if kv:
                        name = kv.group(1).strip()
                        desc = kv.group(2).strip()
                        if name:
                            entities[current_section].append({"name": name, "description": desc})
                            found_any = True

        if not found_any:
            return None

        # Build Script object
        new_script = Script(
            id=str(uuid.uuid4()),
            title=title,
            original_text=text,
            characters=[],
            scenes=[],
            props=[],
            frames=[],
            created_at=time.time(),
            updated_at=time.time(),
        )

        for c in entities["characters"]:
            new_script.characters.append(Character(
                id=str(uuid.uuid4()),
                name=c["name"],
                description=c.get("description", ""),
                age=c.get("age"),
                clothing=c.get("clothing", ""),
            ))
        for s in entities["scenes"]:
            new_script.scenes.append(Scene(
                id=str(uuid.uuid4()),
                name=s["name"],
                description=s.get("description", ""),
            ))
        for p in entities["props"]:
            new_script.props.append(Prop(
                id=str(uuid.uuid4()),
                name=p["name"],
                description=p.get("description", ""),
            ))

        return new_script




    def _auto_link_frame_assets(self, frames: list, characters: list, scenes: list, props: list = None) -> None:
        """
        Auto-link frames to scene/character/prop assets by matching names
        in the action_description text. This saves the user from having to
        manually assign reference images in the storyboard editor.

        Priority:
          1. If action_description contains a resource line like
             【角色：老赵 · 场景：机舱内 · 道具：行李箱】,
             do exact name-to-ID matching for those explicitly declared names.
          2. Fall back to substring matching of all character/scene names
             anywhere in the description text.

        Mutates frames in-place: fills scene_id, character_ids, prop_ids.
        """
        if props is None:
            props = []

        import re as _re

        for frame in frames:
            desc = (frame.action_description or "")
            if not desc:
                continue

            # Step 1: Try to extract explicitly declared names from resource line
            # Format: 【场景：X · 角色：Y · 道具：Z】 or 【X · Y · Z】
            res_m = _re.search(r'【([^】]*)】', desc)
            declared_scenes = []
            declared_chars = []
            declared_props = []
            if res_m:
                inner = res_m.group(1).strip()
                segments = [s.strip() for s in inner.split('·') if s.strip()]
                has_keys = any('：' in s for s in segments)
                if has_keys:
                    for seg in segments:
                        if '：' not in seg:
                            continue
                        key, val = seg.split('：', 1)
                        key = key.strip()
                        val = val.strip()
                        if val and val != "无":
                            vals = [v.strip() for v in val.split(',') if v.strip()]
                            if key == "场景":
                                declared_scenes = vals
                            elif key == "角色":
                                declared_chars = vals
                            elif key == "道具":
                                declared_props = vals
                else:
                    # Compact: first=场景, second=角色, third=道具
                    labels = [declared_scenes, declared_chars, declared_props]
                    for i, val in enumerate(segments[:3]):
                        if val and val != "无":
                            labels[i].append(val)

            # Step 2: Match characters by name
            # Use exact match for declared names, substring for the rest
            desc_normalized = self._entity_name_key(desc)
            
            for ch in characters:
                ch_key = self._entity_name_key(ch.name)
                if not ch_key:
                    continue
                # Check if this character is declared explicitly
                if ch.name in declared_chars:
                    if ch.id not in frame.character_ids:
                        frame.character_ids.append(ch.id)
                elif ch_key in desc_normalized:
                    # Fallback: substring matching
                    if ch.id not in frame.character_ids:
                        frame.character_ids.append(ch.id)

            # Step 3: Match scene by name
            for sc in scenes:
                sc_key = self._entity_name_key(sc.name)
                if not sc_key:
                    continue
                if sc.name in declared_scenes:
                    frame.scene_id = sc.id
                    break
                if sc_key in desc_normalized:
                    frame.scene_id = sc.id
                    break

            # Step 4: Match props by name
            if declared_props:
                for prop in props:
                    if prop.name in declared_props and prop.id not in frame.prop_ids:
                        frame.prop_ids.append(prop.id)



        return None

    _MAX_LABEL_LEN = 20

    def annotate_video_task(
        self,
        script_id: str,
        task_id: str,
        is_starred: Optional[bool] = None,
        label: Optional[str] = None,
        clear_label: bool = False,
    ) -> Optional["VideoTask"]:
        """Set the user's review annotations on a video task. Two fields,
        both optional so callers can update either independently:
          - is_starred: shortlist flag, multi-select per shot
          - label: short free-text note (≤20 chars). Pass clear_label=True
            to explicitly remove the label (None on its own means "don't
            change").
        Returns the updated VideoTask, or None if script/task not found
        (caller can decide whether that's a 404)."""
        with self._save_lock:
            script = self.scripts.get(script_id)
            if not script:
                return None
            tasks = getattr(script, "video_tasks", None) or []
            task = next((t for t in tasks if getattr(t, "id", None) == task_id), None)
            if not task:
                return None
            if is_starred is not None:
                task.is_starred = bool(is_starred)
            if clear_label:
                task.label = None
            elif label is not None:
                trimmed = label.strip()[: self._MAX_LABEL_LEN]
                task.label = trimmed or None
            try:
                self._save_data()
            except Exception:
                logger.warning("annotate_video_task: save failed")
            return task

    _T2I_HISTORY_LIMIT = 10
    _MAX_GENERATE_COUNT = 6
    _WORKBENCH_TAB_VALUES = ("t2i_i2v", "keyframe_r2v", "asset_compose", "direct_r2v")

    def update_frame_workbench(
        self,
        script_id: str,
        frame_id: str,
        workbench_tab_mode: Optional[str] = None,
        t2i_image_urls: Optional[List[str]] = None,
        t2i_selected_index: Optional[int] = None,
        workbench_generate_count: Optional[int] = None,
        storyboard_image_prompt: Optional[str] = None,
        keyframe_start_prompt: Optional[str] = None,
        keyframe_end_prompt: Optional[str] = None,
        keyframe_start_image_url: Optional[str] = None,
        keyframe_end_image_url: Optional[str] = None,
        keyframe_start_image_urls: Optional[List[str]] = None,
        keyframe_end_image_urls: Optional[List[str]] = None,
    ) -> Optional["StoryboardFrame"]:
        """Persist Storyboard R2V workbench state onto a frame.

        Each field is optional; only the ones the caller passes get
        written. The four fields cover everything the per-shot panel
        carries that needs to survive refresh/cross-device:
          - workbench_tab_mode: 't2i_i2v' | 'keyframe_r2v' | 'asset_compose'
          - t2i_image_urls: full ordered history (caller is the source
            of truth, server clamps to _T2I_HISTORY_LIMIT FIFO)
          - t2i_selected_index: active首帧 index, clamped to range
          - workbench_generate_count: per-shot batch size, clamped to
            [1, _MAX_GENERATE_COUNT]
          - storyboard_image_prompt: editable prompt for generating
            storyboard/first-frame images in I2V or asset-compose tabs
          - keyframe_start_prompt / keyframe_end_prompt: editable prompts
            for generating start/end keyframes
          - keyframe_start_image_url / keyframe_end_image_url: selected
            complete shot keyframes for keyframe R2V
          - keyframe_start_image_urls / keyframe_end_image_urls:
            independent candidate pools for start/end keyframes

        Returns the updated StoryboardFrame, or None if the
        script/frame can't be found (caller maps to 404).
        Unknown enum values for workbench_tab_mode are rejected with
        ValueError so a typo doesn't silently persist garbage."""
        with self._save_lock:
            script = self.scripts.get(script_id)
            if not script:
                return None
            frames = getattr(script, "frames", None) or []
            frame = next((f for f in frames if getattr(f, "id", None) == frame_id), None)
            if not frame:
                return None
            if workbench_tab_mode is not None:
                if workbench_tab_mode not in self._WORKBENCH_TAB_VALUES:
                    raise ValueError(
                        f"workbench_tab_mode must be one of {self._WORKBENCH_TAB_VALUES}, "
                        f"got {workbench_tab_mode!r}",
                    )
                frame.workbench_tab_mode = workbench_tab_mode
            if t2i_image_urls is not None:
                # Filter empties + cap FIFO so the client can't grow the
                # list unbounded by repeated calls. The client also caps
                # at the same limit, but defense in depth.
                cleaned = [u for u in t2i_image_urls if isinstance(u, str) and u.strip()]
                if len(cleaned) > self._T2I_HISTORY_LIMIT:
                    cleaned = cleaned[-self._T2I_HISTORY_LIMIT:]
                frame.t2i_image_urls = cleaned
            if t2i_selected_index is not None:
                # Clamp against the resulting URL list, not whatever was
                # there before — t2i_image_urls may have been written
                # this same call.
                urls = frame.t2i_image_urls or []
                if not urls:
                    frame.t2i_selected_index = 0
                else:
                    frame.t2i_selected_index = max(0, min(int(t2i_selected_index), len(urls) - 1))
            if workbench_generate_count is not None:
                frame.workbench_generate_count = max(
                    1, min(int(workbench_generate_count), self._MAX_GENERATE_COUNT)
                )
            if storyboard_image_prompt is not None:
                frame.storyboard_image_prompt = storyboard_image_prompt.strip() or None
            if keyframe_start_prompt is not None:
                frame.keyframe_start_prompt = keyframe_start_prompt.strip() or None
            if keyframe_end_prompt is not None:
                frame.keyframe_end_prompt = keyframe_end_prompt.strip() or None
            if keyframe_start_image_url is not None:
                frame.keyframe_start_image_url = keyframe_start_image_url.strip() or None
            if keyframe_end_image_url is not None:
                frame.keyframe_end_image_url = keyframe_end_image_url.strip() or None
            if keyframe_start_image_urls is not None:
                cleaned = [u for u in keyframe_start_image_urls if isinstance(u, str) and u.strip()]
                if len(cleaned) > self._T2I_HISTORY_LIMIT:
                    cleaned = cleaned[-self._T2I_HISTORY_LIMIT:]
                frame.keyframe_start_image_urls = cleaned
            if keyframe_end_image_urls is not None:
                cleaned = [u for u in keyframe_end_image_urls if isinstance(u, str) and u.strip()]
                if len(cleaned) > self._T2I_HISTORY_LIMIT:
                    cleaned = cleaned[-self._T2I_HISTORY_LIMIT:]
                frame.keyframe_end_image_urls = cleaned
            frame.updated_at = time.time()
            try:
                self._save_data()
            except Exception:
                logger.warning("update_frame_workbench: save failed")
            return frame

    def upload_t2i_frame(
        self,
        script_id: str,
        frame_id: str,
        file_path: str,
    ) -> Optional["StoryboardFrame"]:
        """Append an uploaded image to a frame's T2I history and auto-select it.

        Mirrors `update_frame_workbench`'s clamping rules (≤ _T2I_HISTORY_LIMIT
        FIFO; t2i_selected_index → index of the newly appended URL). Caller is
        expected to have already saved the file under output/uploads/ and pass
        the relative URL path the frontend can resolve via /files.

        Returns the updated frame, or None if script/frame can't be found.
        """
        with self._save_lock:
            script = self.scripts.get(script_id)
            if not script:
                return None
            frames = getattr(script, "frames", None) or []
            frame = next((f for f in frames if getattr(f, "id", None) == frame_id), None)
            if not frame:
                return None
            current = list(getattr(frame, "t2i_image_urls", None) or [])
            current.append(file_path)
            # Same FIFO cap as update_frame_workbench so uploads can't grow
            # the history unbounded either.
            if len(current) > self._T2I_HISTORY_LIMIT:
                current = current[-self._T2I_HISTORY_LIMIT:]
            frame.t2i_image_urls = current
            # Newly uploaded image becomes the active首帧 — Issue 10 design
            # requires the upload immediately unlocks Step 2.
            frame.t2i_selected_index = len(current) - 1
            frame.updated_at = time.time()
            try:
                self._save_data()
            except Exception:
                logger.warning("upload_t2i_frame: save failed")
            return frame

    def upload_video_candidate(
        self,
        script_id: str,
        frame_id: str,
        file_path: str,
        prompt: str = "",
        model: str = "uploaded-video",
        duration: int = 5,
        resolution: str = "uploaded",
        workbench_tab: Optional[str] = None,
    ) -> Optional["VideoTask"]:
        """Add an uploaded video as a completed take for a storyboard frame."""
        with self._save_lock:
            script = self.scripts.get(script_id)
            if not script:
                return None
            frames = getattr(script, "frames", None) or []
            frame = next((f for f in frames if getattr(f, "id", None) == frame_id), None)
            if not frame:
                return None
            if workbench_tab is not None and workbench_tab not in self._WORKBENCH_TAB_VALUES:
                raise ValueError(
                    f"workbench_tab must be one of {self._WORKBENCH_TAB_VALUES}, "
                    f"got {workbench_tab!r}",
                )
            task = VideoTask(
                id=str(uuid.uuid4()),
                project_id=script_id,
                frame_id=frame_id,
                image_url="",
                prompt=prompt or getattr(frame, "action_description", "") or "",
                status="completed",
                video_url=file_path,
                duration=max(1, int(duration or 5)),
                resolution=resolution or "uploaded",
                generate_audio=False,
                prompt_extend=False,
                model=model or "uploaded-video",
                generation_mode="r2v" if workbench_tab in ("keyframe_r2v", "asset_compose") else "i2v",
                workbench_tab=workbench_tab,
                label="上传",
                created_at=time.time(),
            )
            if not script.video_tasks:
                script.video_tasks = []
            script.video_tasks.append(task)
            if not getattr(frame, "selected_video_id", None):
                frame.selected_video_id = task.id
                frame.video_url = file_path
            frame.updated_at = time.time()
            try:
                self._save_data()
            except Exception:
                logger.warning("upload_video_candidate: save failed")
            return task

    def _append_frame_t2i_url(self, frame: "StoryboardFrame", image_url: str) -> None:
        if not image_url:
            return
        current = list(getattr(frame, "t2i_image_urls", None) or [])
        if image_url in current:
            frame.t2i_selected_index = current.index(image_url)
        else:
            current.append(image_url)
            if len(current) > self._T2I_HISTORY_LIMIT:
                current = current[-self._T2I_HISTORY_LIMIT:]
            frame.t2i_image_urls = current
            frame.t2i_selected_index = len(current) - 1

    def _frame_has_t2i_image(self, frame: "StoryboardFrame") -> bool:
        return bool(
            getattr(frame, "rendered_image_url", None)
            or getattr(frame, "image_url", None)
            or getattr(frame, "t2i_image_urls", None)
        )

    def mark_video_task_failed(
        self, script_id: str, task_id: str, error_message: str
    ) -> bool:
        """Belt-and-suspenders setter used by BG-task wrappers when an
        exception escapes the pipeline's own try/except. Writes
        status='failed' + error so the UI never sees an eternal
        spinner. Also used by the cancel endpoint. Returns True when a
        task was found and marked."""
        with self._save_lock:
            script = self.scripts.get(script_id)
            if not script:
                return False
            tasks = getattr(script, "video_tasks", None) or []
            task = next((t for t in tasks if getattr(t, "id", None) == task_id), None)
            if not task:
                return False
            if getattr(task, "status", None) == "completed":
                # Already successfully completed — don't downgrade on a
                # spurious wrapper exception or a late cancel.
                return False
            task.status = "failed"
            try:
                if not getattr(task, "error", None):
                    task.error = error_message
            except Exception:
                pass
            try:
                self._save_data()
            except Exception:
                logger.warning("mark_video_task_failed: save failed")
            return True

    def _resolve_video_backend(self, model_name: str) -> str:
        try:
            return resolve_provider_backend(model_name)
        except (KeyError, ValueError):
            logger.debug(
                "Provider backend not registered for video model %s, defaulting to dashscope.",
                model_name,
            )
            return "dashscope"
        except Exception as e:
            logger.warning(
                "Unexpected error resolving provider backend for video model %s: %s. "
                "Falling back to dashscope.",
                model_name,
                e,
            )
            return "dashscope"

    def _get_video_model(self, model_name: Optional[str] = None):
        """Get video model based on selected model and VIDEO_PROVIDER env var."""
        effective_model = (model_name or os.environ.get("VIDEO_MODEL", "") or "").lower()
        if effective_model.startswith("agnes-"):
            from ...models.agnes_video import AgnesVideoModel
            video_config = getattr(self, "config", {}).get("video", {}).get("model", {})
            logger.info("Using Agnes Video model")
            return AgnesVideoModel(video_config)
        if effective_model.startswith("seedance-") or effective_model.startswith("dreamina-seedance-"):
            from ...models.seedance import SeedanceVideoModel
            video_config = getattr(self, "config", {}).get("video", {}).get("model", {})
            logger.info("Using Seedance Video model")
            return SeedanceVideoModel(video_config)

        if model_name:
            try:
                if resolve_provider_backend(model_name) == "dashscope":
                    return self.video_generator.model
            except (KeyError, ValueError):
                pass

        video_provider = os.environ.get("VIDEO_PROVIDER", "dashscope").lower()
        has_key = bool(os.environ.get("VIDEO_API_KEY", ""))
        video_config = getattr(self, "config", {}).get("video", {}).get("model", {})
        if video_provider == "openai" and has_key:
            from ...models.openai_video import OpenAIVideoModel
            logger.info("Using OpenAI-compatible video model")
            return OpenAIVideoModel(video_config)
        elif video_provider == "comfyui":
            from ...models.comfyui import ComfyUIVideoModel
            logger.info("Using ComfyUI video model")
            return ComfyUIVideoModel(video_config)
        else:
            return self.video_generator.model

    # ... (existing methods)

    def export_project(self, script_id: str, options: Dict[str, Any]) -> str:
        """Step 7: Export project to final video."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
            
        export_url = self.export_manager.render_project(script, options)
        return export_url

    def get_script(self, script_id: str) -> Optional[Script]:
        return self.scripts.get(script_id)

    def _load_data(self) -> Dict[str, Script]:
        """Load scripts from SQLite (with automatic JSON migration on first run)."""
        result: Dict[str, Script] = {}
        try:
            for d in self._storage.list_scripts():
                result[d["id"]] = Script(**d)
        except Exception as e:
            logger.error(f"Failed to load scripts: {e}")
        return result

    def _save_data(self, script_id: Optional[str] = None):
        """Save scripts to SQLite.  If *script_id* is given, only that script
        is written; otherwise every script is upserted (faithful to legacy
        batch-save semantics).
        """
        with self._save_lock:
            try:
                if script_id:
                    s = self.scripts.get(script_id)
                    if s:
                        self._storage.save_script(s.model_dump())
                else:
                    for s in self.scripts.values():
                        self._storage.save_script(s.model_dump())
            except Exception as e:
                logger.error(f"Failed to save data: {e}")

    def _repair_series_bindings(self):
        """Repair episodes listed in series.episode_ids that have series_id=None."""
        repaired = False
        for series_id, series in self.series_store.items():
            for ep_id in series.episode_ids:
                script = self.scripts.get(ep_id)
                if script and not script.series_id:
                    script.series_id = series_id
                    if not script.episode_number:
                        script.episode_number = series.episode_ids.index(ep_id) + 1
                    repaired = True
                    logger.info(f"Repaired series binding: episode {ep_id} → series {series_id}")
        if repaired:
            self._save_data()

    def create_project(self, title: str, text: str, skip_analysis: bool = False, workflow_mode: str = "i2v_legacy") -> Script:
        """Step 1: Parse novel and create project."""
        if skip_analysis:
            script = self.script_processor.create_draft_script(title, text)
        else:
            script = self.script_processor.parse_novel(title, text)
        
        script.workflow_mode = workflow_mode
        self.scripts[script.id] = script
        self._save_data()
        return script
    
    def extract_preview(self, script_id: str, text: str) -> Script:
        """Run entity extraction without saving. Cache result for subsequent apply.

        Fast path: if text contains structured `## 角色 / ## 场景 / ## 道具`
        sections in '{名称}：{描述}' format, parse with regex (no LLM cost).
        Falls back to LLM parse_novel() when no structured sections are found.
        """
        existing_script = self.scripts.get(script_id)
        if not existing_script:
            raise ValueError("Script not found")

        # Fast path: try regex-based entity extraction first
        fast_result = self._fast_parse_entities(text, existing_script.title)
        if fast_result is not None:
            self._extraction_cache[script_id] = (time.time(), fast_result, True)
            fast_result._fast_path = True  # flag for API response
            return fast_result

        # Slow path: LLM-based extraction
        new_script = self.script_processor.parse_novel(existing_script.title, text)
        self._supplement_mentioned_existing_entities(existing_script, new_script, text)
        self._extraction_cache[script_id] = (time.time(), new_script)
        return new_script

    def normalize_script_preview(self, script_id: str, text: str) -> Dict[str, Any]:
        """Rewrite arbitrary script text into the structured LumenX format.

        This is a dry run: it does not save or replace project data. The returned
        counts are deterministic parser estimates from the normalized text so the
        frontend can show what will be applied.
        """
        existing_script = self.scripts.get(script_id)
        if not existing_script:
            raise ValueError("Script not found")
        normalized_text = self.script_processor.normalize_storyboard_script(existing_script.title, text)

        entity_preview = self._fast_parse_entities(normalized_text, existing_script.title)
        try:
            frame_preview = self.script_processor._try_parse_frames_from_text(normalized_text)
        except Exception as exc:
            logger.warning(f"normalize_script_preview: frame preview parse failed: {exc}")
            frame_preview = []

        return {
            "normalized_text": normalized_text,
            "counts": {
                "characters": len(entity_preview.characters) if entity_preview else 0,
                "scenes": len(entity_preview.scenes) if entity_preview else 0,
                "props": len(entity_preview.props) if entity_preview else 0,
                "frames": len(frame_preview or []),
            },
        }

    def normalize_extract_storyboard(
        self,
        script_id: str,
        text: str,
        normalized_text: Optional[str] = None,
    ) -> Script:
        """Normalize script text, overwrite original_text, extract entities and frames."""
        existing_script = self.scripts.get(script_id)
        if not existing_script:
            raise ValueError("Script not found")

        final_text = (normalized_text or "").strip()
        if not final_text:
            final_text = self.script_processor.normalize_storyboard_script(existing_script.title, text)
        if not final_text:
            raise RuntimeError("脚本格式整理未返回可用文本。")

        fast_result = self._fast_parse_entities(final_text, existing_script.title)
        if fast_result is not None:
            self._extraction_cache[script_id] = (time.time(), fast_result, True)

        updated_script = self.reparse_project(script_id, final_text)
        updated_script.original_text = final_text
        self.scripts[script_id] = updated_script
        return self.analyze_text_to_frames(script_id, final_text)

    def _cleanup_old_entity_oss_images(self, script: "Script") -> None:
        """Delete orphaned OSS images from entities being replaced."""
        for char in (script.characters or []):
            self._cleanup_single_entity_oss_images(char)
        for scene in (script.scenes or []):
            self._cleanup_single_entity_oss_images(scene)
        for prop in (script.props or []):
            self._cleanup_single_entity_oss_images(prop)


    def _cleanup_single_entity_oss_images(self, entity: Any) -> None:
        """Delete OSS images for a single character/scene/prop entity."""
        from ...utils.oss_utils import is_object_key
        uploader = None

        def _try_delete(url: str) -> None:
            if not url or not is_object_key(url):
                return
            nonlocal uploader
            if uploader is None:
                from ...utils.oss_utils import OSSImageUploader
                uploader = OSSImageUploader()
                if not uploader.is_configured:
                    uploader = None
                    return
            uploader.delete_object(url)

        _try_delete(getattr(entity, "image_url", None))
        _try_delete(getattr(entity, "full_body_image_url", None))
        _try_delete(getattr(entity, "three_view_image_url", None))
        _try_delete(getattr(entity, "headshot_image_url", None))
        _try_delete(getattr(entity, "avatar_url", None))
        for asset_field in ("image_asset", "full_body_asset", "three_view_asset", "headshot_asset"):
            asset = getattr(entity, asset_field, None)
            if asset:
                for v in (asset.variants or []):
                    _try_delete(getattr(v, "url", None))
        # Also handle stages reference images (Cast page's primary image source)
        for stage in (getattr(entity, "stages", None) or []):
            for v in (stage.reference_images or []):
                _try_delete(getattr(v, "url", None))
        # Handle AssetUnit fields (reference_sheet, full_body, three_views, head_shot)
        for unit_field in ("reference_sheet", "full_body", "three_views", "head_shot"):
            unit = getattr(entity, unit_field, None)
            if unit:
                for v in (unit.image_variants or []):
                    _try_delete(getattr(v, "url", None))
                for v in (unit.video_variants or []):
                    _try_delete(getattr(v, "url", None))



    def _entity_name_key(self, name: str) -> str:
        return re.sub(r"[\s·•_\-—（）()]+", "", str(name or "")).casefold()

    def _supplement_mentioned_existing_entities(self, existing_script: Script, parsed_script: Script, text: str) -> None:
        """Keep named existing entities when an extraction pass accidentally omits them.

        LLM extraction is probabilistic. Re-running it must not make an established
        creature disappear while its exact name is still repeated in the script.
        Only exact textual mentions are restored; no fuzzy guessing is involved.
        """
        series = self.series_store.get(existing_script.series_id) if existing_script.series_id else None
        specs = (
            ("characters", Character),
            ("scenes", Scene),
            ("props", Prop),
        )
        for attr, model_cls in specs:
            parsed_pool = getattr(parsed_script, attr)
            known_keys = {self._entity_name_key(item.name) for item in parsed_pool}
            source_pool = list(getattr(existing_script, attr))
            if series:
                source_pool.extend(getattr(series, attr))
            for item in source_pool:
                key = self._entity_name_key(item.name)
                if not key or key in known_keys or item.name not in text:
                    continue
                common = {
                    "id": str(uuid.uuid4()),
                    "name": item.name,
                    "description": item.description,
                    "visual_weight": getattr(item, "visual_weight", 3),
                    "status": GenerationStatus.PENDING,
                }
                if model_cls is Character:
                    common.update(age=item.age, gender=item.gender, clothing=item.clothing)
                elif model_cls is Scene:
                    common.update(time_of_day=item.time_of_day, lighting_mood=item.lighting_mood)
                parsed_pool.append(model_cls(**common))
                known_keys.add(key)

    @staticmethod
    def _merge_entity_visual_metadata(target: Any, incoming: Any) -> None:
        for field_name in ("description", "age", "gender", "clothing", "time_of_day", "lighting_mood"):
            value = getattr(incoming, field_name, None)
            if value not in (None, "") and hasattr(target, field_name):
                setattr(target, field_name, value)
        if hasattr(target, "visual_weight") and hasattr(incoming, "visual_weight"):
            target.visual_weight = max(target.visual_weight, incoming.visual_weight)

    @staticmethod
    def _has_entity_visual_assets(entity: Any) -> bool:
        if not entity:
            return False
        legacy_fields = (
            "image_url", "full_body_image_url", "three_view_image_url",
            "headshot_image_url", "avatar_url", "reference_image_url",
        )
        if any(getattr(entity, field_name, None) for field_name in legacy_fields):
            return True
        for asset_field in ("image_asset", "full_body_asset", "three_view_asset", "headshot_asset"):
            asset = getattr(entity, asset_field, None)
            if asset and getattr(asset, "variants", None):
                return True
        for unit_field in ("reference_sheet", "full_body", "three_views", "head_shot"):
            unit = getattr(entity, unit_field, None)
            if unit and (getattr(unit, "image_variants", None) or getattr(unit, "video_variants", None)):
                return True
        if any(getattr(stage, "reference_images", None) for stage in (getattr(entity, "stages", None) or [])):
            return True
        return False

    def _copy_entity_visual_assets(self, target: Any, source: Any, only_if_missing: bool = True) -> None:
        """Preserve generated/uploaded reference assets across entity re-extraction.

        Re-running entity extraction creates fresh model objects. Exact-name
        matches represent the same logical asset, so generated image references
        should move forward instead of being treated as orphaned leftovers.
        """
        if not source or not target:
            return
        if only_if_missing and self._has_entity_visual_assets(target):
            return
        import copy as _copy

        for field_name in (
            "image_url", "full_body_image_url", "three_view_image_url",
            "headshot_image_url", "avatar_url", "reference_image_url",
            "full_body_prompt", "three_view_prompt", "headshot_prompt",
            "video_prompt", "video_url", "audio_url", "sfx_url", "bgm_url",
        ):
            if hasattr(target, field_name) and hasattr(source, field_name):
                value = getattr(source, field_name, None)
                if value not in (None, "", []):
                    setattr(target, field_name, _copy.deepcopy(value))

        for field_name in (
            "image_asset", "full_body_asset", "three_view_asset", "headshot_asset",
            "reference_sheet", "full_body", "three_views", "head_shot",
            "video_assets", "stages",
        ):
            if hasattr(target, field_name) and hasattr(source, field_name):
                value = getattr(source, field_name, None)
                if value:
                    setattr(target, field_name, _copy.deepcopy(value))

        if self._has_entity_visual_assets(source):
            if hasattr(target, "status") and getattr(target, "status", GenerationStatus.PENDING) == GenerationStatus.PENDING:
                target.status = getattr(source, "status", GenerationStatus.COMPLETED)
            for field_name in ("locked", "is_consistent"):
                if hasattr(target, field_name) and hasattr(source, field_name):
                    setattr(target, field_name, getattr(source, field_name))

    def _preserve_matching_entity_assets(self, existing_script: Script, parsed_script: Script) -> None:
        """Carry existing visual references into freshly parsed exact-name entities."""
        series = self.series_store.get(existing_script.series_id) if existing_script.series_id else None
        for attr in ("characters", "scenes", "props"):
            previous_by_name = {
                self._entity_name_key(item.name): item
                for item in getattr(existing_script, attr, [])
            }
            if series:
                for item in getattr(series, attr, []):
                    previous_by_name.setdefault(self._entity_name_key(item.name), item)
            for incoming in getattr(parsed_script, attr, []):
                previous = previous_by_name.get(self._entity_name_key(incoming.name))
                if previous:
                    self._copy_entity_visual_assets(incoming, previous, only_if_missing=True)

    def _cleanup_replaced_episode_entity_images(self, existing_script: Script, protected_keys: set) -> None:
        """Clean only episode-local entities that are genuinely absent after reparse."""
        for attr in ("characters", "scenes", "props"):
            for entity in getattr(existing_script, attr, []):
                key = self._entity_name_key(entity.name)
                if key and key in protected_keys:
                    continue
                self._cleanup_single_entity_oss_images(entity)

    def _merge_exact_series_entities(self, script: Script) -> None:
        """Automatically reconcile exact-name matches into the shared library.

        When a fresh episode entity matches a series entity, keep the shared
        entity as the durable asset record: update textual metadata/prompts
        from the new extraction, but preserve generated images, uploaded
        variants, and stage reference images.
        """
        series = self.series_store.get(script.series_id) if script.series_id else None
        if not series:
            return
        changed = False
        for attr in ("characters", "scenes", "props"):
            shared_by_name = {self._entity_name_key(item.name): item for item in getattr(series, attr)}
            remaining = []
            for local in getattr(script, attr):
                shared = shared_by_name.get(self._entity_name_key(local.name))
                if not shared:
                    remaining.append(local)
                    continue
                self._merge_entity_visual_metadata(shared, local)
                self._copy_entity_visual_assets(shared, local, only_if_missing=True)
                changed = True
            setattr(script, attr, remaining)
        if changed:
            series.updated_at = time.time()
            self._save_series_data()

    def reparse_project(self, script_id: str, text: str) -> Script:
        """Re-parse the text for an existing project, replacing all entities."""
        existing_script = self.scripts.get(script_id)
        if not existing_script:
            raise ValueError("Script not found")

        # Use cached extraction if available (from extract_preview)
        import copy as _copy
        cached = self._extraction_cache.pop(script_id, None)
        is_fast_path = False
        if cached and isinstance(cached, (list, tuple)) and len(cached) >= 3:
            is_fast_path = cached[2]
        if cached and isinstance(cached, (list, tuple)) and len(cached) >= 2 and (time.time() - cached[0]) < 300:
            new_script = _copy.deepcopy(cached[1])
            if is_fast_path:
                new_script._fast_path = True
        else:
            new_script = self.script_processor.parse_novel(existing_script.title, text)
            self._supplement_mentioned_existing_entities(existing_script, new_script, text)
        
        # Preserve the original script ID and timestamps
        new_script.id = existing_script.id
        new_script.created_at = existing_script.created_at
        new_script.updated_at = time.time()
        
        # Preserve project-level settings
        new_script.art_direction = existing_script.art_direction
        new_script.model_settings = existing_script.model_settings
        new_script.style_preset = existing_script.style_preset
        new_script.style_prompt = existing_script.style_prompt
        new_script.merged_video_url = existing_script.merged_video_url
        new_script.workflow_mode = existing_script.workflow_mode
        # Preserve series binding — the freshly parsed Script defaults
        # series_id/episode_number to None, which would orphan an episode
        # mid-reparse and break the Reconcile suggestions endpoint
        # (it returns [] for any project without a series_id). Same for
        # prompt_config, default_generation_mode, bgm_url, mix_settings —
        # all project-level fields unrelated to entity extraction.
        # custom_voices lives on Series, NOT Script — do not touch it here.
        new_script.series_id = existing_script.series_id
        new_script.episode_number = existing_script.episode_number
        new_script.prompt_config = existing_script.prompt_config
        new_script.default_generation_mode = existing_script.default_generation_mode
        new_script.bgm_url = existing_script.bgm_url
        new_script.mix_settings = existing_script.mix_settings

        # Preserve existing frames and video tasks (re-extracting entities
        # should not discard already-generated storyboards)
        new_script.frames = existing_script.frames
        new_script.video_tasks = existing_script.video_tasks

        # Carry generated/uploaded references forward for exact-name matches.
        # Entity extraction is allowed to refresh descriptions, but it must not
        # make already-generated Cast reference images disappear.
        self._preserve_matching_entity_assets(existing_script, new_script)

        # Exact-name matches are the same logical entity in this product's
        # cross-episode model. Merge them immediately so confirmation never
        # leaves a transient episode-local duplicate beside the shared card.
        self._merge_exact_series_entities(new_script)

        protected_keys = set()
        for attr in ("characters", "scenes", "props"):
            for entity in getattr(new_script, attr, []):
                key = self._entity_name_key(entity.name)
                if key:
                    protected_keys.add(key)
        if new_script.series_id:
            series = self.series_store.get(new_script.series_id)
            if series:
                for attr in ("characters", "scenes", "props"):
                    for entity in getattr(series, attr, []):
                        key = self._entity_name_key(entity.name)
                        if key:
                            protected_keys.add(key)

        # Clean up only old episode-local visuals that are no longer represented
        # by either the fresh episode entities or the parent series library.
        self._cleanup_replaced_episode_entity_images(existing_script, protected_keys)

        import logging as _lg2
        _lg2.getLogger(__name__).warning(f"reparse_project: series_id={new_script.series_id}, has_series={new_script.series_id is not None}")
        # Series assets are durable shared library entries. Re-extracting one
        # episode may update exact-name metadata, but it must not clear generated
        # images for series assets that are absent from the current text.
        if new_script.series_id:
            series = self.series_store.get(new_script.series_id)
            if series:
                series.updated_at = time.time()
                self._save_series_data()

        # Replace the script in memory
        self.scripts[script_id] = new_script
        self._save_data()
        return new_script


    def generate_assets(self, script_id: str) -> Script:
        """Step 2: Generate character and scene assets (Batch)."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
            
        logger.info(f"Generating assets for script {script.id}")
        
        # Sort characters: Base characters first (those without base_character_id)
        sorted_chars = sorted(script.characters, key=lambda c: 0 if not c.base_character_id else 1)

        for char in sorted_chars:
            self.generate_asset(script_id, char.id, "character")
            
        for scene in script.scenes:
            self.generate_asset(script_id, scene.id, "scene")
            
        for prop in script.props:
            self.generate_asset(script_id, prop.id, "prop")
            
        self._save_data()
        return script

    def generate_asset(self, script_id: str, asset_id: str, asset_type: str, style_preset: str = None, reference_image_url: str = None, style_prompt: str = None, generation_type: str = "all", prompt: str = None, apply_style: bool = True, negative_prompt: str = None, batch_size: int = 1, model_name: str = None, aspect_ratio: str = None) -> Script:
        """Step 2: Generate a specific asset (character/scene/prop).
        If style_preset is None, uses the project's global style."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        # Get effective model names from project settings if not overridden
        t2i_model = model_name or script.model_settings.t2i_model
        i2i_model = script.model_settings.i2i_model
        
        # Get effective size based on asset type (aspect_ratio param overrides model_settings)
        from .assets import ASPECT_RATIO_TO_SIZE
        if aspect_ratio:
            effective_aspect = aspect_ratio
        elif asset_type == "character":
            effective_aspect = script.model_settings.character_aspect_ratio
        elif asset_type == "scene":
            effective_aspect = script.model_settings.scene_aspect_ratio
        elif asset_type == "prop":
            effective_aspect = script.model_settings.prop_aspect_ratio
        else:
            effective_aspect = "9:16"

        if asset_type == "character":
            default_size = "576*1024"
        elif asset_type == "scene":
            default_size = "1024*576"
        else:
            default_size = "1024*1024"

        effective_size = ASPECT_RATIO_TO_SIZE.get(effective_aspect, default_size)
        
        # Determine effective style: Art Direction > passed style > legacy style
        effective_positive_prompt = ""
        effective_negative_prompt = negative_prompt or ""

        # Resolve art_direction: episode own > series inherited
        resolved_art_direction = script.art_direction
        if not resolved_art_direction and script.series_id:
            series = self.series_store.get(script.series_id)
            if series and series.art_direction:
                resolved_art_direction = series.art_direction
        if isinstance(resolved_art_direction, dict):
            resolved_art_direction = ArtDirection(**resolved_art_direction)

        if apply_style:
            if resolved_art_direction and resolved_art_direction.style_config:
                effective_positive_prompt = resolved_art_direction.style_config.get('positive_prompt', '')
                global_neg = resolved_art_direction.style_config.get('negative_prompt', '')
                if global_neg:
                    effective_negative_prompt = f"{effective_negative_prompt}, {global_neg}" if effective_negative_prompt else global_neg
            elif style_prompt:
                effective_positive_prompt = style_prompt
            elif style_preset:
                effective_positive_prompt = f"{style_preset} style"
            elif script.style_preset:
                effective_positive_prompt = f"{script.style_preset} style"
                if script.style_prompt:
                    effective_positive_prompt += f", {script.style_prompt}"
        
        if asset_type not in ("character", "scene", "prop"):
            raise ValueError(f"Invalid asset_type: {asset_type}")

        target_asset, source = self._find_asset_with_source(script, asset_id, asset_type)
        if not target_asset:
            raise ValueError(f"{asset_type.capitalize()} {asset_id} not found")
        if source == "series":
            logger.info(f"Found {asset_type} {asset_id} in Series (fallback)")
        
        target_asset.status = GenerationStatus.PROCESSING
        self._save_after_asset_mutation(source)
        
        try:
            # Generate with Art Direction style injected
            if asset_type == "character":
                # Pass generation_type and specific prompt if available
                self.asset_generator.generate_character(
                    target_asset, 
                    generation_type=generation_type, 
                    prompt=prompt, 
                    positive_prompt=effective_positive_prompt, # Used as style suffix if prompt is auto-generated
                    negative_prompt=effective_negative_prompt,
                    batch_size=batch_size,
                    model_name=t2i_model,
                    i2i_model_name=i2i_model,
                    size=effective_size
                )
            elif asset_type == "scene":
                self.asset_generator.generate_scene(target_asset, effective_positive_prompt, effective_negative_prompt, batch_size=batch_size, model_name=t2i_model, size=effective_size, prompt=prompt)
            elif asset_type == "prop":
                self.asset_generator.generate_prop(target_asset, effective_positive_prompt, effective_negative_prompt, batch_size=batch_size, model_name=t2i_model, size=effective_size, prompt=prompt)
                
            target_asset.status = GenerationStatus.COMPLETED
        except Exception as e:
            target_asset.status = GenerationStatus.FAILED
            raise e
        finally:
            self._save_after_asset_mutation(source)
        
        return script

    def create_asset_generation_task(self, script_id: str, asset_id: str, asset_type: str,
                                      style_preset: str = None, reference_image_url: str = None,
                                      style_prompt: str = None, generation_type: str = "all",
                                      prompt: str = None, apply_style: bool = True,
                                      negative_prompt: str = None, batch_size: int = 1,
                                      model_name: str = None, aspect_ratio: str = None) -> Tuple[Script, str]:
        """Creates an async asset generation task and returns (script, task_id) immediately."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        if asset_type not in ("character", "scene", "prop"):
            raise ValueError(f"Invalid asset_type: {asset_type}")
        
        # Find the asset and set to PROCESSING. Assets shown in an episode can
        # be owned by the parent Series shared pool; persist to the owner.
        target_asset, source = self._find_asset_with_source(script, asset_id, asset_type)
        if not target_asset:
            raise ValueError(f"{asset_type.capitalize()} {asset_id} not found")
        if source == "series":
            logger.info(f"Found {asset_type} {asset_id} in Series (fallback for task)")
        
        target_asset.status = GenerationStatus.PROCESSING
        
        # Create task
        task_id = str(uuid.uuid4())
        self.asset_generation_tasks[task_id] = {
            "status": "pending",  # pending -> processing -> completed/failed
            "progress": 0,
            "error": None,
            "script_id": script_id,
            "asset_id": asset_id,
            "asset_type": asset_type,
            "created_at": time.time(),
            # Store all params for later processing
            "params": {
                "style_preset": style_preset,
                "reference_image_url": reference_image_url,
                "style_prompt": style_prompt,
                "generation_type": generation_type,
                "prompt": prompt,
                "apply_style": apply_style,
                "negative_prompt": negative_prompt,
                "batch_size": batch_size,
                "model_name": model_name,
                "aspect_ratio": aspect_ratio,
            }
        }
        
        self._save_after_asset_mutation(source)
        return script, task_id

    def process_asset_generation_task(self, task_id: str):
        """Processes an asset generation task in the background."""
        task = self.asset_generation_tasks.get(task_id)
        if not task:
            logger.error(f"Task {task_id} not found")
            return

        task["status"] = "processing"

        try:
            params = task["params"]
            if task.get("stage_id"):
                self._process_stage_asset_task(task, params)
            elif task.get("is_series"):
                # Series asset generation — operate on series_store
                self._process_series_asset_task(task, params)
            else:
                # Project asset generation — existing logic
                self.generate_asset(
                    task["script_id"],
                    task["asset_id"],
                    task["asset_type"],
                    params["style_preset"],
                    params["reference_image_url"],
                    params["style_prompt"],
                    params["generation_type"],
                    params["prompt"],
                    params["apply_style"],
                    params["negative_prompt"],
                    params["batch_size"],
                    params["model_name"],
                    params.get("aspect_ratio"),
                )
            task["status"] = "completed"
            task["progress"] = 100
            self._set_task_asset_status(task, GenerationStatus.COMPLETED)
            logger.info(f"Task {task_id} completed successfully")
        except Exception as e:
            task["status"] = "failed"
            task["error"] = str(e)
            self._set_task_asset_status(task, GenerationStatus.FAILED)
            logger.error(f"Task {task_id} failed: {e}")

    @staticmethod
    def _build_stage_generation_prompt(asset: Any, asset_type: str, stage: AssetStage) -> str:
        description = str(getattr(asset, "description", "") or "").strip()
        delta = str(stage.visual_delta or "").strip()
        stage_detail = f"Evolution stage: {stage.label}. {delta}".strip()
        if asset_type == "character":
            return (
                f"Character turnaround reference sheet for {asset.name}. {description}. {stage_detail}. "
                "One single unified image containing exactly three separate full-body views of the SAME character: "
                "front view, strict side profile view, and back view, aligned left to right at the same scale. "
                "Head-to-toe visible in every view, neutral standing pose, neutral expression, identical face, "
                "hairstyle, body proportions, clothing, materials, colors, damage and accessories across all views. "
                "Plain light neutral studio background, clean production character-design sheet, even lighting. "
                "No action pose, no perspective pose, no scenery, no props, no text, no numbers, no logo, no watermark."
            )
        if asset_type == "scene":
            return (
                f"Photorealistic location still for {asset.name}. {description}. {stage_detail}. "
                "Create exactly one single full-frame environment photograph, one continuous landscape shot, empty location. "
                "If the scene description mentions a person, survivor, or occupancy capacity, treat that only as scale/context and do not draw any person. "
                "Do not create a reference sheet, contact sheet, collage, grid, storyboard panel, multi-panel layout, "
                "inset image, thumbnail strip, border, caption, social-media mark, weibo mark, logo, watermark, or any text. "
                "No people, no characters, no figures, no portraits, no faces, no hands."
            )
        return (
            f"Photorealistic object still for {asset.name}. {description}. {stage_detail}. "
            "Create exactly one single centered prop reference photograph only, one continuous image. "
            "Do not create a reference sheet, contact sheet, collage, grid, multi-panel layout, secondary views, "
            "detail close-up panels, inset images, thumbnail strip, border, caption, social-media mark, weibo mark, logo, watermark, or any text. "
            "No hands, no thumbs-up, no people, no characters."
        )

    @staticmethod
    def _stage_reference_negative_prompt(asset_type: str) -> str:
        if asset_type == "scene":
            return SCENE_REFERENCE_NEGATIVE_PROMPT
        if asset_type == "prop":
            return PROP_REFERENCE_NEGATIVE_PROMPT
        return "single portrait, single front view, close-up only, cropped body, action pose, scenery, text, watermark, logo"

    def _process_stage_asset_task(self, task: Dict[str, Any], params: Dict[str, Any]) -> None:
        """Generate a stage-only reference without mutating the base asset image pools."""
        script = self.scripts.get(task["script_id"])
        if not script:
            raise ValueError("Script not found")
        asset_type = task["asset_type"]
        asset, source = self._find_asset_with_source(script, task["asset_id"], asset_type)
        stage = next((item for item in getattr(asset, "stages", []) if item.id == task["stage_id"]), None) if asset else None
        if not asset or not stage:
            raise ValueError("Stage asset not found")
        series = self.series_store.get(script.series_id) if script.series_id else None
        model_settings = series.model_settings if source == "series" and series else script.model_settings

        prompt = str(params.get("prompt") or self._build_stage_generation_prompt(asset, asset_type, stage))
        resolved_art_direction = script.art_direction
        if not resolved_art_direction and series:
            resolved_art_direction = series.art_direction if series else None
        if isinstance(resolved_art_direction, dict):
            resolved_art_direction = ArtDirection(**resolved_art_direction)
        style_prompt = ""
        negative_prompt = str(params.get("negative_prompt") or "")
        if resolved_art_direction and resolved_art_direction.style_config:
            style_prompt = resolved_art_direction.style_config.get("positive_prompt", "")
            global_negative = resolved_art_direction.style_config.get("negative_prompt", "")
            if global_negative:
                negative_prompt = f"{negative_prompt}, {global_negative}" if negative_prompt else global_negative
        actual_prompt = f"{prompt}, {style_prompt}" if style_prompt and style_prompt not in prompt else prompt
        stage.last_generation_prompt = actual_prompt

        selected_stage_image = next((item for item in stage.reference_images if item.id == stage.selected_image_id), None)
        # Scene/prop stages must regenerate from text only. Reusing the current
        # image as i2i input recursively preserves bad contact sheets, grids,
        # watermarks, and accidental people.
        reference_url = ((selected_stage_image.url if selected_stage_image else None) or self._asset_primary_image_url(asset, asset_type)) if asset_type == "character" else None
        reference_path = None
        if reference_url:
            if is_object_key(reference_url) or str(reference_url).startswith(("http://", "https://", "data:")):
                reference_path = reference_url
            else:
                candidate = reference_url if os.path.isabs(reference_url) else os.path.join("output", reference_url)
                if os.path.exists(candidate):
                    reference_path = candidate

        from .assets import ASPECT_RATIO_TO_SIZE
        if asset_type == "character":
            aspect = params.get("aspect_ratio") or model_settings.character_aspect_ratio
            default_size = "576*1024"
        elif asset_type == "prop":
            aspect = params.get("aspect_ratio") or model_settings.prop_aspect_ratio
            default_size = "1024*1024"
        else:
            aspect = params.get("aspect_ratio") or model_settings.scene_aspect_ratio
            default_size = "1024*576"
        size = ASPECT_RATIO_TO_SIZE.get(aspect, default_size)
        model_name = model_settings.i2i_model if reference_path else (params.get("model_name") or model_settings.t2i_model)
        reference_negative = self._stage_reference_negative_prompt(asset_type)
        negative_prompt = f"{negative_prompt}, {reference_negative}" if negative_prompt else reference_negative
        logger.info(
            "Stage asset generation asset_type=%s asset_id=%s stage_id=%s model=%s request_mode=%s reference_path=%s size=%s",
            asset_type,
            asset.id,
            stage.id,
            model_name,
            "i2i" if reference_path else "t2i",
            reference_path[:160] if isinstance(reference_path, str) else None,
            size,
        )

        extension_dir = os.path.join(self.asset_generator.output_dir, "stages")
        os.makedirs(extension_dir, exist_ok=True)
        batch_size = max(1, min(4, int(params.get("batch_size") or 1)))
        for _ in range(batch_size):
            variant_id = str(uuid.uuid4())
            output_path = os.path.join(extension_dir, f"{asset.id}_{stage.id}_{variant_id}.png")
            self.asset_generator._get_model().generate(
                actual_prompt,
                output_path,
                ref_image_path=reference_path,
                negative_prompt=negative_prompt,
                ref_strength=0.8,
                model_name=model_name,
                size=size,
            )
            image_url = os.path.relpath(output_path, "output")
            try:
                from ...utils.oss_utils import OSSImageUploader
                uploader = OSSImageUploader()
                if uploader.is_configured:
                    object_key = uploader.upload_file(output_path, sub_path="assets/stages")
                    if object_key:
                        image_url = object_key
            except Exception as exc:
                logger.warning("Failed to upload stage reference image: %s", exc)

            variant = ImageVariant(id=variant_id, url=image_url, prompt_used=actual_prompt)
            stage.reference_images.append(variant)
            stage.selected_image_id = variant.id
        stage.status = GenerationStatus.COMPLETED
        self._save_after_asset_mutation(source)

    def _set_task_asset_status(self, task: Dict[str, Any], status: GenerationStatus) -> None:
        """Persist the visible asset status for an async image generation task."""
        asset_id = task.get("asset_id")
        asset_type = task.get("asset_type")
        owner_id = task.get("script_id")
        if not asset_id or not asset_type or not owner_id:
            return

        try:
            if task.get("is_series"):
                series = self.series_store.get(owner_id)
                if not series:
                    return
                pool = (
                    series.characters if asset_type == "character"
                    else series.scenes if asset_type == "scene"
                    else series.props if asset_type == "prop"
                    else []
                )
                target = next((a for a in pool if a.id == asset_id), None)
                if target:
                    target.status = status
                    series.updated_at = time.time()
                    self._save_series_data()
                return

            script = self.scripts.get(owner_id)
            if not script:
                return
            target, source = self._find_asset_with_source(script, asset_id, asset_type)
            if target:
                target.status = status
                stage_id = task.get("stage_id")
                stage = next((item for item in getattr(target, "stages", []) if item.id == stage_id), None)
                if stage:
                    stage.status = status
                self._save_after_asset_mutation(source)
        except Exception as exc:
            logger.warning("Failed to persist asset task status: %s", exc)

    def _process_series_asset_task(self, task: Dict, params: Dict):
        """Process a Series asset generation task."""
        series_id = task["script_id"]  # stored as script_id for compatibility
        series = self.series_store.get(series_id)
        if not series:
            raise ValueError("Series not found")

        asset_id = task["asset_id"]
        asset_type = task["asset_type"]
        positive_prompt = params.get("effective_positive_prompt", "")
        negative_prompt = params.get("effective_negative_prompt", "")
        t2i_model = params.get("t2i_model", "wan2.6-t2i")
        effective_size = params.get("effective_size", "576*1024")
        batch_size = params.get("batch_size", 1)
        generation_type = params.get("generation_type", "all")
        prompt = params.get("prompt")
        reference_image_url = params.get("reference_image_url")

        if asset_type == "character":
            target = next((c for c in series.characters if c.id == asset_id), None)
            if not target:
                raise ValueError(f"Character {asset_id} not found in series")
            self.asset_generator.generate_character(
                target, generation_type=generation_type, prompt=prompt or "",
                positive_prompt=positive_prompt, negative_prompt=negative_prompt,
                batch_size=batch_size, model_name=t2i_model, size=effective_size,
            )
        elif asset_type == "scene":
            target = next((s for s in series.scenes if s.id == asset_id), None)
            if not target:
                raise ValueError(f"Scene {asset_id} not found in series")
            self.asset_generator.generate_scene(
                target, positive_prompt=positive_prompt, negative_prompt=negative_prompt,
                batch_size=batch_size, model_name=t2i_model, size=effective_size,
                prompt=prompt,
            )
        elif asset_type == "prop":
            target = next((p for p in series.props if p.id == asset_id), None)
            if not target:
                raise ValueError(f"Prop {asset_id} not found in series")
            self.asset_generator.generate_prop(
                target, positive_prompt=positive_prompt, negative_prompt=negative_prompt,
                batch_size=batch_size, model_name=t2i_model, size=effective_size,
                prompt=prompt,
            )
        else:
            raise ValueError(f"Unknown asset type: {asset_type}")

        self._save_series_data()

    def get_asset_generation_task_status(self, task_id: str) -> Optional[Dict[str, Any]]:
        """Returns the status of an asset generation task."""
        # Check image tasks first
        task = self.asset_generation_tasks.get(task_id)
        if not task:
            # Then check video tasks (motion ref)
            task = self.video_generation_tasks.get(task_id)
        
        if not task:
            # Finally, scan all scripts for VideoTask objects
            for script in self.scripts.values():
                for vt in (script.video_tasks or []):
                    if vt.id == task_id:
                        return {
                            "task_id": task_id,
                            "status": vt.status,
                            "progress": vt.progress if hasattr(vt, 'progress') else 0,
                            "error": vt.error if hasattr(vt, 'error') else None,
                            "script_id": script.id,
                            "video_url": vt.video_url if hasattr(vt, 'video_url') else None,
                            "created_at": vt.created_at if hasattr(vt, 'created_at') else None,
                        }
            return None
        
        return {
            "task_id": task_id,
            "status": task["status"],
            "progress": task.get("progress", 0),
            "error": task.get("error"),
            "asset_id": task.get("asset_id"),
            "asset_type": task.get("asset_type"),
            "script_id": task.get("script_id"),
            "created_at": task.get("created_at")
        }

    def create_motion_ref_task(self, script_id: str, asset_id: str, asset_type: str, 
                                prompt: Optional[str] = None, audio_url: Optional[str] = None, 
                                duration: int = 5, batch_size: int = 1) -> Tuple[Script, str]:
        """Creates an async motion reference generation task."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
            
        task_id = str(uuid.uuid4())
        self.video_generation_tasks[task_id] = {
            "status": "pending",
            "progress": 0,
            "error": None,
            "script_id": script_id,
            "asset_id": asset_id,
            "asset_type": asset_type,
            "created_at": time.time(),
            "params": {
                "prompt": prompt,
                "audio_url": audio_url,
                "duration": duration,
                "batch_size": batch_size
            }
        }
        
        self._save_data()
        return script, task_id

    def process_motion_ref_task(self, script_id: str, task_id: str):
        """Processes a video generation task in the background."""
        task = self.video_generation_tasks.get(task_id)
        if not task:
            logger.error(f"Video task {task_id} not found")
            return
            
        task["status"] = "processing"
        
        try:
            params = task["params"]
            # Call the synchronous generate_motion_ref method
            self.generate_motion_ref(
                script_id=script_id,
                asset_id=task["asset_id"],
                asset_type=task["asset_type"],
                prompt=params["prompt"],
                audio_url=params["audio_url"],
                duration=params["duration"],
                batch_size=params["batch_size"]
            )
            task["status"] = "completed"
            task["progress"] = 100
            logger.info(f"Video task {task_id} completed successfully")
        except Exception as e:
            task["status"] = "failed"
            task["error"] = str(e)
            logger.error(f"Video task {task_id} failed: {e}")

    def sync_descriptions_from_script_entities(self, script_id: str) -> Script:
        """
        Syncs entity descriptions from ScriptProcessor parsed entities.
        This clears saved prompts so the UI will regenerate them from the current description.
        
        Note: This only updates prompts, not generated images/videos.
        """
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        # Clear saved prompts for all characters so UI will regenerate from description
        for character in script.characters:
            character.full_body_prompt = None
            character.three_view_prompt = None
            character.headshot_prompt = None
            character.video_prompt = None
        
        # Scenes and props might also have prompts to clear (if applicable)
        for scene in script.scenes:
            if hasattr(scene, 'prompt'):
                scene.prompt = None
        
        for prop in script.props:
            if hasattr(prop, 'prompt'):
                prop.prompt = None
        
        self._save_data()
        logger.info(f"Descriptions synced for script {script_id}: cleared prompts for {len(script.characters)} characters, {len(script.scenes)} scenes, {len(script.props)} props")
        return script

    @staticmethod
    def _asset_primary_image_url(asset: Any, asset_type: str) -> Optional[str]:
        """Resolve the selected image across current and legacy asset schemas."""
        if asset_type == "character":
            for unit_name in ("reference_sheet", "full_body"):
                unit = getattr(asset, unit_name, None)
                if unit and unit.image_variants:
                    selected = next((item for item in unit.image_variants if item.id == unit.selected_image_id), None)
                    return (selected or unit.image_variants[-1]).url
            legacy = getattr(asset, "full_body_asset", None)
            if legacy and legacy.variants:
                selected = next((item for item in legacy.variants if item.id == legacy.selected_id), None)
                return (selected or legacy.variants[-1]).url
            return getattr(asset, "full_body_image_url", None) or getattr(asset, "image_url", None)
        image_asset = getattr(asset, "image_asset", None)
        if image_asset and image_asset.variants:
            selected = next((item for item in image_asset.variants if item.id == image_asset.selected_id), None)
            return (selected or image_asset.variants[-1]).url
        return getattr(asset, "image_url", None)

    def update_asset_stage(self, script_id: str, asset_id: str, asset_type: str, action: str,
                           stage_id: Optional[str] = None, data: Optional[Dict[str, Any]] = None) -> Tuple[Script, Optional[str]]:
        """Mutate one evolution stage while retaining a single logical asset."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        asset, source = self._find_asset_with_source(script, asset_id, asset_type)
        if not asset or not hasattr(asset, "stages"):
            raise ValueError(f"Asset {asset_id} does not support stages")
        data = data or {}
        stage = next((item for item in asset.stages if item.id == stage_id), None)
        task_id = None
        if action == "create":
            stage = AssetStage(**data)
            asset.stages.append(stage)
        elif not stage:
            raise ValueError(f"Stage {stage_id} not found")
        else:
            # Old UI versions could add the same base image repeatedly. Collapse
            # those records before every mutation while preserving the selected
            # record when it is one of the duplicates.
            selected_variant = next((item for item in stage.reference_images if item.id == stage.selected_image_id), None)
            unique_by_url: Dict[str, ImageVariant] = {}
            for item in stage.reference_images:
                if item.url not in unique_by_url or item is selected_variant:
                    unique_by_url[item.url] = item
            stage.reference_images = list(unique_by_url.values())
            if selected_variant:
                stage.selected_image_id = unique_by_url[selected_variant.url].id

        if action == "create":
            pass
        elif action == "update":
            updated = stage.model_copy(update={k: v for k, v in data.items() if k in AssetStage.model_fields})
            asset.stages[asset.stages.index(stage)] = updated
        elif action == "toggle_lock":
            stage.locked = not stage.locked
        elif action == "select":
            variant_id = data.get("image_id")
            if not any(item.id == variant_id for item in stage.reference_images):
                raise ValueError("Stage image not found")
            stage.selected_image_id = variant_id
        elif action == "remove_image":
            variant_id = data.get("image_id")
            if not any(item.id == variant_id for item in stage.reference_images):
                raise ValueError("Stage image not found")
            stage.reference_images = [item for item in stage.reference_images if item.id != variant_id]
            if stage.selected_image_id == variant_id:
                stage.selected_image_id = stage.reference_images[-1].id if stage.reference_images else None
            stage.status = GenerationStatus.COMPLETED if stage.selected_image_id else GenerationStatus.PENDING
        elif action == "copy_previous":
            previous = max((item for item in asset.stages if item.to_episode < stage.from_episode), key=lambda item: item.to_episode, default=None)
            if not previous:
                raise ValueError("Previous stage not found")
            stage.reference_images = [item.model_copy(deep=True, update={"id": str(uuid.uuid4())}) for item in previous.reference_images]
            stage.selected_image_id = stage.reference_images[0].id if stage.reference_images else None
            stage.status = GenerationStatus.COMPLETED if stage.reference_images else GenerationStatus.PENDING
        elif action == "use_base":
            image_url = self._asset_primary_image_url(asset, asset_type)
            if not image_url:
                raise ValueError("Base asset has no image")
            variant = next((item for item in stage.reference_images if item.url == image_url), None)
            if not variant:
                variant = ImageVariant(id=str(uuid.uuid4()), url=image_url, prompt_used="Base asset")
                stage.reference_images.append(variant)
            stage.selected_image_id = variant.id; stage.status = GenerationStatus.COMPLETED
        elif action == "use_image":
            image_url = str(data.get("image_url") or "").strip()
            if not image_url:
                raise ValueError("Image URL is required")
            variant = next((item for item in stage.reference_images if item.url == image_url), None)
            if not variant:
                variant = ImageVariant(id=str(uuid.uuid4()), url=image_url, prompt_used=str(data.get("prompt_used") or "Existing asset candidate"))
                stage.reference_images.append(variant)
            stage.selected_image_id = variant.id; stage.status = GenerationStatus.COMPLETED
        elif action == "generate":
            if stage.locked:
                raise ValueError("Stage is locked")
            prompt = self._build_stage_generation_prompt(asset, asset_type, stage)
            stage.last_generation_prompt = prompt
            batch_size = max(1, min(4, int(data.get("batch_size") or 1)))
            aspect_ratio = str(data.get("aspect_ratio") or ("16:9" if asset_type == "character" else "16:9"))
            _, task_id = self.create_asset_generation_task(
                script_id, asset_id, asset_type, prompt=prompt,
                generation_type="stage_reference", batch_size=batch_size,
                aspect_ratio=aspect_ratio,
            )
            self.asset_generation_tasks[task_id]["stage_id"] = stage.id
            stage.status = GenerationStatus.PROCESSING
        else:
            raise ValueError(f"Unsupported stage action: {action}")
        self._save_after_asset_mutation(source)
        return script, task_id

    def add_character(self, script_id: str, name: str, description: str) -> Script:
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        new_char = Character(
            id=f"char_{uuid.uuid4().hex[:8]}",
            name=name,
            description=description
        )
        script.characters.append(new_char)
        self._save_data()
        return script

    def delete_character(self, script_id: str, char_id: str) -> Script:
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        script.characters = [c for c in script.characters if c.id != char_id]
        self._save_data()
        return script

    def add_scene(self, script_id: str, name: str, description: str) -> Script:
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        new_scene = Scene(
            id=f"scene_{uuid.uuid4().hex[:8]}",
            name=name,
            description=description
        )
        script.scenes.append(new_scene)
        self._save_data()
        return script

    def delete_scene(self, script_id: str, scene_id: str) -> Script:
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        script.scenes = [s for s in script.scenes if s.id != scene_id]
        self._save_data()
        return script
    
    def _find_asset_with_source(
        self, script: "Script", asset_id: str, asset_type: str
    ) -> Tuple[Optional[object], Optional[str]]:
        """Locate an asset by (id, type) in either the episode's local
        list OR the parent series' shared pool. Returns
        (asset, source) where source ∈ {"script", "series"} so the
        caller can mutate the right object and save the right side.

        Episode-local always wins (the user explicitly forked this
        asset to override the series version). Falls back to series
        only when the id isn't local. Returns (None, None) when the
        asset doesn't exist in either container — caller should 404.
        """
        if asset_type == "character":
            ep_list = script.characters
        elif asset_type == "scene":
            ep_list = script.scenes
        elif asset_type == "prop":
            ep_list = script.props
        else:
            return None, None
        local = next((a for a in ep_list if a.id == asset_id), None)
        if local is not None:
            return local, "script"
        # Fall back to series shared pool if this episode belongs to
        # a series.
        if not script.series_id:
            return None, None
        series = self.series_store.get(script.series_id)
        if not series:
            return None, None
        if asset_type == "character":
            sh_list = series.characters
        elif asset_type == "scene":
            sh_list = series.scenes
        else:  # prop
            sh_list = series.props
        shared = next((a for a in sh_list if a.id == asset_id), None)
        if shared is not None:
            return shared, "series"
        return None, None

    def _save_after_asset_mutation(self, source: str) -> None:
        """Persist after mutating an asset; pick the right save path
        based on which container the asset lives in (episode vs series)."""
        if source == "series":
            self._save_series_data()
        else:
            self._save_data()

    def toggle_asset_lock(self, script_id: str, asset_id: str, asset_type: str) -> Script:
        """Toggle the locked status of an asset. Works on both
        episode-local and series-shared assets (A2 decision: default
        write to series, since locking a shared character should
        affect all episodes that use it)."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        target_asset, source = self._find_asset_with_source(script, asset_id, asset_type)
        if not target_asset:
            raise ValueError(f"Asset {asset_id} of type {asset_type} not found")

        # Toggle the locked status
        target_asset.locked = not target_asset.locked
        self._save_after_asset_mutation(source)
        return script

    def toggle_frame_lock(self, script_id: str, frame_id: str) -> Script:
        """Toggle the locked status of a frame."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
            
        target_frame = next((f for f in script.frames if f.id == frame_id), None)
        if not target_frame:
            raise ValueError(f"Frame {frame_id} not found")
            
        # Toggle the locked status
        target_frame.locked = not target_frame.locked
        self._save_data()
        return script

    def update_asset_image(self, script_id: str, asset_id: str, asset_type: str, image_url: str) -> Script:
        """Updates the image URL of an asset manually. Per A2 decision,
        series-shared assets are updated in place (shared semantics);
        episode-local assets are updated locally."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        target_asset, source = self._find_asset_with_source(script, asset_id, asset_type)
        if not target_asset:
            raise ValueError(f"Asset {asset_id} of type {asset_type} not found")

        target_asset.image_url = image_url
        # For characters, also update avatar if it's not set or if we want to sync them
        # For now, let's assume the uploaded image is the main reference.
        # If it's a character, we might want to set avatar_url to the same image for simplicity
        if asset_type == "character":
            target_asset.avatar_url = image_url

        self._save_after_asset_mutation(source)
        return script

    def update_asset_description(self, script_id: str, asset_id: str, asset_type: str, description: str) -> Script:
        """Updates the description of an asset."""
        return self.update_asset_attributes(script_id, asset_id, asset_type, {"description": description})

    def update_asset_attributes(self, script_id: str, asset_id: str, asset_type: str, attributes: Dict[str, Any]) -> Script:
        """Updates arbitrary attributes of an asset. Routes the write
        to either the episode-local or the parent series' shared copy
        depending on which container owns the asset (A2 decision)."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        target_asset, source = self._find_asset_with_source(script, asset_id, asset_type)
        if not target_asset:
            raise ValueError(f"Asset {asset_id} of type {asset_type} not found")

        # Update attributes
        for key, value in attributes.items():
            if hasattr(target_asset, key):
                setattr(target_asset, key, value)
            else:
                logger.warning(f"Attribute {key} not found in {asset_type} model")

        self._save_after_asset_mutation(source)
        return script

    def add_uploaded_asset_variant(
        self, 
        script_id: str, 
        asset_type: str, 
        asset_id: str, 
        upload_type: str, 
        image_url: str, 
        description: Optional[str] = None
    ) -> Script:
        """
        Adds an uploaded image as a new variant to an asset.
        The uploaded image is marked with is_uploaded_source=True.
        
        Args:
            script_id: The project ID
            asset_type: "character", "scene", or "prop"
            asset_id: The asset ID
            upload_type: "full_body", "head_shot", "three_views", or "image"
            image_url: URL of the uploaded image (OSS Object Key)
            description: Optional modified description for reverse generation
        """
        from .models import ImageVariant, AssetUnit, ImageAsset
        
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        # Find target asset. Cast displays a union of episode-local and
        # series-shared assets, so uploads must route to the owning container.
        target_asset, source = self._find_asset_with_source(script, asset_id, asset_type)
        
        if not target_asset:
            raise ValueError(f"Asset {asset_id} of type {asset_type} not found")
        
        # Create new variant with upload source flag
        new_variant = ImageVariant(
            id=str(uuid.uuid4()),
            url=image_url,
            prompt_used=description or target_asset.description,
            is_uploaded_source=True,
            upload_type=upload_type
        )
        
        # Update description if provided
        if description:
            target_asset.description = description
        
        # Add variant to the appropriate asset unit
        if asset_type == "character":
            # Map upload_type to the correct asset unit
            if upload_type == "full_body":
                target_unit = target_asset.full_body
            elif upload_type == "head_shot":
                target_unit = target_asset.head_shot
            elif upload_type == "three_views":
                target_unit = target_asset.three_views
            else:
                raise ValueError(f"Invalid upload_type for character: {upload_type}")
            
            # Ensure AssetUnit exists
            if target_unit is None:
                target_unit = AssetUnit()
                if upload_type == "full_body":
                    target_asset.full_body = target_unit
                elif upload_type == "head_shot":
                    target_asset.head_shot = target_unit
                elif upload_type == "three_views":
                    target_asset.three_views = target_unit
            
            # Add variant and select it
            target_unit.image_variants.append(new_variant)
            target_unit.selected_image_id = new_variant.id
            target_unit.image_updated_at = time.time()
            
            # === ALSO UPDATE LEGACY FIELDS for frontend compatibility ===
            # Create variant for legacy ImageAsset structure
            legacy_variant = ImageVariant(
                id=new_variant.id,
                url=image_url,
                prompt_used=description or target_asset.description,
                is_uploaded_source=True,
                upload_type=upload_type
            )
            
            if upload_type == "full_body":
                # Ensure full_body_asset exists
                if target_asset.full_body_asset is None:
                    from .models import ImageAsset
                    target_asset.full_body_asset = ImageAsset()
                target_asset.full_body_asset.variants.append(legacy_variant)
                target_asset.full_body_asset.selected_id = new_variant.id
                target_asset.full_body_image_url = image_url
            elif upload_type == "head_shot":
                # Ensure headshot_asset exists
                if target_asset.headshot_asset is None:
                    from .models import ImageAsset
                    target_asset.headshot_asset = ImageAsset()
                target_asset.headshot_asset.variants.append(legacy_variant)
                target_asset.headshot_asset.selected_id = new_variant.id
                target_asset.headshot_image_url = image_url
            elif upload_type == "three_views":
                # Ensure three_view_asset exists
                if target_asset.three_view_asset is None:
                    from .models import ImageAsset
                    target_asset.three_view_asset = ImageAsset()
                target_asset.three_view_asset.variants.append(legacy_variant)
                target_asset.three_view_asset.selected_id = new_variant.id
                target_asset.three_view_image_url = image_url
            
            logger.info(f"Added uploaded variant {new_variant.id} to character {asset_id} {upload_type}")
            
        elif asset_type in ["scene", "prop"]:
            # Scene and Prop use the standard ImageAsset container.
            if target_asset.image_asset is None:
                target_asset.image_asset = ImageAsset()

            target_asset.image_asset.variants.append(new_variant)
            target_asset.image_asset.selected_id = new_variant.id
            target_asset.image_url = image_url
            target_asset.status = GenerationStatus.COMPLETED
            
            logger.info(f"Added uploaded variant {new_variant.id} to {asset_type} {asset_id}")
        
        self._save_after_asset_mutation(source)
        return script

    def update_project_style(self, script_id: str, style_preset: str, style_prompt: Optional[str] = None) -> Script:
        """Updates the global style settings for a project."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
            
        script.style_preset = style_preset
        script.style_prompt = style_prompt
        script.updated_at = time.time()
        self._save_data()
        return script
    
    def save_art_direction(self, script_id: str, selected_style_id: str, style_config: Dict[str, Any], custom_styles: List[Dict[str, Any]] = None, ai_recommendations: List[Dict[str, Any]] = None) -> Script:
        """Saves the Art Direction configuration."""
        from .models import ArtDirection
        
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        # Create Art Direction object
        art_direction = ArtDirection(
            selected_style_id=selected_style_id,
            style_config=style_config,
            custom_styles=custom_styles or [],
            ai_recommendations=ai_recommendations or []
        )
        
        script.art_direction = art_direction
        script.updated_at = time.time()
        self._save_data()
        return script

    # === STORYBOARD DRAMATIZATION v2 ===

    def analyze_text_to_frames(self, script_id: str, text: str) -> Script:
        """
        Analyzes script text and generates storyboard frames using LLM.
        Replaces existing frames with newly generated ones.
        """
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        logger.info(f"Analyzing text to frames for project {script_id}")

        # Resolve assets (merge Series + Episode if applicable)
        resolved = self.resolve_episode_assets(script)
        all_characters = resolved["characters"]
        all_scenes = resolved["scenes"]
        all_props = resolved["props"]

        # Build entities JSON from resolved characters, scenes, props
        entities_json = {
            "characters": [{"id": c.id, "name": c.name, "description": c.description} for c in all_characters],
            "scenes": [{"id": s.id, "name": s.name, "description": s.description} for s in all_scenes],
            "props": [{"id": p.id, "name": p.name, "description": p.description} for p in all_props],
        }

        # Fast path: try regex-based frame parsing first
        # The user's script may already have structured **镜头** markers
        try:
            regex_frames = self.script_processor._try_parse_frames_from_text(text)
            logger.info(f"regex fast path: {len(regex_frames)} frames via regex")
        except Exception as _e3:
            logger.warning(f"regex fast path error: {_e3}")
            regex_frames = []
        
        if regex_frames and len(regex_frames) >= 2:
            logger.info(f"Fast path: parsed {len(regex_frames)} frames via regex from structured script")
            # Run auto-link to associate entity IDs from the resource line
            self._auto_link_frame_assets(regex_frames, all_characters, all_scenes, all_props)
            raw_frames = []
            for f in regex_frames:
                # Resolve referenced entity names from action_description (resource line)
                desc = f.action_description or ""
                scene_ref = ""
                char_refs = []
                prop_refs = []
                # Try to extract from auto-link results
                if f.scene_id:
                    scene_obj = next((s for s in all_scenes if s.id == f.scene_id), None)
                    if scene_obj:
                        scene_ref = scene_obj.name
                if f.character_ids:
                    for cid in f.character_ids:
                        cobj = next((c for c in all_characters if c.id == cid), None)
                        if cobj:
                            char_refs.append(cobj.name)
                if f.prop_ids:
                    for pid in f.prop_ids:
                        pobj = next((p for p in all_props if p.id == pid), None)
                        if pobj:
                            prop_refs.append(pobj.name)
                raw_frames.append({
                    "scene_ref_name": scene_ref,
                    "character_ref_names": char_refs,
                    "prop_ref_names": prop_refs,
                    "action_summary": desc,
                    "action_description": desc,
                    "shot_size": f.shot_size or "中景",
                    "camera_angle": f.camera_angle or "平视",
                    "duration": f.duration or 4,
                })
        else:
            # Slow path: LLM-based storyboard analysis
            logger.info("Slow path: calling LLM for storyboard analysis")
            raw_frames = self.script_processor.analyze_to_storyboard(text, entities_json)

        if not raw_frames:
            raise RuntimeError("AI 分镜分析未返回任何帧数据，请重试。")

        # Convert raw frame dicts to StoryboardFrame objects
        new_frames = []
        for idx, frame_data in enumerate(raw_frames):
            # Resolve scene ID by name
            scene_ref_name = frame_data.get("scene_ref_name", "")
            scene_id = None
            for scene in all_scenes:
                if scene.name == scene_ref_name or scene_ref_name in scene.name:
                    scene_id = scene.id
                    break
            if not scene_id and all_scenes:
                scene_id = all_scenes[0].id  # Fallback to first scene
            elif not scene_id:
                scene_id = str(uuid.uuid4())  # Generate a placeholder ID

            # Resolve character IDs by names (case-insensitive, bidirectional contains)
            char_ref_names = frame_data.get("character_ref_names", [])
            character_ids = []
            for char_name in char_ref_names:
                cn = char_name.strip().lower()
                for char in all_characters:
                    cname = char.name.strip().lower()
                    if cname == cn or cn in cname or cname in cn:
                        character_ids.append(char.id)
                        break

            # Resolve prop IDs by names (case-insensitive, bidirectional contains)
            prop_ref_names = frame_data.get("prop_ref_names", [])
            prop_ids = []
            for prop_name in prop_ref_names:
                pn = prop_name.strip().lower()
                for prop in all_props:
                    pname = prop.name.strip().lower()
                    if pname == pn or pn in pname or pname in pn:
                        prop_ids.append(prop.id)
                        break

            episode_number = script.episode_number or 1
            character_stage_refs = {}
            for character_id in character_ids:
                character = next((c for c in all_characters if c.id == character_id), None)
                if character:
                    stage = next((s for s in character.stages if s.from_episode <= episode_number <= s.to_episode), None)
                    if stage:
                        character_stage_refs[character_id] = stage.id
            scene = next((s for s in all_scenes if s.id == scene_id), None)
            scene_stage = next((s for s in scene.stages if s.from_episode <= episode_number <= s.to_episode), None) if scene else None
            
            frame = StoryboardFrame(
                id=str(uuid.uuid4()),
                scene_id=scene_id,
                character_ids=character_ids,
                prop_ids=prop_ids,
                character_stage_refs=character_stage_refs,
                scene_stage_ref=scene_stage.id if scene_stage else None,
                episode_state=frame_data.get("episode_state"),
                hud_template=frame_data.get("hud_template"),
                hud_payload=frame_data.get("hud_payload") or {},
                subtitle_template=frame_data.get("subtitle_template"),
                action_description=frame_data.get("action_summary", frame_data.get("action_description", "")),
                visual_atmosphere=frame_data.get("visual_atmosphere"),
                shot_size=frame_data.get("shot_size"),
                camera_angle=frame_data.get("camera_angle", "平视"),
                camera_movement=frame_data.get("camera_movement"),
                dialogue=frame_data.get("dialogue"),
                speaker=frame_data.get("speaker"),
                duration=frame_data.get("duration"),
                status=GenerationStatus.PENDING
            )
            new_frames.append(frame)
        
        # Replace existing frames with new ones
        script.frames = new_frames
        script.updated_at = time.time()
        
        logger.info(f"Generated {len(new_frames)} frames from text analysis")
        self._save_data()
        return script

    def _refine_frame_inner(self, script_id: str, frame_id: str) -> Optional[StoryboardFrame]:
        """Core refinement logic (no DB save). Thread-safe for batch parallelism."""
        from .prompt_assembly import assemble_prompt, sync_dialogue_to_tts
        from .models import DialogueStructured, CameraMovementData, Blocking, AudioNote, LightingData, StageSubject

        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        frame = next((f for f in script.frames if f.id == frame_id), None)
        if not frame:
            raise ValueError(f"Frame {frame_id} not found")

        frame_idx = script.frames.index(frame)
        resolved = self.resolve_episode_assets(script)
        all_characters = resolved["characters"]
        all_scenes = resolved["scenes"]

        # Build coarse frame dict for LLM
        coarse = {
            "action_summary": frame.action_description,
            "shot_size": frame.shot_size,
            "camera_angle": frame.camera_angle,
            "camera_movement": frame.camera_movement,
            "dialogue": frame.dialogue,
            "speaker": frame.speaker,
            "duration": frame.duration,
            "character_names": [c.name for c in all_characters if c.id in frame.character_ids],
            "scene_name": next((s.name for s in all_scenes if s.id == frame.scene_id), None),
        }

        # Character/scene assets
        char_assets = [
            {"name": c.name, "description": c.description, "clothing": c.clothing or ""}
            for c in all_characters if c.id in frame.character_ids
        ]
        scene_assets = [
            {"name": s.name, "description": s.description}
            for s in all_scenes if s.id == frame.scene_id
        ]

        # Adjacent frame context
        prev_ctx = None
        if frame_idx > 0:
            pf = script.frames[frame_idx - 1]
            prev_ctx = f"Action: {pf.action_description}. Shot: {pf.shot_size}, {pf.camera_angle}."
        next_ctx = None
        if frame_idx < len(script.frames) - 1:
            nf = script.frames[frame_idx + 1]
            next_ctx = f"Action: {nf.action_description}. Shot: {nf.shot_size}, {nf.camera_angle}."

        result = self.script_processor.refine_frame_to_rich(
            coarse, char_assets, scene_assets, prev_ctx, next_ctx
        )
        if not result:
            return frame

        # Map result onto frame fields
        if result.get("visual_description"):
            from .prompt_assembly import inject_reference_tags
            frame.visual_description = inject_reference_tags(
                result["visual_description"], frame, all_characters, all_scenes
            )
        if result.get("shot_size"):
            frame.shot_size = result["shot_size"]
        if result.get("camera_angle"):
            frame.camera_angle = result["camera_angle"]
        if result.get("duration"):
            frame.duration = result["duration"]
        if result.get("transition_hint"):
            frame.transition_hint = result["transition_hint"]

        # Camera movement structured
        cm = result.get("camera_movement")
        if cm and isinstance(cm, dict) and cm.get("primary"):
            frame.camera_movement_structured = CameraMovementData(
                primary=cm["primary"],
                secondary=cm.get("secondary"),
                speed=cm.get("speed", "normal"),
                description=cm.get("description"),
            )

        # Blocking
        blk = result.get("blocking")
        if blk and isinstance(blk, dict) and blk.get("description"):
            stage_list = None
            if blk.get("stage") and isinstance(blk["stage"], list):
                stage_list = [
                    StageSubject(
                        ref=s.get("ref", ""),
                        zone=s.get("zone", "center"),
                        depth=s.get("depth", "mid"),
                        height=s.get("height"),
                        facing=s.get("facing"),
                        posture=s.get("posture"),
                    )
                    for s in blk["stage"] if isinstance(s, dict)
                ]
            frame.blocking = Blocking(
                description=blk["description"],
                stage=stage_list,
                camera_relation=blk.get("camera_relation"),
            )

        # Dialogue structured
        ds = result.get("dialogue_structured")
        if ds and isinstance(ds, dict) and ds.get("line"):
            frame.dialogue_structured = DialogueStructured(
                speaker=ds.get("speaker", frame.speaker or ""),
                line=ds["line"],
                emotion=ds.get("emotion"),
                delivery=ds.get("delivery"),
            )

        # Audio note
        an = result.get("audio_note")
        if an and isinstance(an, dict) and (an.get("sfx") or an.get("ambience")):
            frame.audio_note = AudioNote(
                sfx=an.get("sfx"),
                ambience=an.get("ambience"),
                bgm_note=an.get("bgm_note"),
            )

        # Lighting
        lt = result.get("lighting")
        if lt and isinstance(lt, dict) and (lt.get("description") or lt.get("direction")):
            frame.lighting = LightingData(
                direction=lt.get("direction"),
                quality=lt.get("quality"),
                color_temp=lt.get("color_temp"),
                description=lt.get("description"),
            )

        # Sync dialogue → TTS instructions & compute assembled prompt
        sync_dialogue_to_tts(frame)
        frame.assembled_prompt = assemble_prompt(frame, all_characters)
        frame.updated_at = time.time()
        return frame

    def refine_frame(self, script_id: str, frame_id: str) -> Optional[StoryboardFrame]:
        """Phase 2: Refine a single coarse frame into a rich frame (with DB save)."""
        result = self._refine_frame_inner(script_id, frame_id)
        self._save_data()
        return result

    def refine_batch_generator(self, script_id: str):
        """Phase 2: Generator that yields SSE events while refining all frames.
        Frames are refined in parallel (max 3 concurrent) to reduce wait time."""
        from concurrent.futures import ThreadPoolExecutor, as_completed
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        with self._refine_batch_lock:
            existing = self._refine_batch_status.get(script_id)
            if existing and existing.get("running"):
                raise RuntimeError("Batch refine is already running for this project")

        pending_frames = [
            (idx, frame)
            for idx, frame in enumerate(script.frames)
            if not (frame.assembled_prompt and frame.visual_description)
        ]
        total = len(pending_frames)
        if total == 0:
            yield ("batch_complete", {
                "total": 0,
                "success": 0,
                "failed": 0,
                "skipped": len(script.frames),
            })
            return

        with self._refine_batch_lock:
            self._refine_batch_status[script_id] = {
                "running": True,
                "total": total,
                "completed": 0,
                "success": 0,
                "failed": 0,
                "skipped": len(script.frames) - total,
                "remaining": total,
                "started_at": time.time(),
                "updated_at": time.time(),
            }

        # Refine only frames that do not already have rich assembled prompts.
        # This makes interrupted/refreshed batch refinement resumable enough for
        # the UI: clicking "continue" will not spend LLM calls on completed frames.
        success = 0
        failed = 0
        max_workers = min(3, total)

        def _refine_one(entry):
            idx, frame = entry
            try:
                self._refine_frame_inner(script_id, frame.id)
                # Persist inside the worker so completed frames survive if the
                # SSE client disconnects before the main generator consumes the
                # future result.
                self._save_data(script_id)
                return ("ok", idx, frame.id)
            except Exception as exc:
                logger.error(f"[refine_batch] frame={frame.id} error={exc}")
                return ("err", idx, frame.id, str(exc))

        try:
            with ThreadPoolExecutor(max_workers=max_workers) as pool:
                futures = {
                    pool.submit(_refine_one, (idx, frame)): (idx, frame)
                    for idx, frame in pending_frames
                }
                for future in as_completed(futures):
                    result = future.result()
                    completed = success + failed + 1
                    if result[0] == "ok":
                        _, idx, fid = result
                        success += 1
                        event_payload = {
                            "frame_id": fid,
                            "frame_index": idx,
                            "total": total,
                            "success": success,
                            "failed": failed,
                            "completed": completed,
                        }
                        event_type = "frame_refine_complete"
                    else:
                        _, idx, fid, err = result
                        failed += 1
                        event_payload = {
                            "frame_id": fid,
                            "frame_index": idx,
                            "total": total,
                            "error": err,
                            "success": success,
                            "failed": failed,
                            "completed": completed,
                        }
                        event_type = "frame_refine_error"

                    with self._refine_batch_lock:
                        status = self._refine_batch_status.setdefault(script_id, {})
                        status.update({
                            "running": True,
                            "total": total,
                            "completed": completed,
                            "success": success,
                            "failed": failed,
                            "skipped": len(script.frames) - total,
                            "remaining": max(0, total - completed),
                            "updated_at": time.time(),
                        })
                    self._save_data()
                    yield (event_type, event_payload)

            self._save_data()
            with self._refine_batch_lock:
                self._refine_batch_status[script_id] = {
                    "running": False,
                    "total": total,
                    "completed": success + failed,
                    "success": success,
                    "failed": failed,
                    "skipped": len(script.frames) - total,
                    "remaining": max(0, total - success),
                    "updated_at": time.time(),
                }
            yield ("batch_complete", {
                "total": total,
                "success": success,
                "failed": failed,
                "skipped": len(script.frames) - total,
            })
        finally:
            with self._refine_batch_lock:
                status = self._refine_batch_status.get(script_id)
                if status and status.get("running"):
                    status.update({
                        "running": False,
                        "completed": success + failed,
                        "success": success,
                        "failed": failed,
                        "remaining": max(0, total - success - failed),
                        "updated_at": time.time(),
                    })

    def refine_frame_prompt(self, script_id: str, frame_id: str, raw_prompt: str, assets: List[Dict[str, Any]], feedback: str = "") -> Dict[str, Any]:
        """
        Refines a raw prompt into bilingual (CN/EN) prompts using LLM.
        Also updates the frame with the refined prompts.
        """
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        logger.debug(f"Refining prompt for frame {frame_id}")

        # Read custom prompt config with 3-level fallback (Episode → Series → default)
        series = self.series_store.get(script.series_id) if script.series_id else None
        custom_prompt = self.get_effective_prompt("storyboard_polish", script, series)
        # If it's the system default, pass empty so the LLM method uses its built-in default
        from .llm import DEFAULT_STORYBOARD_POLISH_PROMPT
        if custom_prompt == DEFAULT_STORYBOARD_POLISH_PROMPT:
            custom_prompt = ""

        # Call LLM to refine prompt
        result = self.script_processor.polish_storyboard_prompt(raw_prompt, assets, feedback, custom_prompt)
        
        # Find and update the frame
        frame_found = False
        for frame in script.frames:
            if frame.id == frame_id:
                frame.image_prompt_cn = result.get("prompt_cn")
                frame.image_prompt_en = result.get("prompt_en")
                frame.image_prompt = result.get("prompt_en")  # Also update legacy field
                frame.updated_at = time.time()
                frame_found = True
                break
        
        if frame_found:
            self._save_data()
        
        return {
            "prompt_cn": result.get("prompt_cn"),
            "prompt_en": result.get("prompt_en"),
            "frame_updated": frame_found
        }

    def generate_storyboard(self, script_id: str) -> Script:
        """Step 3: Generate storyboard images (Initial/Batch)."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
            
        script = self.storyboard_generator.generate_storyboard(script)
        self._save_data()
        return script

    def update_frame(self, script_id: str, frame_id: str, **kwargs) -> Script:
        """Update frame data (prompt, scene_id, character_ids, etc.)."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        frame = next((f for f in script.frames if f.id == frame_id), None)
        if not frame:
            raise ValueError(f"Frame {frame_id} not found")
        
        # Update only provided fields
        if kwargs.get('image_prompt') is not None:
            frame.image_prompt = kwargs['image_prompt']
        if kwargs.get('action_description') is not None:
            frame.action_description = kwargs['action_description']
        if kwargs.get('dialogue') is not None:
            frame.dialogue = kwargs['dialogue']
        if kwargs.get('camera_angle') is not None:
            frame.camera_angle = kwargs['camera_angle']
        if kwargs.get('scene_id') is not None:
            frame.scene_id = kwargs['scene_id']
        if kwargs.get('character_ids') is not None:
            frame.character_ids = kwargs['character_ids']
        if kwargs.get('duration') is not None:
            frame.duration = kwargs['duration']
        if kwargs.get('shot_size') is not None:
            frame.shot_size = kwargs['shot_size']
        if kwargs.get('camera_movement_description') is not None:
            if frame.camera_movement_structured:
                frame.camera_movement_structured.description = kwargs['camera_movement_description']
                frame.camera_movement_structured.primary = kwargs['camera_movement_description']
            else:
                from .models import CameraMovementData
                frame.camera_movement_structured = CameraMovementData(
                    primary=kwargs['camera_movement_description'],
                    speed="normal",
                    description=kwargs['camera_movement_description'],
                )
        if kwargs.get('transition_hint') is not None:
            frame.transition_hint = kwargs['transition_hint']
        
        self._save_data()
        return script

    def add_frame(self, script_id: str, scene_id: str = None, action_description: str = "", camera_angle: str = "medium_shot", insert_at: int = None) -> Script:
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        new_frame = StoryboardFrame(
            id=f"frame_{uuid.uuid4().hex[:8]}",
            scene_id=scene_id or (script.scenes[0].id if script.scenes else ""),
            character_ids=[],
            action_description=action_description,
            camera_angle=camera_angle
        )
        
        if insert_at is not None and 0 <= insert_at <= len(script.frames):
            script.frames.insert(insert_at, new_frame)
        else:
            script.frames.append(new_frame)
            
        self._save_data()
        return script

    def copy_frame(self, script_id: str, frame_id: str, insert_at: int = None) -> Script:
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
            
        original_frame = next((f for f in script.frames if f.id == frame_id), None)
        if not original_frame:
            raise ValueError(f"Frame {frame_id} not found")
            
        # Create a deep copy with new ID
        new_frame = original_frame.copy()
        new_frame.id = f"frame_{uuid.uuid4().hex[:8]}"
        new_frame.updated_at = time.time()
        # Reset generation status and URLs for the copy? 
        # Usually copy implies copying content, but maybe we want to keep the image?
        # Let's keep the image/content but reset status if it was processing?
        # Actually, if we copy, we probably want the same image reference initially.
        # But we should reset the "locked" status maybe?
        new_frame.locked = False
        
        if insert_at is not None and 0 <= insert_at <= len(script.frames):
            script.frames.insert(insert_at, new_frame)
        else:
            # Insert after the original frame by default
            try:
                original_index = script.frames.index(original_frame)
                script.frames.insert(original_index + 1, new_frame)
            except ValueError:
                script.frames.append(new_frame)
                
        self._save_data()
        return script

    def delete_frame(self, script_id: str, frame_id: str) -> Script:
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        script.frames = [f for f in script.frames if f.id != frame_id]
        self._save_data()
        return script

    def reorder_frames(self, script_id: str, frame_ids: List[str]) -> Script:
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        frame_map = {f.id: f for f in script.frames}
        new_frames = []
        for fid in frame_ids:
            if fid in frame_map:
                new_frames.append(frame_map[fid])
        
        script.frames = new_frames
        self._save_data()
        return script

    def generate_motion_ref(
        self,
        script_id: str,
        asset_id: str,
        asset_type: str,  # 'full_body' | 'head_shot' for characters; 'scene' | 'prop' for scenes and props
        prompt: Optional[str] = None,
        audio_url: Optional[str] = None,
        duration: int = 5,
        batch_size: int = 1
    ) -> Script:
        """Generate Motion Reference video for an asset (Character Full Body/Headshot, Scene, or Prop).

        Args:
            script_id: ID of the project/script
            asset_id: ID of the asset (character, scene, or prop)
            asset_type: 'full_body' | 'head_shot' for characters; 'scene' or 'prop' for scenes and props
            prompt: Custom prompt for motion generation
            audio_url: URL of driving audio for lip-sync
            duration: Video duration in seconds (5 or 10)
            batch_size: Number of videos to generate
        """
        from .models import VideoVariant, AssetUnit, VideoTask

        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        # Find the target asset based on type
        target_asset = None
        asset_display_name = ""

        if asset_type in ["full_body", "head_shot"]:
            # Find the character
            target_asset = next((c for c in script.characters if c.id == asset_id), None)
            asset_display_name = "Character"
        elif asset_type == "scene":
            # Find the scene
            target_asset = next((s for s in script.scenes if s.id == asset_id), None)
            asset_display_name = "Scene"
        elif asset_type == "prop":
            # Find the prop
            target_asset = next((p for p in script.props if p.id == asset_id), None)
            asset_display_name = "Prop"
        else:
            raise ValueError(f"Invalid asset_type: {asset_type}. Must be 'full_body', 'head_shot', 'scene', or 'prop'")

        if not target_asset:
            raise ValueError(f"{asset_display_name} {asset_id} not found")

        # Get the appropriate AssetUnit or image URL based on the asset type
        asset_unit = None  # For characters with AssetUnit
        generated_videos = []  # Store generated videos

        if asset_type in ["full_body", "head_shot"]:
            # Handle character asset
            asset_unit = getattr(target_asset, asset_type, None)
            # Get source image from the AssetUnit or legacy field
            if asset_unit and asset_unit.selected_image_id:
                source_img = next(
                    (v for v in asset_unit.image_variants if v.id == asset_unit.selected_image_id),
                    None
                )
                source_image_url = source_img.url if source_img else (
                    target_asset.full_body_image_url if asset_type == "full_body" else target_asset.headshot_image_url
                )
            else:
                source_image_url = (
                    target_asset.full_body_image_url if asset_type == "full_body"
                    else target_asset.headshot_image_url
                )

            # Default prompt for character
            if not prompt:
                if audio_url:
                    prompt = f"{asset_type.replace('_', ' ').title()} character reference video. {target_asset.description}. The character is speaking naturally matching the audio, with accurate lip-sync and facial expressions. Stable camera, high quality, 4k."
                else:
                    prompt = f"{asset_type.replace('_', ' ').title()} character reference video. {target_asset.description}. Looking around, breathing, slight movement, subtle gestures. Stable camera, high quality, 4k."
        else:
            # Handle scene or prop assets
            source_image_url = target_asset.image_url
            # Default prompt for scene and prop
            if not prompt:
                if asset_type == "scene":
                    if audio_url:
                        prompt = f"Cinematic scene video reference of {target_asset.name}. {target_asset.description}. Ambient motion, lighting changes, natural elements moving, birds, clouds. Soundscape matching the audio. High quality, 4k."
                    else:
                        prompt = f"Cinematic scene video reference of {target_asset.name}. {target_asset.description}. Ambient motion, lighting changes, natural elements moving, birds, clouds. Slow pan across the scene. High quality, 4k."
                else:  # prop
                    if audio_url:
                        prompt = f"Cinematic prop video reference of {target_asset.name}. {target_asset.description}. Rotating object, detailed textures visible, ambient motion, subtle movements matching audio. High quality, 4k."
                    else:
                        prompt = f"Cinematic prop video reference of {target_asset.name}. {target_asset.description}. Rotating object, detailed textures visible, ambient motion, subtle movements. High quality, 4k."

        # Check if source image exists
        if not source_image_url:
            raise ValueError(f"No source image available for {asset_type}. Please generate a static image first.")

        # Generate videos based on the asset type
        for i in range(batch_size):
            try:
                # Call video generator (I2V)
                video_result = self.video_generator.generate_i2v(
                    image_url=source_image_url,
                    prompt=prompt,
                    duration=duration,
                    audio_url=audio_url
                )

                if video_result and video_result.get("video_url"):
                    if asset_type in ["full_body", "head_shot"]:
                        # For characters, create VideoVariant in AssetUnit
                        video_variant = VideoVariant(
                            id=f"video_{uuid.uuid4().hex[:8]}",
                            url=video_result["video_url"],
                            prompt_used=prompt,
                            audio_url=audio_url,
                            source_image_id=None  # Don't set this to avoid complications
                        )
                        asset_unit.video_variants.append(video_variant)

                        # Auto-select the first generated video
                        if not asset_unit.selected_video_id:
                            asset_unit.selected_video_id = video_variant.id

                        generated_videos.append(video_variant)
                        logger.info(f"Generated motion ref video: {video_variant.id}")
                    else:
                        # For scenes and props, create VideoTask and add to asset's video_assets
                        video_task = VideoTask(
                            id=f"video_{uuid.uuid4().hex[:8]}",
                            project_id=script_id,
                            asset_id=asset_id,
                            image_url=source_image_url,
                            prompt=prompt,
                            status="completed",  # Since generation is done in this step
                            video_url=video_result["video_url"],
                            duration=duration,
                            created_at=time.time(),
                            generate_audio=bool(audio_url),
                            model="wan2.6-i2v",
                            generation_mode="i2v"  # Image to video (motion reference)
                        )

                        # Add to the asset's video_assets
                        target_asset.video_assets.append(video_task)
                        generated_videos.append(video_task)
                        logger.info(f"Generated motion ref video for {asset_type}: {video_task.id}")
            except Exception as e:
                logger.error(f"Failed to generate motion ref video for {asset_type}: {e}")

        # For character assets, update the AssetUnit
        if asset_type in ["full_body", "head_shot"]:
            # Ensure AssetUnit exists
            if asset_unit is None:
                asset_unit = AssetUnit()
                setattr(target_asset, asset_type, asset_unit)

            asset_unit.video_prompt = prompt
            asset_unit.video_updated_at = time.time()
        # For scene and prop assets, the video tasks are already added in the generation loop above

        if batch_size > 0 and not generated_videos:
            raise RuntimeError(f"Failed to generate any motion reference videos for {asset_type}")

        self._save_data()
        return script

    def generate_storyboard_render(self, script_id: str, frame_id: str, composition_data: Optional[Dict[str, Any]], prompt: str, batch_size: int = 1) -> Script:
        """Step 3b: Render a specific frame from composition data."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
            
        frame = next((f for f in script.frames if f.id == frame_id), None)
        if not frame:
            raise ValueError(f"Frame {frame_id} not found")
            
        frame.status = GenerationStatus.PROCESSING
        if composition_data:
            frame.composition_data = composition_data
        frame.image_prompt = prompt
        self._save_data()
        
        try:
            # Extract reference image URL from composition data if available
            ref_image_url = None
            ref_image_urls = []
            
            if composition_data:
                ref_image_url = composition_data.get('reference_image_url')
                ref_image_urls = composition_data.get('reference_image_urls', [])
            
            ref_image_paths = []
            
            # Resolve multiple paths
            for url in ref_image_urls:
                if not url:
                    continue
                if is_object_key(url) or url.startswith("http"):
                    ref_image_paths.append(url)
                else:
                    potential_path = _safe_resolve_path("output", url)
                    if os.path.exists(potential_path):
                        ref_image_paths.append(potential_path)
            
            # Also handle single path if provided (legacy support)
            if ref_image_url and ref_image_url not in ref_image_urls:
                if is_object_key(ref_image_url) or ref_image_url.startswith("http"):
                    if ref_image_url not in ref_image_paths:
                        ref_image_paths.append(ref_image_url)
                else:
                    potential_path = _safe_resolve_path("output", ref_image_url)
                    if os.path.exists(potential_path):
                        if potential_path not in ref_image_paths:
                            ref_image_paths.append(potential_path)
            
            # Use the first path as ref_image_path for legacy generator support if needed
            ref_image_path = ref_image_paths[0] if ref_image_paths else None
            
            # Use the prompt as-is from frontend (already contains style)
            final_prompt = prompt
            
            # Update frame with final prompt
            frame.image_prompt = final_prompt
            
            # Find scene for this frame
            scene = next((s for s in script.scenes if s.id == frame.scene_id), None)

            # Get effective size from storyboard_aspect_ratio
            from .assets import ASPECT_RATIO_TO_SIZE
            storyboard_aspect_ratio = script.model_settings.storyboard_aspect_ratio
            effective_size = ASPECT_RATIO_TO_SIZE.get(storyboard_aspect_ratio, "1024*576")  # Default to landscape
            
            # Use model from settings
            i2i_model = script.model_settings.i2i_model
            logger.info(f"Rendering frame {frame_id} using model {i2i_model} with {len(ref_image_paths)} reference images")
            if len(ref_image_urls) > 0:
                logger.debug(f"Original reference URLs from frontend: {ref_image_urls}")

            # Call generator
            self.storyboard_generator.generate_frame(
                frame, 
                script.characters, 
                scene, 
                ref_image_path=ref_image_path,
                ref_image_paths=ref_image_paths,
                prompt=final_prompt,
                batch_size=batch_size,
                size=effective_size,
                model_name=i2i_model
            )
            if frame.status == GenerationStatus.COMPLETED:
                selected_url = frame.rendered_image_url or frame.image_url
                if selected_url:
                    self._append_frame_t2i_url(frame, selected_url)
            script.updated_at = time.time()
            
            self._save_data()
            return script
        except Exception as e:
            frame.status = GenerationStatus.FAILED
            script.updated_at = time.time()
            self._save_data()
            raise e
            # 1. Take the composition_data (positions of assets)
            # 2. Construct a composite image (ControlNet input)
            # 3. Call Img2Img with the composite + prompt

    def render_batch_generator(self, script_id: str):
        """Batch-generate storyboard still images for frames missing T2I output."""
        from concurrent.futures import ThreadPoolExecutor, as_completed

        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        with self._render_batch_lock:
            existing = self._render_batch_status.get(script_id)
            if existing and existing.get("running"):
                raise RuntimeError("Batch storyboard render is already running for this project")

        pending_frames = [
            (idx, frame)
            for idx, frame in enumerate(script.frames)
            if not self._frame_has_t2i_image(frame)
        ]
        total = len(pending_frames)
        if total == 0:
            yield ("batch_complete", {
                "total": 0,
                "success": 0,
                "failed": 0,
                "skipped": len(script.frames),
            })
            return

        with self._render_batch_lock:
            self._render_batch_status[script_id] = {
                "running": True,
                "total": total,
                "completed": 0,
                "success": 0,
                "failed": 0,
                "skipped": len(script.frames) - total,
                "remaining": total,
                "started_at": time.time(),
                "updated_at": time.time(),
            }

        success = 0
        failed = 0
        max_workers = min(2, total)

        def _render_prompt(frame: "StoryboardFrame") -> str:
            return (
                frame.assembled_prompt
                or frame.visual_description
                or frame.image_prompt
                or frame.action_description
                or ""
            ).strip()

        def _render_one(entry):
            idx, frame = entry
            try:
                prompt = _render_prompt(frame)
                if not prompt:
                    raise ValueError("Frame has no prompt for storyboard render")
                self.generate_storyboard_render(script_id, frame.id, None, prompt, 1)
                if not self._frame_has_t2i_image(frame):
                    raise RuntimeError("Storyboard render finished without an image")
                return ("ok", idx, frame.id)
            except Exception as exc:
                logger.error(f"[render_batch] frame={frame.id} error={exc}")
                frame.status = GenerationStatus.FAILED
                frame.updated_at = time.time()
                self._save_data(script_id)
                return ("err", idx, frame.id, str(exc))

        try:
            with ThreadPoolExecutor(max_workers=max_workers) as pool:
                futures = {
                    pool.submit(_render_one, (idx, frame)): (idx, frame)
                    for idx, frame in pending_frames
                }
                for future in as_completed(futures):
                    result = future.result()
                    completed = success + failed + 1
                    if result[0] == "ok":
                        _, idx, fid = result
                        success += 1
                        event_type = "frame_render_complete"
                        event_payload = {
                            "frame_id": fid,
                            "frame_index": idx,
                            "total": total,
                            "success": success,
                            "failed": failed,
                            "completed": completed,
                        }
                    else:
                        _, idx, fid, err = result
                        failed += 1
                        event_type = "frame_render_error"
                        event_payload = {
                            "frame_id": fid,
                            "frame_index": idx,
                            "total": total,
                            "error": err,
                            "success": success,
                            "failed": failed,
                            "completed": completed,
                        }

                    with self._render_batch_lock:
                        status = self._render_batch_status.setdefault(script_id, {})
                        status.update({
                            "running": True,
                            "total": total,
                            "completed": completed,
                            "success": success,
                            "failed": failed,
                            "skipped": len(script.frames) - total,
                            "remaining": max(0, total - completed),
                            "updated_at": time.time(),
                        })
                    self._save_data(script_id)
                    yield (event_type, event_payload)

            self._save_data(script_id)
            with self._render_batch_lock:
                self._render_batch_status[script_id] = {
                    "running": False,
                    "total": total,
                    "completed": success + failed,
                    "success": success,
                    "failed": failed,
                    "skipped": len(script.frames) - total,
                    "remaining": 0,
                    "updated_at": time.time(),
                }
            yield ("batch_complete", {
                "total": total,
                "success": success,
                "failed": failed,
                "skipped": len(script.frames) - total,
            })
        finally:
            with self._render_batch_lock:
                status = self._render_batch_status.get(script_id)
                if status and status.get("running"):
                    status.update({
                        "running": False,
                        "completed": success + failed,
                        "success": success,
                        "failed": failed,
                        "remaining": max(0, total - success - failed),
                        "updated_at": time.time(),
                    })

    def generate_video(self, script_id: str) -> Script:
        """Step 4: Generate video clips."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
            
        script = self.video_generator.generate_video(script)
        self._save_data()
        return script

    def create_video_task(self, script_id: str, image_url: str, prompt: str, duration: int = 5, seed: int = None, resolution: str = "720p", generate_audio: bool = False, audio_url: str = None, prompt_extend: bool = True, negative_prompt: str = None, model: str = "wan2.7-i2v", frame_id: str = None, shot_type: str = "single", generation_mode: str = "i2v", reference_video_urls: list = None, reference_image_urls: list = None, ratio: str = None, watermark: Optional[bool] = None, mode: str = None, sound: str = None, cfg_scale: float = None, vidu_audio: bool = None, movement_amplitude: str = None, workbench_tab: Optional[str] = None) -> Tuple[Script, str]:
        """Creates a new video generation task."""
        script = self.get_script(script_id)
        if not script:
            raise ValueError("Script not found")
        
        task_id = str(uuid.uuid4())
        
        # If R2V mode is selected, use the appropriate R2V model.
        # When VIDEO_PROVIDER=openai, skip the override — the OpenAI
        # adapter uses env VIDEO_MODEL and the provider-agnostic model
        # mapping doesn't apply.
        video_provider = os.environ.get("VIDEO_PROVIDER", "dashscope").lower()
        if generation_mode == "r2v" and video_provider != "openai":
            if model and model.startswith("happyhorse-"):
                model = "happyhorse-1.0-r2v"
            elif model and model.startswith("wan2.7-"):
                model = "wan2.7-r2v"
            elif model and model.startswith("kling"):
                model = "kling-v3-r2v"
            elif model and model.startswith("pixverse"):
                model = "pixverse-c1-r2v"
            elif model and model.startswith("vidu"):
                model = "viduq3-pro-r2v"
            elif model and model.startswith("seedance-"):
                model = "seedance-2.0-r2v"
            else:
                model = "wan2.7-r2v"

        # Defensive guard against model⇄mode⇄refs mismatch. Every R2V
        # model needs reference inputs; without them the underlying
        # provider call raises mid-generation, the BG task crashes,
        # and the user sees nothing but a spinner. Catch the
        # inconsistency at task-creation time so the frontend gets a
        # clean 400 instead of a permanently-failed task.
        #
        # Originally we only checked wan2.7-r2v / wan2.6-r2v (the
        # first reported case). Production added happyhorse-1.0-r2v,
        # kling-v3-r2v, pixverse-c1-r2v, pixverse-v5.6-r2v,
        # viduq3-pro-r2v, viduq3-turbo-r2v — all need refs too. We
        # now match on the "-r2v" suffix so new R2V families inherit
        # the check automatically. Only wan2.6-r2v (legacy) takes
        # video refs; everything else takes image refs.
        is_r2v_model = isinstance(model, str) and model.endswith("-r2v")
        if is_r2v_model:
            needs_video_refs = model == "wan2.6-r2v"
            refs = (
                (reference_video_urls or []) if needs_video_refs
                else (reference_image_urls or [])
            )
            if not refs:
                kind = "video" if needs_video_refs else "image"
                raise ValueError(
                    f"Model '{model}' is reference-to-video and requires {kind} references, "
                    f"but none were provided. Attach reference {kind}s (use @ in the prompt "
                    "to reference characters / scenes / props) or switch to an I2V model "
                    "(e.g. wan2.7-i2v)."
                )

        # Snapshot the input image to ensure consistency
        snapshot_url = image_url
        try:
            # Resolve source path
            if image_url and not image_url.startswith("http"):
                # Assume relative to output dir
                src_path = _safe_resolve_path("output", image_url)
                if os.path.exists(src_path) and os.path.isfile(src_path):
                    # Create snapshot dir
                    snapshot_dir = os.path.join("output", "video_inputs")
                    os.makedirs(snapshot_dir, exist_ok=True)

                    # Define snapshot path
                    ext = os.path.splitext(os.path.basename(image_url))[1] or ".png"
                    _validate_safe_id(task_id, "task_id")
                    snapshot_filename = f"{task_id}{ext}"
                    snapshot_path = _safe_resolve_path(snapshot_dir, snapshot_filename)
                    
                    # Copy file
                    import shutil
                    shutil.copy2(src_path, snapshot_path)
                    
                    # Update URL to relative path
                    snapshot_url = f"video_inputs/{snapshot_filename}"
        except Exception as e:
            logger.error(f"Failed to snapshot input image: {e}")
            # Fallback to original URL

        # Enrich prompt with dialogue cue when a frame has dialogue text.
        # This gives the video model explicit mouth-movement instructions.
        if frame_id and prompt:
            frame = next((f for f in script.frames if f.id == frame_id), None)
            if frame:
                from .prompt_assembly import enrich_prompt_with_dialogue
                prompt = enrich_prompt_with_dialogue(prompt, frame)

        prompt = self._ensure_video_no_bgm_prompt(prompt)
        negative_prompt = self._ensure_video_no_bgm_negative_prompt(negative_prompt)

        task = VideoTask(
            id=task_id,
            project_id=script_id,
            frame_id=frame_id,
            image_url=snapshot_url,
            prompt=prompt,
            status="pending",
            duration=duration,
            seed=seed,
            resolution=resolution,
            generate_audio=generate_audio,
            audio_url=audio_url,
            prompt_extend=prompt_extend,
            negative_prompt=negative_prompt,
            model=model,
            shot_type=shot_type,
            generation_mode=generation_mode,
            reference_video_urls=reference_video_urls or [],
            reference_image_urls=reference_image_urls or [],
            ratio=ratio,
            watermark=watermark,
            mode=mode,
            sound=sound,
            cfg_scale=cfg_scale,
            vidu_audio=vidu_audio,
            movement_amplitude=movement_amplitude,
            workbench_tab=workbench_tab,
            created_at=time.time()
        )

        if not script.video_tasks:
            script.video_tasks = []
        script.video_tasks.append(task)

        self._save_data()
        return script, task_id

    def extract_last_frame(self, script_id: str, frame_id: str, video_task_id: str) -> Script:
        """Extract the last frame from a video task and add it as a variant of the frame's rendered_image_asset."""
        from .models import ImageVariant, ImageAsset

        script = self.get_script(script_id)
        if not script:
            raise ValueError("Script not found")

        frame = next((f for f in script.frames if f.id == frame_id), None)
        if not frame:
            raise ValueError("Frame not found")

        # Find the video task
        video_task = next((t for t in script.video_tasks if t.id == video_task_id), None)
        if not video_task or video_task.status != "completed" or not video_task.video_url:
            raise ValueError("Video task not found or not completed")

        # Resolve video path
        video_path = video_task.video_url
        if not video_path.startswith("/") and not video_path.startswith("http"):
            video_path = _safe_resolve_path("output", video_path)

        if video_path.startswith("http"):
            # Download to temp file first
            video_path = self._download_temp_image(video_path)

        if not os.path.exists(video_path):
            raise ValueError(f"Video file not found: {video_path}")

        # Extract last frame using FFmpeg
        ffmpeg_path = get_ffmpeg_path()
        if not ffmpeg_path:
            raise RuntimeError("FFmpeg is required for frame extraction but was not found.")

        output_dir = os.path.join("output", "storyboard")
        os.makedirs(output_dir, exist_ok=True)
        _validate_safe_id(frame_id, "frame_id")
        output_filename = f"frame_{frame_id}_lastframe_{uuid.uuid4().hex[:8]}.jpg"
        output_path = _safe_resolve_path(output_dir, output_filename)

        cmd = [
            ffmpeg_path, "-sseof", "-0.1",
            "-i", video_path,
            "-frames:v", "1",
            "-q:v", "2",
            "-y", output_path
        ]

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            if result.returncode != 0:
                raise RuntimeError(f"FFmpeg error: {result.stderr}")
        except subprocess.TimeoutExpired:
            raise RuntimeError("FFmpeg frame extraction timed out")

        if not os.path.exists(output_path):
            raise RuntimeError("Failed to extract last frame from video")

        # Upload to OSS if configured
        from ...utils.oss_utils import OSSImageUploader
        uploader = OSSImageUploader()
        oss_url = uploader.upload_image(output_path)
        image_url = oss_url if oss_url else os.path.relpath(output_path, "output")

        # Create new variant
        variant = ImageVariant(
            id=str(uuid.uuid4()),
            url=image_url,
            prompt_used="Extracted last frame from video",
            is_uploaded_source=True,
            upload_type="image",
        )

        # Initialize rendered_image_asset if needed
        if not frame.rendered_image_asset:
            frame.rendered_image_asset = ImageAsset()

        frame.rendered_image_asset.variants.append(variant)
        frame.rendered_image_asset.selected_id = variant.id
        # Also update rendered_image_url so VideoCreator can pick it up
        frame.rendered_image_url = image_url

        script.updated_at = time.time()
        self._save_data()
        return script

    def upload_frame_image(self, script_id: str, frame_id: str, image_path: str) -> Script:
        """Upload an image as a variant of the frame's rendered_image_asset."""
        from .models import ImageVariant, ImageAsset

        # Validate that image_path is inside the output directory
        safe_path = _safe_resolve_path("output", os.path.relpath(image_path, "output") if os.path.isabs(image_path) else image_path)

        script = self.get_script(script_id)
        if not script:
            raise ValueError("Script not found")

        frame = next((f for f in script.frames if f.id == frame_id), None)
        if not frame:
            raise ValueError("Frame not found")

        # Upload to OSS if configured
        from ...utils.oss_utils import OSSImageUploader
        uploader = OSSImageUploader()
        oss_url = uploader.upload_image(safe_path)
        image_url = oss_url if oss_url else os.path.relpath(safe_path, "output")

        # Create new variant
        variant = ImageVariant(
            id=str(uuid.uuid4()),
            url=image_url,
            prompt_used="User uploaded image",
            is_uploaded_source=True,
            upload_type="image",
        )

        if not frame.rendered_image_asset:
            frame.rendered_image_asset = ImageAsset()

        frame.rendered_image_asset.variants.append(variant)
        frame.rendered_image_asset.selected_id = variant.id
        # Also update rendered_image_url so VideoCreator can pick it up
        frame.rendered_image_url = image_url

        script.updated_at = time.time()
        self._save_data()
        return script

    def _download_temp_image(self, url: str) -> str:
        """Downloads an image to a temporary file."""
        import requests
        import tempfile
        
        # If it's a local file path (relative to output)
        if not url.startswith("http"):
            local_path = _safe_resolve_path("output", url)
            if os.path.exists(local_path):
                return local_path
                
        # Download from URL
        try:
            response = requests.get(url, stream=True)
            response.raise_for_status()
            
            # Create temp file
            fd, path = tempfile.mkstemp(suffix=".png")
            with os.fdopen(fd, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)
            return path
        except Exception as e:
            logger.error(f"Failed to download image: {e}")
            raise
    def select_video_for_frame(self, script_id: str, frame_id: str, video_id: str) -> Script:
        """Step 5a: Select a video variant for a frame."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
            
        frame = next((f for f in script.frames if f.id == frame_id), None)
        if not frame:
            raise ValueError("Frame not found")
            
        # Verify video exists and belongs to project
        video = next((v for v in script.video_tasks if v.id == video_id), None)
        if not video:
            raise ValueError("Video task not found")
            
        frame.selected_video_id = video_id
        
        # Also update the frame's video_url to point to this video for easy access
        frame.video_url = video.video_url
        
        self._save_data()
        return script

    def _resolve_media_path(self, url: str, suffix: str = "") -> Optional[str]:
        """Resolve a media URL to a local file path.

        Handles three cases:
        1. Local relative path (e.g. 'video/xxx.mp4') → resolve under output/
        2. OSS object key (e.g. 'lumenx/videos/xxx.mp4') → sign URL then download
        3. Full HTTP URL → download directly
        """
        if not url:
            return None

        # Case 1: Try as local path first
        if not url.startswith("http"):
            local_path = _safe_resolve_path("output", url)
            if os.path.exists(local_path):
                return local_path
            # Not found locally — might be an OSS object key
            if is_object_key(url):
                from ...utils.oss_utils import OSSImageUploader
                uploader = OSSImageUploader()
                if uploader.is_configured:
                    url = uploader.sign_url_for_api(url)
                else:
                    logger.error(f"[DUB] File not local and OSS not configured: {url}")
                    return None
            else:
                return None

        # Case 2 & 3: Download from HTTP URL
        import hashlib
        url_hash = hashlib.md5(url.split("?")[0].encode()).hexdigest()[:12]
        cache_dir = os.path.join("output", "cache")
        os.makedirs(cache_dir, exist_ok=True)
        cached = os.path.join(cache_dir, f"{url_hash}{suffix}")
        if os.path.exists(cached) and os.path.getsize(cached) > 0:
            return cached
        try:
            import requests
            resp = requests.get(url, stream=True, timeout=60)
            resp.raise_for_status()
            with open(cached, "wb") as f:
                for chunk in resp.iter_content(chunk_size=65536):
                    f.write(chunk)
            logger.info(f"[DUB] Downloaded remote media -> {cached}")
            return cached
        except Exception as e:
            logger.error(f"[DUB] Failed to download media: {e}")
            if os.path.exists(cached):
                os.remove(cached)
            return None

    def _warmup_demucs_model(self):
        """Pre-download htdemucs model at startup so first dub request is fast."""
        try:
            from demucs.pretrained import get_model
            get_model("htdemucs")
            logger.info("[DUB] Demucs htdemucs model ready")
            self._demucs_ready.set()
        except Exception as e:
            self._demucs_error = str(e)
            self._demucs_ready.set()
            logger.warning(f"[DUB] Demucs model warmup failed: {e}")

    def _separate_background_audio(self, video_path: str, work_dir: str) -> Optional[str]:
        """Extract audio from video and separate background (no_vocals) using Demucs.

        Returns the path to the background audio WAV file, or None if
        separation fails (caller falls back to simple replacement).
        """
        ffmpeg_path = get_ffmpeg_path()
        extracted_audio = os.path.join(work_dir, "original_audio.wav")

        # Step 1: Extract audio from video
        extract_cmd = [
            ffmpeg_path, "-y",
            "-i", video_path,
            "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2",
            extracted_audio,
        ]
        try:
            result = subprocess.run(extract_cmd, capture_output=True, timeout=30)
            if result.returncode != 0 or not os.path.exists(extracted_audio):
                logger.warning("[DUB] No audio track in source video, skipping separation")
                return None
        except Exception as e:
            logger.warning(f"[DUB] Audio extraction failed: {e}")
            return None

        # Check if extracted audio has any content (some videos are silent)
        if os.path.getsize(extracted_audio) < 1000:
            logger.info("[DUB] Source video has negligible audio, skipping separation")
            return None

        # Step 2: Run Demucs separation (two-stems: vocals + no_vocals)
        # Wait for background model warmup to finish (avoids duplicate download)
        if not self._demucs_ready.wait(timeout=120):
            raise RuntimeError("Demucs 模型正在下载中（首次约需30秒），请稍后重试。")

        try:
            import demucs.separate
            demucs.separate.main([
                "--two-stems", "vocals",
                "-n", "htdemucs",
                "--out", work_dir,
                extracted_audio,
            ])
        except Exception as e:
            logger.warning(f"[DUB] Demucs separation failed: {e}, falling back to simple replacement")
            return None

        # Demucs outputs to: {work_dir}/htdemucs/original_audio/no_vocals.wav
        bg_path = os.path.join(work_dir, "htdemucs", "original_audio", "no_vocals.wav")
        if not os.path.exists(bg_path):
            # Try alternate path structures
            for root, dirs, files in os.walk(work_dir):
                if "no_vocals.wav" in files:
                    bg_path = os.path.join(root, "no_vocals.wav")
                    break

        if os.path.exists(bg_path):
            logger.info(f"[DUB] Background audio separated successfully: {bg_path}")
            return bg_path

        logger.warning("[DUB] Demucs output not found, falling back to simple replacement")
        return None

    def _ensure_bg_audio_cached(self, frame, video_path: str, video_url: str) -> Optional[str]:
        """Ensure background audio is separated and cached for this frame's video.

        Returns absolute path to bg audio WAV, or None if video has no audio.
        Caches result to output/audio/bg_{frame_id}.wav — only re-runs Demucs
        if video source changed.
        """
        if frame.bg_audio_url and frame.bg_audio_source_video == video_url:
            cached_path = _safe_resolve_path("output", frame.bg_audio_url)
            if os.path.exists(cached_path):
                logger.info(f"[DUB] Background audio cache hit: {frame.bg_audio_url}")
                return cached_path

        import tempfile
        import shutil
        work_dir = tempfile.mkdtemp(prefix="demucs_")
        try:
            bg_path = self._separate_background_audio(video_path, work_dir)
            if not bg_path:
                frame.bg_audio_url = None
                frame.bg_audio_source_video = video_url
                return None

            cache_filename = f"bg_{frame.id}.wav"
            cache_path = _safe_resolve_path(os.path.join("output", "audio"), cache_filename)
            os.makedirs(os.path.dirname(cache_path), exist_ok=True)
            shutil.copy2(bg_path, cache_path)

            frame.bg_audio_url = f"audio/{cache_filename}"
            frame.bg_audio_source_video = video_url
            logger.info(f"[DUB] Background audio cached: {cache_filename}")
            return cache_path
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

    def preview_dub(self, script_id: str, frame_id: str, video_task_id: str, offset_ms: int = 0) -> "Script":
        """Generate a preview dubbed video (Demucs cached + fast adelay+amix+mux).

        Replaces any existing preview_video_url (lazy cleanup).
        Does NOT touch dubbed_video_url.
        """
        _validate_safe_id(script_id, "script_id")
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        frame = next((f for f in script.frames if f.id == frame_id), None)
        if not frame:
            raise ValueError(f"Frame {frame_id} not found")

        if not frame.audio_url:
            raise ValueError("Frame has no TTS audio (audio_url). Generate dialogue audio first.")

        video_task = next((t for t in script.video_tasks if t.id == video_task_id), None)
        if not video_task or not video_task.video_url:
            raise ValueError(f"Video task {video_task_id} not found or has no video_url")

        ffmpeg_path = get_ffmpeg_path()
        if not ffmpeg_path:
            raise RuntimeError("FFmpeg is required for audio dubbing but was not found.")

        video_path = self._resolve_media_path(video_task.video_url, suffix=".mp4")
        tts_path = self._resolve_media_path(frame.audio_url, suffix=".mp3")

        if not video_path or not os.path.exists(video_path):
            raise ValueError(f"Video file not found: {video_task.video_url}")
        if not tts_path or not os.path.exists(tts_path):
            raise ValueError(f"Audio file not found: {frame.audio_url}")
        if os.path.getsize(tts_path) < 1000:
            raise ValueError("TTS audio file is invalid or empty. Please regenerate dialogue audio.")

        # Delete old preview (lazy cleanup)
        if frame.preview_video_url:
            old_preview = _safe_resolve_path("output", frame.preview_video_url)
            if os.path.exists(old_preview):
                try:
                    os.remove(old_preview)
                except OSError:
                    pass

        output_filename = f"preview_{frame_id}_{int(time.time())}.mp4"
        output_path = _safe_resolve_path(os.path.join("output", "video"), output_filename)
        os.makedirs(os.path.dirname(output_path), exist_ok=True)

        # Ensure background audio is cached (Demucs runs only on first call or video change)
        bg_audio_path = self._ensure_bg_audio_cached(frame, video_path, video_task.video_url)

        import tempfile
        work_dir = tempfile.mkdtemp(prefix="dub_mix_")
        try:
            if bg_audio_path:
                mixed_audio = os.path.join(work_dir, "mixed.wav")
                delay_str = f"{offset_ms}|{offset_ms}"

                mix_cmd = [
                    ffmpeg_path, "-y",
                    "-i", bg_audio_path,
                    "-i", tts_path,
                    "-filter_complex",
                    f"[1:a]adelay={delay_str}[tts];[0:a][tts]amix=inputs=2:duration=first:weights=1 1[out]",
                    "-map", "[out]",
                    "-ac", "2", "-ar", "44100",
                    mixed_audio,
                ]

                logger.info(f"[DUB] Mixing TTS with background (adelay={offset_ms}ms)")
                subprocess.run(mix_cmd, check=True, capture_output=True, timeout=60)

                if not os.path.exists(mixed_audio):
                    raise RuntimeError("Audio mixing failed: output file not created")

                mux_cmd = [
                    ffmpeg_path, "-y",
                    "-i", video_path,
                    "-i", mixed_audio,
                    "-map", "0:v",
                    "-map", "1:a",
                    "-c:v", "copy",
                    "-c:a", "aac", "-b:a", "192k",
                    "-movflags", "+faststart",
                    output_path,
                ]
                subprocess.run(mux_cmd, check=True, capture_output=True, timeout=60)
            else:
                delay_str = f"{offset_ms}|{offset_ms}"
                cmd = [
                    ffmpeg_path, "-y",
                    "-i", video_path,
                    "-i", tts_path,
                    "-filter_complex",
                    f"[1:a]adelay={delay_str}[tts];[tts]apad[out]",
                    "-map", "0:v",
                    "-map", "[out]",
                    "-c:v", "copy",
                    "-c:a", "aac", "-b:a", "192k",
                    "-movflags", "+faststart",
                    output_path,
                ]
                logger.info(f"[DUB] Simple replacement with adelay={offset_ms}ms")
                subprocess.run(cmd, check=True, capture_output=True, timeout=120)

        except subprocess.CalledProcessError as e:
            stderr_msg = e.stderr.decode() if e.stderr else "No error output"
            logger.error(f"[DUB] FFmpeg failed: {stderr_msg[:400]}")
            raise RuntimeError(f"Audio dubbing failed: {stderr_msg[:200]}")
        finally:
            import shutil
            shutil.rmtree(work_dir, ignore_errors=True)

        if not os.path.exists(output_path):
            raise RuntimeError("Preview video was not created")

        frame.preview_video_url = f"video/{output_filename}"
        frame.dubbed_video_task_id = video_task_id
        frame.dub_offset_ms = offset_ms
        self._save_data()

        logger.info(f"[DUB] Preview generated: {output_filename}")
        return script

    def apply_dub(self, script_id: str, frame_id: str) -> "Script":
        """Promote preview_video_url to dubbed_video_url."""
        _validate_safe_id(script_id, "script_id")
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        frame = next((f for f in script.frames if f.id == frame_id), None)
        if not frame:
            raise ValueError(f"Frame {frame_id} not found")

        if not frame.preview_video_url:
            raise ValueError("No preview to apply. Generate a preview first.")

        # Delete old dubbed file
        if frame.dubbed_video_url:
            old_path = _safe_resolve_path("output", frame.dubbed_video_url)
            if os.path.exists(old_path):
                try:
                    os.remove(old_path)
                except OSError:
                    pass

        frame.dubbed_video_url = frame.preview_video_url
        frame.preview_video_url = None
        self._save_data()

        logger.info(f"[DUB] Applied: {frame.dubbed_video_url}")
        return script

    def revert_dub(self, script_id: str, frame_id: str) -> "Script":
        """Revert dubbing — clear dubbed and preview, keep bg cache."""
        _validate_safe_id(script_id, "script_id")
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        frame = next((f for f in script.frames if f.id == frame_id), None)
        if not frame:
            raise ValueError(f"Frame {frame_id} not found")

        for url_field in ("dubbed_video_url", "preview_video_url"):
            url = getattr(frame, url_field)
            if url:
                path = _safe_resolve_path("output", url)
                if os.path.exists(path):
                    try:
                        os.remove(path)
                    except OSError:
                        pass
                setattr(frame, url_field, None)

        frame.dub_offset_ms = 0
        frame.dubbed_video_task_id = None
        self._save_data()
        return script

    def merge_videos(self, script_id: str) -> Script:
        """Step 5b: Merge selected videos into a single file."""
        _validate_safe_id(script_id, "script_id")
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        logger.info(f"[MERGE] Starting video merge for script {script_id}")
        
        # Check if ffmpeg is available (prioritize bundled version)
        ffmpeg_path = get_ffmpeg_path()
        if not ffmpeg_path:
            install_instructions = get_ffmpeg_install_instructions()
            error_msg = (
                "FFmpeg is required for video merging but was not found.\n\n"
                f"{install_instructions}\n\n"
                "After installation, restart the application."
            )
            logger.error(f"[MERGE] FFmpeg not found. {error_msg}")
            raise RuntimeError(error_msg)
        
        # Log ffmpeg version for debugging
        try:
            version_result = subprocess.run(
                [ffmpeg_path, "-version"],
                capture_output=True,
                text=True,
                timeout=5
            )
            if version_result.returncode == 0:
                version_line = version_result.stdout.split('\n')[0] if version_result.stdout else "Unknown"
                logger.debug(f"[MERGE] Using FFmpeg: {version_line}")
                logger.debug(f"[MERGE] FFmpeg path: {ffmpeg_path}")
            else:
                logger.warning(f"[MERGE] Could not get FFmpeg version (exit code {version_result.returncode})")
        except Exception as e:
            logger.warning(f"[MERGE] Could not get FFmpeg version: {e}")
            
        # Collect video paths
        video_paths = []
        for i, frame in enumerate(script.frames):
            logger.info(f"[MERGE] Processing frame {i+1}/{len(script.frames)}: {frame.id}")

            # Prefer dubbed version (TTS audio already overlaid with lip-sync offset)
            if frame.dubbed_video_url:
                dubbed_path = _safe_resolve_path("output", frame.dubbed_video_url)
                if os.path.exists(dubbed_path):
                    logger.debug(f"[MERGE]   -> Using dubbed video: {frame.dubbed_video_url}")
                    video_paths.append(frame.dubbed_video_url)
                    continue
                else:
                    logger.warning(f"[MERGE]   -> Dubbed video file missing: {dubbed_path}, falling back")

            if not frame.selected_video_id:
                # Try to find a default completed video
                default_video = next((v for v in script.video_tasks if v.frame_id == frame.id and v.status == "completed"), None)
                if default_video and default_video.video_url:
                    logger.debug(f"[MERGE]   -> Using default video: {default_video.video_url}")
                    video_paths.append(default_video.video_url)
                else:
                    logger.warning(f"[MERGE]   -> No video selected or available, skipping")
                continue
                
            video = next((v for v in script.video_tasks if v.id == frame.selected_video_id), None)
            if video and video.video_url:
                logger.debug(f"[MERGE]   -> Selected video: {video.video_url}")
                video_paths.append(video.video_url)
            else:
                logger.warning(f"[MERGE]   -> Selected video {frame.selected_video_id} not found or has no URL")
                
        if not video_paths:
            logger.error("[MERGE] No videos found to merge!")
            raise ValueError("No videos selected to merge. Please select videos for each frame first.")
        
        logger.info(f"[MERGE] Found {len(video_paths)} videos to merge")
            
        # Create file list for ffmpeg
        list_path = _safe_resolve_path("output", f"merge_list_{script_id}.txt")
        abs_video_paths = []

        with open(list_path, "w") as f:
            for path in video_paths:
                # Resolve to absolute path
                if not path.startswith("http"):
                    abs_path = _safe_resolve_path("output", path)
                    if os.path.exists(abs_path):
                        f.write(f"file '{abs_path}'\n")
                        abs_video_paths.append(abs_path)
                        logger.debug(f"[MERGE] Added to list: {abs_path}")
                    else:
                        logger.warning(f"[MERGE] Video file not found: {abs_path}")
                        
        if not abs_video_paths:
            logger.error("[MERGE] No valid video files found on disk!")
            raise ValueError("No valid video files found. The video files may have been deleted or moved.")
        
        logger.info(f"[MERGE] Merge list created with {len(abs_video_paths)} videos")

        # Output path
        output_filename = f"merged_{script_id}_{int(time.time())}.mp4"
        output_path = _safe_resolve_path(os.path.join("output", "video"), output_filename)
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        
        logger.debug(f"[MERGE] Output path: {output_path}")
        
        # Log video file details for debugging
        for i, path in enumerate(abs_video_paths):
            try:
                size_mb = os.path.getsize(path) / (1024 * 1024)
                logger.debug(f"[MERGE] Input video {i+1}: {os.path.basename(path)} ({size_mb:.2f} MB)")
            except Exception as e:
                logger.warning(f"[MERGE] Could not get size for video {i+1}: {e}")
        
        # Run ffmpeg
        # Use re-encoding for better compatibility (slower but more reliable)
        # -c:v libx264 -c:a aac ensures consistent output format
        cmd = [
            ffmpeg_path, "-y",  # Use the detected ffmpeg path
            "-f", "concat",
            "-safe", "0",
            "-i", list_path,
            "-c:v", "libx264",  # Re-encode video with H.264
            "-crf", "23",       # Quality (lower = better, 23 is default)
            "-preset", "fast",  # Encoding speed
            "-c:a", "aac",      # Re-encode audio with AAC
            "-b:a", "128k",     # Audio bitrate
            "-movflags", "+faststart",  # Web optimization
            output_path
        ]
        
        logger.debug(f"[MERGE] Running FFmpeg command: {' '.join(cmd)}")
        logger.debug(f"[MERGE] Platform: {platform.system()} {platform.release()}")
        
        try:
            result = subprocess.run(cmd, check=True, capture_output=True, timeout=600)  # 10 min timeout for re-encoding
            logger.debug(f"[MERGE] FFmpeg stdout: {result.stdout.decode()[:500] if result.stdout else 'empty'}")
            logger.info(f"[MERGE] FFmpeg completed successfully")
            
            # Update script with merged video path
            # Use 'videos/' (plural) to match the /files/videos route
            script.merged_video_url = f"videos/{output_filename}"

            # Verify file was created and log details
            if os.path.exists(output_path):
                file_size_mb = os.path.getsize(output_path) / (1024 * 1024)
                logger.info(f"[MERGE] ✅ Merged video created successfully: {output_filename} ({file_size_mb:.2f} MB)")
                logger.info(f"[MERGE] ✅ Video accessible at: /files/videos/{output_filename}")
            else:
                logger.error(f"[MERGE] ❌ Merged video file NOT found at: {output_path}")
                raise RuntimeError(f"Video merge completed but output file not found: {output_path}")

            # PR-3l · Pass 2: BGM mux. If script.bgm_url is set and the BGM
            # file exists, overlay it under the existing audio track at the
            # configured mix level. Dialogue stays on the original track of
            # the per-frame videos (sound-driven I2V already embedded it);
            # a future enhancement can swap to per-frame dialogue overlay.
            try:
                mixed_path = self._maybe_apply_bgm_mux(
                    script, output_path, ffmpeg_path,
                )
                if mixed_path:
                    # Replace the concat output with the mixed one (same filename)
                    os.replace(mixed_path, output_path)
                    logger.info(f"[MERGE] ✅ BGM mux applied — final file: {output_filename}")
            except Exception as bgm_err:
                # BGM is optional; log + carry on with the silent video
                logger.warning(f"[MERGE] BGM mux skipped due to error: {bgm_err}")

            self._save_data()

            # Cleanup list file
            if os.path.exists(list_path):
                os.remove(list_path)

            return script
        except subprocess.TimeoutExpired:
            logger.error("[MERGE] FFmpeg timed out after 600 seconds")
            raise RuntimeError("FFmpeg timed out. The videos may be too large.")
        except subprocess.CalledProcessError as e:
            stderr_msg = e.stderr.decode() if e.stderr else "No error output"
            stdout_msg = e.stdout.decode() if e.stdout else "No output"
            
            # Log full details for debugging
            logger.error(f"[MERGE] FFmpeg failed with exit code {e.returncode}")
            logger.error(f"[MERGE] FFmpeg command: {' '.join(cmd)}")
            logger.error(f"[MERGE] FFmpeg stderr: {stderr_msg}")
            logger.error(f"[MERGE] FFmpeg stdout: {stdout_msg}")
            logger.error(f"[MERGE] Video files attempted: {[os.path.basename(p) for p in abs_video_paths]}")
            
            # Extract user-friendly error message
            user_msg = self._extract_ffmpeg_error_message(stderr_msg, abs_video_paths)
            raise RuntimeError(user_msg)
    
    def _maybe_apply_bgm_mux(
        self,
        script: Script,
        video_path: str,
        ffmpeg_path: str,
    ) -> Optional[str]:
        """PR-3l · Overlay BGM at the configured mix level on top of the
        already-merged video. Returns the path of the new file, or None
        when no BGM is configured / the file is missing.

        Strategy: 2-input filter — amix the existing video audio (volume =
        dialogue_level/100) with the looped BGM (volume = bgm_level/100).
        SFX track will be added in a later pass when SFX files exist.
        """
        bgm_rel = (script.bgm_url or "").strip()
        if not bgm_rel:
            return None
        bgm_abs = _safe_resolve_path("output", bgm_rel)
        if not os.path.exists(bgm_abs):
            logger.info(f"[MERGE/BGM] preset file missing — {bgm_abs}; skipping mux")
            return None

        mix = script.mix_settings or {"dialogue": 100, "bgm": 35, "sfx": 60}
        dial = max(0, min(100, int(mix.get("dialogue", 100)))) / 100.0
        bgm_lvl = max(0, min(100, int(mix.get("bgm", 35)))) / 100.0

        mixed_path = video_path.replace(".mp4", "_mixed.mp4")
        # -stream_loop -1 loops BGM until shortest (the video) ends.
        # apad on the dialogue side avoids amix cutting early on silence.
        filter_complex = (
            f"[0:a]volume={dial:.3f},apad[a0];"
            f"[1:a]volume={bgm_lvl:.3f},aloop=loop=-1:size=2e9[a1];"
            f"[a0][a1]amix=inputs=2:duration=first:dropout_transition=0[aout]"
        )
        cmd = [
            ffmpeg_path, "-y",
            "-i", video_path,
            "-stream_loop", "-1", "-i", bgm_abs,
            "-filter_complex", filter_complex,
            "-map", "0:v", "-map", "[aout]",
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "192k",
            "-shortest",
            "-movflags", "+faststart",
            mixed_path,
        ]
        logger.info(f"[MERGE/BGM] muxing BGM dial={dial:.2f} bgm={bgm_lvl:.2f} — {os.path.basename(bgm_abs)}")
        try:
            subprocess.run(cmd, check=True, capture_output=True, timeout=300)
        except subprocess.CalledProcessError as e:
            stderr_msg = e.stderr.decode() if e.stderr else ""
            logger.warning(f"[MERGE/BGM] ffmpeg failed: {stderr_msg[:400]}")
            return None
        if not os.path.exists(mixed_path):
            logger.warning(f"[MERGE/BGM] mixed output not found: {mixed_path}")
            return None
        return mixed_path

    def _extract_ffmpeg_error_message(self, stderr: str, video_paths: List[str]) -> str:
        """
        Extract a user-friendly error message from ffmpeg stderr output.
        
        Args:
            stderr: The stderr output from ffmpeg
            video_paths: List of video file paths that were being processed
            
        Returns:
            A user-friendly error message
        """
        if not stderr:
            return "FFmpeg merge failed with no error output. Please check the log files."
        
        stderr_lower = stderr.lower()
        
        # Common error patterns with user-friendly messages
        if "no such file or directory" in stderr_lower:
            return (
                "One or more video files could not be found.\n"
                "The videos may have been deleted or moved.\n"
                "Please try regenerating the missing videos."
            )
        
        if "invalid data found" in stderr_lower or "invalid file" in stderr_lower or "moov atom not found" in stderr_lower:
            return (
                "One or more video files are corrupted or incomplete.\n"
                "This can happen if video generation was interrupted.\n"
                "Please try regenerating the affected videos."
            )
        
        if ("codec" in stderr_lower and ("not supported" in stderr_lower or "unknown" in stderr_lower)):
            return (
                "Video codec compatibility issue detected.\n"
                "The video format may not be supported by your FFmpeg installation.\n"
                "Try updating FFmpeg to the latest version."
            )
        
        if "permission denied" in stderr_lower or "access is denied" in stderr_lower:
            return (
                "Permission denied when accessing video files.\n"
                "Please check that the application has read/write permissions\n"
                "for the output directory."
            )
        
        if "disk full" in stderr_lower or "no space" in stderr_lower:
            return (
                "Insufficient disk space to create the merged video.\n"
                "Please free up some space and try again."
            )
        
        if "height not divisible" in stderr_lower or "width not divisible" in stderr_lower:
            return (
                "Video resolution compatibility issue.\n"
                "The videos have incompatible dimensions.\n"
                "This should not happen - please report this issue."
            )
        
        if "invalid argument" in stderr_lower:
            # Check if it's related to file list
            if any("filelist" in line.lower() or "concat" in line.lower() for line in stderr.split('\n')):
                return (
                    "FFmpeg could not read the video file list.\n"
                    "This might be a file path encoding issue.\n"
                    "Please ensure video filenames don't contain special characters."
                )
        
        # Fallback: extract the most relevant error line
        # Usually the last non-empty line before the final summary
        error_lines = [line.strip() for line in stderr.split('\n') if line.strip()]
        if error_lines:
            # Look for lines that seem like actual errors (contain "error", "failed", etc.)
            for line in reversed(error_lines):
                line_lower = line.lower()
                if any(keyword in line_lower for keyword in ['error', 'failed', 'invalid', 'cannot', 'unable']):
                    # Truncate if too long
                    if len(line) > 200:
                        line = line[:200] + "..."
                    return f"FFmpeg error: {line}\n\nPlease check the application logs for more details."
            
            # If no error keyword found, use last line
            last_line = error_lines[-1]
            if len(last_line) > 200:
                last_line = last_line[:200] + "..."
            return f"FFmpeg merge failed: {last_line}\n\nPlease check the application logs for more details."
        
        return "FFmpeg merge failed with unknown error. Please check the application logs for details."

    def process_video_task(self, script_id: str, task_id: str):
        """Processes a video task."""
        script = self.get_script(script_id)
        if not script:
            logger.error(f"Script {script_id} not found for task {task_id}")
            return
            
        task = next((t for t in script.video_tasks if t.id == task_id), None)
        
        if not task:
            logger.error(f"Task {task_id} not found in script {script_id}")
            return

        try:
            # Update status to processing
            task.status = "processing"
            self._apply_video_audio_policy(task)
            self._save_data()
            
            # Download image to temp file
            img_path = None
            if task.image_url:
                img_path = self._download_temp_image(task.image_url)
            
            # Generate video
            output_filename = f"video_{task_id}.mp4"
            output_path = os.path.join("output", "video", output_filename)
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            
            # Handle Audio Logic
            # 1. Silent: audio_url=None, audio=False
            # 2. AI Sound: audio_url=None, audio=True
            # 3. Sound Driven: audio_url=URL (audio param ignored)
            
            final_audio_url = None
            final_generate_audio = False
            
            if task.audio_url:
                # Sound Driven Mode
                final_audio_url = task.audio_url
                final_generate_audio = False # API says audio param ignored if url present, but let's be explicit
            elif task.generate_audio:
                # AI Sound Mode
                final_audio_url = None
                final_generate_audio = True
            else:
                # Silent Mode
                final_audio_url = None
                final_generate_audio = False

            # Ensure img_url is passed correctly for OSS
            img_url = task.image_url

            # Route to the appropriate model based on task.model
            model_name = task.model or ""
            model_name_lower = model_name.lower()
            backend = self._resolve_video_backend(model_name)
            use_vendor_kling = backend == "vendor" and (
                model_name_lower.startswith("kling-") or model_name_lower.startswith("kling/kling-")
            )
            use_vendor_vidu = backend == "vendor" and (
                model_name_lower.startswith("vidu")
                or model_name_lower.startswith("viduq2")
                or model_name_lower.startswith("viduq3")
                or model_name_lower.startswith("vidu/vidu")
            )

            if use_vendor_kling:
                # Use Kling model (cached)
                if self._kling_model is None:
                    from ...models.kling import KlingModel
                    self._kling_model = KlingModel({})
                video_path, _ = self._kling_model.generate(
                    prompt=task.prompt,
                    output_path=output_path,
                    img_url=img_url,
                    img_path=img_path,
                    duration=task.duration,
                    model=task.model,
                    negative_prompt=task.negative_prompt,
                    aspect_ratio=task.ratio or "16:9",
                    mode=task.mode or "std",
                    sound=task.sound or "off",
                    cfg_scale=task.cfg_scale,
                )
            elif use_vendor_vidu:
                # Use Vidu model (cached)
                if self._vidu_model is None:
                    from ...models.vidu import ViduModel
                    self._vidu_model = ViduModel({})
                video_path, _ = self._vidu_model.generate(
                    prompt=task.prompt,
                    output_path=output_path,
                    img_url=img_url,
                    img_path=img_path,
                    duration=task.duration,
                    model=task.model,
                    resolution=task.resolution,
                    aspect_ratio=task.ratio or "16:9",
                    seed=task.seed or 0,
                    audio=task.vidu_audio if task.vidu_audio is not None else False,
                    movement_amplitude=task.movement_amplitude or "auto",
                )
            else:
                # Check for OpenAI video provider first
                # Issue 17: persist provider IDs (Bailian / DashScope task_id +
                # request_id) onto our VideoTask the moment the model gets them.
                def _capture_provider_ids(provider_name: str, ptask_id: Optional[str], preq_id: Optional[str]) -> None:
                    task.provider_name = provider_name
                    task.provider_task_id = ptask_id
                    task.provider_request_id = preq_id
                    try:
                        self._save_data()
                    except Exception:
                        logger.warning("Failed to persist provider IDs mid-flight; will retry at task completion")
                video_model = self._get_video_model(task.model)
                video_path, _ = video_model.generate(
                    prompt=task.prompt,
                    output_path=output_path,
                    img_path=img_path,
                    img_url=img_url,
                    duration=task.duration,
                    seed=task.seed,
                    resolution=task.resolution,
                    # Pass new params
                    audio_url=final_audio_url,
                    audio=final_generate_audio,
                    prompt_extend=task.prompt_extend,
                    negative_prompt=task.negative_prompt,
                    model=task.model,
                    shot_type=task.shot_type,
                    ref_video_urls=task.reference_video_urls if task.generation_mode == "r2v" else None,
                    ref_image_urls=task.reference_image_urls if task.generation_mode == "r2v" else None,
                    ratio=task.ratio,
                    mode=task.mode,
                    # Pass watermark explicitly; wanx.generate's default is False so
                    # None becomes False, matching "leave to provider default = off".
                    watermark=bool(task.watermark) if task.watermark is not None else False,
                    audio_setting=task.audio_setting,
                    camera_motion=None,
                    subject_motion=None,
                    on_provider_ids=_capture_provider_ids,
                )
            
            # Models deliberately generate text-free footage. Composite exact
            # HUD/subtitle typography only after the provider has returned the
            # final clip so Pillow can draw at the ffprobe-reported dimensions.
            final_video_path = video_path or output_path
            if task.frame_id:
                frame = next((item for item in script.frames if item.id == task.frame_id), None)
                if frame and (
                    (frame.hud_template and frame.hud_template.mode in ("overlay", "featured"))
                    or (frame.subtitle_template and frame.subtitle_template.text)
                ):
                    from .overlay_render import overlay_video
                    overlay_path = os.path.join("output", "video", f"video_{task_id}_overlay.mp4")
                    ffmpeg_path = get_ffmpeg_path() or "ffmpeg"
                    sibling_ffprobe = os.path.join(os.path.dirname(ffmpeg_path), "ffprobe") if os.path.dirname(ffmpeg_path) else ""
                    ffprobe_path = sibling_ffprobe if sibling_ffprobe and os.path.exists(sibling_ffprobe) else "ffprobe"
                    overlay_video(
                        final_video_path,
                        overlay_path,
                        hud_template=frame.hud_template.model_dump() if frame.hud_template else None,
                        episode_state=frame.episode_state.model_dump() if frame.episode_state else None,
                        hud_payload=frame.hud_payload,
                        subtitle_template=frame.subtitle_template.model_dump() if frame.subtitle_template else None,
                        ffmpeg=ffmpeg_path,
                        ffprobe=ffprobe_path,
                    )
                    final_video_path = overlay_path
                    task.overlay_video_url = os.path.relpath(overlay_path, "output")
                    frame.overlay_video_url = task.overlay_video_url

            task.video_url = os.path.relpath(final_video_path, "output")
            task.status = "completed"
            
            # Sync video_url back to the corresponding frame
            if task.frame_id:
                for frame in script.frames:
                    if frame.id == task.frame_id:
                        frame.video_url = task.video_url
                        logger.info(
                            f"Synced video_url to frame {task.frame_id}"
                        )
                        break
            
            # Sync with asset if this is an asset video
            if task.asset_id:
                self._sync_asset_video_task(script, task)
            
        except Exception as e:
            import traceback
            logger.exception("Failed to process video task")
            logger.error(f"Video generation failed: {e}")
            task.status = "failed"
            if task.asset_id:
                self._sync_asset_video_task(script, task)
            
        self._save_data()

    def _sync_asset_video_task(self, script: Script, task: VideoTask):
        """Syncs the updated task status/url back to the asset's video_assets list."""
        target_asset = None
        # Search in all asset types
        for char in script.characters:
            if char.id == task.asset_id:
                target_asset = char
                break
        if not target_asset:
            for scene in script.scenes:
                if scene.id == task.asset_id:
                    target_asset = scene
                    break
        if not target_asset:
            for prop in script.props:
                if prop.id == task.asset_id:
                    target_asset = prop
                    break
        
        if target_asset:
            # Find and update the task in the asset's list
            for i, t in enumerate(target_asset.video_assets):
                if t.id == task.id:
                    target_asset.video_assets[i] = task
                    break
            else:
                # Not found, append it (shouldn't happen if created correctly, but good fallback)
                target_asset.video_assets.append(task)

    def create_asset_video_task(self, script_id: str, asset_id: str, asset_type: str, prompt: str = None, duration: int = 5, aspect_ratio: str = None) -> Tuple[Script, str]:
        """Creates a video generation task for an asset (I2V)."""
        script = self.get_script(script_id)
        if not script:
            raise ValueError("Script not found")
            
        target_asset = None
        if asset_type == "character":
            target_asset = next((c for c in script.characters if c.id == asset_id), None)
            if not target_asset:
                raise ValueError(f"Asset {asset_id} not found")
            # Use full body image for character video
            image_url = target_asset.full_body_image_url or target_asset.image_url
            if not prompt:
                prompt = f"A cinematic shot of {target_asset.name}, {target_asset.description}, looking around, breathing, slight movement, high quality, 4k"
        elif asset_type == "scene":
            target_asset = next((s for s in script.scenes if s.id == asset_id), None)
            if not target_asset:
                raise ValueError(f"Asset {asset_id} not found")
            image_url = target_asset.image_url
            if not prompt:
                prompt = f"A cinematic shot of {target_asset.name}, {target_asset.description}, ambient motion, lighting change, high quality, 4k"
        elif asset_type == "prop":
            target_asset = next((p for p in script.props if p.id == asset_id), None)
            if not target_asset:
                raise ValueError(f"Asset {asset_id} not found")
            image_url = target_asset.image_url
            if not prompt:
                prompt = f"A cinematic shot of {target_asset.name}, {target_asset.description}, rotating slowly, high quality, 4k"
        else:
            raise ValueError(f"Invalid asset_type: {asset_type}")
            
        if not target_asset:
            raise ValueError(f"Asset {asset_id} not found")
            
        if not image_url:
            raise ValueError(f"Asset {asset_id} has no image to generate video from")

        # Create task using existing method logic but with asset_id
        task_id = str(uuid.uuid4())
        
        # Snapshot logic (duplicated from create_video_task for now, or could refactor)
        snapshot_url = image_url
        try:
            if not image_url.startswith("http"):
                src_path = os.path.join("output", image_url)
                if os.path.exists(src_path):
                    snapshot_dir = os.path.join("output", "video_inputs")
                    os.makedirs(snapshot_dir, exist_ok=True)
                    ext = os.path.splitext(image_url)[1] or ".png"
                    snapshot_filename = f"{task_id}{ext}"
                    snapshot_path = os.path.join(snapshot_dir, snapshot_filename)
                    import shutil
                    shutil.copy2(src_path, snapshot_path)
                    snapshot_url = f"video_inputs/{snapshot_filename}"
        except Exception:
            pass

        prompt = self._ensure_video_no_bgm_prompt(prompt)
        negative_prompt = self._ensure_video_no_bgm_negative_prompt(None)

        task = VideoTask(
            id=task_id,
            project_id=script_id,
            asset_id=asset_id,
            image_url=snapshot_url,
            prompt=prompt,
            status="pending",
            duration=duration,
            resolution="720p",
            negative_prompt=negative_prompt,
            ratio=aspect_ratio,
            model="wan2.6-i2v", # Asset video uses I2V
            created_at=time.time()
        )
        
        # Add to global list
        if not script.video_tasks:
            script.video_tasks = []
        script.video_tasks.append(task)
        
        # Add to asset list
        target_asset.video_assets.append(task)
        
        self._save_data()
        return script, task_id

    def delete_asset_video(self, script_id: str, asset_id: str, asset_type: str, video_id: str) -> Script:
        """Deletes a video from an asset."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        # Find asset
        target_asset = None
        if asset_type == "character":
            target_asset = next((c for c in script.characters if c.id == asset_id), None)
        elif asset_type == "scene":
            target_asset = next((s for s in script.scenes if s.id == asset_id), None)
        elif asset_type == "prop":
            target_asset = next((p for p in script.props if p.id == asset_id), None)
        
        if not target_asset:
            raise ValueError(f"Asset {asset_id} of type {asset_type} not found")
        
        # Find the task first to get video_url for file deletion
        video_task_to_delete = None
        if script.video_tasks:
            video_task_to_delete = next((v for v in script.video_tasks if v.id == video_id), None)
        
        # Remove from asset's video_assets
        if target_asset.video_assets:
            original_len = len(target_asset.video_assets)
            target_asset.video_assets = [v for v in target_asset.video_assets if v.id != video_id]
            if len(target_asset.video_assets) == original_len and not video_task_to_delete:
                 # Only raise if not found in either place, or just log warning?
                 # If found in global list but not asset list, it's weird but we should proceed.
                 pass

        # Also remove from script.video_tasks
        if script.video_tasks:
            script.video_tasks = [v for v in script.video_tasks if v.id != video_id]
        
        # Try to delete the video file
        try:
            if video_task_to_delete and video_task_to_delete.video_url:
                video_path = os.path.join("output", video_task_to_delete.video_url)
                if os.path.exists(video_path):
                    os.remove(video_path)
                    logger.info(f"Deleted video file: {video_path}")
        except Exception as e:
            logger.warning(f"Failed to delete video file: {e}")
        
        self._save_data()
        return script

    def generate_audio(self, script_id: str) -> Script:
        """Step 5: Generate audio (Dialogue & SFX)."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
            
        logger.info(f"Generating audio for script {script.id}")
        
        for frame in script.frames:
            # Generate Dialogue
            if frame.dialogue:
                speaker = None
                if frame.character_ids:
                    speaker = next((c for c in script.characters if c.id == frame.character_ids[0]), None)
                
                if speaker:
                    self.audio_generator.generate_dialogue(
                        frame, speaker,
                        speed=speaker.voice_speed,
                        pitch=speaker.voice_pitch,
                        volume=speaker.voice_volume
                    )
            
            # Generate SFX (Text-to-Audio)
            if frame.action_description:
                self.audio_generator.generate_sfx(frame)
                
            # Generate SFX (Video-to-Audio) - if video exists
            if frame.video_url:
                self.audio_generator.generate_sfx_from_video(frame)
                
            # Generate BGM
            # Simple logic: generate BGM for every frame (or scene start)
            self.audio_generator.generate_bgm(frame)
                
        self._save_data()
        return script

    def generate_dialogue_line(
        self,
        script_id: str,
        frame_id: str,
        speed: float = 1.0,
        pitch: float = 1.0,
        volume: int = 50,
        instructions: Optional[str] = None,
    ) -> Script:
        """Generates audio for a specific frame with parameters.

        PR-3j: accepts `instructions` (chip emotion + free text). For
        custom voices (clone/design) we resolve the target_model/family
        override here so generation reuses the registered voice model.
        """
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        frame = next((f for f in script.frames if f.id == frame_id), None)
        if not frame:
            raise ValueError("Frame not found")

        dialogue_text = (
            (frame.dialogue_structured.line if frame.dialogue_structured else None)
            or frame.dialogue
        )
        if dialogue_text:
            speaker = None
            if frame.character_ids:
                speaker = next((c for c in script.characters if c.id == frame.character_ids[0]), None)
            speaker_name = frame.speaker or (
                frame.dialogue_structured.speaker if frame.dialogue_structured else None
            )
            if not speaker and speaker_name:
                key = speaker_name.strip().lower()
                speaker = next(
                    (c for c in script.characters if c.name.strip().lower() == key
                     or key in c.name.strip().lower()
                     or c.name.strip().lower() in key),
                    None,
                )

            if speaker:
                model_override = None
                family_override = None
                if speaker.voice_id:
                    custom = self.find_custom_voice(speaker.voice_id)
                    if custom:
                        model_override = custom.target_model
                        family_override = custom.family
                self.audio_generator.generate_dialogue(
                    frame, speaker, speed, pitch, volume,
                    instructions=instructions,
                    model_override=model_override,
                    family_override=family_override,
                )

        self._save_data()
        return script

    def bind_voice(self, script_id: str, char_id: str, voice_id: str, voice_name: str) -> Script:
        """Bind a voice to an episode-local or series-shared character."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        char, source = self._find_asset_with_source(script, char_id, "character")
        if not char:
            raise ValueError("Character not found")

        char.voice_id = voice_id
        char.voice_name = voice_name
        self._save_after_asset_mutation(source)
        return script

    def get_script(self, script_id: str) -> Optional[Script]:
        return self.scripts.get(script_id)

    def _select_variant_in_asset(self, image_asset: Any, variant_id: str) -> Any:
        """Helper to select a variant in an ImageAsset. Returns the selected variant if found."""
        if not image_asset or not image_asset.variants:
            return None
            
        for variant in image_asset.variants:
            if variant.id == variant_id:
                image_asset.selected_id = variant_id
                return variant
        return None

    def _delete_variant_in_asset(self, image_asset: Any, variant_id: str) -> bool:
        """Helper to delete a variant in an ImageAsset. Returns True if found and deleted."""
        if not image_asset or not image_asset.variants:
            return False
            
        initial_len = len(image_asset.variants)
        image_asset.variants = [v for v in image_asset.variants if v.id != variant_id]
        
        if len(image_asset.variants) < initial_len:
            # If we deleted the selected one, select the last one or None
            if image_asset.selected_id == variant_id:
                if image_asset.variants:
                    image_asset.selected_id = image_asset.variants[-1].id
                else:
                    image_asset.selected_id = None
            return True
        return False

    def select_asset_variant(self, script_id: str, asset_id: str, asset_type: str, variant_id: str, generation_type: str = None) -> Script:
        """Selects a specific variant for an asset."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
            
        target_asset = None
        if asset_type == "character":
            target_asset = next((c for c in script.characters if c.id == asset_id), None)
            if target_asset:
                # If generation_type is specified, only select from that specific asset
                if generation_type == "full_body":
                    variant = self._select_variant_in_asset(target_asset.full_body_asset, variant_id)
                    if variant:
                        target_asset.full_body_image_url = variant.url
                        target_asset.image_url = variant.url  # Legacy sync
                elif generation_type == "three_view":
                    variant = self._select_variant_in_asset(target_asset.three_view_asset, variant_id)
                    if variant:
                        target_asset.three_view_image_url = variant.url
                elif generation_type == "headshot":
                    variant = self._select_variant_in_asset(target_asset.headshot_asset, variant_id)
                    if variant:
                        target_asset.headshot_image_url = variant.url
                        target_asset.avatar_url = variant.url  # Sync avatar
                else:
                    # Legacy fallback: search all assets (for backward compatibility)
                    variant = self._select_variant_in_asset(target_asset.full_body_asset, variant_id)
                    if variant:
                        target_asset.full_body_image_url = variant.url
                        target_asset.image_url = variant.url
                    
                    if not variant:
                        variant = self._select_variant_in_asset(target_asset.three_view_asset, variant_id)
                        if variant:
                            target_asset.three_view_image_url = variant.url
                    
                    if not variant:
                        variant = self._select_variant_in_asset(target_asset.headshot_asset, variant_id)
                        if variant:
                            target_asset.headshot_image_url = variant.url
                            target_asset.avatar_url = variant.url
                        
        elif asset_type == "scene":
            target_asset = next((s for s in script.scenes if s.id == asset_id), None)
            if target_asset:
                variant = self._select_variant_in_asset(target_asset.image_asset, variant_id)
                if variant:
                    target_asset.image_url = variant.url

        elif asset_type == "prop":
            target_asset = next((p for p in script.props if p.id == asset_id), None)
            if target_asset:
                variant = self._select_variant_in_asset(target_asset.image_asset, variant_id)
                if variant:
                    target_asset.image_url = variant.url

        elif asset_type == "storyboard_frame":
            target_asset = next((f for f in script.frames if f.id == asset_id), None)
            if target_asset:
                # Check rendered_image_asset
                variant = self._select_variant_in_asset(target_asset.rendered_image_asset, variant_id)
                if variant:
                    target_asset.rendered_image_url = variant.url
                    target_asset.image_url = variant.url # Main image is rendered one
                
                # Also check image_asset (sketch)?
                if not variant:
                    variant = self._select_variant_in_asset(target_asset.image_asset, variant_id)
                    # If sketch, maybe don't update main image_url if rendered exists?
                    # For now, let's assume we only select rendered variants for frames usually.
        
        self._save_data()
        return script

    def delete_asset_variant(self, script_id: str, asset_id: str, asset_type: str, variant_id: str) -> Script:
        """Deletes a specific variant from an asset."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
            
        target_asset = None
        if asset_type == "character":
            target_asset = next((c for c in script.characters if c.id == asset_id), None)
            if target_asset:
                if self._delete_variant_in_asset(target_asset.full_body_asset, variant_id):
                    # Sync legacy if needed
                    if target_asset.full_body_asset.selected_id:
                        selected = next((v for v in target_asset.full_body_asset.variants if v.id == target_asset.full_body_asset.selected_id), None)
                        target_asset.image_url = selected.url if selected else None
                    else:
                        target_asset.image_url = None
                
                elif self._delete_variant_in_asset(target_asset.three_view_asset, variant_id):
                    if target_asset.three_view_asset.selected_id:
                        selected = next((v for v in target_asset.three_view_asset.variants if v.id == target_asset.three_view_asset.selected_id), None)
                        target_asset.three_view_image_url = selected.url if selected else None
                    else:
                        target_asset.three_view_image_url = None

                elif self._delete_variant_in_asset(target_asset.headshot_asset, variant_id):
                    if target_asset.headshot_asset.selected_id:
                        selected = next((v for v in target_asset.headshot_asset.variants if v.id == target_asset.headshot_asset.selected_id), None)
                        target_asset.headshot_image_url = selected.url if selected else None
                    else:
                        target_asset.headshot_image_url = None

        elif asset_type == "scene":
            target_asset = next((s for s in script.scenes if s.id == asset_id), None)
            if target_asset and self._delete_variant_in_asset(target_asset.image_asset, variant_id):
                if target_asset.image_asset.selected_id:
                    selected = next((v for v in target_asset.image_asset.variants if v.id == target_asset.image_asset.selected_id), None)
                    target_asset.image_url = selected.url if selected else None
                else:
                    target_asset.image_url = None

        elif asset_type == "prop":
            target_asset = next((p for p in script.props if p.id == asset_id), None)
            if target_asset and self._delete_variant_in_asset(target_asset.image_asset, variant_id):
                if target_asset.image_asset.selected_id:
                    selected = next((v for v in target_asset.image_asset.variants if v.id == target_asset.image_asset.selected_id), None)
                    target_asset.image_url = selected.url if selected else None
                else:
                    target_asset.image_url = None

        elif asset_type == "storyboard_frame":
            target_asset = next((f for f in script.frames if f.id == asset_id), None)
            if target_asset:
                if self._delete_variant_in_asset(target_asset.rendered_image_asset, variant_id):
                    if target_asset.rendered_image_asset.selected_id:
                        selected = next((v for v in target_asset.rendered_image_asset.variants if v.id == target_asset.rendered_image_asset.selected_id), None)
                        target_asset.rendered_image_url = selected.url if selected else None
                        target_asset.image_url = selected.url if selected else None
                    else:
                        target_asset.rendered_image_url = None
                        # Don't clear image_url if it might fall back to sketch? 
                        # For now, clear it if rendered is cleared.
                        target_asset.image_url = None

        self._save_data()
        return script

    def update_model_settings(self, script_id: str, t2i_model: str = None, i2i_model: str = None, i2v_model: str = None, r2v_model: str = None, character_aspect_ratio: str = None, scene_aspect_ratio: str = None, prop_aspect_ratio: str = None, storyboard_aspect_ratio: str = None, image_model: str = None) -> Script:
        """Updates the model settings for a script."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        if t2i_model:
            script.model_settings.t2i_model = t2i_model
        if i2i_model:
            script.model_settings.i2i_model = i2i_model
        if i2v_model:
            script.model_settings.i2v_model = i2v_model
        if r2v_model:
            script.model_settings.r2v_model = r2v_model
        if image_model:
            script.model_settings.image_model = image_model
        if character_aspect_ratio:
            script.model_settings.character_aspect_ratio = character_aspect_ratio
        if scene_aspect_ratio:
            script.model_settings.scene_aspect_ratio = scene_aspect_ratio
        if prop_aspect_ratio:
            script.model_settings.prop_aspect_ratio = prop_aspect_ratio
        if storyboard_aspect_ratio:
            script.model_settings.storyboard_aspect_ratio = storyboard_aspect_ratio

        self._save_data()
        return script

    def _set_variant_favorite(self, image_asset: Any, variant_id: str, is_favorited: bool) -> bool:
        """Helper to set favorite status of a variant. Returns True if found."""
        if not image_asset or not image_asset.variants:
            return False
        for v in image_asset.variants:
            if v.id == variant_id:
                v.is_favorited = is_favorited
                return True
        return False

    def toggle_variant_favorite(self, script_id: str, asset_id: str, asset_type: str, variant_id: str, is_favorited: bool, generation_type: str = None) -> Script:
        """Toggles the favorite status of a variant."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        found = False
        if asset_type == "character":
            target_asset = next((c for c in script.characters if c.id == asset_id), None)
            if target_asset:
                if generation_type == "full_body":
                    found = self._set_variant_favorite(target_asset.full_body_asset, variant_id, is_favorited)
                elif generation_type == "three_view":
                    found = self._set_variant_favorite(target_asset.three_view_asset, variant_id, is_favorited)
                elif generation_type == "headshot":
                    found = self._set_variant_favorite(target_asset.headshot_asset, variant_id, is_favorited)
                else:
                    # Try all character assets
                    found = self._set_variant_favorite(target_asset.full_body_asset, variant_id, is_favorited) or \
                            self._set_variant_favorite(target_asset.three_view_asset, variant_id, is_favorited) or \
                            self._set_variant_favorite(target_asset.headshot_asset, variant_id, is_favorited)
        
        elif asset_type == "scene":
            target_asset = next((s for s in script.scenes if s.id == asset_id), None)
            if target_asset:
                found = self._set_variant_favorite(target_asset.image_asset, variant_id, is_favorited)
        
        elif asset_type == "prop":
            target_asset = next((p for p in script.props if p.id == asset_id), None)
            if target_asset:
                found = self._set_variant_favorite(target_asset.image_asset, variant_id, is_favorited)
        
        elif asset_type == "storyboard_frame":
            target_asset = next((f for f in script.frames if f.id == asset_id), None)
            if target_asset:
                found = self._set_variant_favorite(target_asset.rendered_image_asset, variant_id, is_favorited) or \
                        self._set_variant_favorite(target_asset.image_asset, variant_id, is_favorited)
        
        if not found:
            raise ValueError(f"Variant {variant_id} not found")

        self._save_data()
        return script

    # ============================================================
    # Series Storage & CRUD
    # ============================================================

    def _load_series_data(self) -> Dict[str, Series]:
        """Load series from SQLite."""
        result: Dict[str, Series] = {}
        try:
            for d in self._storage.list_series():
                result[d["id"]] = Series(**d)
        except Exception as e:
            logger.error(f"Failed to load series data: {e}")
        return result

    def _save_series_data_unlocked(self):
        """Save all series to SQLite (caller must hold self._save_lock)."""
        try:
            for s in self.series_store.values():
                self._storage.save_series(s.model_dump())
        except Exception as e:
            logger.error(f"Failed to save series data: {e}")

    def _save_series_data(self):
        """Save series data with thread lock."""
        with self._save_lock:
            self._save_series_data_unlocked()
    
    def _save_series(self, series_id: Optional[str] = None):
        """Save a single series or all series to SQLite."""
        with self._save_lock:
            try:
                if series_id:
                    s = self.series_store.get(series_id)
                    if s:
                        self._storage.save_series(s.model_dump())
                else:
                    for s in self.series_store.values():
                        self._storage.save_series(s.model_dump())
            except Exception as e:
                logger.error(f"Failed to save series: {e}")

    def create_series(self, title: str, description: str = "", workflow_mode: str = "i2v_legacy", content_mode: str = "scripted", default_generation_mode: str = "r2v") -> Series:
        """Create a new Series."""
        with self._save_lock:
            series = Series(
                id=str(uuid.uuid4()),
                title=title,
                description=description,
                workflow_mode=workflow_mode,
                content_mode=content_mode,
                default_generation_mode=default_generation_mode,
                created_at=time.time(),
                updated_at=time.time(),
            )
            self.series_store[series.id] = series
            self._save_series_data_unlocked()
            return series

    def get_series(self, series_id: str) -> Optional[Series]:
        return self.series_store.get(series_id)

    def list_series(self) -> List[Series]:
        return list(self.series_store.values())

    def update_series(self, series_id: str, updates: Dict[str, Any]) -> Series:
        """Update Series fields (title, description, etc.)."""
        with self._save_lock:
            series = self.series_store.get(series_id)
            if not series:
                raise ValueError("Series not found")
            for key, value in updates.items():
                if hasattr(series, key) and key not in ("id", "created_at", "episode_ids"):
                    if key == "art_direction" and isinstance(value, dict):
                        value = ArtDirection(**value)
                    setattr(series, key, value)
            series.updated_at = time.time()
            self.series_store[series_id] = series
            self._save_series_data_unlocked()
            return series

    def delete_project(self, script_id: str) -> Script:
        """Delete a project and its associated data."""
        with self._save_lock:
            script = self.scripts.get(script_id)
            if not script:
                raise ValueError("Project not found")
            # If project belongs to a Series, remove from episode_ids
            if script.series_id:
                series = self.series_store.get(script.series_id)
                if series and script_id in series.episode_ids:
                    series.episode_ids.remove(script_id)
                    self._save_series_data_unlocked()
            # Delete from memory and persistent storage
            del self.scripts[script_id]
            self._storage.delete_script(script_id)
            self._save_data()
            return script


    def delete_series(self, series_id: str) -> None:
        """Delete a Series and disassociate its episodes."""
        with self._save_lock:
            series = self.series_store.get(series_id)
            if not series:
                raise ValueError("Series not found")
            # Disassociate episodes
            for ep_id in series.episode_ids:
                script = self.scripts.get(ep_id)
                if script:
                    script.series_id = None
                    script.episode_number = None
            self._save_data()
            del self.series_store[series_id]
            self._storage.delete_series(series_id)
            self._save_series_data_unlocked()

    def _sync_assets_to_series(self, series: Series, episode: Script) -> None:
        """Merge episode assets into Series. Episode-local assets take priority by ID."""
        ep_char_ids = {c.id for c in episode.characters}
        ep_scene_ids = {s.id for s in episode.scenes}
        ep_prop_ids = {p.id for p in episode.props}

        # Merge characters: episode first, then series (non-duplicate)
        merged_chars = list(episode.characters)
        for c in series.characters:
            if c.id not in ep_char_ids:
                merged_chars.append(c)
        series.characters = merged_chars

        # Merge scenes
        merged_scenes = list(episode.scenes)
        for s in series.scenes:
            if s.id not in ep_scene_ids:
                merged_scenes.append(s)
        series.scenes = merged_scenes

        # Merge props
        merged_props = list(episode.props)
        for p in series.props:
            if p.id not in ep_prop_ids:
                merged_props.append(p)
        series.props = merged_props


    def add_episode_to_series(self, series_id: str, script_id: str, episode_number: Optional[int] = None) -> Series:
        """Add an existing Script/Project as an Episode to a Series."""
        with self._save_lock:
            series = self.series_store.get(series_id)
            if not series:
                raise ValueError("Series not found")
            script = self.scripts.get(script_id)
            if not script:
                raise ValueError("Script not found")
            # If script already belongs to another series, remove it from the old one
            if script.series_id and script.series_id != series_id:
                old_series = self.series_store.get(script.series_id)
                if old_series and script_id in old_series.episode_ids:
                    old_series.episode_ids.remove(script_id)
            if script_id not in series.episode_ids:
                series.episode_ids.append(script_id)
            script.series_id = series_id
            script.episode_number = episode_number or len(series.episode_ids)
            series.updated_at = time.time()
            self._save_data()
            # Sync episode assets to Series (merge, episode-local takes priority)
            self._sync_assets_to_series(series, script)
            self._save_series_data_unlocked()
            return series

    def remove_episode_from_series(self, series_id: str, script_id: str) -> Series:
        """Remove an Episode from a Series (does not delete the project)."""
        with self._save_lock:
            series = self.series_store.get(series_id)
            if not series:
                raise ValueError("Series not found")
            if script_id in series.episode_ids:
                series.episode_ids.remove(script_id)
            script = self.scripts.get(script_id)
            if script:
                script.series_id = None
                script.episode_number = None
            series.updated_at = time.time()
            self._save_data()
            self._save_series_data_unlocked()
            return series

    # ─────────────────────────────────────────────────────────────
    # PR-3h/i · Custom voice (clone + design) management
    # Per Q16.1: series-level pool. Episodes / characters in the series
    # share access via VoicePickerModal's 我的复刻 / 我的设计 tabs.
    # ─────────────────────────────────────────────────────────────

    def create_voice_clone(
        self,
        series_id: str,
        audio_url: str,
        label: str,
        target_model: str = "cosyvoice-v3.5-plus",
    ) -> 'CustomVoice':
        """Clone a voice from a reference audio URL via dashscope customization.

        Calls /services/audio/tts/customization with model='voice-enrollment'
        action='create_voice'. Persists the returned voice_id under
        series.custom_voices[]. Returns the CustomVoice entry.

        Per doc: audio must be ≤10MB, MP3/WAV/M4A, ≥16kHz, 10-20s recommended.
        Frontend should pre-validate before calling.
        """
        import requests
        from .models import CustomVoice  # local import to avoid circular

        with self._save_lock:
            series = self.series_store.get(series_id)
            if not series:
                raise ValueError(f"Series not found: {series_id}")

            api_key = os.getenv("DASHSCOPE_API_KEY")
            if not api_key:
                raise RuntimeError("DASHSCOPE_API_KEY not configured")

            # Dashscope customization endpoint (Beijing region; intl uses
            # dashscope-intl URL — TODO when LumenX supports intl deployment)
            url = "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization"
            payload = {
                "model": "voice-enrollment",
                "input": {
                    "action": "create_voice",
                    "target_model": target_model,
                    "prefix": label[:20],  # API has prefix length limit
                    "url": audio_url,
                },
            }
            headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

            logger.info(f"[voice/clone] creating voice for series={series_id} label='{label}' target={target_model}")
            resp = requests.post(url, json=payload, headers=headers, timeout=60)
            if resp.status_code != 200:
                logger.error(f"[voice/clone] dashscope error {resp.status_code}: {resp.text[:500]}")
                raise RuntimeError(f"Voice clone failed: HTTP {resp.status_code} — {resp.text[:200]}")

            data = resp.json()
            # Per doc shape: output.voice (CosyVoice) or output.voice_id (Qwen-TTS)
            voice_id = (
                data.get("output", {}).get("voice")
                or data.get("output", {}).get("voice_id")
                or data.get("voice")
            )
            if not voice_id:
                logger.error(f"[voice/clone] no voice_id in response: {data}")
                raise RuntimeError(f"Voice clone succeeded but voice_id missing in response: {data}")

            custom = CustomVoice(
                id=str(voice_id),
                label=label,
                origin="clone",
                target_model=target_model,
                family="cosyvoice",  # PR-3h hardcodes CosyVoice clone target
                source_audio_url=audio_url,
            )
            if series.custom_voices is None:
                series.custom_voices = []
            series.custom_voices.append(custom)
            series.updated_at = time.time()
            self._save_series_data_unlocked()
            logger.info(f"[voice/clone] success voice_id={voice_id} stored on series={series_id}")
            return custom

    def list_custom_voices(self, series_id: str) -> List['CustomVoice']:
        """Return all custom voices in a series (clones + designs).
        Empty list if series has none or doesn't exist."""
        series = self.series_store.get(series_id)
        if not series:
            return []
        return list(series.custom_voices or [])

    def delete_custom_voice(self, series_id: str, voice_id: str) -> bool:
        """Remove a custom voice entry. Returns True if removed, False if
        not found. Note: does NOT call dashscope to delete the underlying
        voice (the platform allows re-use for 24h; cleanup is best-effort)."""
        with self._save_lock:
            series = self.series_store.get(series_id)
            if not series or not series.custom_voices:
                return False
            before = len(series.custom_voices)
            series.custom_voices = [v for v in series.custom_voices if v.id != voice_id]
            removed = before != len(series.custom_voices)
            if removed:
                series.updated_at = time.time()
                self._save_series_data_unlocked()
            return removed

    def find_custom_voice(self, voice_id: str) -> Optional['CustomVoice']:
        """Search all series for a custom voice by voice_id. Used by
        /voice/preview to resolve target_model for cloned/designed voices
        (which aren't in the static TTS_VOICE_REGISTRY)."""
        for series in self.series_store.values():
            for cv in (series.custom_voices or []):
                if cv.id == voice_id:
                    return cv
        return None

    # ─────────────────────────────────────────────────────────────
    # PR-3i · Voice design (iterate: prompt → preview → accept)
    # Unlike clone (audio-driven, 1 shot), design is text-driven and
    # users naturally iterate. Each preview mints a new voice on
    # dashscope; we only persist the voice the user explicitly accepts.
    # ─────────────────────────────────────────────────────────────

    def voice_design_preview(
        self,
        voice_prompt: str,
        preview_text: str,
        target_model: str = "cosyvoice-v3.5-plus",
    ) -> Dict[str, Any]:
        """Mint a new design voice via dashscope (preview returned inline).

        Per dashscope contract: create_voice with voice_prompt MUST be paired
        with preview_text in the same call; the API returns both the voice_id
        and a preview audio URL. We download the URL into our cache dir so
        the frontend can play it through the same /files static mount used
        by /voice/preview.

        Does NOT persist; user iterates by re-calling with tweaked params.
        """
        import requests
        import hashlib

        api_key = os.getenv("DASHSCOPE_API_KEY")
        if not api_key:
            raise RuntimeError("DASHSCOPE_API_KEY not configured")

        url = "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization"
        payload = {
            "model": "voice-enrollment",
            "input": {
                "action": "create_voice",
                "target_model": target_model,
                "prefix": "design",
                "voice_prompt": voice_prompt[:500],
                "preview_text": (preview_text or "你好，这是一段音色测试。")[:200],
            },
        }
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

        logger.info(f"[voice/design] preview voice_prompt='{voice_prompt[:60]}…' target={target_model}")
        # dashscope voice design has variable latency (10-60s); the customization
        # service occasionally returns its own timeout. Retry once on 5xx/timeout.
        resp = None
        last_err = None
        for attempt in range(2):
            try:
                resp = requests.post(url, json=payload, headers=headers, timeout=120)
                if resp.status_code == 200:
                    break
                last_err = f"HTTP {resp.status_code} — {resp.text[:200]}"
                if resp.status_code < 500 and "Timeout" not in (resp.text or ""):
                    break  # client error, don't retry
                logger.warning(f"[voice/design] attempt {attempt+1} failed: {last_err}; retrying")
            except requests.RequestException as e:
                last_err = str(e)
                logger.warning(f"[voice/design] attempt {attempt+1} network error: {e}; retrying")
        if resp is None or resp.status_code != 200:
            logger.error(f"[voice/design] all attempts failed: {last_err}")
            raise RuntimeError(f"Voice design failed: {last_err}")

        data = resp.json()
        output = data.get("output", {}) or {}
        voice_id = output.get("voice") or output.get("voice_id") or data.get("voice")
        remote_preview = output.get("preview_audio") or output.get("preview_audio_url") or output.get("audio_url")
        if not voice_id:
            logger.error(f"[voice/design] no voice_id in response: {data}")
            raise RuntimeError(f"Voice design API returned no voice_id: {data}")

        voice_id_str = str(voice_id)

        cache_dir = "output/cache/voice_design_preview"
        os.makedirs(cache_dir, exist_ok=True)
        cache_key = hashlib.md5(f"{voice_id_str}|{preview_text}".encode("utf-8")).hexdigest()
        cache_path = os.path.join(cache_dir, f"{cache_key}.mp3")

        if remote_preview:
            # Download the dashscope-served preview into our cache.
            try:
                audio_resp = requests.get(remote_preview, timeout=60)
                audio_resp.raise_for_status()
                with open(cache_path, "wb") as f:
                    f.write(audio_resp.content)
            except Exception as e:
                logger.warning(f"[voice/design] preview download failed, falling back to local TTS: {e}")
                remote_preview = None

        if not remote_preview:
            if not self.audio_generator.tts:
                raise RuntimeError("TTS unavailable; cannot synthesize preview")
            self.audio_generator.tts.synthesize(
                text=preview_text,
                output_path=cache_path,
                voice=voice_id_str,
                model_override=target_model,
                family_override="cosyvoice",
            )

        preview_url = f"cache/voice_design_preview/{cache_key}.mp3"
        return {"voice_id": voice_id_str, "preview_url": preview_url, "target_model": target_model}

    def voice_design_save(
        self,
        series_id: str,
        voice_id: str,
        voice_prompt: str,
        label: str,
        target_model: str = "cosyvoice-v3.5-plus",
    ) -> 'CustomVoice':
        """Persist a previewed design voice into series.custom_voices[]."""
        from .models import CustomVoice

        with self._save_lock:
            series = self.series_store.get(series_id)
            if not series:
                raise ValueError(f"Series not found: {series_id}")

            existing = next(
                (cv for cv in (series.custom_voices or []) if cv.id == voice_id),
                None,
            )
            if existing:
                logger.info(f"[voice/design] save: voice_id={voice_id} already exists; returning existing")
                return existing

            custom = CustomVoice(
                id=voice_id,
                label=label,
                origin="design",
                target_model=target_model,
                family="cosyvoice",
                voice_prompt=voice_prompt[:500],
            )
            if series.custom_voices is None:
                series.custom_voices = []
            series.custom_voices.append(custom)
            series.updated_at = time.time()
            self._save_series_data_unlocked()
            logger.info(f"[voice/design] saved voice_id={voice_id} to series={series_id}")
            return custom

    def translate_character_to_voice_prompt(self, description: str) -> str:
        """LLM helper: convert a character description into a CosyVoice
        voice_prompt suitable for /services/audio/tts/customization.

        The prompt should describe vocal qualities (timbre, pace, age, mood)
        in concise Chinese. CosyVoice voice_prompt cap is 500 chars; we
        target ~120-200 to leave headroom for tone hints.
        """
        from .llm_adapter import LLMAdapter

        adapter = LLMAdapter()
        if not adapter.is_configured:
            raise RuntimeError("LLM adapter not configured (missing DASHSCOPE_API_KEY)")

        system_prompt = (
            "你是一个语音设计师，擅长将角色设定转化为简洁的中文音色描述。"
            "输出要求："
            "1. 只描述音色、语速、年龄、情绪，不要描写外貌或剧情。"
            "2. 用 100-200 字中文，单段无标题，不带引号或多余说明。"
            "3. 重点：性别·年龄·音色质感·语速·气质氛围。"
        )
        user_prompt = f"角色设定：\n{description.strip()[:1000]}\n\n请输出音色描述。"

        text = adapter.chat(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        )
        return (text or "").strip()[:500]

    def get_series_episodes(self, series_id: str) -> List[Script]:
        """Get all Episodes belonging to a Series, in order."""
        series = self.series_store.get(series_id)
        if not series:
            raise ValueError("Series not found")
        # Use the storage layer for proper ordering (episode_number, created_at)
        episodes = []
        try:
            for d in self._storage.get_series_episodes(series_id):
                episodes.append(Script(**d))
        except Exception:
            # Fallback to in-memory ordering by episode_ids
            for ep_id in series.episode_ids:
                script = self.scripts.get(ep_id)
                if script:
                    episodes.append(script)
        return episodes

    def resolve_episode_assets(self, episode: Script, series: Optional[Series] = None) -> Dict[str, List]:
        """Merge Episode-local assets with Series shared assets.
        Episode-local assets take priority (by ID) over Series assets."""
        if not series:
            # Auto-lookup series if episode has series_id
            if episode.series_id:
                series = self.series_store.get(episode.series_id)
        if not series:
            return {
                "characters": episode.characters,
                "scenes": episode.scenes,
                "props": episode.props,
            }
        # Build lookup by ID for episode-local assets
        ep_char_ids = {c.id for c in episode.characters}
        ep_scene_ids = {s.id for s in episode.scenes}
        ep_prop_ids = {p.id for p in episode.props}

        merged_characters = list(episode.characters) + [c for c in series.characters if c.id not in ep_char_ids]
        merged_scenes = list(episode.scenes) + [s for s in series.scenes if s.id not in ep_scene_ids]
        merged_props = list(episode.props) + [p for p in series.props if p.id not in ep_prop_ids]

        return {
            "characters": merged_characters,
            "scenes": merged_scenes,
            "props": merged_props,
        }

    # ============================================================
    # File Import & Episode Splitting
    # ============================================================

    def import_file_and_split(self, text: str, suggested_episodes: int = 3) -> List[Dict]:
        """Split text into episodes using LLM. Returns episode preview data."""
        return self.script_processor.split_into_episodes(text, suggested_episodes)

    def create_series_from_import(self, title: str, text: str, episodes_data: List[Dict],
                                   description: str = "") -> Dict:
        """Create a Series with Episodes from import data.
        episodes_data: list of dicts with episode_number, title, start_marker, end_marker."""
        # Create the Series (already acquires lock internally)
        series = self.create_series(title, description)

        # Split text into episode chunks based on markers
        episode_texts = self._split_text_by_markers(text, episodes_data)

        with self._save_lock:
            # Create Episode (Script) for each chunk
            created_episodes = []
            for idx, ep_data in enumerate(episodes_data):
                ep_text = episode_texts[idx] if idx < len(episode_texts) else ""
                ep_title = ep_data.get("title", f"第{idx+1}集")
                episode_number = ep_data.get("episode_number", idx + 1)

                # Create draft script (no LLM analysis yet — user can trigger later)
                script = self.script_processor.create_draft_script(ep_title, ep_text)
                script.series_id = series.id
                script.episode_number = episode_number
                self.scripts[script.id] = script

                series.episode_ids.append(script.id)
                created_episodes.append({
                    "id": script.id,
                    "title": ep_title,
                    "episode_number": episode_number,
                    "text_length": len(ep_text),
                })

            self._save_data()
            self._save_series_data_unlocked()

        return {
            "series": series.model_dump(),
            "episodes": created_episodes,
        }

    def _split_text_by_markers(self, text: str, episodes_data: List[Dict]) -> List[str]:
        """Split text into chunks using start/end markers from LLM.
        Searches sequentially to avoid overlapping chunks."""
        chunks = []
        search_from = 0  # Track position to avoid overlap

        for ep in episodes_data:
            start_marker = ep.get("start_marker", "")
            end_marker = ep.get("end_marker", "")

            start_idx = search_from
            end_idx = len(text)

            if start_marker:
                found = text.find(start_marker, search_from)
                if found >= 0:
                    start_idx = found

            if end_marker:
                found = text.find(end_marker, start_idx)
                if found >= 0:
                    end_idx = found + len(end_marker)

            chunks.append(text[start_idx:end_idx])
            search_from = end_idx  # Next episode starts after this one

        # Fallback: if markers produced empty/overlapping chunks, do equal split
        if not chunks or all(len(c.strip()) == 0 for c in chunks):
            chunk_size = max(1, len(text) // len(episodes_data))
            chunks = []
            for i in range(len(episodes_data)):
                start = i * chunk_size
                end = start + chunk_size if i < len(episodes_data) - 1 else len(text)
                chunks.append(text[start:end])

        return chunks

    # ============================================================
    # Series Asset Operations
    # ============================================================

    def _find_series_asset(self, series_id: str, asset_id: str, asset_type: str):
        """Find an asset in a Series. Returns (series, asset) tuple."""
        if asset_type not in ("character", "scene", "prop"):
            raise ValueError(f"Invalid asset type: {asset_type}")
        series = self.series_store.get(series_id)
        if not series:
            raise ValueError("Series not found")
        target_asset = None
        if asset_type == "character":
            target_asset = next((c for c in series.characters if c.id == asset_id), None)
        elif asset_type == "scene":
            target_asset = next((s for s in series.scenes if s.id == asset_id), None)
        elif asset_type == "prop":
            target_asset = next((p for p in series.props if p.id == asset_id), None)
        if not target_asset:
            raise ValueError(f"Asset {asset_id} of type {asset_type} not found in series")
        return series, target_asset

    def toggle_series_asset_lock(self, series_id: str, asset_id: str, asset_type: str) -> Series:
        """Toggle the locked status of a Series asset."""
        with self._save_lock:
            series, target_asset = self._find_series_asset(series_id, asset_id, asset_type)
            target_asset.locked = not target_asset.locked
            self._save_series_data_unlocked()
            return series

    def update_series_asset_image(self, series_id: str, asset_id: str, asset_type: str, image_url: str) -> Series:
        """Updates the image URL of a Series asset."""
        with self._save_lock:
            series, target_asset = self._find_series_asset(series_id, asset_id, asset_type)
            target_asset.image_url = image_url
            if asset_type == "character":
                target_asset.avatar_url = image_url
            self._save_series_data_unlocked()
            return series

    def update_series_asset_attributes(self, series_id: str, asset_id: str, asset_type: str, attributes: Dict[str, Any]) -> Series:
        """Updates arbitrary attributes of a Series asset."""
        with self._save_lock:
            series, target_asset = self._find_series_asset(series_id, asset_id, asset_type)
            for key, value in attributes.items():
                if hasattr(target_asset, key) and key not in ("id", "status", "locked"):
                    setattr(target_asset, key, value)
            series.updated_at = time.time()
            self._save_series_data_unlocked()
            return series

    def generate_series_asset(self, series_id: str, asset_id: str, asset_type: str,
                              style_preset: str = None, reference_image_url: str = None,
                              style_prompt: str = None, generation_type: str = "all",
                              prompt: str = None, apply_style: bool = True,
                              negative_prompt: str = None, batch_size: int = 1,
                              model_name: str = None, aspect_ratio: str = None) -> tuple:
        """Generate a Series asset. Creates an async task like project asset generation.
        Returns (series, task_id)."""
        series = self.series_store.get(series_id)
        if not series:
            raise ValueError("Series not found")

        if asset_type not in ("character", "scene", "prop"):
            raise ValueError(f"Invalid asset_type: {asset_type}")

        pool = (
            series.characters if asset_type == "character"
            else series.scenes if asset_type == "scene"
            else series.props
        )
        target_asset = next((a for a in pool if a.id == asset_id), None)
        if not target_asset:
            raise ValueError(f"{asset_type.capitalize()} {asset_id} not found in series")

        t2i_model = model_name or series.model_settings.t2i_model

        from .assets import ASPECT_RATIO_TO_SIZE
        if asset_type == "character":
            effective_aspect_ratio = aspect_ratio or series.model_settings.character_aspect_ratio
            default_size = "576*1024"
        elif asset_type == "scene":
            effective_aspect_ratio = aspect_ratio or series.model_settings.scene_aspect_ratio
            default_size = "1024*576"
        else:
            effective_aspect_ratio = aspect_ratio or series.model_settings.prop_aspect_ratio
            default_size = "1024*1024"
        effective_size = ASPECT_RATIO_TO_SIZE.get(effective_aspect_ratio, default_size)

        effective_positive_prompt = ""
        effective_negative_prompt = negative_prompt or ""
        resolved_art_dir = series.art_direction
        if isinstance(resolved_art_dir, dict):
            resolved_art_dir = ArtDirection(**resolved_art_dir)
        if apply_style:
            if resolved_art_dir and resolved_art_dir.style_config:
                effective_positive_prompt = resolved_art_dir.style_config.get('positive_prompt', '')
                global_neg = resolved_art_dir.style_config.get('negative_prompt', '')
                if global_neg:
                    effective_negative_prompt = f"{effective_negative_prompt}, {global_neg}" if effective_negative_prompt else global_neg
            elif style_prompt:
                effective_positive_prompt = style_prompt
            elif style_preset:
                effective_positive_prompt = f"{style_preset} style"

        task_id = str(uuid.uuid4())
        self.asset_generation_tasks[task_id] = {
            "status": "pending",
            "progress": 0,
            "error": None,
            "script_id": series_id,  # reuse field name for task lookup
            "asset_id": asset_id,
            "asset_type": asset_type,
            "created_at": time.time(),
            "is_series": True,
            "params": {
                "style_preset": style_preset,
                "reference_image_url": reference_image_url,
                "effective_positive_prompt": effective_positive_prompt,
                "effective_negative_prompt": effective_negative_prompt,
                "generation_type": generation_type,
                "prompt": prompt,
                "apply_style": apply_style,
                "batch_size": batch_size,
                "t2i_model": t2i_model,
                "effective_size": effective_size,
                "aspect_ratio": effective_aspect_ratio,
            }
        }
        target_asset.status = GenerationStatus.PROCESSING
        series.updated_at = time.time()
        self._save_series_data()
        return series, task_id

    def import_assets_from_series(self, target_series_id: str, source_series_id: str, asset_ids: List[str]) -> Tuple[Series, List[str], List[str]]:
        """Deep-copy selected assets from source Series to target Series.
        Returns (target_series, imported_ids, skipped_ids)."""
        with self._save_lock:
            target = self.series_store.get(target_series_id)
            if not target:
                raise ValueError("Target series not found")
            source = self.series_store.get(source_series_id)
            if not source:
                raise ValueError("Source series not found")

            # Build lookup of all source assets
            source_assets = {}
            for c in source.characters:
                source_assets[c.id] = ("character", c)
            for s in source.scenes:
                source_assets[s.id] = ("scene", s)
            for p in source.props:
                source_assets[p.id] = ("prop", p)

            imported_ids = []
            skipped_ids = []
            for aid in asset_ids:
                if aid not in source_assets:
                    skipped_ids.append(aid)
                    continue
                asset_type, asset = source_assets[aid]
                # Deep copy with new ID
                import copy
                new_asset = copy.deepcopy(asset)
                new_asset.id = str(uuid.uuid4())
                if asset_type == "character":
                    target.characters.append(new_asset)
                elif asset_type == "scene":
                    target.scenes.append(new_asset)
                elif asset_type == "prop":
                    target.props.append(new_asset)
                imported_ids.append(aid)

            target.updated_at = time.time()
            self._save_series_data_unlocked()
            return target, imported_ids, skipped_ids

    def get_effective_prompt(self, prompt_type: str, episode: Script, series: Optional[Series] = None) -> str:
        """Three-level fallback: Episode -> Series -> system default."""
        valid_prompt_types = ("storyboard_polish", "video_polish", "r2v_polish")
        if prompt_type not in valid_prompt_types:
            raise ValueError(f"Invalid prompt_type: {prompt_type}. Must be one of {valid_prompt_types}")
        from .llm import DEFAULT_STORYBOARD_POLISH_PROMPT, DEFAULT_VIDEO_POLISH_PROMPT, DEFAULT_R2V_POLISH_PROMPT
        defaults = {
            "storyboard_polish": DEFAULT_STORYBOARD_POLISH_PROMPT,
            "video_polish": DEFAULT_VIDEO_POLISH_PROMPT,
            "r2v_polish": DEFAULT_R2V_POLISH_PROMPT,
        }
        episode_value = getattr(episode.prompt_config, prompt_type, "")
        if episode_value.strip():
            return episode_value
        if series:
            series_value = getattr(series.prompt_config, prompt_type, "")
            if series_value.strip():
                return series_value
        return defaults.get(prompt_type, "")
