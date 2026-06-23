import os

import pytest

from src.audio.local_qwen3_tts import LOCAL_PREVIEW_TEXT, LocalQwen3TTSProcessor
from src.apps.comic_gen.audio import AudioGenerator
from src.apps.comic_gen.models import Character, Script, Series
from src.apps.comic_gen.pipeline import ComicGenPipeline


def test_local_voice_catalog_is_offline_and_qwen_compatible():
    voices = LocalQwen3TTSProcessor.list_voices()
    assert "Uncle_Fu" in voices
    assert voices["Uncle_Fu"]["family"] == "qwen3"
    assert voices["Uncle_Fu"]["model"].startswith("local/")
    assert voices["Uncle_Fu"]["preview_text"] == LOCAL_PREVIEW_TEXT


def test_local_processor_reports_setup_command_when_runtime_missing(tmp_path):
    processor = LocalQwen3TTSProcessor(python_path=str(tmp_path / "missing-python"))
    with pytest.raises(RuntimeError, match="setup_local_qwen3_tts.sh"):
        processor.synthesize("你好", str(tmp_path / "out.mp3"), voice="Uncle_Fu")


def test_audio_generator_selects_local_backend(monkeypatch):
    monkeypatch.setenv("TTS_BACKEND", "local_qwen3")
    generator = AudioGenerator()
    assert isinstance(generator.tts, LocalQwen3TTSProcessor)
    assert any(item["id"] == "Uncle_Fu" for item in generator.get_available_voices())


def test_voice_binding_persists_to_series_shared_character():
    character = Character(id="laozhao", name="老赵", description="中年求生者")
    series = Series(id="series-1", title="侏罗纪求生", characters=[character], episode_ids=["ep-1"], created_at=1, updated_at=1)
    episode = Script(id="ep-1", title="第一集", original_text="", series_id=series.id, created_at=1, updated_at=1)
    pipeline = ComicGenPipeline.__new__(ComicGenPipeline)
    pipeline.scripts = {episode.id: episode}
    pipeline.series_store = {series.id: series}
    pipeline._save_series_data = lambda: None
    pipeline._save_data = lambda: None

    pipeline.bind_voice(episode.id, character.id, "Uncle_Fu", "Uncle Fu · 沉稳大叔（本地）")
    assert series.characters[0].voice_id == "Uncle_Fu"
    assert series.characters[0].voice_name.startswith("Uncle Fu")
