# AGENTS.md

This file provides guidance to AI coding agents working on the LumenX codebase.

## Repository Overview

LumenX is an AI-powered comic video production platform. It supports the full workflow from script → assets (characters/scenes/props) → storyboard frames → video clips → merged final video. It uses **Next.js 14 + React 18 + TypeScript + Tailwind CSS** frontend with a **FastAPI (Python 3.11+)** backend.

The desktop app is packaged with PyInstaller + pywebview. In development, the frontend runs on port 3008/3009 and the backend on port 17177.

---

## Critical Conventions (Read Before Coding)

### Python Handler Sync/Async Convention

**Every new endpoint MUST use `def`, NOT `async def`.**

FastAPI's contract:
- `async def` → runs on asyncio event loop. If the body does ANY blocking I/O (sync HTTP call, `json.dump`, `requests.post`, OpenAI/DashScope sync client, `subprocess.run`, etc.) it FREEZES every other request — including unrelated GETs the frontend modal uses to load config. Symptom: "modal stuck on 加载配置中..."
- `def` → auto-dispatched to anyio's threadpool. Blocking I/O won't touch the event loop. Concurrent requests stay responsive.

Use `async def` ONLY when the body has `await` (streaming uploads, real asyncio primitives, `await call_next` in middleware, `asyncio.to_thread`). As of last audit, only 7 endpoints use `async def`: middleware `add_cache_control_header`, `create_project`, `reparse_project`, `import_file_preview`, `import_file_confirm`, `upload_t2i_frame`, `analyze_script_for_styles`.

### API Response Encoding

**All API responses MUST use `signed_response(data)`**, not a raw dict/Model dump. This wraps the payload in a deterministic JSON-encoded + signed envelope so the frontend can verify integrity. Not using `signed_response` will cause silent frontend decode failures.

Example:
```python
return signed_response(updated_script)
```

### Frontend Type Sync

The frontend has its own TypeScript type definitions in `frontend/src/store/projectStore.ts`. These are **hand-maintained, not auto-generated** from the Python models. When you add a field to a Pydantic model in `models.py`, you MUST add the corresponding optional field to the matching TS interface.

The key type interfaces to keep in sync:
| Python (`models.py`) | TypeScript (`projectStore.ts`) |
|---|---|
| `Script` | `Project` |
| `Character` | `Character` |
| `Scene` | `Scene` |
| `Prop` | `Prop` |
| `StoryboardFrame` | `StoryboardFrame` |
| `Series` | `Series` |
| `VideoTask` | `VideoTask` |
| `AssetStage` | `AssetStage` |
| `EpisodeState` | (missing — needs adding) |
| `HudTemplate` | (missing — needs adding) |
| `SubtitleTemplate` | (missing — needs adding) |

### Stage Reference Freezing

When a storyboard frame references a character/scene stage, the stage ID is **frozen** into `character_stage_refs` / `scene_stage_ref` at frame creation time. The frame should NOT be directly modified when the stage changes later — this is intentional to preserve historical frame-to-stage mappings.

### Three-Level Prompt Fallback

Prompts use a three-level fallback chain: **Episode → Series → system default**. The relevant method is `pipeline.get_effective_prompt(prompt_type, episode, series)`. Valid `prompt_type` values: `"storyboard_polish"`, `"video_polish"`, `"r2v_polish"`.

---

## Code Organization

### Backend (`src/`)

```
src/
├── apps/comic_gen/          # Core application (bulk of the logic)
│   ├── api.py               # FastAPI routes (~4000 lines, all endpoints)
│   ├── pipeline.py          # ComicGenPipeline — main business logic class
│   ├── models.py            # All Pydantic data models
│   ├── llm.py               # LLM interaction: script parsing, prompt assembly
│   ├── llm_adapter.py       # Adapter for different LLM providers
│   ├── assets.py            # Asset generation (character/scene/prop images)
│   ├── storyboard.py        # Storyboard frame rendering
│   ├── video.py             # Video generation (I2V/R2V)
│   ├── audio.py             # Audio generation (TTS, SFX, BGM)
│   ├── overlay_render.py    # HUD/subtitle overlay compositing (PIL + FFmpeg)
│   ├── prompt_assembly.py   # Prompt assembly helpers
│   └── export.py            # Final video merge/export
├── models/                  # AI model wrappers (Kling, Wan, Vidu, OpenAI, etc.)
│   ├── base.py              # Base model interface
│   ├── factory.py           # Model factory/provider resolution
│   └── kling.py, vidu.py, wanx.py, openai_image.py, openai_video.py, ...
├── utils/                   # Shared utilities
│   ├── storage.py           # SQLite storage backend
│   ├── provider_registry.py # Provider backend routing (DashScope vs vendor)
│   ├── model_catalog.py     # Model metadata catalog
│   ├── oss_utils.py         # Alibaba Cloud OSS integration
│   └── system_check.py      # FFmpeg/environment checks
├── audio/                   # Audio processing (TTS)
└── config.py                # Global configuration
```

### Frontend (`frontend/src/`)

```
frontend/src/
├── app/                        # Next.js App Router pages
│   ├── layout.tsx
│   └── page.tsx
├── components/
│   ├── layout/                 # App shell, sidebar, breadcrumbs
│   ├── project/                # Project list, create project dialog
│   ├── series/                 # Series management, asset library
│   ├── modules/                # Feature modules
│   │   ├── StoryboardR2V.tsx   # Main R2V storyboard editor (complex, ~2700 lines)
│   │   └── storyboard-r2v/     # Sub-components for the R2V editor
│   │       ├── ShotCard.tsx    # Individual shot card
│   │       ├── shot-panel/     # Shot detail panel (params, candidates, T2I)
│   │       └── ...
│   ├── common/                 # Shared components
│   │   ├── AssetStageDialog.tsx # Stage management dialog
│   │   ├── AssetCard.tsx       # Asset card with stage support
│   │   └── VariantSelector.tsx # Image variant selector
│   └── shared/                 # Preview, toast, step headers
├── lib/
│   ├── api.ts                  # API client (all backend calls)
│   └── modelCatalog.ts         # Model catalog config
└── store/
    └── projectStore.ts         # TypeScript type definitions
```

---

## Key Feature: Cross-Episode Asset Evolution (Stages)

Characters and Scenes can have `stages: List[AssetStage]`, each defining a visual evolution across an episode range (e.g., "老赵 E1-E3 正常 → E4-E5 晒黑 → E6-E9 恐龙皮披肩").

### Backend (`models.py`)

```python
class AssetStage(BaseModel):
    id: str                          # UUID
    label: str                       # Human-readable label
    from_episode: int                # Start episode (>=1)
    to_episode: int                  # End episode (>=1)
    visual_delta: str                # Visual change description
    reference_images: List[ImageVariant]  # Generated stage images
    selected_image_id: Optional[str]      # Active image
    locked: bool
    status: GenerationStatus
    last_generation_prompt: Optional[str]
```

### Stage Image Generation

Stage image generation is **stage-scoped** — generated images write to `stage.reference_images`, NOT to the character's top-level `full_body_asset`/`three_view_asset`. This is enforced in `_process_stage_asset_task()` in `pipeline.py`. The generation prompt is a **turnaround sheet layout** (front + side + back views, same scale) built by `_build_stage_generation_prompt()`.

### Storyboard Frame Stage References

Frames freeze which stage was used at creation time:

```python
class StoryboardFrame(BaseModel):
    character_stage_refs: Dict[str, str]    # character_id → stage_id
    scene_stage_ref: Optional[str]          # scene_id → stage_id
```

When rendering a storyboard frame, the pipeline resolves the stage's `selected_image_id` to get the actual image URL from the parent series' character/scene.

---

## Key Feature: HUD & Subtitle Overlays

### Design Philosophy

AI models produce **text-free footage**. Pillow draws precise text/panels on transparent RGBA layers, and FFmpeg composites them without re-encoding the source audio.

### Three HUD Modes

| Mode | Usage | Processing |
|---|---|---|
| `flash` | Quick popups (金币+3, 成就 2s) | AI-generated directly (no script overlay) |
| `overlay` | Persistent HUD (resource panel, mini-map) | Script overlay via `overlay_video()` |
| `featured` | Full-screen panel close-up (POV) | AI generates blue-glow background (NO text) + script fills text |

### Marker in Script Text

The LLM prompt instructs models to emit `[HUD:flash]` / `[HUD:overlay]` / `[HUD:featured]` markers in the action summary. The `ScriptProcessor._normalize_overlay_metadata()` method post-processes these markers deterministically:

1. Scans the original text for `[HUD:...]` markers
2. Maps markers to frames left-to-right
3. Sets `hud_template.mode` and `hud_payload`
4. For `overlay`/`featured` modes, appends `"无文字、无数字、无logo，仅保留蓝色HUD光晕、半透明底图和清晰留白区域。"` to the image prompt

### Rendering (`overlay_render.py`)

- `render_hud_layer(size, state, payload, output)` — generates transparent PNG with status panel (health bar, day counter), resource panel, warning bar, and achievement popup
- `render_subtitle_layer(size, template, output)` — generates transparent PNG for subtitles
- `overlay_video(video_path, output_path, ...)` — probes video dimensions, renders layers, composites with FFmpeg

### Pipeline Integration

After video generation completes in `pipeline.py` (~line 3925), the code checks if the frame has HUD/subtitle templates and calls `overlay_video()`. The result is stored in `VideoTask.overlay_video_url` and `StoryboardFrame.overlay_video_url`.

---

## API Patterns

### Endpoint Naming

All project-specific endpoints follow: `POST /projects/{script_id}/resource/action`. The `script_id` parameter is the episode/project ID (UUID string).

### Request Bodies

All POST/PUT endpoints use Pydantic request models defined inline in `api.py` before the handler. These are separate from the core models in `models.py` — they represent the HTTP API contract, not the domain model.

### Background Tasks

AI generation tasks (asset generation, video generation) use FastAPI `BackgroundTasks`. The pattern is:
1. Handler creates a task entry in `pipeline.asset_generation_tasks` or `pipeline.video_generation_tasks`
2. Handler returns immediately with the task ID
3. `background_tasks.add_task(pipeline.process_asset_generation_task, task_id)` kicks off async processing
4. Frontend polls via `GET /task_status/{task_id}`

### Frame Update vs Workbench Update

There are two frame update endpoints with different responsibilities:
- `POST /projects/{script_id}/frames/update` (`UpdateFrameRequest`) — for core storyboard fields (prompt, scene_id, character_ids, etc.)
- `PATCH /projects/{script_id}/frames/{frame_id}/workbench` (`UpdateFrameWorkbenchRequest`) — for R2V workbench UI state only (tab mode, T2I images, generate count)

For HUD/subtitle/episode_state changes on a frame, extend `UpdateFrameRequest` or add a new dedicated endpoint.

---

## Frontend State & API Flow

### Storyboard Asset References (Single Source of Truth)

The R2V storyboard editor has a deliberately centralized asset-reference resolver:

```
frontend/src/components/modules/storyboard-r2v/assetReferences.ts
```

Use this module for **all** character/scene/prop reference-image logic. Do not add ad-hoc image/tag parsing in `StoryboardR2V.tsx`, `AssetDrawer.tsx`, prompt assembly helpers, or shot-panel components.

The resolver owns:
- Merging episode assets with parent series assets via `mergeAssetPools()`
- Preferring series assets that contain generated `stages.reference_images`
- Resolving reference images across legacy fields (`image_url`, `image_asset`, `full_body_asset`, `reference_sheet`, etc.)
- Falling back to the first available stage image when a frozen frame `scene_stage_ref` / `character_stage_refs` points to a stale or missing stage ID
- Parsing reference tags with `parseAssetReferenceTags()`
- Detecting tags with `hasAssetReferenceTags()`
- Stripping tags with `stripAssetReferenceTags()`

Supported prompt reference tags:

```text
[character1:老赵]   # legacy positional generic slot, still supported
[character:老赵]    # typed character tag
[scene:飞机残骸区]  # typed scene tag
[prop:铝合金碎片]   # typed prop tag
```

Important: `[characterN:name]` is legacy and historically acted as a generic positional reference slot, so the resolver intentionally falls back from character → scene → prop for that form.

When generating storyboard images or non-Agnes R2V videos, the frontend must derive `reference_image_urls` from `parseAssetReferenceTags()` against the merged asset pool. If a prompt contains asset tags but the resolver returns zero URLs, block submission and show the resolver's `unresolved` names. Do not silently submit `refs=0` to R2V providers that require asset references.

When generating complete storyboard images, first frames, or start/end keyframes, asset references belong in the image-generation step, not directly in the final video step. `StoryboardR2V.tsx::generateT2I()` must:
- Build tags with `buildPromptWithReferenceTags()`
- Resolve them through `parseAssetReferenceTags()`
- Pass resolved URLs to `api.renderFrame()` as `composition_data.reference_image_urls`
- Append an explicit natural-language mapping of each reference image to the image prompt, e.g. "参考图1是角色「老赵」..." / "参考图2是场景「机舱内」..."
- Block generation when the prompt has asset tags but zero usable reference images, and warn when some referenced assets are unresolved

Do not assume that sending image URLs alone gives a model strong asset identity binding. Agnes Image (`agnes-image-2.0-flash`) accepts reference images through OpenAI-compatible `extra_body.image`, and logs may show `request_mode=i2i`, `ref_count>0`, `resolved_ref_count>0`; this proves transport succeeded, but the model may still treat images as weak visual/style references unless the prompt explicitly binds image N to a role/scene/prop and asks for one complete shot image.

Storyboard R2V workbench tabs are deliberately split into three concepts:
- `asset_compose` / 资产合成: use character/scene/prop asset refs to generate complete shot keyframes. This is where asset tags should influence image generation.
- `keyframe_r2v` / 关键帧 R2V: submit complete shot keyframes to video models. Do not use this as a raw asset-list submission path.
- `t2i_i2v` / 首帧 I2V: generate or upload a first frame, then submit it as an I2V input.

Current implementation notes (July 2026):
- The workbench intentionally supports separate video-provider and Seedance-provider configuration. Do not route official Seedance through a generic OpenAI/video-provider adapter if it would mutate the official request shape. Keep official-provider routing compatible with Volcano/Doubao semantics, and keep relay/provider-specific compatibility in dedicated adapters.
- Seedance is used as a video output model for image/keyframe-based video. It can help with multi-asset-generated complete shot frames, but it should not replace the upstream image model that composes character/scene/prop references into a complete storyboard/keyframe image.
- `gpt-image-2` / OpenAI-compatible image providers may differ between `/v1/images/edits` and `/v1/images/generations + extra_body.image`. Keep compatibility isolated in the image provider adapter, not in storyboard UI code.
- The `t2i_i2v` and `asset_compose` tabs expose an editable `storyboard_image_prompt` field on frame workbench state. Use it only for storyboard/first-frame image generation; do not let it overwrite the shot's main video prompt.
- The `t2i_i2v`, `asset_compose`, and `keyframe_r2v` image slots should share the same mental model: preview, generate/regenerate, upload, selectable candidate pool. Keep media previews compact; avoid full-width image stages that make controls look detached or overlapped.
- The right-side Request Log is the canonical request/task visibility surface. The old top-right Queue panel was removed to reduce duplicated task UI.
- Cast/asset image cards should keep their generating state until the asset image is actually available. Do not clear spinners merely because a request log entry was created.

The `keyframe_r2v` tab exposes editable `keyframe_start_prompt` and `keyframe_end_prompt` fields on the frame workbench state. Use these prompts when generating start/end keyframes; do not rely on a hidden suffix appended to the same base prompt for both frames.

Start/end keyframes are independent workbench slots. Persist the selected images in `keyframe_start_image_url` / `keyframe_end_image_url`, and persist their candidate pools separately in `keyframe_start_image_urls` / `keyframe_end_image_urls`. Do not reuse `t2i_image_urls` as the keyframe candidate source for both slots; that couples the thumbnails and loading state and makes generating a tail frame appear to regenerate the start frame.

POV / subjective-camera protection:
- When the shot prompt or structured camera angle contains `主观视角`, `第一人称`, or `POV`, image generation should append a hard POV constraint: the camera is the subject's eyes/viewpoint; do not show the subject's face, body, back, half-body, or full-body as a third-person composition.
- Character reference images in POV shots should be described as identity/clothing/local-body cues only (hands, sleeves, knees, held objects, watch), not as instructions to place the full character in frame.
- The global storyboard writing skill (`~/.codex/skills/分镜脚本写作/SKILL.md`) has matching guidance. Keep runtime prompt assembly and authoring guidance aligned.

Agnes-specific note: `agnes-video-v2.0` treats `extra_body.image` as visual/keyframe material, not as invisible identity references or an unordered asset library. Do **not** send character reference sheets/full-body sheets or raw scene/prop asset lists to Agnes video refs. The Storyboard R2V UI labels this path as keyframe R2V: generate/upload a complete shot keyframe first, then submit that complete frame as Agnes' video reference. If two complete keyframes are available, submit them as Agnes keyframes (`mode=keyframes`). Asset tags may still be used upstream to compose the keyframe image, but they should be stripped from the Agnes video prompt.

Agnes Video log semantics:
- I2V uses top-level `request_body.image`; this is counted as `image=1`, not as `refs=1`.
- `refs=N` refers only to additional multi-reference / keyframe images sent via `extra_body.image`.
- The operation detail should use `Agnes submit · image=... · refs=... · mode=...`, and debug should include `resolved_inputs.single_image` plus `all_visual_inputs`.
- `refs=0` with `mode=i2v` does not mean the first frame was missing; check `request_body.image` / `single_image`.

Agnes capacity note: Agnes may reject concurrent submissions with `503 Service busy (tasks: 1)`. The backend adapter retries busy submits using `VIDEO_BUSY_RETRY_ATTEMPTS` and `VIDEO_BUSY_RETRY_DELAY`; the frontend should also avoid parallel Agnes batch submissions and clamp Agnes "takes" to 1.

Regression tests for this chain live in:

```
frontend/src/__tests__/storyboard-reference-tags.test.ts
```

Keep tests covering at least:
- Episode empty asset + series asset with generated stage image
- Stale frozen stage ID
- Scene names with leading `-`
- Typed `[scene:...]` / `[prop:...]` tags
- Legacy `[characterN:...]` tags

### API Client (`frontend/src/lib/api.ts`)

All backend calls go through the `api` object (`export const api = { ... }`). Each method:
1. Calls `axios.post/get/delete/patch` to the backend
2. Returns `res.data`

**To add a new API call**, add a new async method to the `api` object following the existing patterns.

### Type Definitions (`frontend/src/store/projectStore.ts`)

Central TypeScript type definitions. When you add a field to a Python model, add it here as `optional` (use `?`). The backend always returns the full `Project`/`Series` object after mutations, so the frontend just replaces the stored value.

### Direct Frame State Pattern

The R2V storyboard editor (`StoryboardR2V.tsx`) reads frame data from the `Project.frames[]` array. When the user edits a frame in the Shot Panel, changes are sent to the backend via `updateFrame()` or `updateFrameWorkbench()`, and the response (full updated `Project` object) replaces local state.

---

## Testing

Tests live in `tests/` and use pytest. Run with:
```bash
cd /Users/zhangjianmin/project/lumenx
source .venv/bin/activate
python -m pytest tests/test_stage_overlay.py -v
```

Key test patterns from `test_stage_overlay.py`:
- Models are constructed directly with minimal required fields (no fixtures needed)
- The `ComicGenPipeline` class is instantiated via `ComicGenPipeline.__new__(ComicGenPipeline)` and only the required attributes are set — avoids the heavy constructor
- Image checks use PIL (`Image.open(...)`) to verify dimensions, mode, and non-empty bounding boxes
- Test files go to `tmp_path` fixtures

### Pyproject Test Config

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
python_files = ["test_*.py", "*_test.py"]
addopts = "-v --tb=short"
```

---

## Naming & Coding Conventions

### Python
- Line length: 100 chars (black + isort)
- Model classes: PascalCase, in `models.py`
- API endpoints: `def`, not `async def` (see above)
- Pipeline methods: snake_case, operate on `self.scripts[script_id]`
- Import style: relative imports within the package (`from .models import ...`)
- All Pydantic models use `Field(...)` with `description=` for every field

### TypeScript
- Interfaces: PascalCase, in `projectStore.ts`
- API methods: camelCase, in `api.ts`
- Components: PascalCase TSX files
- Use `z stand`n` for state management
- Tailwind CSS for styling (dark theme, glassmorphism, neon accents)

### Database
- SQLite via `SQLiteStorageBackend` (in `src/utils/storage.py`)
- Data loaded into memory on startup: `self.scripts` (dict of Script), `self.series_store` (dict of Series)
- Writes go through `self._save_data()` / `self._save_series_data()` with a reentrant lock `self._save_lock`

---

## Common Pitfalls

1. **Forgetting `signed_response()`** — causes frontend decode failures
2. **Using `async def` for blocking handlers** — freezes the event loop, especially during AI model calls
3. **Not updating frontend TS types** — new backend model fields show up as `undefined` in the frontend
4. **Writing to character.full_body_asset instead of stage.reference_images** — stage generation MUST be stage-scoped
5. **Not appending `"无文字、无数字、无logo"` to image prompts** — AI will hallucinate text in overlay/featured mode frames
6. **Re-creating ComicGenPipeline fully** — use `__new__()` in tests to avoid the heavy constructor
7. **Path traversal** — always use `_validate_safe_id()` and `_safe_resolve_path()` for user-supplied path components

---

## Design Context Quick Reference

- **Dark theme only** (`#050508` background), no light mode
- **Glassmorphism** — frosted glass panels with `backdrop-blur`
- **Neon blue** (`#646cff`) primary, **hot pink** (`#ff0080`) accent
- **Brand gradient** — Purple → Indigo → Pink (the "X" in LumenX)
- **Typography**: Space Grotesk (headings), Inter (body), JetBrains Mono (code)
- **Tagline**: "Render Noise into Narrative"
- **Users**: Independent creators who think in stories, not software

---

## Git Rules

- Git author is already configured for this repo — do not modify git config
- **NEVER** add `Co-Authored-By` lines in commit messages
- This checkout is a personal fork maintained by `Wizard-J <79328210@qq.com>`
- Push to the personal GitHub fork (`git@github.com:Wizard-J/lumenx.git`)
- Direct pushes to `main` are allowed for this fork when the user asks to publish or sync work
- The `github` and `origin` remotes may both point to the same fork; prefer `github` when present

## Workflow Triggers

When the user asks about publishing to GitHub, running the publish workflow, or preparing a GitHub-safe branch/commit/PR — load and follow `.codex/workflows/lumenx-git-publish.md`.

When the user asks about onboarding a new model, updating model docs/versions/defaults, or refreshing Wan/Kling/Vidu/PixVerse support — load and follow `.codex/workflows/lumenx-model-onboarding.md`.

When the user asks about building the desktop app, packaging for macOS/Windows, or creating a DMG/EXE build — load and follow `.codex/workflows/lumenx-build.md`.

Legacy Claude command sources live in `.claude/commands/`. Keep behavior parity between Claude and Codex guidance unless the user asks for divergence.

## Backend Startup

```bash
cd /Users/zhangjianmin/project/lumenx
source .venv/bin/activate
# Edit .env first with your API keys
python main.py                    # Desktop mode (pywebview)
# OR for headless development:
uvicorn src.apps.comic_gen.api:app --host 127.0.0.1 --port 17177 --reload
```

## Frontend Development

```bash
cd /Users/zhangjianmin/project/lumenx/frontend
npm install
npm run dev   # Starts on port 3008/3009
```

API Key Configuration: Copy `.env.example` → `.env`, add Alibaba Cloud DashScope API keys.

## Existing API Endpoint Reference

### Projects
- `POST /projects` — Create new project from script text
- `GET /projects` — List all projects
- `GET /projects/{id}` — Get project details
- `DELETE /projects/{id}` — Delete project
- `PUT /projects/{id}/reparse` — Reprocess script

### Assets
- `POST /projects/{id}/generate_assets` — Generate all project assets
- `POST /projects/{id}/assets/generate` — Generate specific asset
- `POST /projects/{id}/assets/toggle_lock` — Lock/unlock asset
- `POST /projects/{id}/assets/stages` — Stage CRUD: create/update/delete/use_image/generate/remove_image
- `POST /projects/{id}/assets/update_attributes` — Update arbitrary asset attributes
- `POST /projects/{id}/assets/update_description` — Update asset description

### Storyboard & Video
- `POST /projects/{id}/generate_storyboard` — Generate storyboards
- `POST /projects/{id}/storyboard/render` — Render specific frame
- `POST /projects/{id}/generate_video` — Generate videos from storyboards
- `POST /projects/{id}/video_tasks` — Create video generation tasks
- `PATCH /projects/{id}/frames/{frame_id}/workbench` — Update R2V workbench state
- `POST /projects/{id}/frames/update` — Update frame fields
- `POST /projects/{id}/merge` — Merge video segments

### Series
- `POST /series` — Create series
- `GET /series` — List all series
- `GET /series/{id}` — Get series details
- `PUT /series/{id}` — Update series
- `DELETE /series/{id}` — Delete series
- `POST /series/{id}/episodes` — Add episode to series
- `DELETE /series/{id}/episodes/{script_id}` — Remove episode from series

### Art Direction
- `POST /projects/{id}/art_direction/analyze` — Analyze script for style
- `POST /projects/{id}/art_direction/save` — Save art direction
- `GET /art_direction/presets` — Get style presets

## Debugging Common Issues

- **FFmpeg not found**: Install FFmpeg and ensure it's in PATH. The system check at `src/utils/system_check.py` probes common install locations.
- **API keys missing**: Configure via `.env` file or app settings dialog.
- **OSS errors**: Verify credentials and bucket permissions in Alibaba Cloud OSS.
- **Video merge failures**: Check if video files exist and have proper relative paths.
- **Modal stuck on 加载配置中...**: Likely caused by an `async def` endpoint doing blocking I/O. Convert to `def`.
- **Frontend can't reach backend**: Backend runs on port 17177. Frontend dev server auto-detects and proxies.

### R2V Preflight & External Video Models

The frontend `generateVideoBatch` has a preflight check for `keyframe_r2v` mode that blocks submission when no complete keyframe image is available for image-based video models. Agnes and other image-based R2V models should receive complete keyframes from the shot image history, not raw asset lists.

Key rules for the R2V preflight:
- `isExternalVideoModel(routeModelId)` → external image-based video path (e.g. Agnes), uses complete keyframes as `referenceImageUrls`
- `isR2vImageBased(routeModelId)` → native image-based R2V model, also uses complete keyframes from the shot
- Non-image R2V legacy routes may still require provider-specific reference media

Three separate locations have this logic (all in `StoryboardR2V.tsx`):
- Preflight in `generateVideoBatch`
- `submitForSingleShot` (`generateVideo`)
- `createOne` inside `generateVideoBatch`

### Reference Tag Generation Chain

The R2V reference image chain works in two phases:

**Phase 1 — Tag Generation** (`buildPromptWithReferenceTags` in `buildAssembledPrompt.ts:125-158`):
1. `buildReferenceTags()` iterates `shot.characterIds`/`sceneId`/`propIds` → matches by **ID** against Episode-level `characters[]`/`scenes[]`/`props[]`
2. Generates tags like `[character1:角色名]` prepended to prompt
3. Scene tags are filtered: only kept if the scene name appears in the raw prompt text
4. Existing user-written tags (e.g. in polished prompt) are preserved and deduped

**Phase 2 — Tag Resolution** (`parseAssetTags` in `StoryboardR2V.tsx:1211-1251`):
1. Parses `[characterN:name]` tags from prompt
2. Looks up by **name** — first in Episode-level data, then Series-level fallback (`seriesAssets`)
3. Calls `resolveAssetReferenceImage()` (`buildAssembledPrompt.ts:11-38`) which tries: stage ref image → `reference_sheet` → `three_views` → `three_view_asset` → `full_body` → `full_body_asset` → legacy URL fields

**Common pitfalls in the tag chain:**
- Phase 1 (tag generation) only uses Episode-level characters. If characters are in Series but not copied to Episode, tags won't be generated even though Phase 2 has Series fallback. This is an asymmetry.
- Scene tags are filtered by name match in the raw prompt — a scene that shares an ID across all shots may be dropped from shots that don't mention the location name.
- Names must match exactly (case-insensitive find) between Phase 1 ID→name lookup and Phase 2 name→resource lookup.
