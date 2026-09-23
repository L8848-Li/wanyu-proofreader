#!/usr/bin/env python3
"""Tests for check_test_inventory.py's CI-link detection.

The guard's whole job is to notice when CI stops running a registered suite, so
its own detection must be able to fail. A previous version matched free text in
ci.yml, which two strings inside comments could satisfy while the real YAML keys
were commented out.
"""
import importlib.util
import io
import re
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

SPEC = importlib.util.spec_from_file_location(
    'inventory_guard', Path(__file__).resolve().parent / 'check_test_inventory.py')
inventory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inventory)

MATRIX_JOB = 'pocketbase-compatibility'
RACE_JOB = 'race-integration'
RUN_STEP = 'run: python3 backend/tests/run_integration.py "${SUITE}_integration.mjs"'
SUITE_ENV = '          SUITE: ${{ matrix.suite }}'
BROKEN_LINK = 'does not feed suites.json'


def workflow(text):
    import yaml
    return yaml.safe_load(text)


def job_block(text, job):
    """One top-level job's block as three offsets: its `job:` line, its body, the end.

    The block closes at the next key at exactly two spaces of indent, so nothing
    inside the job can be mistaken for the line that ends it.
    """
    header = re.search(r'^  ' + re.escape(job) + r':\n', text, re.MULTILINE)
    if not header:
        raise AssertionError(f'ci.yml no longer has a {job} job')
    sibling = re.search(r'^  [A-Za-z0-9_-]+:\n', text[header.end():], re.MULTILINE)
    end = header.end() + (sibling.start() if sibling else len(text) - header.end())
    return header.start(), header.end(), end


def mutate_job(text, job, anchor, replacement):
    """Rewrite one line inside a single job's block, and nowhere else.

    `env:` and the runner `run:` appear verbatim in more than one job, so a
    whole-file first-match replace follows whatever order ci.yml happens to list
    the jobs in. Reorder them and an `assertTrue` would then be judging an
    untouched matrix job — a mutation that cannot fail. Slicing to the named job
    keeps the mutation where the assertion says it is, and raises instead of
    quietly matching nothing.
    """
    _, body, end = job_block(text, job)
    block = text[body:end]
    mutated = block.replace(anchor, replacement, 1)
    if mutated == block:
        raise AssertionError(f'{anchor!r} is not inside the {job} job')
    return text[:body] + mutated + text[end:]


def moved_ahead_of(text, job, other):
    """The workflow with `job` cut out and pasted directly before `other`."""
    start, _, end = job_block(text, job)
    block = text[start:end]
    rest = text[:start] + text[end:]
    target = job_block(rest, other)[0]
    return rest[:target] + block + rest[target:]


class MatrixLink(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.real = inventory.CI.read_text()

    def assertMutated(self, mutated):
        self.assertNotEqual(mutated, self.real, 'the mutation did not apply')

    def test_real_workflow_is_accepted(self):
        self.assertTrue(inventory.ci_builds_matrix_from_registry(workflow(self.real)))

    def test_anchors_really_are_shared_by_two_jobs(self):
        # Why mutate_job exists: both lines below are written the same way in the
        # matrix job and in race-integration.
        self.assertEqual(self.real.count(SUITE_ENV), 2, 'a fixture assumption broke')
        self.assertEqual(self.real.count(RUN_STEP), 2, 'a fixture assumption broke')
        with self.assertRaises(AssertionError):
            mutate_job(self.real, 'seed-demo', SUITE_ENV, '          SUITE: core_logic')

    def test_job_order_is_not_part_of_the_evidence(self):
        # Paste the race job above the matrix job and pin the matrix job's value.
        # A whole-file first-match replace would hit the race job instead, leaving
        # a clean matrix job behind — and assertFalse on that untouched job is the
        # case where a reordered ci.yml turns the guard's own tests into decoration.
        reordered = moved_ahead_of(self.real, RACE_JOB, MATRIX_JOB)
        self.assertTrue(inventory.ci_builds_matrix_from_registry(workflow(reordered)),
                        'reordering the jobs must not change the verdict')
        pinned = mutate_job(reordered, MATRIX_JOB, SUITE_ENV, '          SUITE: core_logic')
        self.assertFalse(inventory.ci_builds_matrix_from_registry(workflow(pinned)))

    def test_commented_out_keys_do_not_count(self):
        # The exact mutation that fooled the previous substring check: the two
        # magic strings survive inside comments while the real keys are inert.
        mutated = self.real.replace(
            '    needs: prepare-matrix',
            '    # needs: prepare-matrix')
        mutated = mutated.replace(
            '        include: ${{ fromJson(needs.prepare-matrix.outputs.suites) }}',
            '        # include: ${{ fromJson(needs.prepare-matrix.outputs.suites) }}')
        self.assertMutated(mutated)
        self.assertFalse(inventory.ci_builds_matrix_from_registry(workflow(mutated)))

    def test_missing_dependency_is_rejected(self):
        mutated = self.real.replace('    needs: prepare-matrix\n', '')
        self.assertMutated(mutated)
        self.assertFalse(inventory.ci_builds_matrix_from_registry(workflow(mutated)))

    def test_static_matrix_is_rejected(self):
        mutated = self.real.replace(
            '        include: ${{ fromJson(needs.prepare-matrix.outputs.suites) }}',
            '        suite: [core_logic]')
        self.assertMutated(mutated)
        self.assertFalse(inventory.ci_builds_matrix_from_registry(workflow(mutated)))

    def test_unconsumed_matrix_value_is_rejected(self):
        # The bypass this guards against: the matrix job still fans out into
        # eleven jobs and still names run_integration.py, but the dispatched
        # ${{ matrix.suite }} is pinned to a constant, so every job runs the
        # same suite. The anchor survives; only the consumption breaks.
        mutated = mutate_job(self.real, MATRIX_JOB, SUITE_ENV, '          SUITE: core_logic')
        self.assertFalse(inventory.ci_builds_matrix_from_registry(workflow(mutated)))

    def test_legitimate_spellings_of_the_handoff_are_accepted(self):
        # The guard reads the env key out of the YAML instead of assuming one, so
        # these valid ways of passing the value cannot make a clean main red. The
        # first version of this check matched the literal `${{ matrix.suite }}`
        # and the literal name SUITE, and rejected all of them.
        cases = (
            ('a step env under another name',
             f'{SUITE_ENV}\n        {RUN_STEP}',
             '          SUITE_NAME: ${{ matrix.suite }}\n'
             '        run: python3 backend/tests/run_integration.py "${SUITE_NAME}_integration.mjs"'),
            ('an expression written without spaces',
             SUITE_ENV,
             '          SUITE: ${{matrix.suite}}'),
        )
        for label, anchor, replacement in cases:
            with self.subTest(label):
                mutated = mutate_job(self.real, MATRIX_JOB, anchor, replacement)
                self.assertTrue(
                    inventory.ci_builds_matrix_from_registry(workflow(mutated)))

    def test_job_level_env_is_accepted(self):
        # A job-level env: reaches every step of the job, so the value really is
        # consumed even though no step declares it.
        mutated = mutate_job(self.real, MATRIX_JOB, f'        env:\n{SUITE_ENV}\n', '')
        mutated = mutated.replace(
            '    needs: prepare-matrix\n',
            '    needs: prepare-matrix\n    env:\n      SUITE: ${{ matrix.suite }}\n', 1)
        self.assertMutated(mutated)
        self.assertTrue(inventory.ci_builds_matrix_from_registry(workflow(mutated)))

    def test_expanding_the_value_without_testing_anything_is_rejected(self):
        # Pinning the matrix value is not the only way to stop testing suites:
        # the step can still expand ${SUITE} while running nothing. So the
        # substitution alone must not be enough — the job has to keep running the
        # integration runner. Drop that requirement and this reads as consumed,
        # matrix_driven stays true, and main() skips all eleven matrix suites.
        mutated = mutate_job(self.real, MATRIX_JOB, RUN_STEP, 'run: echo ${SUITE}')
        self.assertFalse(inventory.ci_builds_matrix_from_registry(workflow(mutated)))

    def test_expansion_outside_the_runner_does_not_count(self):
        # The other half of the same hole: the runner is still called, but with a
        # hardcoded suite, and a second step expands the matrix value for show.
        # Every fan-out still names eleven jobs and none of them is a suite.
        mutated = mutate_job(
            self.real, MATRIX_JOB, f'        {RUN_STEP}',
            '        run: python3 backend/tests/run_integration.py "core_logic_integration.mjs"\n'
            '      - name: Report which slot this job drew\n'
            '        run: echo "suite=${{ matrix.suite }}"')
        self.assertFalse(inventory.ci_builds_matrix_from_registry(workflow(mutated)))

    def test_the_matrix_value_expanded_in_the_runner_is_accepted(self):
        # core-workflows spells it this way: no env at all, the runner step
        # interpolates the matrix expression itself.
        mutated = mutate_job(
            self.real, MATRIX_JOB, RUN_STEP,
            'run: python3 backend/tests/run_integration.py "${{ matrix.suite }}_integration.mjs"')
        self.assertTrue(inventory.ci_builds_matrix_from_registry(workflow(mutated)))

    def test_a_similarly_named_matrix_key_is_not_the_suite_value(self):
        # `matrix.suites` and `matrix.suite_extra` are other variables. Matching
        # them by prefix let an unrelated one pose as the source of the suite.
        for label, replacement in (('a plural sibling', '          SUITE: ${{ matrix.suites }}'),
                                   ('a longer name', '          SUITE: ${{ matrix.suite_extra }}')):
            with self.subTest(label):
                mutated = mutate_job(self.real, MATRIX_JOB, SUITE_ENV, replacement)
                self.assertFalse(
                    inventory.ci_builds_matrix_from_registry(workflow(mutated)))


class GuardExitCodes(unittest.TestCase):
    def run_against(self, ci_text):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'ci.yml'
            path.write_text(ci_text, encoding='utf-8')
            report = io.StringIO()
            with mock.patch.object(inventory, 'CI', path), redirect_stderr(report):
                with redirect_stdout(io.StringIO()):
                    code = inventory.main()
            return code, report.getvalue()

    def assertFailsFor(self, ci_text, expected):
        """Fail for one named reason, not merely with exit code 1.

        A mutant that always exits 1 would satisfy a bare exit-code assertion, and
        an unrelated new `problems.append` would let five mutations pass for a
        reason nobody meant to test. `test_untouched_repository_passes` pins the
        clean repository at 0, so a reported reason here is caused by this test's
        mutation — but the reason still has to be the one under test.
        """
        code, report = self.run_against(ci_text)
        self.assertEqual(code, 1, f'expected a failure mentioning {expected!r}')
        self.assertIn(expected, report, 'wrong reason reported:\n' + report)

    def test_unregistered_suite_on_disk_fails(self):
        extra = inventory.TESTS / 'zz_unregistered_integration.mjs'
        extra.write_text('// temporary fixture for this test\n', encoding='utf-8')
        self.addCleanup(extra.unlink, missing_ok=True)
        self.assertFailsFor(self.real_ci(), 'is not registered in suites.json')

    def real_ci(self):
        return inventory.CI.read_text()

    def test_broken_matrix_link_fails_the_guard(self):
        mutated = self.real_ci().replace('    needs: prepare-matrix\n', '')
        self.assertNotEqual(mutated, self.real_ci(), 'the mutation did not apply')
        self.assertFailsFor(mutated, BROKEN_LINK)

    def test_untouched_repository_passes(self):
        code, report = self.run_against(self.real_ci())
        self.assertEqual(code, 0, 'the clean repository must pass:\n' + report)


class DeletedRunStepsAreCaught(GuardExitCodes):
    """The guard must notice when CI stops executing something it claims to cover.

    Substring matching against the whole workflow could not see this: the job
    names and suite names survive in comments and in unrelated steps after the
    `run:` that does the work is deleted.
    """

    # (label, job to mutate, anchor, replacement, the reason that must appear)
    MUTATIONS = (
        ('matrix job no longer runs its suites', MATRIX_JOB, RUN_STEP, 'run: echo skipped',
         BROKEN_LINK),
        ('the dedicated rare-characters runner is no longer invoked', 'backend-unicode',
         'run: python3 backend/tests/run_rare_characters_integration.py', 'run: echo skipped',
         'no CI step executes run_rare_characters_integration.py'),
        ('the migration verifier is no longer invoked', 'backend-unicode',
         'run: python3 backend/tests/check_migrations.py', 'run: echo skipped',
         'check_migrations.py: exists but no CI step executes it'),
        ('a suite is no longer invoked anywhere', 'chunk-upload-browser',
         'run: python3 backend/tests/run_integration.py pdf_chunks_integration.mjs',
         'run: echo skipped',
         'pdf_chunks_integration.mjs: registered but no CI step executes'),
        ('the guard itself is no longer invoked', 'static-analysis',
         'run: python3 check_test_inventory.py', 'run: echo skipped',
         'check_test_inventory.py: exists but no CI step executes it'),
        ('the matrix value is pinned to a constant instead of consumed', MATRIX_JOB,
         SUITE_ENV, '          SUITE: core_logic', BROKEN_LINK),
        ('the matrix step expands ${SUITE} but runs no suite', MATRIX_JOB,
         RUN_STEP, 'run: echo ${SUITE}', BROKEN_LINK),
        ('the race job no longer runs its suites', RACE_JOB,
         f'{RUN_STEP} --race', 'run: echo skipped --race',
         'race-integration: declares a suite matrix but no runner step consumes it'),
        ('the race job pins its matrix value', RACE_JOB,
         SUITE_ENV, '          SUITE: upload_jobs',
         'race-integration: declares a suite matrix but no runner step consumes it'),
    )

    def test_each_deletion_fails(self):
        for label, job, anchor, replacement, expected in self.MUTATIONS:
            with self.subTest(label):
                mutated = mutate_job(self.real_ci(), job, anchor, replacement)
                self.assertFailsFor(mutated, expected)

    def test_matrix_job_fails_for_its_own_reason(self):
        # The race job keeps its suites while the matrix job loses them, so the
        # reason cannot be the race message above and vice versa.
        self.assertFailsFor(
            mutate_job(self.real_ci(), MATRIX_JOB, RUN_STEP, 'run: echo skipped'),
            BROKEN_LINK)
        self.assertFailsFor(
            mutate_job(self.real_ci(), RACE_JOB, f'{RUN_STEP} --race', 'run: echo skipped --race'),
            'race-integration: declares a suite matrix')

    def test_commented_out_keys_alone_do_not_count(self):
        # The original bypass: the magic strings survive inside comments.
        mutated = mutate_job(self.real_ci(), MATRIX_JOB, f'        {RUN_STEP}\n',
                             f'        # {RUN_STEP}\n')
        self.assertFailsFor(mutated, BROKEN_LINK)


if __name__ == '__main__':
    unittest.main()
