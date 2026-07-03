from src.apps.comic_gen.models import GenerationStatus, ImageAsset, ImageVariant, Prop, Scene, Script, Series
from src.apps.comic_gen.llm import ScriptProcessor
from src.apps.comic_gen.pipeline import ComicGenPipeline


NORMALIZED_TEXT = """# 第一集

## 角色
老赵：35-40岁，普通身材，黑色短发，灰色衬衫，神情警觉。
迅猛龙：两米高的肉食恐龙，细密鳞片，黄色竖瞳，钩爪明显。

## 场景
机舱内：日间客机机舱，舷窗明亮，两排座位。
密林：原始森林内部，高大树干密集，地面覆落叶。

## 道具
行李箱：黑色硬壳行李箱，半露在行李架中。

## 分镜
**镜头 01** | 约4s | 中景 | 平视
【场景：机舱内 · 角色：老赵 · 道具：行李箱】
0-2s: 老赵靠窗而坐，晨光照亮右脸。
2-4s: 飞机轻微颠簸，行李箱从行李架半露出来。
**音效**：机舱白噪音。
**备注**：无。

**镜头 02** | 约5s | 全景 | 平视
【场景：密林 · 角色：老赵、迅猛龙 · 道具：无】
0-2s: 老赵在密林中回头，脚步急促。
2-5s: 迅猛龙从树影中逼近，老赵转身逃跑。
**音效**：树叶声和急促脚步声。
**备注**：无。
"""


def test_normalize_extract_storyboard_overwrites_text_and_generates_frames():
    script = Script(
        id="ep-1",
        title="第一集",
        original_text="散乱原文",
        created_at=1,
        updated_at=1,
    )
    pipeline = ComicGenPipeline.__new__(ComicGenPipeline)
    pipeline.scripts = {script.id: script}
    pipeline.series_store = {}
    pipeline.script_processor = ScriptProcessor.__new__(ScriptProcessor)
    pipeline._extraction_cache = {}
    pipeline._save_data = lambda *args, **kwargs: None
    pipeline._save_series_data = lambda *args, **kwargs: None

    updated = pipeline.normalize_extract_storyboard(
        script.id,
        "散乱原文",
        normalized_text=NORMALIZED_TEXT,
    )

    assert updated.original_text == NORMALIZED_TEXT.strip()
    assert [c.name for c in updated.characters] == ["老赵", "迅猛龙"]
    assert [s.name for s in updated.scenes] == ["机舱内", "密林"]
    assert [p.name for p in updated.props] == ["行李箱"]
    assert len(updated.frames) == 2
    assert updated.frames[0].scene_id == updated.scenes[0].id
    assert updated.frames[0].character_ids == [updated.characters[0].id]
    assert updated.frames[0].prop_ids == [updated.props[0].id]
    assert updated.frames[0].duration == 4
    assert updated.frames[1].scene_id == updated.scenes[1].id
    assert set(updated.frames[1].character_ids) == {updated.characters[0].id, updated.characters[1].id}


def test_reparse_preserves_generated_assets_for_same_named_episode_entities():
    existing_variant = ImageVariant(id="scene-img", url="assets/scenes/cabin.png")
    existing_scene = Scene(
        id="old-scene",
        name="机舱内",
        description="旧描述",
        image_asset=ImageAsset(selected_id=existing_variant.id, variants=[existing_variant]),
        image_url=existing_variant.url,
        status=GenerationStatus.COMPLETED,
    )
    existing = Script(
        id="ep-1",
        title="第一集",
        original_text="旧文本",
        scenes=[existing_scene],
        created_at=1,
        updated_at=1,
    )
    parsed = Script(
        id="preview",
        title="第一集",
        original_text="",
        scenes=[Scene(id="new-scene", name="机舱内", description="新描述")],
        created_at=1,
        updated_at=1,
    )
    pipeline = ComicGenPipeline.__new__(ComicGenPipeline)
    pipeline.scripts = {existing.id: existing}
    pipeline.series_store = {}
    pipeline._extraction_cache = {existing.id: (9999999999, parsed, True)}
    pipeline._save_data = lambda *args, **kwargs: None
    pipeline._save_series_data = lambda *args, **kwargs: None

    updated = pipeline.reparse_project(existing.id, "机舱内：新描述")

    assert updated.scenes[0].description == "新描述"
    assert updated.scenes[0].image_asset.variants[0].url == "assets/scenes/cabin.png"
    assert updated.scenes[0].image_asset.selected_id == "scene-img"
    assert updated.scenes[0].image_url == "assets/scenes/cabin.png"
    assert updated.scenes[0].status == GenerationStatus.COMPLETED


def test_upload_prop_variant_updates_series_shared_asset():
    prop = Prop(id="prop-1", name="行李箱", description="黑色硬壳行李箱")
    script = Script(
        id="ep-1",
        title="第一集",
        original_text="",
        series_id="series-1",
        created_at=1,
        updated_at=1,
    )
    series = Series(
        id="series-1",
        title="侏罗纪求生",
        props=[prop],
        created_at=1,
        updated_at=1,
    )
    saved = {"script": 0, "series": 0}
    pipeline = ComicGenPipeline.__new__(ComicGenPipeline)
    pipeline.scripts = {script.id: script}
    pipeline.series_store = {series.id: series}
    pipeline._save_data = lambda *args, **kwargs: saved.__setitem__("script", saved["script"] + 1)
    pipeline._save_series_data = lambda *args, **kwargs: saved.__setitem__("series", saved["series"] + 1)

    pipeline.add_uploaded_asset_variant(
        script_id=script.id,
        asset_type="prop",
        asset_id=prop.id,
        upload_type="image",
        image_url="uploads/prop.png",
        description="上传后的道具描述",
    )

    assert prop.description == "上传后的道具描述"
    assert prop.image_url == "uploads/prop.png"
    assert prop.image_asset.selected_id == prop.image_asset.variants[0].id
    assert prop.image_asset.variants[0].url == "uploads/prop.png"
    assert prop.image_asset.variants[0].is_uploaded_source is True
    assert prop.status == GenerationStatus.COMPLETED
    assert saved == {"script": 0, "series": 1}
