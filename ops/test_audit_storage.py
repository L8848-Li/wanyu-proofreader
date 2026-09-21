#!/usr/bin/env python3
"""Tests for ops/audit_storage.py.

The tool is an operator-facing alert: a broken one ships silently and simply
stops alerting, so its exit codes, TTL findings and read-only guarantee need to
be pinned. Nothing here touches a real pb_data.
"""
import importlib.util
import io
import os
import shutil
import tempfile
import sys
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

SPEC = importlib.util.spec_from_file_location('audit_storage', Path(__file__).resolve().parent / 'audit_storage.py')
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)

HOUR = 3600


def build_data_dir(root, stale_cache=False, crashed_split=False):
    root = Path(root)
    (root / 'storage' / 'ab' / 'cd').mkdir(parents=True)
    (root / 'data.db').write_bytes(b'x' * 4096)
    (root / 'storage' / 'ab' / 'cd' / 'file.pdf').write_bytes(b'y' * 2048)
    cache = root / 'pdf-preview-cache-v1' / 'pages-demo'
    cache.mkdir(parents=True)
    (cache / 'page-1.pdf').write_bytes(b'z' * 1024)
    (cache / 'ready').write_bytes(b'')
    staging = root / 'pdf-upload-staging-v1' / 'user-1'
    staging.mkdir(parents=True)
    (staging / 'chunk-0').write_bytes(b'w' * 512)
    if stale_cache:
        old = time.time() - 3 * 24 * HOUR
        os.utime(cache / 'ready', (old, old))
        os.utime(cache, (old, old))
    if crashed_split:
        building = root / 'pdf-preview-cache-v1' / 'building-leftover'
        building.mkdir(parents=True)
        (building / 'page-1.pdf').write_bytes(b'v' * 256)
        old = time.time() - 2 * HOUR
        os.utime(building / 'page-1.pdf', (old, old))
        os.utime(building, (old, old))
    return root


def snapshot(root):
    return sorted(str(path.relative_to(root)) for path in Path(root).rglob('*'))


class AuditStorage(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix='fangji-audit-'))
        self.addCleanup(shutil.rmtree, self.temp, ignore_errors=True)

    def run_audit(self, data_dir, budget=audit.DEFAULT_BUDGET):
        argv = ['audit_storage.py', '--data-dir', str(data_dir), '--budget', str(budget), '--json']
        captured = io.StringIO()
        with mock.patch.object(sys, 'argv', argv), redirect_stdout(captured), redirect_stderr(captured):
            code = audit.main()
        return code, captured.getvalue()

    def test_healthy_directory_reports_no_findings(self):
        build_data_dir(self.temp)
        code, output = self.run_audit(self.temp)
        self.assertEqual(code, 0)
        self.assertEqual(output.strip().count('"level"'), 0, output)

    def test_is_read_only(self):
        build_data_dir(self.temp, stale_cache=True, crashed_split=True)
        before = snapshot(self.temp)
        self.run_audit(self.temp)
        self.assertEqual(before, snapshot(self.temp), 'the audit must not create, move or delete anything')

    def test_stale_cache_and_crashed_split_are_reported(self):
        build_data_dir(self.temp, stale_cache=True, crashed_split=True)
        code, output = self.run_audit(self.temp)
        self.assertEqual(code, 0, 'a warning alone must not page anyone')
        self.assertIn('crashed page-split', output)
        self.assertIn('TTLs old', output)

    def test_budget_breach_exits_nonzero(self):
        build_data_dir(self.temp)
        code, _ = self.run_audit(self.temp, budget=1024)
        self.assertEqual(code, 1)

    def test_missing_directory_exits_nonzero(self):
        code, _ = self.run_audit(self.temp / 'not-here')
        self.assertEqual(code, 1)

    def test_sizes_are_counted_without_following_symlinks(self):
        build_data_dir(self.temp)
        link = self.temp / 'storage' / 'loop'
        link.symlink_to(self.temp)
        code, output = self.run_audit(self.temp)
        self.assertEqual(code, 0)
        self.assertIn('"total_bytes"', output)


if __name__ == '__main__':
    unittest.main()
