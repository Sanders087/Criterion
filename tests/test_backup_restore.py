"""Offline restore drill using a live WAL writer and new empty output directories."""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "backup-db.py"


class BackupRestore(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "fixture.sqlite"
        self.backups = self.root / "backups"

    def cli(self, *args, ok=True):
        env = {key: os.environ[key] for key in ("PATH", "SystemRoot", "TMP", "TEMP") if key in os.environ}
        env["DATABASE_PATH"] = str(self.source)
        run = subprocess.run([sys.executable, "-B", str(SCRIPT), *map(str, args)], env=env,
                             capture_output=True, text=True, timeout=20)
        self.assertEqual(run.returncode == 0, ok, run.stderr)
        return run

    def test_live_wal_restore_retention_and_no_overwrite(self):
        self.backups.mkdir(mode=0o700)
        expired = self.backups / "criterion-20000101T000000000000Z.sqlite"
        expired.touch()
        unrelated = self.backups / "preserve.sqlite"
        unrelated.touch()
        with closing(sqlite3.connect(self.source)) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute("CREATE TABLE fixture(value TEXT)")
            writer.commit()
            writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            writer.execute("INSERT INTO fixture VALUES ('wal-only-synthetic')")
            writer.commit()
            self.assertGreater(Path(str(self.source) + "-wal").stat().st_size, 0)
            writer.execute("INSERT INTO fixture VALUES ('uncommitted-synthetic')")
            snapshot = Path(self.cli().stdout.strip())
            writer.rollback()
        self.assertTrue(snapshot.is_file())
        self.assertFalse(expired.exists())
        self.assertTrue(unrelated.exists())
        state = json.loads((self.backups / "status.json").read_text())
        self.assertEqual(state["status"], "ok")
        self.assertGreater(state["lastSuccessTimestampSeconds"], 0)
        self.assertFalse(Path(str(snapshot) + "-wal").exists())
        if os.name == "posix":
            self.assertEqual(snapshot.stat().st_mode & 0o777, 0o600)
            self.assertEqual(self.backups.stat().st_mode & 0o777, 0o700)
        self.cli("--if-due")
        self.assertEqual(list(self.backups.glob("criterion-*.sqlite")), [snapshot])
        isolated = self.root / "isolated"
        isolated.mkdir(mode=0o700)
        restored = isolated / "restored.sqlite"
        self.cli("--restore", snapshot, "--to", restored)
        with closing(sqlite3.connect(restored)) as db:
            self.assertEqual(db.execute("SELECT value FROM fixture").fetchall(), [("wal-only-synthetic",)])
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchall(), [("ok",)])
        self.cli("--restore", snapshot, "--to", restored, ok=False)
        self.cli("--restore", snapshot, "--to", self.source, ok=False)
        stale_target = isolated / "orphan.sqlite"
        Path(str(stale_target) + "-wal").touch()
        self.cli("--restore", snapshot, "--to", stale_target, ok=False)
        self.assertFalse(stale_target.exists())

    def test_failed_backup_preserves_last_success_and_publishes_no_partial_files(self):
        with closing(sqlite3.connect(self.source)) as db:
            db.execute("CREATE TABLE fixture(id INTEGER)")
        snapshot = Path(self.cli().stdout.strip())
        status = self.backups / "status.json"
        last = json.loads(status.read_text())["lastSuccessTimestampSeconds"]
        marker = b"private-synthetic-corrupt-fixture"
        self.source.write_bytes(marker * 40)
        result = self.cli(ok=False)
        self.assertNotIn(marker.decode(), result.stdout + result.stderr)
        self.assertEqual(json.loads(status.read_text()), {"status": "failed", "lastSuccessTimestampSeconds": last})
        self.assertEqual(set(self.backups.iterdir()), {snapshot, status})
        destination = self.root / "invalid-restore.sqlite"
        self.cli("--restore", self.source, "--to", destination, ok=False)
        self.assertFalse(destination.exists())

    def test_missing_source_never_creates_empty_database(self):
        self.cli(ok=False)
        self.assertFalse(self.source.exists())
        self.assertEqual(json.loads((self.backups / "status.json").read_text()),
                         {"status": "failed", "lastSuccessTimestampSeconds": None})


if __name__ == "__main__":
    unittest.main()
