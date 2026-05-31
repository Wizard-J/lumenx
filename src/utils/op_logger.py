"""
SQLite-backed operation logger for debugging LLM / pipeline calls.
Provides entries accessible via /debug/operations.
"""

import threading
from typing import Optional, Any
from .storage import SQLiteStorageBackend

# Lazily-initialised singleton backend (shared with pipeline)
_backend: Optional[SQLiteStorageBackend] = None
_lock = threading.Lock()


def _get_backend() -> SQLiteStorageBackend:
    global _backend
    if _backend is None:
        with _lock:
            if _backend is None:
                _backend = SQLiteStorageBackend()
    return _backend


def enter_operation(
    op_type: str,
    detail: str = "",
    model: str = "",
    **extra,
) -> int:
    return _get_backend().log_operation(
        op_type=op_type,
        status="pending",
        detail=detail,
        model=model,
        extra=extra if extra else None,
    )


def update_operation(
    entry_id: int,
    status: str,
    detail: str = "",
    duration_ms: float = 0,
    **extra,
) -> bool:
    return _get_backend().update_operation(
        op_id=entry_id,
        status=status,
        detail=detail,
        duration_ms=duration_ms,
        extra=extra if extra else None,
    )


def get_recent(limit: int = 50, op_type: str = "") -> list:
    return _get_backend().get_recent_operations(limit=limit, op_type=op_type)


def clear() -> None:
    _get_backend().clear_operations()
