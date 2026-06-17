from src.apps.comic_gen.llm import ScriptProcessor


def test_entity_extraction_prompt_classifies_monsters_as_characters():
    processor = ScriptProcessor.__new__(ScriptProcessor)

    prompt = processor._construct_prompt("暗变蜥蜴从岩缝中爬出，追逐主角。")

    assert "monsters, creatures, animals" in prompt
    assert "classify it as a" in prompt
    assert "character even if it is non-human" in prompt
    assert "Do NOT classify a monster" in prompt
    assert "as a prop" in prompt
