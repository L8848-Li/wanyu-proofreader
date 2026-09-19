#!/usr/bin/env python3
"""Fail when the suite files, suites.json and the CI/docs lists drift apart.

The matrix used to live only inside ci.yml, so CONTRIBUTING.md listed four
suites while CI ran eleven. Adding a suite file now requires registering it.
"""
import json
import sys

import harness

ROOT = harness.BACKEND.parent
CI = ROOT / '.github' / 'workflows' / 'ci.yml'
CONTRIBUTING = ROOT / 'CONTRIBUTING.md'
TESTS = harness.BACKEND / 'tests'


def main():
    tests = harness.BACKEND / 'tests'
    entries = json.loads((tests / 'suites.json').read_text())
    registered = {entry['suite']: entry for entry in entries}
    on_disk = sorted(path.name for path in tests.glob('*_integration.mjs'))
    ci_text = CI.read_text()
    generated = 'suites.json' in ci_text
    problems = []

    for suite in sorted(set(on_disk) - set(registered)):
        problems.append(f'{suite}: exists on disk but is not registered in suites.json')
    for suite in sorted(set(registered) - set(on_disk)):
        problems.append(f'{suite}: listed in suites.json but backend/tests/{suite} is missing')
    for suite, entry in registered.items():
        # A matrix generated from suites.json covers ci_matrix entries implicitly;
        # the special ones must name their own runner and that runner must run in CI.
        if entry.get('ci_matrix') and generated:
            continue
        runner = entry.get('ci_runner')
        if runner:
            if runner in ci_text:
                continue
            problems.append(f'{suite}: registered but no CI job runs {runner}')
            continue
        if suite not in ci_text:
            problems.append(f'{suite}: registered but no CI job references it')

    contributing = CONTRIBUTING.read_text()
    if 'make check' not in contributing:
        problems.append('CONTRIBUTING.md does not document `make check`')
    for check in sorted(path.name for path in tests.glob('check_*.py')):
        if check not in ci_text:
            problems.append(f'{check}: exists but CI never runs it')

    if problems:
        print('test inventory drift:', file=sys.stderr)
        for problem in problems:
            print(f'  - {problem}', file=sys.stderr)
        return 1
    print(f'PASS: {len(on_disk)} integration suites registered, listed in CI and documented')
    return 0


if __name__ == '__main__':
    sys.exit(main())
