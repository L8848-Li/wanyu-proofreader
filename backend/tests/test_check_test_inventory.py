#!/usr/bin/env python3
"""Tests for check_test_inventory.py's CI-link detection.

The guard's whole job is to notice when CI stops running a registered suite, so
its own detection must be able to fail. A previous version matched free text in
ci.yml, which two strings inside comments could satisfy while the real YAML keys
were commented out.
"""
import importlib.util
import io
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

SPEC = importlib.util.spec_from_file_location(
    'inventory_guard', Path(__file__).resolve().parent / 'check_test_inventory.py')
inventory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inventory)


def workflow(text):
    import yaml
    return yaml.safe_load(text)


class MatrixLink(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.real = inventory.CI.read_text()

    def test_real_workflow_is_accepted(self):
        self.assertTrue(inventory.ci_builds_matrix_from_registry(workflow(self.real)))

    def test_commented_out_keys_do_not_count(self):
        # The exact mutation that fooled the previous substring check: the two
        # magic strings survive inside comments while the real keys are inert.
        mutated = self.real.replace(
            '    needs: prepare-matrix',
            '    # needs: prepare-matrix')
        mutated = mutated.replace(
            '        include: ${{ fromJson(needs.prepare-matrix.outputs.suites) }}',
            '        # include: ${{ fromJson(needs.prepare-matrix.outputs.suites) }}')
        self.assertNotEqual(mutated, self.real, 'the mutation did not apply')
        self.assertFalse(inventory.ci_builds_matrix_from_registry(workflow(mutated)))

    def test_missing_dependency_is_rejected(self):
        mutated = self.real.replace('    needs: prepare-matrix\n', '')
        self.assertNotEqual(mutated, self.real, 'the mutation did not apply')
        self.assertFalse(inventory.ci_builds_matrix_from_registry(workflow(mutated)))

    def test_static_matrix_is_rejected(self):
        mutated = self.real.replace(
            '        include: ${{ fromJson(needs.prepare-matrix.outputs.suites) }}',
            '        suite: [core_logic]')
        self.assertNotEqual(mutated, self.real, 'the mutation did not apply')
        self.assertFalse(inventory.ci_builds_matrix_from_registry(workflow(mutated)))

    def test_unconsumed_matrix_value_is_rejected(self):
        # The bypass this guards against: the matrix job still fans out into
        # eleven jobs and still names run_integration.py, but the dispatched
        # ${{ matrix.suite }} is pinned to a constant, so every job runs the
        # same suite. The anchor survives; only the consumption breaks.
        mutated = self.real.replace(
            '          SUITE: ${{ matrix.suite }}',
            '          SUITE: core_logic')
        self.assertNotEqual(mutated, self.real, 'the mutation did not apply')
        self.assertFalse(inventory.ci_builds_matrix_from_registry(workflow(mutated)))


class GuardExitCodes(unittest.TestCase):
    def run_against(self, ci_text):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'ci.yml'
            path.write_text(ci_text, encoding='utf-8')
            with mock.patch.object(inventory, 'CI', path):
                return inventory.main()

    def test_unregistered_suite_on_disk_fails(self):
        extra = inventory.TESTS / 'zz_unregistered_integration.mjs'
        extra.write_text('// temporary fixture for this test\n', encoding='utf-8')
        self.addCleanup(extra.unlink, missing_ok=True)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(self.run_against(self.real_ci()), 1)

    def real_ci(self):
        return inventory.CI.read_text()

    def test_broken_matrix_link_fails_the_guard(self):
        mutated = self.real_ci().replace('    needs: prepare-matrix\n', '')
        self.assertNotEqual(mutated, self.real_ci(), 'the mutation did not apply')
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(self.run_against(mutated), 1)

    def test_untouched_repository_passes(self):
        with redirect_stdout(io.StringIO()):
            self.assertEqual(self.run_against(self.real_ci()), 0)


class DeletedRunStepsAreCaught(GuardExitCodes):
    """The guard must notice when CI stops executing something it claims to cover.

    Substring matching against the whole workflow could not see this: the job
    names and suite names survive in comments and in unrelated steps after the
    `run:` that does the work is deleted.
    """

    MUTATIONS = (
        ('matrix job no longer runs its suites',
         'run: python3 backend/tests/run_integration.py "${SUITE}_integration.mjs"',
         'run: echo skipped'),
        ('the dedicated rare-characters runner is no longer invoked',
         'run: python3 backend/tests/run_rare_characters_integration.py',
         'run: echo skipped'),
        ('the migration verifier is no longer invoked',
         'run: python3 backend/tests/check_migrations.py',
         'run: echo skipped'),
        ('a suite is no longer invoked anywhere',
         'run: python3 backend/tests/run_integration.py pdf_chunks_integration.mjs',
         'run: echo skipped'),
        ('the guard itself is no longer invoked',
         'run: python3 check_test_inventory.py',
         'run: echo skipped'),
        ('the matrix value is pinned to a constant instead of consumed',
         '          SUITE: ${{ matrix.suite }}',
         '          SUITE: core_logic'),
    )

    def test_each_deletion_fails(self):
        for label, anchor, replacement in self.MUTATIONS:
            mutated = self.real_ci().replace(anchor, replacement)
            self.assertNotEqual(mutated, self.real_ci(), f'mutation did not apply: {label}')
            with self.subTest(label):
                with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                    self.assertEqual(self.run_against(mutated), 1)

    def test_commented_out_keys_alone_do_not_count(self):
        # The original bypass: the magic strings survive inside comments.
        mutated = self.real_ci().replace(
            '        run: python3 backend/tests/run_integration.py "${SUITE}_integration.mjs"\n',
            '        # run: python3 backend/tests/run_integration.py "${SUITE}_integration.mjs"\n')
        self.assertNotEqual(mutated, self.real_ci(), 'the mutation did not apply')
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(self.run_against(mutated), 1)


if __name__ == '__main__':
    unittest.main()
