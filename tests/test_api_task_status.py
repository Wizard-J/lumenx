import time

from fastapi.testclient import TestClient

from src.apps.comic_gen.models import Script


class DummyPipeline:
    def __init__(self):
        self.script = Script(
            id="p1",
            title="Project",
            original_text="text",
            created_at=time.time(),
            updated_at=time.time(),
        )

    def get_asset_generation_task_status(self, task_id):
        return {
            "task_id": task_id,
            "status": "completed",
            "script_id": self.script.id,
            "progress": 100,
            "error": None,
        }

    def get_script(self, script_id):
        return self.script if script_id == self.script.id else None


def test_completed_task_status_returns_script_object(monkeypatch):
    import dotenv

    monkeypatch.setattr(dotenv, "load_dotenv", lambda *args, **kwargs: None)
    from src.apps.comic_gen import api

    monkeypatch.setattr(api, "pipeline", DummyPipeline())
    client = TestClient(api.app)

    response = client.get("/tasks/task-1")

    assert response.status_code == 200
    payload = response.json()
    assert isinstance(payload["script"], dict)
    assert payload["script"]["id"] == "p1"
