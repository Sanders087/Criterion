"""Prepare only the SQLite mount, then run both services without root privileges."""
import os
import sys
import json
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


def event(name, **fields):
    print("Criterion diagnostics v2: " + json.dumps({"timestamp": datetime.now(timezone.utc).isoformat(),
                      "service": "criterion", "event": name, **fields}), flush=True)


phase = "validate_paths"
try:
    root = Path("/data")
    database = Path(os.environ.get("DATABASE_PATH", "/data/criterion.sqlite"))
    if root.is_symlink() or database.parent != root or database.is_symlink():
        raise ValueError("Database must be a regular file directly inside /data")
    event("storage.entrypoint", phase="before_permissions", databasePath=str(database),
          processUid=os.getuid(), directory=permissions(root), database=permissions(database))
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
    event("storage.entrypoint", phase="after_permissions", databasePath=str(database),
          processUid=os.getuid(), directory=permissions(root), database=permissions(database))
    phase = "execute_supervisor"
    os.umask(0o077)
    os.execvp(sys.argv[1], sys.argv[1:])
except Exception as error:
    event("entrypoint.failed", phase=phase, errno=error.errno if isinstance(error, OSError) else None)
    print("Criterion: unable to prepare /data or start application. Check volume permissions and command.", file=sys.stderr)
    sys.exit(1)
