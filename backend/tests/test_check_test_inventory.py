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


if __name__ == '__main__':
    unittest.main()
