from pathlib import Path

import pytest
import requests

from src.models.agnes_video import AgnesVideoModel, _duration_to_frames
from src.apps.comic_gen.pipeline import ComicGenPipeline


def test_duration_is_normalized_to_agnes_8n_plus_1_rule():
    assert _duration_to_frames(1, 24) == 25
    assert _duration_to_frames(2, 24) == 49
    assert _duration_to_frames(5, 24) == 121
    assert _duration_to_frames(10, 24) == 241
    assert _duration_to_frames(15, 24) == 361


def test_base_url_accepts_optional_v1_suffix(monkeypatch):
    monkeypatch.setenv("VIDEO_BASE_URL", "https://apihub.agnes-ai.com/v1/")
    assert AgnesVideoModel({}).base_url == "https://apihub.agnes-ai.com"


def test_pipeline_routes_selected_agnes_model_to_agnes_adapter(monkeypatch):
    monkeypatch.setenv("VIDEO_PROVIDER", "openai")
    monkeypatch.setenv("VIDEO_API_KEY", "test-key")
    monkeypatch.setenv("VIDEO_MODEL", "some-openai-video-model")

    pipeline = ComicGenPipeline.__new__(ComicGenPipeline)
    pipeline.config = {"video": {"model": {}}}

    assert isinstance(
        pipeline._get_video_model("agnes-video-v2.0"),
        AgnesVideoModel,
    )


def test_explicit_model_name_overrides_video_model_env(monkeypatch, tmp_path: Path):
    captured = {}

    class Response:
        ok = True

        def json(self):
            return {"id": "task_123", "video_id": "video_123", "status": "processing"}

    def fake_post(*args, **kwargs):
        captured["json"] = kwargs["json"]
        return Response()

    monkeypatch.setenv("VIDEO_API_KEY", "test-key")
    monkeypatch.setenv("VIDEO_MODEL", "env-video-model")
    monkeypatch.setattr("src.models.agnes_video.requests.post", fake_post)
    monkeypatch.setattr("src.models.agnes_video.enter_operation", lambda *a, **k: 1)
    monkeypatch.setattr("src.models.agnes_video.update_operation", lambda *a, **k: True)
    monkeypatch.setattr(
        "src.models.agnes_video.AgnesVideoModel._poll_agnes",
        lambda *a, **k: "https://cdn.example.com/out.mp4",
    )
    monkeypatch.setattr(
        "src.models.agnes_video.AgnesVideoModel._download_video",
        lambda *a, **k: None,
    )

    AgnesVideoModel({}).generate(
        prompt="test",
        output_path=str(tmp_path / "out.mp4"),
        model_name="agnes-video-v2.0",
        duration=2,
    )

    assert captured["json"]["model"] == "agnes-video-v2.0"


def test_submit_timeout_defaults_to_300_and_is_configurable(monkeypatch):
    monkeypatch.delenv("VIDEO_SUBMIT_TIMEOUT", raising=False)
    assert AgnesVideoModel({}).submit_timeout == 300
    monkeypatch.setenv("VIDEO_SUBMIT_TIMEOUT", "240")
    assert AgnesVideoModel({}).submit_timeout == 240
    monkeypatch.setenv("VIDEO_SUBMIT_TIMEOUT", "invalid")
    assert AgnesVideoModel({}).submit_timeout == 300


def test_remote_image_is_preferred_over_downloaded_copy(tmp_path: Path):
    local = tmp_path / "frame.png"
    local.write_bytes(b"local image")
    model = AgnesVideoModel({})

    assert model._resolve_single_image(
        "https://cdn.example.com/frame.png", str(local)
    ) == "https://cdn.example.com/frame.png"


def test_single_image_object_key_is_signed(monkeypatch):
    class DummyUploader:
        is_configured = True

        def sign_url_for_api(self, object_key):
            return f"https://signed.example.com/{object_key}"

    monkeypatch.setattr("src.models.agnes_video.OSSImageUploader", lambda: DummyUploader())
    monkeypatch.setattr("src.models.agnes_video.is_object_key", lambda value: value.startswith("lumenx/"))

    model = AgnesVideoModel({})
    assert model._resolve_single_image("lumenx/storyboard/frame.png", None) == (
        "https://signed.example.com/lumenx/storyboard/frame.png"
    )


def test_ref_image_urls_are_resolved_instead_of_forwarded_raw(monkeypatch, tmp_path: Path):
    captured = {}

    class DummyUploader:
        is_configured = True

        def sign_url_for_api(self, object_key):
            return f"https://signed.example.com/{object_key}"

    class Response:
        ok = True

        def json(self):
            return {"id": "task_123", "video_id": "video_123", "status": "processing"}

    def fake_post(*args, **kwargs):
        captured["json"] = kwargs["json"]
        return Response()

    monkeypatch.setenv("VIDEO_API_KEY", "test-key")
    monkeypatch.setattr("src.models.agnes_video.OSSImageUploader", lambda: DummyUploader())
    monkeypatch.setattr("src.models.agnes_video.is_object_key", lambda value: value.startswith("lumenx/"))
    monkeypatch.setattr("src.models.agnes_video.requests.post", fake_post)
    monkeypatch.setattr("src.models.agnes_video.enter_operation", lambda *a, **k: 1)
    monkeypatch.setattr("src.models.agnes_video.update_operation", lambda *a, **k: True)
    monkeypatch.setattr(
        "src.models.agnes_video.AgnesVideoModel._poll_agnes",
        lambda *a, **k: "https://cdn.example.com/out.mp4",
    )
    monkeypatch.setattr(
        "src.models.agnes_video.AgnesVideoModel._download_video",
        lambda *a, **k: None,
    )

    AgnesVideoModel({}).generate(
        prompt="test",
        output_path=str(tmp_path / "out.mp4"),
        model_name="agnes-video-v2.0",
        duration=2,
        ref_image_urls=["lumenx/storyboard/frame.png"],
        mode="keyframes",
    )

    assert captured["json"]["extra_body"]["image"] == [
        "https://signed.example.com/lumenx/storyboard/frame.png"
    ]


def test_operation_log_contains_resolved_reference_images(monkeypatch, tmp_path: Path):
    updates = []

    class DummyUploader:
        is_configured = True

        def sign_url_for_api(self, object_key):
            return f"https://signed.example.com/{object_key}"

    class Response:
        ok = False
        status_code = 400
        reason = "Bad Request"
        text = '{"error":{"message":"bad image"}}'

        def json(self):
            return {"error": {"message": "bad image"}}

    monkeypatch.setenv("VIDEO_API_KEY", "test-key")
    monkeypatch.setattr("src.models.agnes_video.OSSImageUploader", lambda: DummyUploader())
    monkeypatch.setattr("src.models.agnes_video.is_object_key", lambda value: value.startswith("lumenx/"))
    monkeypatch.setattr("src.models.agnes_video.requests.post", lambda *a, **k: Response())
    monkeypatch.setattr("src.models.agnes_video.enter_operation", lambda *a, **k: 1)
    monkeypatch.setattr(
        "src.models.agnes_video.update_operation",
        lambda *a, **k: updates.append((a, k)) or True,
    )

    with pytest.raises(RuntimeError):
        AgnesVideoModel({}).generate(
            prompt="test",
            output_path=str(tmp_path / "out.mp4"),
            duration=2,
            ref_image_urls=["lumenx/storyboard/frame.png"],
            mode="keyframes",
        )

    last_kwargs = updates[-1][1]
    assert last_kwargs["debug"]["resolved_inputs"]["resolved_ref_image_urls"] == [
        "https://signed.example.com/lumenx/storyboard/frame.png"
    ]
    assert last_kwargs["debug"]["request_body"]["extra_body"]["image"] == [
        "https://signed.example.com/lumenx/storyboard/frame.png"
    ]
    assert last_kwargs["response"]["status_code"] == 400


def test_local_reference_asset_prefers_signed_url_over_data_uri(monkeypatch, tmp_path: Path):
    captured = {}
    asset_dir = tmp_path / "output" / "assets" / "stages"
    asset_dir.mkdir(parents=True)
    asset_path = asset_dir / "frame.png"
    asset_path.write_bytes(b"fake png bytes")

    class DummyUploader:
        is_configured = True

        def upload_file(self, local_path, sub_path=""):
            # Accept relative or absolute; verify it points to the right file
            assert "frame.png" in local_path
            return f"lumenx/{sub_path}/frame.png"

        def sign_url_for_api(self, object_key):
            return f"https://signed.example.com/{object_key}"

    class Response:
        ok = True

        def json(self):
            return {"id": "task_123", "video_id": "video_123", "status": "processing"}

    def fake_post(*args, **kwargs):
        captured["json"] = kwargs["json"]
        return Response()

    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("VIDEO_API_KEY", "test-key")
    monkeypatch.setattr("src.models.agnes_video.OSSImageUploader", lambda: DummyUploader())
    monkeypatch.setattr("src.models.agnes_video.is_object_key", lambda value: value.startswith("lumenx/"))
    monkeypatch.setattr("src.models.agnes_video.requests.post", fake_post)
    monkeypatch.setattr("src.models.agnes_video.enter_operation", lambda *a, **k: 1)
    monkeypatch.setattr("src.models.agnes_video.update_operation", lambda *a, **k: True)
    monkeypatch.setattr(
        "src.models.agnes_video.AgnesVideoModel._poll_agnes",
        lambda *a, **k: "https://cdn.example.com/out.mp4",
    )
    monkeypatch.setattr(
        "src.models.agnes_video.AgnesVideoModel._download_video",
        lambda *a, **k: None,
    )

    AgnesVideoModel({}).generate(
        prompt="test",
        output_path=str(tmp_path / "out.mp4"),
        duration=2,
        ref_image_urls=["assets/stages/frame.png"],
        mode="keyframes",
    )

    assert captured["json"]["extra_body"]["image"] == [
        "https://signed.example.com/lumenx/temp/agnes_video/frame.png"
    ]


def test_local_asset_uses_local_serve_url_when_no_oss(monkeypatch, tmp_path: Path):
    """When OSS is NOT configured but LOCAL_SERVE_BASE_URL IS set,
    local asset files should be served via /local-file/ HTTP URL
    instead of falling through to an oversized data URI."""
    captured = {}
    asset_dir = tmp_path / "assets" / "stages"
    asset_dir.mkdir(parents=True)
    asset_path = asset_dir / "frame.png"
    asset_path.write_bytes(b"fake png bytes")

    class Response:
        ok = True

        def json(self):
            return {"id": "task_123", "video_id": "video_123", "status": "processing"}

    def fake_post(*args, **kwargs):
        captured["json"] = kwargs["json"]
        return Response()

    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("VIDEO_API_KEY", "test-key")
    monkeypatch.setenv("LOCAL_SERVE_BASE_URL", "http://localhost:8000")
    # OSS is NOT configured (default OSSImageUploader has is_configured=False)
    monkeypatch.setattr("src.models.agnes_video.requests.post", fake_post)
    monkeypatch.setattr("src.models.agnes_video.enter_operation", lambda *a, **k: 1)
    monkeypatch.setattr("src.models.agnes_video.update_operation", lambda *a, **k: True)
    monkeypatch.setattr(
        "src.models.agnes_video.AgnesVideoModel._poll_agnes",
        lambda *a, **k: "https://cdn.example.com/out.mp4",
    )
    monkeypatch.setattr(
        "src.models.agnes_video.AgnesVideoModel._download_video",
        lambda *a, **k: None,
    )

    AgnesVideoModel({}).generate(
        prompt="test",
        output_path=str(tmp_path / "out.mp4"),
        duration=2,
        ref_image_urls=["assets/stages/frame.png"],
        mode="keyframes",
    )

    image_list = captured["json"]["extra_body"]["image"]
    assert len(image_list) == 1
    url = image_list[0]
    assert url.startswith("http://localhost:8000/local-file/assets/stages/frame.png")



def test_submit_error_includes_provider_response(monkeypatch, tmp_path: Path):
    class Response:
        ok = False
        status_code = 400
        reason = "Bad Request"
        text = '{"error":{"message":"num_frames must follow 8n + 1"}}'

        def json(self):
            return {"error": {"message": "num_frames must follow 8n + 1"}}

    monkeypatch.setenv("VIDEO_API_KEY", "test-key")
    monkeypatch.setattr("src.models.agnes_video.requests.post", lambda *a, **k: Response())
    monkeypatch.setattr("src.models.agnes_video.enter_operation", lambda *a, **k: 1)
    monkeypatch.setattr("src.models.agnes_video.update_operation", lambda *a, **k: True)

    with pytest.raises(RuntimeError, match=r"HTTP 400.*8n \+ 1"):
        AgnesVideoModel({}).generate(
            prompt="test", output_path=str(tmp_path / "out.mp4"), duration=2
        )


def test_submit_uses_separate_connect_and_read_timeouts(monkeypatch, tmp_path: Path):
    captured = {}

    class Response:
        ok = False
        status_code = 400
        reason = "Bad Request"
        text = "bad request"

        def json(self):
            return {"error": "bad request"}

    def fake_post(*args, **kwargs):
        captured.update(kwargs)
        return Response()

    monkeypatch.setenv("VIDEO_API_KEY", "test-key")
    monkeypatch.setenv("VIDEO_SUBMIT_TIMEOUT", "240")
    monkeypatch.setattr("src.models.agnes_video.requests.post", fake_post)
    monkeypatch.setattr("src.models.agnes_video.enter_operation", lambda *a, **k: 1)
    monkeypatch.setattr("src.models.agnes_video.update_operation", lambda *a, **k: True)

    with pytest.raises(RuntimeError):
        AgnesVideoModel({}).generate(
            prompt="test", output_path=str(tmp_path / "out.mp4"), duration=2
        )

    assert captured["timeout"] == (15, 240)


def test_submit_read_timeout_has_actionable_message(monkeypatch, tmp_path: Path):
    updates = []

    def fake_post(*args, **kwargs):
        raise requests.ReadTimeout(
            "HTTPSConnectionPool(host='apihub.agnes-ai.com', port=443): Read timed out."
        )

    monkeypatch.setenv("VIDEO_API_KEY", "test-key")
    monkeypatch.setenv("VIDEO_SUBMIT_TIMEOUT", "240")
    monkeypatch.setattr("src.models.agnes_video.requests.post", fake_post)
    monkeypatch.setattr("src.models.agnes_video.enter_operation", lambda *a, **k: 1)
    monkeypatch.setattr(
        "src.models.agnes_video.update_operation",
        lambda *a, **k: updates.append((a, k)) or True,
    )

    with pytest.raises(RuntimeError, match="submit timed out after 240s"):
        AgnesVideoModel({}).generate(
            prompt="test", output_path=str(tmp_path / "out.mp4"), duration=2
        )

    assert "provider queue/log" in updates[-1][1]["exception"]["message"]


def test_submit_retries_when_agnes_service_is_busy(monkeypatch, tmp_path: Path):
    calls = []
    updates = []

    class BusyResponse:
        ok = False
        status_code = 503
        reason = "Service Unavailable"
        text = '{"error":{"message":"Service busy (tasks: 1)"}}'

        def json(self):
            return {
                "code": "fail_to_fetch_task",
                "message": '{"error":{"message":"Service busy (tasks: 1)"}}',
                "data": None,
            }

    class OkResponse:
        ok = True
        status_code = 200

        def json(self):
            return {"id": "task_123", "video_id": "video_123", "status": "processing"}

    def fake_post(*args, **kwargs):
        calls.append(kwargs)
        return BusyResponse() if len(calls) == 1 else OkResponse()

    monkeypatch.setenv("VIDEO_API_KEY", "test-key")
    monkeypatch.setenv("VIDEO_BUSY_RETRY_ATTEMPTS", "2")
    monkeypatch.setenv("VIDEO_BUSY_RETRY_DELAY", "5")
    monkeypatch.setattr("src.models.agnes_video.time.sleep", lambda *_: None)
    monkeypatch.setattr("src.models.agnes_video.requests.post", fake_post)
    monkeypatch.setattr("src.models.agnes_video.enter_operation", lambda *a, **k: 1)
    monkeypatch.setattr(
        "src.models.agnes_video.update_operation",
        lambda *a, **k: updates.append((a, k)) or True,
    )
    monkeypatch.setattr(
        "src.models.agnes_video.AgnesVideoModel._poll_agnes",
        lambda *a, **k: "https://cdn.example.com/out.mp4",
    )
    monkeypatch.setattr(
        "src.models.agnes_video.AgnesVideoModel._download_video",
        lambda *a, **k: None,
    )

    AgnesVideoModel({}).generate(
        prompt="test", output_path=str(tmp_path / "out.mp4"), duration=2
    )

    assert len(calls) == 2
    assert any("Agnes busy" in update[1].get("detail", "") for update in updates)
