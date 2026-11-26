"""Prepare only the SQLite mount, then run both services without root privileges."""
import os
import sys
import json
import re
import stat
from datetime import datetime, timezone
from pathlib import Path

def permissions(path):
    try:
        info = path.lstat()
        return {"exists": True, "uid": info.st_uid, "gid": info.st_gid,
                "mode": format(stat.S_IMODE(info.st_mode), "04o"), "sizeBytes": info.st_size}
    except OSError as error:
        return {"exists": False if error.errno == 2 else None, "errno": error.errno}


def log_tag(key, default):
    value = os.environ.get(key, "")
    return value if re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}", value) else default


def event(name, *, phase, database=None, directory=None, errno=None):
    # The bootstrap runs before Node. Accept only the two internal event types
    # and collect file metadata here so callers cannot inject nested fields.
    try:
        levels = ("debug", "info", "warn", "error")
        minimum = os.environ.get("LOG_LEVEL", "info").lower()
        if minimum not in levels:
            minimum = "info"
        if name == "storage.entrypoint" and phase in ("before_permissions", "after_permissions"):
            if levels.index("info") < levels.index(minimum):
                return
            detail = {"phase": phase, "processUid": os.getuid(),
                      "directory": permissions(directory), "database": permissions(database)}
            path = str(database)
            if len(path) <= 512 and path.isprintable():
                detail["databasePath"] = path
            level = "info"
        elif name == "entrypoint.failed" and phase in ("validate_paths", "prepare_permissions", "execute_supervisor"):
            detail = {"phase": phase, "errno": errno if type(errno) is int else None}
            level = "error"
        else:
            return
        stamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        identity = {"level": level, "service": log_tag("SERVICE_NAME", "criterion"),
                    "release": log_tag("APP_RELEASE", "unknown"), "instanceId": log_tag("INSTANCE_ID", "unknown")}
        # Some log viewers render just message. Use the same validated metadata as the JSON fields.
        parts = [f"Criterion diagnostics v2: {name}"]
        for key, value in {**identity, **detail}.items():
            if isinstance(value, dict):
                parts.extend(f"{key}.{field}={item}" for field, item in value.items() if item is not None)
            elif value is not None:
                parts.append(f"{key}={value}")
        line = {"timestamp": stamp, **identity, "event": name, "message": " ".join(parts), **detail}
        print(json.dumps(line), flush=True, file=sys.stderr if level == "error" else sys.stdout)
    except Exception:
        # A missing log sink must not block startup or conceal the original failure.
        pass


phase = "validate_paths"
try:
    root = Path("/data")
    database = Path(os.environ.get("DATABASE_PATH", "/data/criterion.sqlite"))
    if root.is_symlink() or database.parent != root or database.is_symlink():
        raise ValueError("Database must be a regular file directly inside /data")
    event("storage.entrypoint", phase="before_permissions", database=database, directory=root)
    phase = "prepare_permissions"
    root.mkdir(exist_ok=True)
    if os.getuid() == 0:
        os.chown(root, 10001, 10001)
        os.chmod(root, 0o700)
        # Also support a root-owned database explicitly uploaded to the mount.
        for path in (database, Path(str(database) + "-wal"), Path(str(database) + "-shm")):
            if path.is_symlink():
                raise ValueError("Database symlinks are not supported")
            if path.exists():
                os.chown(path, 10001, 10001)
                os.chmod(path, 0o600)
        os.setgroups([])
        os.setgid(10001)
        os.setuid(10001)
    if os.getuid() == 0 or not os.access(root, os.W_OK):
        raise PermissionError("The application user must be able to write /data")
    event("storage.entrypoint", phase="after_permissions", database=database, directory=root)
    phase = "execute_supervisor"
    os.umask(0o077)
    os.execvp(sys.argv[1], sys.argv[1:])
except Exception as error:
    event("entrypoint.failed", phase=phase, errno=error.errno if isinstance(error, OSError) else None)
    print("Criterion: unable to prepare /data or start application. Check volume permissions and command.", file=sys.stderr)
    sys.exit(1)
