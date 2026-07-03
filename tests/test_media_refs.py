from pathlib import Path

from src.utils.media_refs import (
    classify_media_ref,
    is_remote_media_ref,
    is_stable_project_media_ref,
    resolve_local_media_path,
)
from src.utils.oss_utils import object_key_to_local_display_path, remote_url_to_local_display_path, sign_oss_urls_in_data
from src.apps.comic_gen.api import _normalize_local_file_url, _normalize_local_file_urls


def _project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def test_classify_local_relative_path():
    assert classify_media_ref("uploads/foo.png") == "local_path"


def test_classify_local_absolute_path_under_output():
    abs_path = str(_project_root() / "output" / "uploads" / "foo.png")
    assert classify_media_ref(abs_path) == "local_path"


def test_classify_oss_object_key(monkeypatch):
    monkeypatch.setenv("OSS_BASE_PATH", "stable-test-base")
    assert (
        classify_media_ref("stable-test-base/project_1/assets/foo.png")
        == "object_key"
    )


def test_classify_remote_url():
    assert classify_media_ref("https://example.com/a.png") == "remote_url"
    assert is_remote_media_ref("http://example.com/a.png")
    assert is_remote_media_ref("blob:https://example.com/abc")
    assert not is_stable_project_media_ref("blob:https://example.com/abc")


def test_classify_data_uri_is_not_stable_storage():
    value = "data:image/png;base64,AAAA"
    assert classify_media_ref(value) == "data_uri"
    assert not is_stable_project_media_ref(value)


def test_resolve_local_relative_path_to_absolute():
    resolved = resolve_local_media_path("uploads/foo.png")
    expected = str((_project_root() / "output" / "uploads" / "foo.png").resolve())
    assert resolved == expected


def test_resolve_local_absolute_path_under_output():
    input_path = str(_project_root() / "output" / "video" / "clip.mp4")
    expected = str((_project_root() / "output" / "video" / "clip.mp4").resolve())
    assert resolve_local_media_path(input_path) == expected


def test_sign_oss_urls_prefers_local_display_copy(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OSS_BASE_PATH", "lumenx")
    local_file = tmp_path / "output" / "assets" / "stages" / "scene.png"
    local_file.parent.mkdir(parents=True)
    local_file.write_bytes(b"image")

    object_key = "lumenx/assets/stages/scene.png"
    assert object_key_to_local_display_path(object_key) == "assets/stages/scene.png"

    class FakeUploader:
        is_configured = True

        @staticmethod
        def sign_url_for_display(value):
            return f"https://minio.example/{value}"

    payload = {"url": object_key, "nested": [{"url": "lumenx/assets/missing.png"}]}
    signed = sign_oss_urls_in_data(payload, FakeUploader())

    assert signed["url"] == "assets/stages/scene.png"
    assert signed["nested"][0]["url"] == "https://minio.example/lumenx/assets/missing.png"


def test_sign_oss_urls_prefers_local_display_copy_uploads_path(monkeypatch, tmp_path):
    """Same as above but for the uploads/ sub_path — see current-plan fix."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OSS_BASE_PATH", "lumenx")
    local_file = tmp_path / "output" / "uploads" / "manual.png"
    local_file.parent.mkdir(parents=True)
    local_file.write_bytes(b"image")

    object_key = "lumenx/uploads/manual.png"
    assert object_key_to_local_display_path(object_key) == "uploads/manual.png"


def test_api_normalizes_local_static_urls_before_provider_calls():
    assert (
        _normalize_local_file_url("http://localhost:17177/files/assets/stages/scene.png?x=1")
        == "assets/stages/scene.png"
    )
    assert (
        _normalize_local_file_urls([
            "http://localhost:17177/files/video/ref.mp4",
            "https://minio.example/lumenx/assets/remote.png",
        ])
        == ["video/ref.mp4", "https://minio.example/lumenx/assets/remote.png"]
    )


def test_normalize_local_file_skips_third_party_urls():
    """Third-party URLs with /files/ in path must not be rewritten to local paths."""
    url = "https://cdn.example.com/files/assets/stages/scene.png?x=1"
    assert _normalize_local_file_url(url) == url
    # Non-local absolute server URL should also be left alone
    server_url = "http://192.168.1.100:8080/files/assets/img.png"
    assert _normalize_local_file_url(server_url) == server_url


def test_object_key_to_local_display_path_legacy_upload_fallback(monkeypatch, tmp_path):
    """Old uploaded assets stored as lumenx/assets/<uuid>.png but local file
    at output/uploads/<uuid>.png should resolve via backward-compat fallback."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OSS_BASE_PATH", "lumenx")
    local_file = tmp_path / "output" / "uploads" / "legacy.png"
    local_file.parent.mkdir(parents=True)
    local_file.write_bytes(b"image")

    # Old object key under assets/, file lives in uploads/
    assert object_key_to_local_display_path("lumenx/assets/legacy.png") == "uploads/legacy.png"


def test_object_key_to_local_display_path_legacy_upload_fallback_negative(monkeypatch, tmp_path):
    """When neither the primary assets/ path nor the uploads/ fallback exist,
    return None (so sign_oss_urls_in_data signs it to MinIO as before)."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OSS_BASE_PATH", "lumenx")
    assert object_key_to_local_display_path("lumenx/assets/ghost.png") is None


def test_object_key_to_local_display_path_legacy_upload_fallback_nested_not_remapped(monkeypatch, tmp_path):
    """Nested generated paths like assets/stages/scene.png must NOT fallback
    to uploads/ — only direct assets/<filename> keys qualify."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OSS_BASE_PATH", "lumenx")
    # create output/uploads/scene.png so basename would match
    uploads_file = tmp_path / "output" / "uploads" / "scene.png"
    uploads_file.parent.mkdir(parents=True)
    uploads_file.write_bytes(b"image")
    # nested object key should NOT resolve even though basename matches
    assert object_key_to_local_display_path("lumenx/assets/stages/scene.png") is None


def test_remote_url_to_local_display_path_legacy_signed(monkeypatch, tmp_path):
    """Legacy MinIO signed URL containing lumenx/assets/<file> should resolve
    to uploads/<file> when local output/uploads/<file> exists."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OSS_BASE_PATH", "lumenx")
    local_file = tmp_path / "output" / "uploads" / "legacy.png"
    local_file.parent.mkdir(parents=True)
    local_file.write_bytes(b"image")

    signed_url = "https://minio.example/mybucket/lumenx/assets/legacy.png?X-Amz-Signature=abc123"
    assert remote_url_to_local_display_path(signed_url) == "uploads/legacy.png"


def test_remote_url_to_local_display_path_nested_not_remapped(monkeypatch, tmp_path):
    """Signed URL with nested path assets/stages/ must NOT fallback to uploads/."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OSS_BASE_PATH", "lumenx")
    uploads_file = tmp_path / "output" / "uploads" / "scene.png"
    uploads_file.parent.mkdir(parents=True)
    uploads_file.write_bytes(b"image")

    signed_url = "https://minio.example/bucket/lumenx/assets/stages/scene.png?sig=abc"
    assert remote_url_to_local_display_path(signed_url) is None


def test_remote_url_to_local_display_path_non_oss_url(monkeypatch, tmp_path):
    """URL without the OSS base path in its segments should be left alone."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OSS_BASE_PATH", "lumenx")
    uploads_file = tmp_path / "output" / "uploads" / "random.png"
    uploads_file.parent.mkdir(parents=True)
    uploads_file.write_bytes(b"image")

    url = "https://cdn.example.com/images/random.png"
    assert remote_url_to_local_display_path(url) is None


def test_remote_url_to_local_display_path_urlencoded(monkeypatch, tmp_path):
    """URL-encoded filename in OSS path should be decoded properly."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OSS_BASE_PATH", "lumenx")
    local_file = tmp_path / "output" / "uploads" / "a b.png"
    local_file.parent.mkdir(parents=True)
    local_file.write_bytes(b"image")

    signed_url = "https://minio.example/bucket/lumenx/assets/a%20b.png?X-Amz-Signature=abc"
    assert remote_url_to_local_display_path(signed_url) == "uploads/a b.png"


def test_sign_oss_urls_in_data_remaps_legacy_signed_url(monkeypatch, tmp_path):
    """Full plumbing test: sign_oss_urls_in_data remaps a legacy MinIO signed URL to a local path."""

    class FakeUploader:
        is_configured = True

        @staticmethod
        def sign_url_for_display(value):
            return f"https://signed.example/{value}"

    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OSS_BASE_PATH", "lumenx")
    local_file = tmp_path / "output" / "uploads" / "legacy.png"
    local_file.parent.mkdir(parents=True)
    local_file.write_bytes(b"image")

    payload = {"url": "https://minio.example/mybucket/lumenx/assets/legacy.png?X-Amz-Signature=abc"}
    result = sign_oss_urls_in_data(payload, FakeUploader())
    assert result["url"] == "uploads/legacy.png"


def test_remote_url_duplicate_base_path(monkeypatch, tmp_path):
    """URL path like /lumenx/lumenx/assets/<file> where bucket == base_path."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OSS_BASE_PATH", "lumenx")
    local_file = tmp_path / "output" / "uploads" / "legacy.png"
    local_file.parent.mkdir(parents=True)
    local_file.write_bytes(b"image")

    url = "https://minio-s3.wizardj.cn/lumenx/lumenx/assets/legacy.png"
    assert remote_url_to_local_display_path(url) == "uploads/legacy.png"


def test_remote_url_bucket_then_base_path(monkeypatch, tmp_path):
    """URL path like /bucket/lumenx/assets/<file>."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OSS_BASE_PATH", "lumenx")
    local_file = tmp_path / "output" / "uploads" / "legacy.png"
    local_file.parent.mkdir(parents=True)
    local_file.write_bytes(b"image")

    url = "https://minio.example/mybucket/lumenx/assets/legacy.png"
    assert remote_url_to_local_display_path(url) == "uploads/legacy.png"


def test_remote_url_direct_base_path(monkeypatch, tmp_path):
    """URL path like /lumenx/assets/<file>."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OSS_BASE_PATH", "lumenx")
    local_file = tmp_path / "output" / "uploads" / "legacy.png"
    local_file.parent.mkdir(parents=True)
    local_file.write_bytes(b"image")

    url = "https://minio.example/lumenx/assets/legacy.png"
    assert remote_url_to_local_display_path(url) == "uploads/legacy.png"


def test_remote_url_base_path_not_followed_by_media_root(monkeypatch, tmp_path):
    """URL with base_path but next segment not a known media root must not map."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OSS_BASE_PATH", "lumenx")
    url = "https://minio.example/lumenx/not-media/legacy.png"
    assert remote_url_to_local_display_path(url) is None


def test_remote_url_duplicate_base_path_nested_not_remapped(monkeypatch, tmp_path):
    """Duplicate base path with nested assets/stages/<file> must not fallback to uploads/."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OSS_BASE_PATH", "lumenx")
    uploads_file = tmp_path / "output" / "uploads" / "scene.png"
    uploads_file.parent.mkdir(parents=True)
    uploads_file.write_bytes(b"image")

    url = "https://minio.example/lumenx/lumenx/assets/stages/scene.png?sig=abc"
    assert remote_url_to_local_display_path(url) is None


def test_sign_oss_urls_in_data_unconfigured_still_runs_local_fallback(monkeypatch, tmp_path):
    """Even when OSS is unconfigured, local fallbacks should still run."""

    class FakeUploader:
        is_configured = False

        @staticmethod
        def sign_url_for_display(value):
            return f"https://signed.example/{value}"

    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OSS_BASE_PATH", "lumenx")
    local_file = tmp_path / "output" / "uploads" / "legacy.png"
    local_file.parent.mkdir(parents=True)
    local_file.write_bytes(b"image")

    # Object key (not full URL) — should resolve to local path even when unconfigured
    payload = {"url": "lumenx/uploads/legacy.png"}
    result = sign_oss_urls_in_data(payload, FakeUploader())
    assert result["url"] == "uploads/legacy.png"
