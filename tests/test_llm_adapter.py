import sys
import types

from src.apps.comic_gen.llm_adapter import LLMAdapter


def test_openai_provider_local_ollama_is_configured_without_api_key(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    monkeypatch.setenv("LLM_BASE_URL", "http://localhost:11434")
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    adapter = LLMAdapter()

    assert adapter.is_configured is True


def test_openai_provider_local_ollama_base_url_gets_v1(monkeypatch):
    captured = {}

    class FakeOpenAI:
        def __init__(self, api_key, base_url):
            captured["api_key"] = api_key
            captured["base_url"] = str(base_url)

    monkeypatch.setitem(sys.modules, "openai", types.SimpleNamespace(OpenAI=FakeOpenAI))
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    monkeypatch.setenv("LLM_BASE_URL", "http://localhost:11434")
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    adapter = LLMAdapter()
    adapter._get_client()

    assert captured["api_key"] == "ollama"
    assert captured["base_url"] == "http://localhost:11434/v1"
