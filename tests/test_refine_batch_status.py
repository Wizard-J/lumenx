import threading

from src.apps.comic_gen.models import Script, StoryboardFrame
from src.apps.comic_gen.pipeline import ComicGenPipeline


def test_empty_llm_refinement_is_reported_as_failure():
    frame = StoryboardFrame(
        id="frame-1",
        scene_id="scene-1",
        action_description="森林全景",
    )
    script = Script(
        id="project-1",
        title="第一集",
        original_text="",
        frames=[frame],
        created_at=1,
        updated_at=1,
    )
    pipeline = ComicGenPipeline.__new__(ComicGenPipeline)
    pipeline.scripts = {script.id: script}
    pipeline._refine_batch_lock = threading.RLock()
    pipeline._refine_batch_status = {}
    pipeline._save_data = lambda *args, **kwargs: None
    pipeline._refine_frame_inner = lambda *args, **kwargs: frame

    events = list(pipeline.refine_batch_generator(script.id))

    assert events[0][0] == "frame_refine_error"
    assert "no usable storyboard refinement" in events[0][1]["error"]
    assert events[-1][0] == "batch_complete"
    assert events[-1][1]["success"] == 0
    assert events[-1][1]["failed"] == 1
