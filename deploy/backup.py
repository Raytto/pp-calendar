#!/usr/bin/env python3
"""Create an online SQLite backup and retain the newest 30 daily copies."""

from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path

SOURCE = Path("/srv/data/pp-calendar/calendar.sqlite")
TARGET_ROOT = Path("/srv/backups/pp-calendar")
KEEP = 30


def main() -> None:
    TARGET_ROOT.mkdir(parents=True, exist_ok=True)
    destination = TARGET_ROOT / f"calendar-{datetime.now().astimezone():%Y%m%d-%H%M%S}.sqlite"
    try:
        with sqlite3.connect(f"file:{SOURCE}?mode=ro", uri=True) as source:
            with sqlite3.connect(destination) as target:
                source.backup(target)
                result = target.execute("PRAGMA integrity_check").fetchone()[0]
                if result != "ok":
                    raise RuntimeError(f"backup integrity check failed: {result}")
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    destination.chmod(0o600)
    for old in sorted(TARGET_ROOT.glob("calendar-*.sqlite"), reverse=True)[KEEP:]:
        old.unlink()


if __name__ == "__main__":
    main()
