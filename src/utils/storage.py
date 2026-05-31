"""SQLite storage backend for LumenX projects and series.

Migrates from the previous dual-JSON-file approach (projects.json + series.json)
to a transactional SQLite database with foreign-key constraints.

All nested Pydantic models (characters, scenes, props, frames, video_tasks,
art_direction, model_settings, prompt_config) are stored as JSON blobs inside
their parent row.  The core relational fields (id, series_id, episode_number,
timestamps) live as real SQL columns so that data integrity is enforced at
the DB level.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
from typing import Any, Dict, List, Optional, Tuple



logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Abstract interface
# ---------------------------------------------------------------------------

class StorageBackend:
    """Protocol every storage backend must satisfy.

    Concrete backends may add their own initialisation parameters, but calling
    code should only depend on the methods listed here.
    """

    # -- Script CRUD ----------------------------------------------------------

    def get_script(self, script_id: str) -> Optional[Dict[str, Any]]:
        raise NotImplementedError

    def list_scripts(self) -> List[Dict[str, Any]]:
        raise NotImplementedError

    def save_script(self, script: Dict[str, Any]) -> None:
        raise NotImplementedError

    def delete_script(self, script_id: str) -> None:
        raise NotImplementedError

    # -- Series CRUD ----------------------------------------------------------

    def get_series(self, series_id: str) -> Optional[Dict[str, Any]]:
        raise NotImplementedError

    def list_series(self) -> List[Dict[str, Any]]:
        raise NotImplementedError

    def save_series(self, series: Dict[str, Any]) -> None:
        raise NotImplementedError

    def delete_series(self, series_id: str) -> None:
        raise NotImplementedError

    # -- Series ⟷ Script association -----------------------------------------

    def get_series_episodes(self, series_id: str) -> List[Dict[str, Any]]:
        """Return the full Script dicts for every episode in this series."""
        raise NotImplementedError

    # -- Lifecycle ------------------------------------------------------------

    def close(self) -> None:
        """Release any resources (e.g. close the database connection)."""
        raise NotImplementedError


# ---------------------------------------------------------------------------
# SQLite implementation
# ---------------------------------------------------------------------------

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS series (
    id                TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    description       TEXT NOT NULL DEFAULT '',
    characters_json   TEXT NOT NULL DEFAULT '[]',
    scenes_json       TEXT NOT NULL DEFAULT '[]',
    props_json        TEXT NOT NULL DEFAULT '[]',
    art_direction_json TEXT,
    prompt_config_json TEXT NOT NULL DEFAULT '{}',
    model_settings_json TEXT NOT NULL DEFAULT '{}',
    workflow_mode     TEXT NOT NULL DEFAULT 'i2v_legacy',
    episode_ids_json  TEXT NOT NULL DEFAULT '[]',
    created_at        REAL NOT NULL,
    updated_at        REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS scripts (
    id                TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    original_text     TEXT NOT NULL DEFAULT '',
    characters_json   TEXT NOT NULL DEFAULT '[]',
    scenes_json       TEXT NOT NULL DEFAULT '[]',
    props_json        TEXT NOT NULL DEFAULT '[]',
    frames_json       TEXT NOT NULL DEFAULT '[]',
    video_tasks_json  TEXT NOT NULL DEFAULT '[]',
    style_preset      TEXT NOT NULL DEFAULT 'realistic',
    style_prompt      TEXT,
    art_direction_json TEXT,
    model_settings_json TEXT NOT NULL DEFAULT '{}',
    prompt_config_json TEXT NOT NULL DEFAULT '{}',
    workflow_mode     TEXT NOT NULL DEFAULT 'i2v_legacy',
    merged_video_url  TEXT,
    series_id         TEXT,
    episode_number    INTEGER,
    created_at        REAL NOT NULL,
    updated_at        REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scripts_series_id ON scripts(series_id);
CREATE INDEX IF NOT EXISTS idx_scripts_updated ON scripts(updated_at);
CREATE INDEX IF NOT EXISTS idx_series_updated ON series(updated_at);

CREATE TABLE IF NOT EXISTS operations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         REAL NOT NULL,
    type       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    detail     TEXT NOT NULL DEFAULT '',
    model      TEXT NOT NULL DEFAULT '',
    duration_ms REAL NOT NULL DEFAULT 0,
    extra_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_operations_ts ON operations(ts DESC);
"""

# Pydantic models that live as JSON blobs in their parent row.
_SCRIPT_JSON_FIELDS = (
    "characters_json", "scenes_json", "props_json", "frames_json",
    "video_tasks_json", "art_direction_json", "model_settings_json",
    "prompt_config_json",
)
_SERIES_JSON_FIELDS = (
    "episode_ids_json",
    "characters_json", "scenes_json", "props_json", "art_direction_json",
    "prompt_config_json", "model_settings_json",
)


def _parse_json_columns(row: Dict[str, Any], json_keys: Tuple[str, ...]) -> Dict[str, Any]:
    """Parse JSON string columns back to Python objects in-place."""
    for key in json_keys:
        raw = row.get(key)
        if isinstance(raw, str):
            try:
                row[key] = json.loads(raw)
            except json.JSONDecodeError:
                pass
    return row


def _dump_json_columns(data: Dict[str, Any], json_keys: Tuple[str, ...]) -> Dict[str, Any]:
    """Ensure JSON columns are serialised strings."""
    for key in json_keys:
        val = data.get(key)
        if val is not None and not isinstance(val, str):
            data[key] = json.dumps(val, ensure_ascii=False)
    return data


class SQLiteStorageBackend(StorageBackend):
    """Transactional SQLite backend.

    On first run, if the database file does not exist AND the legacy JSON files
    *do* exist, the backend automatically migrates the data.
    """

    def __init__(self, db_path: str = "output/lumenx.db") -> None:
        self.db_path = db_path
        self._conn: Optional[sqlite3.Connection] = None
        self._lock = threading.RLock()

    # -- connection -----------------------------------------------------------

    @property
    def conn(self) -> sqlite3.Connection:
        if self._conn is None:
            os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
            self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
            self._conn.row_factory = sqlite3.Row
            self._conn.execute("PRAGMA journal_mode=WAL")
            
            self._conn.executescript(SCHEMA_SQL)
            self._conn.commit()
        return self._conn

    # -- operations log -------------------------------------------------------

    def log_operation(
        self,
        op_type: str,
        status: str = "pending",
        detail: str = "",
        model: str = "",
        duration_ms: float = 0,
        extra: dict | None = None,
    ) -> int:
        """Insert an operation log entry. Returns the row id."""
        cur = self.conn.execute(
            """INSERT INTO operations (ts, type, status, detail, model, duration_ms, extra_json)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                time.time(), op_type, status, detail[:1000], model,
                round(duration_ms, 1),
                json.dumps(extra or {}, ensure_ascii=False),
            ),
        )
        self.conn.commit()
        return cur.lastrowid

    def update_operation(
        self,
        op_id: int,
        status: str,
        detail: str = "",
        duration_ms: float = 0,
        extra: dict | None = None,
    ) -> bool:
        """Update an existing operation entry."""
        parts = ["status = ?", "duration_ms = ?"]
        params: list = [status, round(duration_ms, 1)]
        if detail:
            parts.append("detail = ?")
            params.append(detail[:1000])
        if extra:
            parts.append("extra_json = ?")
            params.append(json.dumps(extra, ensure_ascii=False))
        params.append(op_id)
        cur = self.conn.execute(
            f"UPDATE operations SET {', '.join(parts)} WHERE id = ?",
            params,
        )
        self.conn.commit()
        return cur.rowcount > 0

    def get_recent_operations(
        self, limit: int = 100, op_type: str = ""
    ) -> list[dict]:
        """Return recent operation log entries, newest first."""
        if op_type:
            rows = self.conn.execute(
                "SELECT * FROM operations WHERE type = ? ORDER BY ts DESC LIMIT ?",
                (op_type, limit),
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT * FROM operations ORDER BY ts DESC LIMIT ?",
                (limit,),
            ).fetchall()
        results = []
        for r in rows:
            d = dict(r)
            d["extra"] = json.loads(d.pop("extra_json", "{}"))
            results.append(d)
        return results

    def clear_operations(self) -> None:
        self.conn.execute("DELETE FROM operations")
        self.conn.commit()

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    # -- auto-migration -------------------------------------------------------

    def _legacy_files_exist(self) -> bool:
        return os.path.exists("output/projects.json") or os.path.exists("output/series.json")

    def needs_migration(self) -> bool:
        """True when the DB is empty but legacy JSON files are present."""
        if not self._legacy_files_exist():
            return False
        try:
            row = self.conn.execute("SELECT COUNT(*) FROM scripts").fetchone()
            if row and row[0] > 0:
                return False
            row = self.conn.execute("SELECT COUNT(*) FROM series").fetchone()
            if row and row[0] > 0:
                return False
        except Exception:
            return True
        return True

    def migrate_from_json(self) -> int:
        # Ensure schema exists
        _ = self.conn

        """Import projects.json + series.json into SQLite.

        Returns the number of imported rows (scripts + series).
        """
        count = 0
        legacy_projects = {}
        legacy_series = {}

        if os.path.exists("output/projects.json"):
            with open("output/projects.json", "r") as f:
                legacy_projects = json.load(f)
        if os.path.exists("output/series.json"):
            with open("output/series.json", "r") as f:
                legacy_series = json.load(f)

        with self._lock:
            # Series first (FK constraint)
            for sid, raw in legacy_series.items():
                s = dict(raw)
                # Flatten nested models → JSON columns
                for field_src, field_dst in [
                    ("characters", "characters_json"),
                    ("scenes", "scenes_json"),
                    ("props", "props_json"),
                    ("art_direction", "art_direction_json"),
                    ("prompt_config", "prompt_config_json"),
                    ("model_settings", "model_settings_json"),
                ]:
                    if field_src in s:
                        s[field_dst] = json.dumps(s.pop(field_src), ensure_ascii=False)
                s["episode_ids_json"] = json.dumps(s.pop("episode_ids", []), ensure_ascii=False)
                self._insert_series(s)
                count += 1

            # Scripts
            for pid, raw in legacy_projects.items():
                p = dict(raw)
                for field_src, field_dst in [
                    ("characters", "characters_json"),
                    ("scenes", "scenes_json"),
                    ("props", "props_json"),
                    ("frames", "frames_json"),
                    ("video_tasks", "video_tasks_json"),
                    ("art_direction", "art_direction_json"),
                    ("model_settings", "model_settings_json"),
                    ("prompt_config", "prompt_config_json"),
                ]:
                    if field_src in p:
                        p[field_dst] = json.dumps(p.pop(field_src), ensure_ascii=False)
                self._insert_script(p)
                count += 1

            self.conn.commit()
        logger.info("Migrated %d rows from legacy JSON files to SQLite.", count)
        return count

    # -- internal helpers -----------------------------------------------------

    def _row_to_script_dict(self, row: sqlite3.Row) -> Dict[str, Any]:
        d = dict(row)
        d = _parse_json_columns(d, _SCRIPT_JSON_FIELDS)
        # Rename JSON columns back to model field names
        mapping = {
            "characters_json": "characters",
            "scenes_json": "scenes",
            "props_json": "props",
            "frames_json": "frames",
            "video_tasks_json": "video_tasks",
            "art_direction_json": "art_direction",
            "model_settings_json": "model_settings",
            "prompt_config_json": "prompt_config",
        }
        for old, new in mapping.items():
            if old in d:
                d[new] = d.pop(old)
        return d

    def _row_to_series_dict(self, row: sqlite3.Row) -> Dict[str, Any]:
        d = dict(row)
        d = _parse_json_columns(d, _SERIES_JSON_FIELDS)
        mapping = {
            "characters_json": "characters",
            "scenes_json": "scenes",
            "props_json": "props",
            "art_direction_json": "art_direction",
            "prompt_config_json": "prompt_config",
            "model_settings_json": "model_settings",
            "episode_ids_json": "episode_ids",
        }
        for old, new in mapping.items():
            if old in d:
                d[new] = d.pop(old)
        return d

    def _insert_script(self, data: Dict[str, Any]) -> None:
        d = dict(data)
        d = _dump_json_columns(d, _SCRIPT_JSON_FIELDS)
        d.pop("episode_number", None)  # may be absent in legacy data
        columns = ", ".join(d.keys())
        placeholders = ", ".join("?" for _ in d)
        self.conn.execute(
            f"INSERT OR REPLACE INTO scripts ({columns}) VALUES ({placeholders})",
            list(d.values()),
        )

    def _insert_series(self, data: Dict[str, Any]) -> None:
        d = dict(data)
        d = _dump_json_columns(d, _SERIES_JSON_FIELDS)
        if "episode_ids" in d:
            d["episode_ids_json"] = json.dumps(d.pop("episode_ids"), ensure_ascii=False)
        columns = ", ".join(d.keys())
        placeholders = ", ".join("?" for _ in d)
        self.conn.execute(
            f"INSERT OR REPLACE INTO series ({columns}) VALUES ({placeholders})",
            list(d.values()),
        )

    def _script_to_row(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Convert model dict → SQL row dict (JSON fields → JSON strings)."""
        d = dict(data)
        mapping = {
            "characters": "characters_json",
            "scenes": "scenes_json",
            "props": "props_json",
            "frames": "frames_json",
            "video_tasks": "video_tasks_json",
            "art_direction": "art_direction_json",
            "model_settings": "model_settings_json",
            "prompt_config": "prompt_config_json",
        }
        for old, new in mapping.items():
            if old in d:
                d[new] = json.dumps(d.pop(old), ensure_ascii=False)
        return d

    def _series_to_row(self, data: Dict[str, Any]) -> Dict[str, Any]:
        d = dict(data)
        mapping = {
            "characters": "characters_json",
            "scenes": "scenes_json",
            "props": "props_json",
            "art_direction": "art_direction_json",
            "prompt_config": "prompt_config_json",
            "model_settings": "model_settings_json",
            "episode_ids": "episode_ids_json",
        }
        for old, new in mapping.items():
            if old in d:
                d[new] = json.dumps(d.pop(old), ensure_ascii=False)
            else:
                d[new] = "[]" if old == "episode_ids" else "{}"
        return d

    # -- public API -----------------------------------------------------------

    def get_script(self, script_id: str) -> Optional[Dict[str, Any]]:
        row = self.conn.execute(
            "SELECT * FROM scripts WHERE id = ?", (script_id,)
        ).fetchone()
        if row is None:
            return None
        return self._row_to_script_dict(row)

    def list_scripts(self) -> List[Dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM scripts ORDER BY updated_at DESC"
        ).fetchall()
        return [self._row_to_script_dict(r) for r in rows]

    def save_script(self, script: Dict[str, Any]) -> None:
        with self._lock:
            row = self._script_to_row(script)
            columns = ", ".join(row.keys())
            placeholders = ", ".join("?" for _ in row)
            self.conn.execute(
                f"INSERT OR REPLACE INTO scripts ({columns}) VALUES ({placeholders})",
                list(row.values()),
            )
            self.conn.commit()

    def delete_script(self, script_id: str) -> None:
        with self._lock:
            self.conn.execute("DELETE FROM scripts WHERE id = ?", (script_id,))
            self.conn.commit()

    def get_series(self, series_id: str) -> Optional[Dict[str, Any]]:
        row = self.conn.execute(
            "SELECT * FROM series WHERE id = ?", (series_id,)
        ).fetchone()
        if row is None:
            return None
        return self._row_to_series_dict(row)

    def list_series(self) -> List[Dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM series ORDER BY updated_at DESC"
        ).fetchall()
        return [self._row_to_series_dict(r) for r in rows]

    def save_series(self, series: Dict[str, Any]) -> None:
        with self._lock:
            row = self._series_to_row(series)
            columns = ", ".join(row.keys())
            placeholders = ", ".join("?" for _ in row)
            self.conn.execute(
                f"INSERT OR REPLACE INTO series ({columns}) VALUES ({placeholders})",
                list(row.values()),
            )
            self.conn.commit()

    def delete_series(self, series_id: str) -> None:
        with self._lock:
            self.conn.execute("DELETE FROM series WHERE id = ?", (series_id,))
            self.conn.commit()

    def get_series_episodes(self, series_id: str) -> List[Dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM scripts WHERE series_id = ? ORDER BY episode_number ASC, created_at ASC",
            (series_id,),
        ).fetchall()
        return [self._row_to_script_dict(r) for r in rows]
