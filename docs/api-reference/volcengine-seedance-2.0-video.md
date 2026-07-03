# Volcengine Seedance 2.0 Video API Evidence

- Source URL: https://www.volcengine.com/docs/82379/1520757
- Provider: Volcengine ModelArk
- Family: Seedance 2.0 video
- Capture date: 2026-07-01
- Scope: async video generation task flow, image-to-video, first/last keyframes, and role-tagged reference images

## Integration Notes

Seedance 2.0 is exposed through the Volcengine ModelArk content generation task API.
The LumenX adapter uses `volcenginesdkarkruntime.Ark` and submits async tasks via
`client.content_generation.tasks.create(...)`, then polls with
`client.content_generation.tasks.get(task_id=...)`.

Image inputs are sent as `content` items with `type: image_url`. LumenX maps:

- selected/generated start keyframe -> `role: first_frame`
- selected/generated end keyframe -> `role: last_frame`
- additional resolved character/scene/prop assets -> `role: reference_image`

The repo-local implementation intentionally keeps keyframe composition upstream in
the existing storyboard image generation path, then uses Seedance for the video
motion step.

## Deferred External Sync

This is a repo-local staging mirror for implementation evidence. The raw vendor
archive and shared Context Hub package still need promotion outside this repo.
