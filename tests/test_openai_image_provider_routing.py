from src.apps.comic_gen.assets import AssetGenerator
from src.apps.comic_gen.models import Character, Scene, StoryboardFrame
from src.apps.comic_gen.storyboard import StoryboardGenerator
from src.models.openai_image import OpenAIImageModel


def test_asset_generator_routes_local_openai_image_without_api_key(monkeypatch):
    monkeypatch.setenv("IMAGE_PROVIDER", "openai")
    monkeypatch.setenv("IMAGE_BASE_URL", "http://127.0.0.1:11434")
    monkeypatch.delenv("IMAGE_API_KEY", raising=False)

    assert isinstance(AssetGenerator()._get_model(), OpenAIImageModel)


def test_storyboard_generator_routes_local_openai_image_without_api_key(monkeypatch):
    monkeypatch.setenv("IMAGE_PROVIDER", "openai")
    monkeypatch.setenv("IMAGE_BASE_URL", "http://localhost:11434")
    monkeypatch.delenv("IMAGE_API_KEY", raising=False)

    assert isinstance(StoryboardGenerator()._get_model(), OpenAIImageModel)


def test_storyboard_injects_consistency_prompt_when_model_has_no_refs(monkeypatch, tmp_path):
    class TextOnlyImageModel:
        def __init__(self):
            self.prompt = ""
            self.ref_image_paths = None
            self.negative_prompt = None

        def supports_reference_images(self):
            return False

        def generate(self, prompt, output_path, **kwargs):
            self.prompt = prompt
            self.ref_image_paths = kwargs.get("ref_image_paths")
            self.negative_prompt = kwargs.get("negative_prompt")
            with open(output_path, "wb") as f:
                f.write(b"fake-image")
            return output_path, 0.01

    model = TextOnlyImageModel()
    generator = StoryboardGenerator({"output_dir": str(tmp_path / "storyboard")})
    monkeypatch.setattr(generator, "_get_model", lambda: model)

    ref_path = tmp_path / "linyan.png"
    ref_path.write_bytes(b"fake-ref")
    frame = StoryboardFrame(
        id="frame-1",
        scene_id="scene-1",
        character_ids=["char-1"],
        action_description="林砚蹲在棚屋门口修鞋",
    )
    character = Character(
        id="char-1",
        name="林砚",
        description="瘦削少年，黑色乱发，掌心有白色裂纹",
        age="17岁",
        clothing="破旧灰褐短袍，右手腕缠灰布条",
    )
    scene = Scene(
        id="scene-1",
        name="棚户区",
        description="黄沙覆盖的废弃棚屋区，破木门，灰布帘",
        time_of_day="夕阳",
        lighting_mood="金色尘雾",
    )

    generator.generate_frame(
        frame,
        [character],
        scene,
        ref_image_paths=[str(ref_path)],
        prompt="林砚蹲在棚屋门口修鞋。近景，平视。",
    )

    assert model.ref_image_paths == []
    assert "纯文生图模式" in model.prompt
    assert "角色一致性锁定：林砚" in model.prompt
    assert "17岁" in model.prompt
    assert "破旧灰褐短袍" in model.prompt
    assert "场景一致性锁定：棚户区" in model.prompt
    assert "水印" in model.prompt
    assert "logo" in model.negative_prompt
    assert "watermark" in model.negative_prompt
    assert "social media handle" in model.negative_prompt
    assert frame.image_prompt == model.prompt
