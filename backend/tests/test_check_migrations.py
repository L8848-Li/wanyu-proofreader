#!/usr/bin/env python3
"""Tests for check_migrations.py's SPECS↔disk reconciliation.

These run without booting a server, so the mutation cases the reviewer asked for
("hide one migration that SPECS covers and the verifier must fail") are cheap to
keep. The round trip itself is verified by running check_migrations.py.
"""
import importlib.util
import shutil
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    'migration_guard', Path(__file__).resolve().parent / 'check_migrations.py')
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)


def copy_migrations(exclude=(), extra=()):
    """A disposable migrations directory that looks like the real one minus `exclude`."""
    target = Path(tempfile.mkdtemp(prefix='fangji-migrations-'))
    for source in sorted(guard.harness.MIGRATIONS.glob('*.js')):
        if source.name not in exclude:
            shutil.copy(source, target)
    for name, text in extra:
        (target / name).write_text(text, encoding='utf-8')
    return target


class SpecCoverage(unittest.TestCase):
    def setUp(self):
        self.temp = copy_migrations()
        self.addCleanup(shutil.rmtree, self.temp, ignore_errors=True)

    def test_real_tree_is_fully_covered(self):
        on_disk, problems = guard.spec_coverage(self.temp)
        self.assertEqual(problems, [])
        self.assertIn(guard.FIRST, on_disk)
        self.assertGreaterEqual(len(on_disk), 4)
        # Every index migration the two deleted one-off scripts pinned is still pinned.
        for name in ('1788941000_pagination_indexes.js',
                     '1788942000_join_attempt_retention.js',
                     '1789027200_pdf_task_affinity.js'):
            self.assertIn(name, on_disk)
            self.assertIn(name, guard.SPECS)

    def test_hidden_migration_fails(self):
        for name in sorted(guard.SPECS):
            without = copy_migrations(exclude=[name])
            self.addCleanup(shutil.rmtree, without, ignore_errors=True)
            _, problems = guard.spec_coverage(without)
            self.assertTrue(any(name in problem for problem in problems),
                            f'removing {name} must fail, got {problems}')

    def test_unasserted_new_migration_fails(self):
        with_extra = copy_migrations(
            extra=[('1790000000_brand_new_index.js', 'migrate((app) => {}, () => {})\n')])
        self.addCleanup(shutil.rmtree, with_extra, ignore_errors=True)
        _, problems = guard.spec_coverage(with_extra)
        self.assertTrue(any('no assertions in SPECS' in problem for problem in problems), problems)

    def test_empty_directory_fails(self):
        empty = Path(tempfile.mkdtemp(prefix='fangji-migrations-'))
        self.addCleanup(shutil.rmtree, empty, ignore_errors=True)
        on_disk, problems = guard.spec_coverage(empty)
        self.assertEqual(on_disk, [])
        self.assertTrue(any(guard.FIRST in problem for problem in problems), problems)

    def test_missing_initial_schema_fails_even_with_other_files(self):
        without_first = copy_migrations(exclude=[guard.FIRST])
        self.addCleanup(shutil.rmtree, without_first, ignore_errors=True)
        _, problems = guard.spec_coverage(without_first)
        self.assertTrue(any('vacuously' in problem for problem in problems), problems)


if __name__ == '__main__':
    unittest.main()
