"""Create a consistent SQLite backup, including committed WAL data."""
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

os.umask(0o077)
source = Path(os.environ.get("DATABASE_PATH", "/data/criterion.sqlite")).resolve(strict=True)
folder = source.parent / "backups"
folder.mkdir(mode=0o700, exist_ok=True)
name = "criterion-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".sqlite"
target = folder / name
with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as database:
    with sqlite3.connect(target) as backup:
        database.backup(backup)
        assert backup.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
print(target)
