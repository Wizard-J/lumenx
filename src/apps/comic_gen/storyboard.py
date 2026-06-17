import os
import time
from typing import Dict, Any, List
from urllib.parse import urlparse
from .models import StoryboardFrame, Character, Scene, Prop, GenerationStatus, ImageAsset, ImageVariant
from ...models.image import WanxImageModel
from ...utils import get_logger
from ...utils.oss_utils import is_object_key

logger = get_logger(__name__)

DEFAULT_STORYBOARD_NEGATIVE_PROMPT = (
    "logo, watermark, signature, username, social media handle, weibo watermark, "
    "text overlay, subtitles, caption, credits, QR code, brand mark, app icon, "
    "corner bug, UI elements, frame border, poster text, illegible text"
)


class StoryboardGenerator:
    def __init__(self, config: Dict[str, Any] = None):
        self.config = config or {}
        self.output_dir = self.config.get('output_dir', 'output/storyboard')

    def _negative_prompt(self) -> str:
        params = self.config.get("model", {}).get("params", {})
        configured = (
            os.environ.get("STORYBOARD_NEGATIVE_PROMPT")
            or params.get("storyboard_negative_prompt")
            or params.get("negative_prompt")
            or ""
        )
        if configured:
            return f"{configured}, {DEFAULT_STORYBOARD_NEGATIVE_PROMPT}"
        return DEFAULT_STORYBOARD_NEGATIVE_PROMPT

    def _get_model(self):
        """Get image model based on current IMAGE_PROVIDER env var."""
        image_provider = os.environ.get("IMAGE_PROVIDER", "dashscope").lower()
        has_key = bool(os.environ.get("IMAGE_API_KEY", ""))
        base_url = os.environ.get("IMAGE_BASE_URL", "")
        is_local_endpoint = urlparse(base_url).hostname in {"localhost", "127.0.0.1", "::1", "0.0.0.0"}
        if image_provider == "openai" and (has_key or is_local_endpoint):
            from ...models.openai_image import OpenAIImageModel
            return OpenAIImageModel(self.config.get('model', {}))
        if image_provider == "comfyui":
            from ...models.comfyui import ComfyUIImageModel
            return ComfyUIImageModel(self.config.get('model', {}))
        return WanxImageModel(self.config.get('model', {}))

    def _model_supports_reference_images(self, model: Any) -> bool:
        checker = getattr(model, "supports_reference_images", None)
        if callable(checker):
            return bool(checker())
        return False

    def _character_consistency_anchor(self, char: Character) -> str:
        parts = [char.name]
        if char.age:
            parts.append(str(char.age))
        if char.gender:
            parts.append(str(char.gender))
        if char.description:
            parts.append(char.description)
        if char.clothing:
            parts.append(f"clothing: {char.clothing}")
        return "，".join(p for p in parts if p)

    def _scene_consistency_anchor(self, scene: Scene) -> str:
        parts = [scene.name]
        if scene.description:
            parts.append(scene.description)
        if scene.time_of_day:
            parts.append(f"time: {scene.time_of_day}")
        if scene.lighting_mood:
            parts.append(f"lighting: {scene.lighting_mood}")
        return "，".join(p for p in parts if p)

    def _inject_text_consistency_prompt(
        self,
        prompt: str,
        frame: StoryboardFrame,
        characters: List[Character],
        scene: Scene,
    ) -> str:
        frame_characters = [
            char for char in characters
            if char.id in frame.character_ids
        ]
        character_lines = [
            self._character_consistency_anchor(char)
            for char in frame_characters
        ]
        character_lines = [line for line in character_lines if line]
        scene_line = self._scene_consistency_anchor(scene) if scene else ""

        if not character_lines and not scene_line:
            return prompt

        anchors = []
        if character_lines:
            anchors.append("角色一致性锁定：" + "；".join(character_lines))
        if scene_line:
            anchors.append("场景一致性锁定：" + scene_line)

        consistency_rules = (
            "纯文生图模式，无可用参考图输入。"
            "请严格保持上述角色的年龄、脸型、发型、体型、服装、标志性细节和主色调一致；"
            "严格保持上述场景的建筑结构、材质、光线、色彩和空间关系一致。"
            "不要重新设计角色或场景。画面中不要出现任何文字、水印、logo、签名或社交媒体标识。"
        )
        return f"{' '.join(anchors)} {consistency_rules} 当前镜头：{prompt}"

    def generate_storyboard(self, script: Any) -> Any:
        """Generates images for all frames in the storyboard."""
        logger.info(f"Generating storyboard for script: {script.title}")
        
        total_frames = len(script.frames)
        for i, frame in enumerate(script.frames):
            logger.info(f"Generating frame {i+1}/{total_frames}: {frame.id}")
            
            # Skip if already completed (unless force regeneration is needed, but for now we skip)
            if frame.status == GenerationStatus.COMPLETED and frame.image_url:
                continue
                
            # Find scene for this frame
            scene = next((s for s in script.scenes if s.id == frame.scene_id), None)
            
            self.generate_frame(frame, script.characters, scene)
            
        return script

    def generate_frame(self, frame: StoryboardFrame, characters: List[Character], scene: Scene, ref_image_path: str = None, ref_image_paths: List[str] = None, prompt: str = None, batch_size: int = 1, size: str = None, model_name: str = None) -> StoryboardFrame:
        """Generates a storyboard frame image."""
        frame.status = GenerationStatus.PROCESSING
        model = self._get_model()
        supports_reference_images = self._model_supports_reference_images(model)
        
        # Default size for storyboard (landscape)
        effective_size = size or "1024*576"
        
        # Construct a rich prompt using character and scene details
        char_descriptions = []
        
        # Collect reference image paths from assets
        asset_ref_paths = []
        
        # If frontend provides explicit reference paths, use them directly
        # Otherwise, auto-collect from characters and scene
        use_frontend_refs = (ref_image_paths and len(ref_image_paths) > 0) or ref_image_path
        
        if use_frontend_refs:
            # Use only what frontend provided (already selected by user)
            if ref_image_paths:
                asset_ref_paths.extend(ref_image_paths)
            if ref_image_path:
                asset_ref_paths.append(ref_image_path)
            logger.info(f"[Storyboard] Using {len(asset_ref_paths)} frontend-provided reference images")
        else:
            # Auto-collect from characters and scene (fallback for batch generation)
            for char_id in frame.character_ids:
                char = next((c for c in characters if c.id == char_id), None)
                if char:
                    # Add character reference image - prioritize selected variant from ImageAsset
                    target_url = None
                    source = "none"
                    
                    # Priority 1: Use selected variant from three_view_asset
                    if char.three_view_asset and char.three_view_asset.selected_id:
                        selected_variant = next((v for v in char.three_view_asset.variants if v.id == char.three_view_asset.selected_id), None)
                        if selected_variant:
                            target_url = selected_variant.url
                            source = f"three_view_asset"
                    
                    # Priority 2: Use selected variant from full_body_asset
                    if not target_url and char.full_body_asset and char.full_body_asset.selected_id:
                        selected_variant = next((v for v in char.full_body_asset.variants if v.id == char.full_body_asset.selected_id), None)
                        if selected_variant:
                            target_url = selected_variant.url
                            source = f"full_body_asset"
                    
                    # Priority 3: Use selected variant from headshot_asset
                    if not target_url and char.headshot_asset and char.headshot_asset.selected_id:
                        selected_variant = next((v for v in char.headshot_asset.variants if v.id == char.headshot_asset.selected_id), None)
                        if selected_variant:
                            target_url = selected_variant.url
                            source = f"headshot_asset"
                    
                    # Priority 4: Fallback to legacy fields
                    if not target_url:
                        target_url = char.three_view_image_url or char.full_body_image_url or char.headshot_image_url or char.avatar_url or char.image_url
                        source = "legacy_fields"
                    
                    logger.info(f"[Storyboard] Character '{char.name}' reference: source={source}, url={target_url}")
                    
                    if target_url:
                        if is_object_key(target_url):
                            asset_ref_paths.append(target_url)
                        else:
                            potential_path = os.path.join("output", target_url)
                            if os.path.exists(potential_path):
                                asset_ref_paths.append(os.path.abspath(potential_path))
                            elif os.path.exists(target_url):
                                asset_ref_paths.append(os.path.abspath(target_url))
            
            # Add scene reference image
            scene_url = None
            if scene:
                if scene.image_asset and scene.image_asset.selected_id:
                    selected_variant = next((v for v in scene.image_asset.variants if v.id == scene.image_asset.selected_id), None)
                    if selected_variant:
                        scene_url = selected_variant.url
                if not scene_url:
                    scene_url = scene.image_url
                
                if scene_url:
                    if is_object_key(scene_url):
                        asset_ref_paths.append(scene_url)
                    else:
                        potential_path = os.path.join("output", scene_url)
                        if os.path.exists(potential_path):
                            asset_ref_paths.append(os.path.abspath(potential_path))
                        elif os.path.exists(scene_url):
                            asset_ref_paths.append(os.path.abspath(scene_url))
        
        # Collect character descriptions for prompt building
        for char_id in frame.character_ids:
            char = next((c for c in characters if c.id == char_id), None)
            if char:
                char_descriptions.append(f"{char.name} ({char.description})")
        
        char_text = ", ".join(char_descriptions)

        # Remove duplicates
        asset_ref_paths = list(set(asset_ref_paths))
        
        if not prompt:
            prompt = f"Storyboard Frame: {frame.action_description}. "
            if char_text:
                prompt += f"Characters: {char_text}. "
            if scene:
                prompt += f"Location: {scene.name}, {scene.description}. "
                
            prompt += f"Camera: {frame.camera_angle}"
            if frame.camera_movement:
                prompt += f", {frame.camera_movement}"
            prompt += "."
        else:
            # If prompt is provided by user/LLM, ensure character descriptions are still present for I2I consistency
            if char_text and char_text not in prompt:
                prompt = f"{prompt} Characters: {char_text}."

        if asset_ref_paths and not supports_reference_images:
            logger.info(
                "[Storyboard] Current image model does not support reference images; "
                "injecting text consistency anchors instead"
            )
            prompt = self._inject_text_consistency_prompt(prompt, frame, characters, scene)
        
        # Store the optimized prompt
        frame.image_prompt = prompt
        negative_prompt = self._negative_prompt()
        
        # Initialize rendered_image_asset if not present
        if not frame.rendered_image_asset:
            frame.rendered_image_asset = ImageAsset(asset_id=frame.id, asset_type="storyboard_frame")

        try:
            import uuid
            
            for _ in range(batch_size):
                variant_id = str(uuid.uuid4())
                output_filename = f"{frame.id}_{variant_id}.png"
                output_path = os.path.join(self.output_dir, output_filename)
                
                # Ensure output directory exists
                os.makedirs(os.path.dirname(output_path), exist_ok=True)

                
                # Use I2I if reference images are available
                # Pass collected asset paths to model
                refs_for_model = asset_ref_paths if supports_reference_images else []
                logger.info(f"[Storyboard] Calling model.generate with {len(refs_for_model)} reference images using model {model_name or 'default'}")
                model.generate(
                    prompt,
                    output_path,
                    ref_image_paths=refs_for_model,
                    size=effective_size,
                    model_name=model_name,
                    negative_prompt=negative_prompt,
                )
                
                # Store relative path for frontend serving
                rel_path = os.path.relpath(output_path, "output")
                
                # Create Variant
                variant = ImageVariant(
                    id=variant_id,
                    url=rel_path,
                    prompt=prompt,
                    created_at=time.time()
                )
                frame.rendered_image_asset.variants.append(variant)
                
                # Auto-select the latest one
                frame.rendered_image_asset.selected_id = variant_id
            
            # Sync legacy fields
            selected_variant = next((v for v in frame.rendered_image_asset.variants if v.id == frame.rendered_image_asset.selected_id), None)
            if selected_variant:
                frame.rendered_image_url = selected_variant.url
                frame.image_url = selected_variant.url
                
            frame.updated_at = time.time()
            frame.status = GenerationStatus.COMPLETED
            
            # Try uploading to OSS if configured - store Object Key (not full URL)
            try:
                from ...utils.oss_utils import OSSImageUploader
                uploader = OSSImageUploader()
                if uploader.is_configured:
                    # Upload the selected variant
                    if selected_variant:
                        # Construct local path from relative path
                        local_path = os.path.join("output", selected_variant.url)
                        if os.path.exists(local_path):
                            # Upload and get Object Key (not full URL)
                            object_key = uploader.upload_file(
                                local_path, 
                                sub_path=f"storyboard"
                            )
                            if object_key:
                                logger.info(f"Uploaded frame {frame.id} to OSS: {object_key}")
                                # Store Object Key (will be converted to signed URL on API response)
                                selected_variant.url = object_key
                                frame.rendered_image_url = object_key
                                frame.image_url = object_key
            except Exception as e:
                logger.error(f"Failed to upload frame {frame.id} to OSS: {e}")
                # Continue even if OSS upload fails
                
        except Exception as e:
            logger.error(f"Failed to generate frame {frame.id}: {e}")
            frame.status = GenerationStatus.FAILED
            
        return frame
