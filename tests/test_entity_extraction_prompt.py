from src.apps.comic_gen.llm import ScriptProcessor


def test_entity_extraction_prompt_classifies_monsters_as_characters():
    processor = ScriptProcessor.__new__(ScriptProcessor)

    prompt = processor._construct_prompt("暗变蜥蜴从岩缝中爬出，追逐主角。")

    assert "monsters, creatures, animals" in prompt
    assert "classify it as a" in prompt
    assert "character even if it is non-human" in prompt
    assert "Do NOT classify a monster" in prompt
    assert "as a prop" in prompt


def test_entity_extraction_keeps_clothing_in_self_contained_description():
    processor = ScriptProcessor.__new__(ScriptProcessor)
    prompt = processor._construct_prompt("老赵穿浅灰衬衫和深色长裤。")
    assert "SELF-CONTAINED" in prompt
    assert "Do not omit clothing" in prompt
    assert "COMPLETENESS IS MANDATORY" in prompt

    script = processor._create_script_from_data("第一集", "", {
        "characters": [{
            "name": "老赵",
            "description": "35-40岁，黑色短发，普通身材",
            "clothing": "浅灰衬衫、深色长裤、深色运动鞋",
        }]
    })
    assert "服装：浅灰衬衫、深色长裤、深色运动鞋" in script.characters[0].description
