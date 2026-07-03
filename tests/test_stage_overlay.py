from pathlib import Path

from PIL import Image

from src.apps.comic_gen.models import AssetStage, Character, GenerationStatus, ImageAsset, ImageVariant, Prop, Scene, StoryboardFrame, Script, Series
from src.apps.comic_gen.llm import ScriptProcessor
from src.apps.comic_gen.pipeline import ComicGenPipeline
from src.apps.comic_gen.assets import AssetGenerator
from src.apps.comic_gen.overlay_render import HUD_BLUE, WARNING_RED, render_hud_layer, render_subtitle_layer


def test_stage_models_are_backward_compatible_and_frame_refs_are_frozen():
    character = Character(id="laozhao", name="老赵", description="中年求生者")
    assert character.stages == []

    stage = AssetStage(label="恐龙皮", from_episode=6, to_episode=9, visual_delta="粗制恐龙皮披肩")
    character.stages.append(stage)
    frame = StoryboardFrame(
        id="frame-1",
        scene_id="base",
        character_ids=[character.id],
        character_stage_refs={character.id: stage.id},
        scene_stage_ref="stone-six-towers",
    )
    character.stages[0].label = "后来改名"
    assert frame.character_stage_refs == {"laozhao": stage.id}
    assert frame.scene_stage_ref == "stone-six-towers"


def test_pillow_layers_use_real_dimensions_and_transparency(tmp_path: Path):
    hud_path = tmp_path / "hud.png"
    subtitle_path = tmp_path / "subtitle.png"
    size = (854, 480)
    render_hud_layer(size, {"day": 8, "health": 78, "wood": 15, "warnings": ["恐龙接近"]}, {}, str(hud_path))
    render_subtitle_layer(size, {"text": "活下去。", "position": "bottom", "font_size": 28, "color": "#FFFFFF", "stroke": "#000000"}, str(subtitle_path))

    hud = Image.open(hud_path)
    subtitle = Image.open(subtitle_path)
    assert hud.size == size == subtitle.size
    assert hud.mode == "RGBA" and subtitle.mode == "RGBA"
    assert HUD_BLUE == "#4A90D9"
    assert WARNING_RED == "#D93838"
    assert hud.getbbox() is not None
    assert subtitle.getbbox() is not None


def test_hud_markers_and_subtitles_are_normalized_deterministically():
    processor = ScriptProcessor.__new__(ScriptProcessor)
    frames = processor._normalize_overlay_metadata(
        [{"action_summary": "面板在视野中弹出", "dialogue": "木材不够。", "duration": 5}],
        "[HUD:featured] 面板在视野中弹出",
    )
    assert frames[0]["hud_template"]["mode"] == "featured"
    assert frames[0]["subtitle_template"]["text"] == "木材不够。"
    assert "无文字、无数字、无logo" in frames[0]["image_prompt"]


def test_stage_can_adopt_existing_candidate_and_records_generation_prompt():
    stage = AssetStage(id="stage-1", label="晒黑", from_episode=3, to_episode=5, visual_delta="皮肤晒黑")
    character = Character(id="laozhao", name="老赵", description="中年求生者", stages=[stage])
    script = Script(id="ep-1", title="第一集", original_text="", characters=[character], created_at=1, updated_at=1)
    pipeline = ComicGenPipeline.__new__(ComicGenPipeline)
    pipeline.scripts = {script.id: script}
    pipeline.series_store = {}
    pipeline.asset_generation_tasks = {}
    pipeline._save_data = lambda: None
    pipeline._save_series_data = lambda: None

    pipeline.update_asset_stage(script.id, character.id, "character", "use_image", stage.id, {"image_url": "assets/laozhao.png"})
    assert stage.selected_image_id
    assert stage.reference_images[0].url == "assets/laozhao.png"
    pipeline.update_asset_stage(script.id, character.id, "character", "use_image", stage.id, {"image_url": "assets/laozhao.png"})
    assert len(stage.reference_images) == 1

    image_id = stage.selected_image_id
    pipeline.update_asset_stage(script.id, character.id, "character", "remove_image", stage.id, {"image_id": image_id})
    assert stage.reference_images == []
    assert stage.selected_image_id is None

    pipeline.create_asset_generation_task = lambda *args, **kwargs: (script, "task-1")
    pipeline.asset_generation_tasks["task-1"] = {}
    _, task_id = pipeline.update_asset_stage(script.id, character.id, "character", "generate", stage.id, {"prompt": "老赵，明显晒黑，保持五官一致"})
    assert task_id == "task-1"
    assert "exactly three separate full-body views" in stage.last_generation_prompt
    assert "皮肤晒黑" in stage.last_generation_prompt


def test_character_stage_prompt_requires_turnaround_sheet_layout():
    stage = AssetStage(label="恐龙皮", from_episode=6, to_episode=9, visual_delta="披粗制恐龙皮披肩")
    character = Character(id="zhao", name="老赵", description="中年求生者")
    prompt = ComicGenPipeline._build_stage_generation_prompt(character, "character", stage)
    assert "front view" in prompt
    assert "strict side profile view" in prompt
    assert "back view" in prompt
    assert "same scale" in prompt
    assert "披粗制恐龙皮披肩" in prompt


def test_scene_and_prop_stage_prompts_reject_collage_people_and_hands():
    stage = AssetStage(label="基础阶段", from_episode=1, to_episode=12, visual_delta="黄昏岩缝")
    scene = Scene(id="rock", name="岩缝", description="狭窄岩石入口")
    prop = Prop(id="berries", name="灌木丛", description="红色浆果灌木")

    scene_prompt = ComicGenPipeline._build_stage_generation_prompt(scene, "scene", stage)
    prop_prompt = ComicGenPipeline._build_stage_generation_prompt(prop, "prop", stage)
    scene_negative = ComicGenPipeline._stage_reference_negative_prompt("scene")
    prop_negative = ComicGenPipeline._stage_reference_negative_prompt("prop")

    assert "Create exactly one single full-frame environment photograph" in scene_prompt
    assert "reference image" not in scene_prompt.lower()
    assert "No people" in scene_prompt
    assert "contact sheet" in scene_prompt
    assert "weibo mark" in scene_prompt
    assert "contact sheet" in scene_negative
    assert "nine-grid" in scene_negative
    assert "people" in scene_negative
    assert "Create exactly one single centered prop reference photograph only" in prop_prompt
    assert "Prop reference image" not in prop_prompt
    assert "No hands" in prop_prompt
    assert "secondary views" in prop_prompt
    assert "weibo mark" in prop_prompt
    assert "thumbs up" in prop_negative


def test_prop_generation_merges_user_prompt_constraints(tmp_path: Path, monkeypatch):
    captured = {}

    class FakeModel:
        @staticmethod
        def generate(prompt, output_path, **kwargs):
            captured["prompt"] = prompt
            captured["negative_prompt"] = kwargs.get("negative_prompt")
            Path(output_path).write_bytes(b"prop")
            return output_path, {}

    class TestGenerator(AssetGenerator):
        def _get_model(self):
            return FakeModel()

    for key in ("OSS_ENDPOINT", "OSS_BUCKET_NAME", "ALIBABA_CLOUD_ACCESS_KEY_ID", "ALIBABA_CLOUD_ACCESS_KEY_SECRET"):
        monkeypatch.delenv(key, raising=False)

    generator = TestGenerator({"output_dir": str(tmp_path / "assets")})
    prop = Prop(id="berries", name="灌木丛", description="红色浆果灌木")

    generator.generate_prop(prop, negative_prompt="bad anatomy", prompt="No secondary views, no weibo icon.")

    assert "User prompt constraints: No secondary views, no weibo icon." in captured["prompt"]
    assert "Create exactly one single centered prop reference photograph only" in captured["prompt"]
    assert "weibo icon" in captured["negative_prompt"]
    assert prop.image_asset.variants


def test_scene_stage_generation_does_not_reuse_bad_reference_image(tmp_path: Path):
    stage = AssetStage(
        id="stage-1",
        label="基础",
        from_episode=1,
        to_episode=12,
        visual_delta="入口仅可蜷缩一人",
        reference_images=[ImageVariant(id="bad-grid", url="assets/stages/bad_grid.png")],
        selected_image_id="bad-grid",
    )
    scene = Scene(id="rock", name="岩缝", description="内部仅可蜷缩一人", stages=[stage])
    script = Script(id="ep-1", title="第一集", original_text="", scenes=[scene], created_at=1, updated_at=1)
    captured = {}

    class FakeModel:
        @staticmethod
        def generate(prompt, output_path, **kwargs):
            captured["prompt"] = prompt
            captured["ref_image_path"] = kwargs.get("ref_image_path")
            captured["model_name"] = kwargs.get("model_name")
            Path(output_path).write_bytes(b"stage-image")
            return output_path, {}

    class FakeGenerator:
        output_dir = str(tmp_path / "assets")

        @staticmethod
        def _get_model():
            return FakeModel()

    pipeline = ComicGenPipeline.__new__(ComicGenPipeline)
    pipeline.scripts = {script.id: script}
    pipeline.series_store = {}
    pipeline.asset_generator = FakeGenerator()
    pipeline._save_after_asset_mutation = lambda source: None

    pipeline._process_stage_asset_task(
        {"script_id": script.id, "asset_id": scene.id, "asset_type": "scene", "stage_id": stage.id},
        {"batch_size": 1, "aspect_ratio": "16:9"},
    )

    assert captured["ref_image_path"] is None
    assert captured["model_name"] == script.model_settings.t2i_model
    assert "do not draw any person" in captured["prompt"]
    assert stage.reference_images[-1].id != "bad-grid"


def test_shared_stage_generation_uses_series_model_settings(tmp_path: Path):
    stage = AssetStage(
        id="stage-1",
        label="基础",
        from_episode=1,
        to_episode=12,
        visual_delta="红色浆果",
    )
    shared_scene = Scene(id="berries", name="灌木丛", description="岩缝附近的红色果实", stages=[stage])
    script = Script(id="ep-1", title="第一集", original_text="", series_id="series-1", created_at=1, updated_at=1)
    script.model_settings.t2i_model = "agnes-image-2.0-flash"
    series = Series(id="series-1", title="侏罗纪求生", scenes=[shared_scene], created_at=1, updated_at=1)
    series.model_settings.t2i_model = "wan2.7-image-pro"
    captured = {}

    class FakeModel:
        @staticmethod
        def generate(prompt, output_path, **kwargs):
            captured["model_name"] = kwargs.get("model_name")
            captured["ref_image_path"] = kwargs.get("ref_image_path")
            Path(output_path).write_bytes(b"stage-image")
            return output_path, {}

    class FakeGenerator:
        output_dir = str(tmp_path / "assets")

        @staticmethod
        def _get_model():
            return FakeModel()

    pipeline = ComicGenPipeline.__new__(ComicGenPipeline)
    pipeline.scripts = {script.id: script}
    pipeline.series_store = {series.id: series}
    pipeline.asset_generator = FakeGenerator()
    pipeline._save_after_asset_mutation = lambda source: None

    pipeline._process_stage_asset_task(
        {"script_id": script.id, "asset_id": shared_scene.id, "asset_type": "scene", "stage_id": stage.id},
        {"batch_size": 1},
    )

    assert captured["model_name"] == "wan2.7-image-pro"
    assert captured["ref_image_path"] is None


def test_stage_generation_writes_only_stage_pool(tmp_path: Path):
    stage = AssetStage(id="stage-1", label="晒黑", from_episode=3, to_episode=5, visual_delta="皮肤明显晒黑")
    character = Character(id="zhao", name="老赵", description="中年求生者", stages=[stage])
    script = Script(id="ep-1", title="第一集", original_text="", characters=[character], created_at=1, updated_at=1)

    class FakeModel:
        def generate(self, prompt, output_path, **kwargs):
            Path(output_path).write_bytes(b"stage-image")

    class FakeGenerator:
        output_dir = str(tmp_path / "assets")

        @staticmethod
        def _get_model():
            return FakeModel()

    pipeline = ComicGenPipeline.__new__(ComicGenPipeline)
    pipeline.scripts = {script.id: script}
    pipeline.series_store = {}
    pipeline.asset_generator = FakeGenerator()
    pipeline._save_after_asset_mutation = lambda source: None
    prompt = pipeline._build_stage_generation_prompt(character, "character", stage)
    pipeline._process_stage_asset_task(
        {"script_id": script.id, "asset_id": character.id, "asset_type": "character", "stage_id": stage.id},
        {"prompt": prompt, "batch_size": 2, "aspect_ratio": "16:9"},
    )

    assert len(stage.reference_images) == 2
    assert stage.selected_image_id == stage.reference_images[-1].id
    assert character.full_body_asset.variants == []
    assert character.three_view_asset.variants == []


def test_storyboard_render_collects_shared_frozen_stage_references():
    char_stage = AssetStage(
        id="char-stage", label="基础", from_episode=1, to_episode=2,
        reference_images=[ImageVariant(id="char-image", url="https://example.com/zhao.png")],
        selected_image_id="char-image",
    )
    scene_stage = AssetStage(
        id="scene-stage", label="基础", from_episode=1, to_episode=2,
        reference_images=[ImageVariant(id="scene-image", url="https://example.com/forest.png")],
        selected_image_id="scene-image",
    )
    character = Character(id="zhao", name="老赵", description="中年求生者", stages=[char_stage])
    scene = Scene(id="forest", name="森林", description="晨雾森林", stages=[scene_stage])
    frame = StoryboardFrame(
        id="frame-1", scene_id=scene.id, character_ids=[character.id],
        character_stage_refs={character.id: char_stage.id}, scene_stage_ref=scene_stage.id,
        visual_description="老赵站在晨雾森林中",
    )
    script = Script(
        id="ep-1", title="第一集", original_text="", series_id="series-1",
        frames=[frame], created_at=1, updated_at=1,
    )
    series = Series(
        id="series-1", title="侏罗纪求生", characters=[character], scenes=[scene],
        created_at=1, updated_at=1,
    )
    captured = {}

    class FakeStoryboardGenerator:
        @staticmethod
        def generate_frame(target_frame, characters, target_scene, **kwargs):
            captured["refs"] = kwargs["ref_image_paths"]
            captured["scene"] = target_scene.id
            target_frame.rendered_image_url = "storyboard/rendered.png"
            target_frame.status = GenerationStatus.COMPLETED

    pipeline = ComicGenPipeline.__new__(ComicGenPipeline)
    pipeline.scripts = {script.id: script}
    pipeline.series_store = {series.id: series}
    pipeline.storyboard_generator = FakeStoryboardGenerator()
    pipeline._save_data = lambda *args, **kwargs: None

    pipeline.generate_storyboard_render(script.id, frame.id, None, frame.visual_description, 1)

    assert captured["scene"] == scene.id
    assert captured["refs"] == [
        "https://example.com/zhao.png",
        "https://example.com/forest.png",
    ]


def test_reextract_restores_mentioned_shared_entity_and_exact_names_auto_merge():
    image_variant = ImageVariant(id="img-1", url="assets/laozhao.png")
    stage = AssetStage(
        id="stage-1",
        label="基础阶段",
        from_episode=1,
        to_episode=12,
        reference_images=[ImageVariant(id="stage-img", url="assets/stages/laozhao.png")],
        selected_image_id="stage-img",
    )
    shared_zhao = Character(
        id="shared-zhao",
        name="老赵",
        description="旧描述",
        full_body_asset=ImageAsset(selected_id=image_variant.id, variants=[image_variant]),
        image_url=image_variant.url,
        full_body_image_url=image_variant.url,
        stages=[stage],
        status=GenerationStatus.COMPLETED,
    )
    shared_raptor = Character(id="shared-raptor", name="迅猛龙", description="敏捷的恐龙")
    existing = Script(
        id="ep-1", title="第一集", original_text="", series_id="series-1",
        characters=[], created_at=1, updated_at=1,
    )
    parsed = Script(
        id="preview", title="第一集", original_text="",
        characters=[Character(id="new-zhao", name="老赵", description="浅灰衬衫，深色长裤")],
        created_at=1, updated_at=1,
    )
    series = Series(
        id="series-1", title="侏罗纪求生", characters=[shared_zhao, shared_raptor],
        created_at=1, updated_at=1,
    )
    pipeline = ComicGenPipeline.__new__(ComicGenPipeline)
    pipeline.series_store = {series.id: series}
    pipeline._save_series_data = lambda: None

    pipeline._supplement_mentioned_existing_entities(
        existing, parsed, "老赵逃进裂缝，迅猛龙在入口徘徊后离开。"
    )
    assert [item.name for item in parsed.characters] == ["老赵", "迅猛龙"]

    parsed.series_id = series.id
    pipeline._merge_exact_series_entities(parsed)
    assert parsed.characters == []
    assert shared_zhao.description == "浅灰衬衫，深色长裤"
    assert shared_zhao.full_body_asset.variants[0].url == "assets/laozhao.png"
    assert shared_zhao.image_url == "assets/laozhao.png"
    assert shared_zhao.full_body_image_url == "assets/laozhao.png"
    assert shared_zhao.stages[0].reference_images[0].url == "assets/stages/laozhao.png"
    assert shared_zhao.stages[0].selected_image_id == "stage-img"
    assert shared_zhao.status == GenerationStatus.COMPLETED
    assert shared_raptor.description == "敏捷的恐龙"


def test_reextract_preserves_unmentioned_series_assets():
    kept_variant = ImageVariant(id="kept-img", url="assets/forest.png")
    orphan_variant = ImageVariant(id="orphan-img", url="assets/orphan.png")
    kept_scene = Scene(
        id="scene-kept",
        name="森林",
        description="旧森林",
        image_asset=ImageAsset(selected_id=kept_variant.id, variants=[kept_variant]),
        image_url=kept_variant.url,
        status=GenerationStatus.COMPLETED,
    )
    orphan_scene = Scene(
        id="scene-orphan",
        name="旧洞穴",
        description="旧洞穴",
        image_asset=ImageAsset(selected_id=orphan_variant.id, variants=[orphan_variant]),
        image_url=orphan_variant.url,
        status=GenerationStatus.COMPLETED,
    )
    existing = Script(
        id="ep-1",
        title="第一集",
        original_text="旧文本",
        series_id="series-1",
        created_at=1,
        updated_at=1,
    )
    parsed = Script(
        id="preview",
        title="第一集",
        original_text="",
        scenes=[Scene(id="new-forest", name="森林", description="新森林描述")],
        created_at=1,
        updated_at=1,
    )
    series = Series(
        id="series-1",
        title="侏罗纪求生",
        scenes=[kept_scene, orphan_scene],
        created_at=1,
        updated_at=1,
    )
    pipeline = ComicGenPipeline.__new__(ComicGenPipeline)
    pipeline.scripts = {existing.id: existing}
    pipeline.series_store = {series.id: series}
    pipeline._extraction_cache = {existing.id: (9999999999, parsed, True)}
    pipeline._save_series_data = lambda: None
    pipeline._save_data = lambda: None

    pipeline.reparse_project(existing.id, "森林里有新的描述。")

    assert kept_scene.description == "新森林描述"
    assert kept_scene.image_asset.variants[0].url == "assets/forest.png"
    assert kept_scene.image_url == "assets/forest.png"
    assert kept_scene.status == GenerationStatus.COMPLETED
    assert orphan_scene.image_asset.variants[0].url == "assets/orphan.png"
    assert orphan_scene.image_asset.selected_id == "orphan-img"
    assert orphan_scene.image_url == "assets/orphan.png"
    assert orphan_scene.status == GenerationStatus.COMPLETED
