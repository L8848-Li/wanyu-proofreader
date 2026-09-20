#!/usr/bin/env python3
"""Fail when the suite files, suites.json and the CI/docs lists drift apart.

The matrix used to live only inside ci.yml, so CONTRIBUTING.md listed four
suites while CI ran eleven. Adding a suite file now requires registering it, and
the CI link is read out of the parsed workflow rather than matched as free text,
so commenting out the real keys cannot leave this guard reporting success.
"""
import json
import sys

import harness
import yaml

ROOT = harness.BACKEND.parent
CI = ROOT / '.github' / 'workflows' / 'ci.yml'
CONTRIBUTING = ROOT / 'CONTRIBUTING.md'
TESTS = harness.BACKEND / 'tests'
MATRIX_JOB = 'pocketbase-compatibility'
PREPARE_JOB = 'prepare-matrix'
MATRIX_EXPRESSION = '${{ fromJson(needs.prepare-matrix.outputs.suites) }}'


def ci_builds_matrix_from_registry(workflow):
    """True only when a real job feeds suites.json into the matrix at runtime."""
    jobs = workflow.get('jobs') or {}
    matrix = jobs.get(MATRIX_JOB) or {}
    if matrix.get('needs') != PREPARE_JOB or PREPARE_JOB not in jobs:
        return False
    expression = ((matrix.get('strategy') or {}).get('matrix') or {}).get('include')
    return expression == MATRIX_EXPRESSION


def main():
    tests = TESTS
    entries = json.loads((tests / 'suites.json').read_text())
    registered = {entry['suite']: entry for entry in entries}
    on_disk = sorted(path.name for path in tests.glob('*_integration.mjs'))
    workflow = yaml.safe_load(CI.read_text())
    problems = []

    generated = ci_builds_matrix_from_registry(workflow)
    if not generated:
        problems.append(f'ci.yml does not feed suites.json into {MATRIX_JOB} via {PREPARE_JOB}')

    for suite in sorted(set(on_disk) - set(registered)):
        problems.append(f'{suite}: exists on disk but is not registered in suites.json')
    for suite in sorted(set(registered) - set(on_disk)):
        problems.append(f'{suite}: listed in suites.json but backend/tests/{suite} is missing')
    for suite, entry in registered.items():
        # A matrix generated from suites.json covers ci_matrix entries implicitly;
        # the special ones must name their own runner and that runner must run.
        if entry.get('ci_matrix') and generated:
            continue
        runner = entry.get('ci_runner')
        if runner:
            if runner in CI.read_text():
                continue
            problems.append(f'{suite}: registered but no CI job runs {runner}')
            continue
        if suite not in CI.read_text():
            problems.append(f'{suite}: registered but no CI job references it')

    if 'make check' not in CONTRIBUTING.read_text():
        problems.append('CONTRIBUTING.md does not document `make check`')
    for check in sorted(path.name for path in tests.glob('check_*.py')):
        if check not in CI.read_text():
            problems.append(f'{check}: exists but CI never runs it')

    if problems:
        print('test inventory drift:', file=sys.stderr)
        for problem in problems:
            print(f'  - {problem}', file=sys.stderr)
        return 1
    print(f'PASS: {len(on_disk)} integration suites registered on disk and reachable from CI')
    return 0


if __name__ == '__main__':
    sys.exit(main())
