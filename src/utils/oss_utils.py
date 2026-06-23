import os
import hashlib
import mimetypes
import time
from typing import Optional
from . import get_logger
from .media_refs import classify_media_ref, MEDIA_REF_LOCAL_PATH, MEDIA_REF_OBJECT_KEY

logger = get_logger(__name__)

# Default configuration
DEFAULT_OSS_BASE_PATH = "lumenx"
SIGN_URL_EXPIRES_DISPLAY = 7200  # 2 hours for frontend display
SIGN_URL_EXPIRES_API = 1800      # 30 minutes for AI API calls

# ── Dependencies ─────────────────────────────────────────────────────
# Supports both Alibaba Cloud OSS (oss2) and S3-compatible storage (boto3).
# MinIO, AWS S3, and other S3-compatible stores use boto3.

_oss2_available = False
_boto3_available = False

try:
    import oss2
    _oss2_available = True
except ImportError:
    oss2 = None

try:
    import boto3
    from botocore.config import Config as BotoConfig
    from botocore.exceptions import ClientError
    _boto3_available = True
except ImportError:
    boto3 = None
    BotoConfig = None
    ClientError = Exception


# ── Helpers ──────────────────────────────────────────────────────────

def is_oss_configured() -> bool:
    """Check if OSS is properly configured."""
    required = [
        os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID"),
        os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET"),
        os.getenv("OSS_ENDPOINT"),
        os.getenv("OSS_BUCKET_NAME")
    ]
    return all(required)


def get_oss_base_path() -> str:
    """Get OSS base path from environment or use default."""
    return os.getenv("OSS_BASE_PATH", DEFAULT_OSS_BASE_PATH).rstrip("/")


def is_object_key(value: str) -> bool:
    """Check if a string value is an OSS Object Key (not a full URL or local path)."""
    return (
        classify_media_ref(value, oss_base_path=get_oss_base_path())
        == MEDIA_REF_OBJECT_KEY
    )


def is_local_path(value: str) -> bool:
    """Check if a string is a local file path (relative or absolute)."""
    return (
        classify_media_ref(value, oss_base_path=get_oss_base_path())
        == MEDIA_REF_LOCAL_PATH
    )


# ── Storage Backend Detection ────────────────────────────────────────

def _detect_backend(endpoint: str) -> str:
    """Detect whether the endpoint is Alibaba OSS or S3-compatible (MinIO etc.)."""
    if not endpoint:
        return "unknown"
    ep_lower = endpoint.lower()
    # Alibaba OSS endpoints contain 'oss-'
    if "oss-" in ep_lower or "aliyuncs.com" in ep_lower:
        return "oss2"
    # Everything else (MinIO, AWS S3, etc.) → boto3
    return "boto3"


# ── Main Uploader ────────────────────────────────────────────────────

class OSSImageUploader:
    """
    OSS/MinIO Uploader supporting Dynamic Signing strategy.

    Supports both:
      - Alibaba Cloud OSS (via oss2 library)
      - S3-compatible storage including MinIO (via boto3 library)

    Key principles:
      - Upload files and return Object Keys (not full URLs)
      - Generate signed URLs on-demand with configurable expiry
      - Support both private bucket access and AI API access
    """

    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
            cls._instance._url_cache = {}
        return cls._instance

    def __init__(self):
        if self._initialized:
            return

        self.access_key_id = os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID")
        self.access_key_secret = os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
        self.endpoint = os.getenv("OSS_ENDPOINT")
        self.bucket_name = os.getenv("OSS_BUCKET_NAME")
        self.base_path = get_oss_base_path()
        self._backend = None  # 'oss2' or 'boto3'
        self._s3_client = None
        self._oss2_bucket = None

        print(
            f"DEBUG: OSS init - ID={'***' if self.access_key_id else 'None'}, "
            f"Secret={'***' if self.access_key_secret else 'None'}, "
            f"Endpoint={self.endpoint}, Bucket={self.bucket_name}, Base={self.base_path}"
        )

        if not all([self.access_key_id, self.access_key_secret, self.endpoint, self.bucket_name]):
            logger.warning("OSS credentials not fully configured. OSS upload will be disabled.")
            print("DEBUG: OSS init - FAILED: missing credentials")
            self._client = None
        else:
            self._init_client()

        self._initialized = True

    def _init_client(self):
        """Initialize the appropriate storage client based on endpoint detection."""
        backend = _detect_backend(self.endpoint)

        if backend == "oss2":
            self._init_oss2()
        else:
            self._init_boto3()

    def _init_oss2(self):
        """Initialize Alibaba Cloud OSS via oss2."""
        if not _oss2_available:
            logger.error("oss2 library not installed. Cannot initialize Alibaba OSS.")
            print("DEBUG: OSS init - oss2 not installed")
            self._client = None
            return
        try:
            auth = oss2.Auth(self.access_key_id, self.access_key_secret)
            self._client = oss2.Bucket(
                auth,
                self.endpoint,
                self.bucket_name,
                connect_timeout=5,
            )
            self._backend = "oss2"
            logger.info(f"OSS (oss2) initialized: bucket={self.bucket_name}, base_path={self.base_path}")
            print(f"DEBUG: OSS init - SUCCESS (oss2): bucket={self.bucket_name}")
        except Exception as e:
            logger.error(f"Failed to initialize OSS (oss2) bucket: {e}")
            print(f"DEBUG: OSS init - ERROR: {e}")
            self._client = None

    def _init_boto3(self):
        """Initialize S3-compatible storage via boto3."""
        if not _boto3_available:
            logger.error("boto3 library not installed. Cannot initialize S3/MinIO.")
            print("DEBUG: OSS init - boto3 not installed")
            self._client = None
            return
        try:
            # MinIO requires signature_version='s3v4'
            config = BotoConfig(
                signature_version='s3v4',
                connect_timeout=5,
                read_timeout=30,
                retries={'max_attempts': 2},
            )
            self._client = boto3.client(
                's3',
                endpoint_url=self.endpoint,
                aws_access_key_id=self.access_key_id,
                aws_secret_access_key=self.access_key_secret,
                config=config,
                region_name=os.getenv("OSS_REGION", "us-east-1"),
            )
            self._backend = "boto3"
            logger.info(f"OSS (boto3) initialized: endpoint={self.endpoint}, bucket={self.bucket_name}")
            print(f"DEBUG: OSS init - SUCCESS (boto3): endpoint={self.endpoint}")
        except Exception as e:
            logger.error(f"Failed to initialize S3/MinIO client: {e}")
            print(f"DEBUG: OSS init - ERROR: {e}")
            self._client = None

    @classmethod
    def reset_instance(cls):
        cls._instance = None

    @property
    def is_configured(self) -> bool:
        return self._client is not None

    # ── Legacy compatibility properties ──────────────────────────
    @property
    def bucket(self):
        """Legacy property: returns client for backward compat with debug endpoints."""
        return self._client

    # ── Object Key helpers ───────────────────────────────────────────

    def _build_object_key(self, sub_path: str, filename: str) -> str:
        parts = [self.base_path]
        if sub_path:
            parts.append(sub_path.strip("/"))
        parts.append(filename)
        return "/".join(parts)

    # ── Upload ───────────────────────────────────────────────────────

    def upload_file(self, local_path: str, sub_path: str = "", custom_filename: str = None) -> Optional[str]:
        """Upload a file to OSS/MinIO and return the Object Key."""
        if not self._client:
            logger.warning("OSS not configured, cannot upload file.")
            return None
        if not os.path.exists(local_path):
            logger.error(f"File not found: {local_path}")
            return None

        try:
            filename = custom_filename or os.path.basename(local_path)
            object_key = self._build_object_key(sub_path, filename)
            logger.info(f"Uploading to OSS: {local_path} -> {object_key}")

            with open(local_path, 'rb') as f:
                if self._backend == "oss2":
                    result = self._client.put_object(object_key, f)
                    if result.status == 200:
                        logger.info(f"Upload success: {object_key}")
                        return object_key
                    else:
                        logger.error(f"Upload failed with status: {result.status}")
                        return None
                else:
                    content_type = mimetypes.guess_type(local_path)[0] or "image/png"
                    self._client.put_object(
                        Bucket=self.bucket_name,
                        Key=object_key,
                        Body=f,
                        ContentType=content_type,
                    )
                    logger.info(f"Upload success: {object_key} (ContentType={content_type})")
                    return object_key
        except Exception as e:
            logger.error(f"OSS upload error: {e}")
            return None

    # ── Signed URL generation ────────────────────────────────────────

    def generate_signed_url(self, object_key: str, expires: int = SIGN_URL_EXPIRES_DISPLAY) -> str:
        """Generate a signed URL for accessing a private OSS/MinIO object."""
        if not self._client:
            logger.warning("OSS not configured, cannot generate signed URL.")
            return ""

        try:
            # Cache check: reuse signed URL if still valid (10 min buffer)
            cache_key = (object_key, expires)
            now = time.time()
            if cache_key in self._url_cache:
                cached_url, timestamp = self._url_cache[cache_key]
                if now - timestamp < (expires - 600):
                    return cached_url

            if self._backend == "oss2":
                url = self._client.sign_url('GET', object_key, expires, slash_safe=True)
            else:
                url = self._client.generate_presigned_url(
                    'get_object',
                    Params={'Bucket': self.bucket_name, 'Key': object_key},
                    ExpiresIn=expires,
                )

            # Ensure HTTPS
            if url.startswith("http://"):
                url = "https://" + url[7:]

            self._url_cache[cache_key] = (url, now)
            return url
        except Exception as e:
            logger.error(f"Failed to generate signed URL for {object_key}: {e}")
            return ""

    def sign_url_for_display(self, object_key: str) -> str:
        """Generate signed URL for frontend display (2 hours validity)."""
        return self.generate_signed_url(object_key, SIGN_URL_EXPIRES_DISPLAY)

    def sign_url_for_api(self, object_key: str) -> str:
        """Generate signed URL for AI API calls (30 minutes validity)."""
        return self.generate_signed_url(object_key, SIGN_URL_EXPIRES_API)

    # ── Object existence check ───────────────────────────────────────

    def object_exists(self, object_key: str) -> bool:
        """Check if an object exists in OSS/MinIO."""
        if not self._client:
            return False
        try:
            if self._backend == "oss2":
                return self._client.object_exists(object_key)
            else:
                self._client.head_object(Bucket=self.bucket_name, Key=object_key)
                return True
        except ClientError as e:
            if e.response['Error']['Code'] == '404':
                return False
            logger.warning(f"Error checking object existence: {e}")
            return False
        except Exception:
            return False


    # ── Object deletion ──────────────────────────────────────────────

    def delete_object(self, object_key: str) -> bool:
        """Delete an object from OSS/MinIO.

        Returns True if the object was successfully deleted, False if it
        didn't exist or deletion failed. Failures are logged but never raised.
        """
        if not self._client or not object_key:
            return False
        try:
            if self._backend == "oss2":
                result = self._client.delete_object(object_key)
                if result.status == 204 or result.status == 200:
                    logger.info(f"Deleted OSS object: {object_key}")
                    return True
                logger.warning(f"Delete returned status {result.status}: {object_key}")
                return False
            else:
                self._client.delete_object(Bucket=self.bucket_name, Key=object_key)
                logger.info(f"Deleted S3 object: {object_key}")
                return True
        except ClientError as e:
            if e.response['Error']['Code'] == '404':
                logger.info(f"Object already gone (404): {object_key}")
                return True
            logger.warning(f"Failed to delete {object_key}: {e}")
            return False
        except Exception as e:
            logger.warning(f"Failed to delete {object_key}: {e}")
            return False

    # ── Legacy methods ───────────────────────────────────────────────

    def upload_image(self, local_image_path: str, sub_path: str = "assets") -> Optional[str]:
        return self.upload_file(local_image_path, sub_path)

    def upload_video(self, local_video_path: str, sub_path: str = "video") -> Optional[str]:
        return self.upload_file(local_video_path, sub_path)

    def get_oss_url(self, object_key: str, use_public_url: bool = False) -> str:
        if use_public_url:
            logger.warning("Public URLs are deprecated. Using signed URL instead for security.")
        return self.sign_url_for_display(object_key)


# ── Module-level helpers ─────────────────────────────────────────────

def sign_oss_urls_in_data(data, uploader: OSSImageUploader = None):
    """Recursively traverse data structure and convert Object Keys to signed URLs."""
    if uploader is None:
        uploader = OSSImageUploader()
    if not uploader.is_configured:
        return data

    def process_value(value):
        if isinstance(value, str):
            if is_object_key(value):
                signed_url = uploader.sign_url_for_display(value)
                return signed_url if signed_url else value
            return value
        elif isinstance(value, dict):
            return {k: process_value(v) for k, v in value.items()}
        elif isinstance(value, list):
            return [process_value(item) for item in value]
        else:
            return value

    return process_value(data)


def convert_local_path_to_object_key(local_path: str, project_id: str = None) -> str:
    """Convert a local relative path to an OSS Object Key format."""
    base_path = get_oss_base_path()
    if local_path.startswith("output/"):
        local_path = local_path[7:]
    if project_id:
        return f"{base_path}/{project_id}/{local_path}"
    else:
        return f"{base_path}/{local_path}"
