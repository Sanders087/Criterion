"""Prepare only the SQLite mount, then run both services without root privileges."""
import os
import sys
from pathlib import Path

try:
    root = Path("/data")
    database = Path(os.environ.get("DATABASE_PATH", "/data/criterion.sqlite"))
    if root.is_symlink() or database.parent != root or database.is_symlink():
        raise ValueError("Database must be a regular file directly inside /data")
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
    os.umask(0o077)
    os.execvp(sys.argv[1], sys.argv[1:])
except Exception:
    print("Criterion: unable to prepare /data or start application. Check volume permissions and command.", file=sys.stderr)
    sys.exit(1)
