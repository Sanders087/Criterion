"""Back up a live SQLite database and restore to a new path without overwriting files."""
import argparse
import json
import os
import re
import sqlite3
import stat
import sys
import tempfile
import time
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

BACKUP_NAME = re.compile(r"criterion-(\d{8}T\d{12}Z)\.sqlite")
RETENTION_DAYS = 14


def private_temp(folder):
    fd, filename = tempfile.mkstemp(prefix=".criterion-backup-", dir=folder)
    os.close(fd)
    return Path(filename)


def sync_dir(folder):
    if os.name == "posix":
        fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def previous_success(folder):
    path = folder / "status.json"
    try:
        if path.is_symlink() or path.stat().st_size > 512:
            return None
        value = json.loads(path.read_text(encoding="utf-8"))["lastSuccessTimestampSeconds"]
        return value if type(value) is int and value > 0 else None
    except (OSError, KeyError, ValueError, TypeError):
        return None


def save_status(folder, status, last):
    tmp = private_temp(folder)
    try:
        with tmp.open("w", encoding="utf-8") as stream:
            json.dump({"status": status, "lastSuccessTimestampSeconds": last}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, folder / "status.json")
        sync_dir(folder)
    finally:
        tmp.unlink(missing_ok=True)


def verified_copy(source, destination):
    if source.is_symlink() or not source.is_file():
        raise ValueError("invalid source")
    if any(os.path.lexists(str(destination) + suffix) for suffix in ("", "-wal", "-shm", "-journal")):
        raise FileExistsError("target must be new")
    tmp = private_temp(destination.parent)
    deadline = time.monotonic() + 600

    def check_deadline(_status, _remaining, _pages):
        if time.monotonic() > deadline:
            raise TimeoutError("backup deadline")

    try:
        uri = source.resolve(strict=True).as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True)) as original, closing(sqlite3.connect(tmp)) as copy:
            original.backup(copy, pages=128, progress=check_deadline, sleep=0.1)
            # Make the published artifact self-contained even when the source used WAL.
            if copy.execute("PRAGMA journal_mode=DELETE").fetchone() != ("delete",):
                raise RuntimeError("snapshot journal")
            if copy.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise RuntimeError("snapshot integrity")
            if copy.execute("PRAGMA foreign_key_check").fetchone() is not None:
                raise RuntimeError("snapshot references")
        with tmp.open("r+b") as stream:
            os.fsync(stream.fileno())
        # Atomic no-clobber publication in the same directory.
        os.link(tmp, destination)
        sync_dir(destination.parent)
    finally:
        for suffix in ("", "-wal", "-shm", "-journal"):
            Path(str(tmp) + suffix).unlink(missing_ok=True)


def prune(folder, now):
    for entry in folder.iterdir():
        match = BACKUP_NAME.fullmatch(entry.name)
        if not match or entry.is_symlink() or not entry.is_file():
            continue
        try:
            created = datetime.strptime(match.group(1), "%Y%m%dT%H%M%S%fZ").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if (now - created).days >= RETENTION_DAYS:
            entry.unlink()


def backup(source, if_due=False):
    folder = source.parent / "backups"
    folder.mkdir(mode=0o700, exist_ok=True)
    info = folder.lstat()
    if not stat.S_ISDIR(info.st_mode) or (os.name == "posix" and (
            info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077)):
        raise PermissionError("private backup directory required")
    last = previous_success(folder)
    now = datetime.now(timezone.utc)
    if if_due and last and 0 <= now.timestamp() - last < 86400:
        return
    try:
        target = folder / ("criterion-" + now.strftime("%Y%m%dT%H%M%S%fZ") + ".sqlite")
        verified_copy(source, target)
        last = int(time.time())
        prune(folder, now)
        save_status(folder, "ok", last)
        print(target)
    except (OSError, sqlite3.Error, RuntimeError, ValueError):
        save_status(folder, "failed", last)
        raise


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--restore", type=Path, metavar="SNAPSHOT")
    parser.add_argument("--to", type=Path, metavar="NEW_SQLITE")
    parser.add_argument("--if-due", action="store_true", help="back up only when last success is at least 24 hours old")
    args = parser.parse_args()
    if bool(args.restore) != bool(args.to) or (args.restore and args.if_due):
        parser.error("restore requires both --restore and --to")
    if args.restore:
        verified_copy(args.restore, args.to)
        print("Criterion: restore verified.")
    else:
        backup(Path(os.environ.get("DATABASE_PATH", "/data/criterion.sqlite")).absolute(), args.if_due)


if __name__ == "__main__":
    try:
        main()
    except (OSError, sqlite3.Error, RuntimeError, ValueError):
        sys.exit("Criterion: database backup or restore failed. Check storage, permissions and integrity.")
