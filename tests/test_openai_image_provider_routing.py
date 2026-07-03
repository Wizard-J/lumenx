from src.apps.comic_gen.assets import AssetGenerator
from src.apps.comic_gen.models import Character, Scene, StoryboardFrame
from src.apps.comic_gen.storyboard import StoryboardGenerator
from src.models.openai_image import OpenAIImageModel


class _FakeImageData:
    def __init__(self, b64_json: str = "ZmFrZS1pbWFnZQ=="):
        self.url = ""
        self.b64_json = b64_json


class _FakeImageResponse:
    def __init__(self):
        self.data = [_FakeImageData()]


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


def test_gpt_image_with_refs_uses_official_images_edit(monkeypatch, tmp_path):
    calls = {"edit": None, "generate": None}

    class FakeImages:
        def edit(self, **kwargs):
            calls["edit"] = kwargs
            return _FakeImageResponse()

        def generate(self, **kwargs):
            calls["generate"] = kwargs
            return _FakeImageResponse()

    class FakeClient:
        images = FakeImages()

    monkeypatch.setenv("IMAGE_MODEL", "gpt-image-2")
    monkeypatch.setenv("IMAGE_BASE_URL", "https://api.openai.com/v1")
    monkeypatch.setenv("IMAGE_API_KEY", "test-key")

    ref_a = tmp_path / "ref-a.png"
    ref_b = tmp_path / "ref-b.png"
    ref_a.write_bytes(b"fake-a")
    ref_b.write_bytes(b"fake-b")

    model = OpenAIImageModel({"params": {}})
    monkeypatch.setattr(model, "_get_client", lambda: FakeClient())

    output = tmp_path / "out.png"
    model.generate(
        "compose one complete storyboard frame",
        str(output),
        ref_image_paths=[str(ref_a), str(ref_b)],
        size="1024*576",
    )

    assert calls["generate"] is None
    assert calls["edit"] is not None
    assert calls["edit"]["model"] == "gpt-image-2"
    assert calls["edit"]["size"] == "2048x1152"
    assert len(calls["edit"]["image"]) == 2
    assert output.read_bytes() == b"fake-image"


def test_agnes_image_with_refs_keeps_extra_body_generate(monkeypatch, tmp_path):
    calls = {"edit": None, "generate": None}

    class FakeImages:
        def edit(self, **kwargs):
            calls["edit"] = kwargs
            return _FakeImageResponse()

        def generate(self, **kwargs):
            calls["generate"] = kwargs
            return _FakeImageResponse()

    class FakeClient:
        images = FakeImages()

    monkeypatch.setenv("IMAGE_MODEL", "agnes-image-2.0-flash")
    monkeypatch.setenv("IMAGE_BASE_URL", "https://apihub.agnes-ai.com/v1")
    monkeypatch.setenv("IMAGE_API_KEY", "test-key")

    ref = tmp_path / "ref.png"
    ref.write_bytes(b"fake-ref")

    model = OpenAIImageModel({"params": {}})
    monkeypatch.setattr(model, "_get_client", lambda: FakeClient())

    output = tmp_path / "out.png"
    model.generate("compose one complete storyboard frame", str(output), ref_image_paths=[str(ref)])

    assert calls["edit"] is None
    assert calls["generate"] is not None
    assert calls["generate"]["model"] == "agnes-image-2.0-flash"
    assert calls["generate"]["size"] == "1024x1024"
    assert calls["generate"]["extra_body"]["image"][0].startswith("data:image/png;base64,")
    assert output.read_bytes() == b"fake-image"


def test_gpt_image_gateway_retries_with_raw_multipart_edit(monkeypatch, tmp_path):
    calls = {"post": None}

    class FakeImages:
        def edit(self, **kwargs):
            raise RuntimeError("gateway rejected SDK multipart")

    class FakeClient:
        images = FakeImages()

    class FakeHTTPResponse:
        status_code = 200
        reason = "OK"
        text = ""

        def raise_for_status(self):
            return None

        def json(self):
            return {"data": [{"b64_json": "ZmFrZS1pbWFnZQ=="}]}

    def fake_post(url, headers, files, data, timeout):
        calls["post"] = {
            "url": url,
            "headers": headers,
            "files": files,
            "data": data,
            "timeout": timeout,
        }
        return FakeHTTPResponse()

    monkeypatch.setenv("IMAGE_MODEL", "gpt-image-2")
    monkeypatch.setenv("IMAGE_BASE_URL", "https://api.modelverse.cn/v1")
    monkeypatch.setenv("IMAGE_API_KEY", "test-key")
    monkeypatch.setattr("requests.post", fake_post)

    ref_a = tmp_path / "ref-a.png"
    ref_b = tmp_path / "ref-b.png"
    ref_a.write_bytes(b"fake-a")
    ref_b.write_bytes(b"fake-b")

    model = OpenAIImageModel({"params": {}})
    monkeypatch.setattr(model, "_get_client", lambda: FakeClient())

    output = tmp_path / "out.png"
    model.generate("compose one complete storyboard frame", str(output), ref_image_paths=[str(ref_a), str(ref_b)])

    assert calls["post"] is not None
    assert calls["post"]["url"] == "https://api.modelverse.cn/v1/images/edits"
    assert calls["post"]["data"]["model"] == "gpt-image-2"
    assert len(calls["post"]["files"]) == 2
    assert {field for field, _payload in calls["post"]["files"]} == {"image"}
    assert output.read_bytes() == b"fake-image"
