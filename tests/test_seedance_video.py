from types import SimpleNamespace

from src.apps.comic_gen.pipeline import ComicGenPipeline
from src.models.seedance import SeedanceVideoModel


class FakeTasks:
    def __init__(self):
        self.created = None

    def create(self, **kwargs):
        self.created = kwargs
        return SimpleNamespace(id="seedance-task-1")

    def get(self, task_id):
        assert task_id == "seedance-task-1"
        return SimpleNamespace(
            status="succeeded",
            content=SimpleNamespace(video_url="https://cdn.example.com/seedance.mp4"),
        )


class FakeArk:
    last_tasks = None

    def __init__(self, base_url, api_key):
        self.base_url = base_url
        self.api_key = api_key
        tasks = FakeTasks()
        FakeArk.last_tasks = tasks
        self.content_generation = SimpleNamespace(tasks=tasks)


def test_pipeline_routes_seedance_model_to_seedance_adapter(monkeypatch):
    pipeline = ComicGenPipeline.__new__(ComicGenPipeline)
    pipeline.config = {"video": {"model": {}}}

    assert isinstance(
        pipeline._get_video_model("seedance-2.0-r2v"),
        SeedanceVideoModel,
    )


def test_seedance_keyframe_and_reference_images_are_role_tagged(monkeypatch, tmp_path):
    monkeypatch.setenv("ARK_API_KEY", "test-key")
    monkeypatch.setattr("src.models.seedance.Ark", FakeArk)
    monkeypatch.setattr("src.models.seedance.time.sleep", lambda *_: None)
    monkeypatch.setattr("src.models.seedance.SeedanceVideoModel._download_video", lambda *a, **k: None)

    model = SeedanceVideoModel({})
    model.generate(
        prompt="A complete shot, cinematic motion.",
        output_path=str(tmp_path / "out.mp4"),
        model="seedance-2.0-r2v",
        duration=5,
        resolution="1080p",
        ratio="16:9",
        ref_image_urls=[
            "https://cdn.example.com/start.png",
            "https://cdn.example.com/end.png",
            "https://cdn.example.com/character.png",
            "https://cdn.example.com/scene.png",
        ],
        mode="keyframes",
    )

    created = FakeArk.last_tasks.created
    assert created["model"] == "dreamina-seedance-2-0-260128"
    assert created["duration"] == 5
    assert created["resolution"] == "1080p"
    assert created["ratio"] == "16:9"
    assert [item.get("role") for item in created["content"][1:]] == [
        "first_frame",
        "last_frame",
        "reference_image",
        "reference_image",
    ]
    assert [item["image_url"]["url"] for item in created["content"][1:]] == [
        "https://cdn.example.com/start.png",
        "https://cdn.example.com/end.png",
        "https://cdn.example.com/character.png",
        "https://cdn.example.com/scene.png",
    ]


def test_seedance_i2v_image_url_is_first_frame(monkeypatch, tmp_path):
    monkeypatch.setenv("ARK_API_KEY", "test-key")
    monkeypatch.setattr("src.models.seedance.Ark", FakeArk)
    monkeypatch.setattr("src.models.seedance.SeedanceVideoModel._download_video", lambda *a, **k: None)

    model = SeedanceVideoModel({})
    model.generate(
        prompt="Animate the frame.",
        output_path=str(tmp_path / "out.mp4"),
        model="seedance-2.0-i2v",
        img_url="https://cdn.example.com/start.png",
    )

    created = FakeArk.last_tasks.created
    assert created["content"][1]["role"] == "first_frame"
    assert created["content"][1]["image_url"]["url"] == "https://cdn.example.com/start.png"


def test_seedance_modelverse_uses_submit_status_contract(monkeypatch, tmp_path):
    posts = []
    gets = []

    class PostResponse:
        ok = True
        status_code = 200

        def json(self):
            return {"output": {"task_id": "mv-task-1"}}

    class GetResponse:
        ok = True
        status_code = 200

        def json(self):
            return {
                "output": {
                    "task_status": "Success",
                    "urls": ["https://cdn.example.com/modelverse.mp4"],
                }
            }

    def fake_post(url, **kwargs):
        posts.append((url, kwargs))
        return PostResponse()

    def fake_get(url, **kwargs):
        gets.append((url, kwargs))
        return GetResponse()

    monkeypatch.setenv("SEEDANCE_PROVIDER", "modelverse")
    monkeypatch.setenv("SEEDANCE_API_KEY", "modelverse-key")
    monkeypatch.setenv("SEEDANCE_BASE_URL", "https://api.modelverse.cn")
    monkeypatch.setattr("src.models.seedance.requests.post", fake_post)
    monkeypatch.setattr("src.models.seedance.requests.get", fake_get)
    monkeypatch.setattr("src.models.seedance.SeedanceVideoModel._download_video", lambda *a, **k: None)

    model = SeedanceVideoModel({})
    model.generate(
        prompt="A complete shot, cinematic motion.",
        output_path=str(tmp_path / "out.mp4"),
        model="seedance-2.0-r2v",
        duration=5,
        resolution="1080p",
        ratio="16:9",
        ref_image_urls=[
            "https://cdn.example.com/start.png",
            "https://cdn.example.com/end.png",
            "https://cdn.example.com/character.png",
        ],
        mode="keyframes",
    )

    assert posts[0][0] == "https://api.modelverse.cn/v1/tasks/submit"
    assert posts[0][1]["headers"]["Authorization"] == "modelverse-key"
    body = posts[0][1]["json"]
    assert body["model"] == "doubao-seedance-2-0-260128"
    assert body["parameters"] == {
        "duration": 5,
        "resolution": "1080p",
        "ratio": "16:9",
    }
    assert [item.get("role") for item in body["input"]["content"][1:]] == [
        "first_frame",
        "last_frame",
        "reference_image",
    ]
    assert gets[0][0] == "https://api.modelverse.cn/v1/tasks/status"
    assert gets[0][1]["params"] == {"task_id": "mv-task-1"}
