from fastapi.testclient import TestClient

from src.apps.comic_gen.models import Character, ImageVariant, Script, Series


class _Pipeline:
    def __init__(self):
        self.shared = Character(
            id="shared-zhao", name="老赵", description="中年男人",
            voice_id="local:uncle_fu",
        )
        self.shared.reference_sheet.image_variants = [
            ImageVariant(id="existing-image", url="assets/zhao.png")
        ]
        self.local = Character(
            id="local-zhao", name="老赵",
            description="35-40岁，黑色短发凌乱；服装：浅灰衬衫、深色长裤、深色运动鞋",
            clothing="浅灰衬衫、深色长裤、深色运动鞋",
        )
        self.script = Script(
            id="ep-1", title="第一集", original_text="", series_id="series-1",
            characters=[self.local], created_at=1, updated_at=1,
        )
        self.series = Series(
            id="series-1", title="侏罗纪求生", characters=[self.shared],
            created_at=1, updated_at=1,
        )
        self.scripts = {self.script.id: self.script}
        self.series_store = {self.series.id: self.series}

    def get_script(self, script_id):
        return self.scripts.get(script_id)

    def get_series(self, series_id):
        return self.series_store.get(series_id)

    def _save_data(self):
        pass

    def _save_series_data(self):
        pass


def test_reconcile_updates_visual_metadata_but_preserves_shared_assets(monkeypatch):
    import dotenv
    monkeypatch.setattr(dotenv, "load_dotenv", lambda *args, **kwargs: None)
    from src.apps.comic_gen import api

    pipeline = _Pipeline()
    monkeypatch.setattr(api, "pipeline", pipeline)
    response = TestClient(api.app).post("/projects/ep-1/reconcile/apply", json={
        "characters": [{
            "local_id": "local-zhao",
            "action": "merge_into_series",
            "target_series_id": "shared-zhao",
        }]
    })
    assert response.status_code == 200
    assert pipeline.shared.description == pipeline.local.description
    assert pipeline.shared.clothing == pipeline.local.clothing
    assert pipeline.shared.voice_id == "local:uncle_fu"
    assert pipeline.shared.reference_sheet.image_variants[0].id == "existing-image"
    assert pipeline.script.characters == []
