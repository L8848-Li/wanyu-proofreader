#!/usr/bin/env python3
"""Fail when the suite files, suites.json and the CI/docs lists drift apart.

The matrix used to live only inside ci.yml, so CONTRIBUTING.md listed four
suites while CI ran eleven. Adding a suite file now requires registering it, and
every coverage claim below is read out of the parsed workflow's `run:` steps and
the `env:` that feeds them, rather than matched against the file as text — so
deleting a job, leaving the job's name behind in a comment, or pinning a matrix
value to a constant can no longer keep this guard green.
"""
import json
import re
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


def run_commands(workflow):
    """Every script CI would actually execute, one entry per job."""
    commands = {}
    for name, job in (workflow.get('jobs') or {}).items():
        scripts = [str(step['run']) for step in (job.get('steps') or [])
                   if isinstance(step, dict) and step.get('run')]
        commands[name] = '\n'.join(scripts)
    return commands


def ci_builds_matrix_from_registry(workflow):
    """True only when a real job feeds suites.json into the matrix at runtime."""
    jobs = workflow.get('jobs') or {}
    matrix = jobs.get(MATRIX_JOB) or {}
    if matrix.get('needs') != PREPARE_JOB or PREPARE_JOB not in jobs:
        return False
    expression = ((matrix.get('strategy') or {}).get('matrix') or {}).get('include')
    if expression != MATRIX_EXPRESSION:
        return False
    commands = run_commands(workflow)
    # The prepare job must really read the registry, not emit a constant list,
    # and the matrix job must still be the one running the suites it was handed.
    if ('suites.json' not in commands.get(PREPARE_JOB, '')
            or 'run_integration.py' not in commands.get(MATRIX_JOB, '')):
        return False
    steps = [step for step in (matrix.get('steps') or []) if isinstance(step, dict)]
    runs = '\n'.join(str(step['run']) for step in steps if step.get('run'))
    if 'matrix.suite' in runs:
        return True
    # Which names the matrix value was handed to: a step env entry, or a job
    # env entry every step of the job inherits. Reading the key out of the YAML
    # instead of assuming one keeps any alias and any `${{matrix.suite}}` spacing
    # working. Only steps that run can consume it, so an `env:` hanging off a
    # `uses:` step leaves the value handed out but never used.
    handed = ([step.get('env') or {} for step in steps if step.get('run')]
              + [matrix.get('env') or {}])
    names = {str(key) for env in handed for key, value in env.items()
             if re.search(r'\$\{\{\s*matrix\.suite', str(value))}
    return any(re.search(r'\$\{' + re.escape(name) + r'\}', runs) for name in names)


def main():
    entries = json.loads((TESTS / 'suites.json').read_text())
    registered = {entry['suite']: entry for entry in entries}
    on_disk = sorted(path.name for path in TESTS.glob('*_integration.mjs'))
    workflow = yaml.safe_load(CI.read_text())
    commands = run_commands(workflow)
    executed = '\n'.join(commands.values())
    problems = []

    if not executed.strip():
        problems.append('ci.yml declares no runnable steps at all')
    matrix_driven = ci_builds_matrix_from_registry(workflow)
    if not matrix_driven:
        problems.append(f'ci.yml does not feed suites.json into {MATRIX_JOB} through {PREPARE_JOB}')

    for suite in sorted(set(on_disk) - set(registered)):
        problems.append(f'{suite}: exists on disk but is not registered in suites.json')
    for suite in sorted(set(registered) - set(on_disk)):
        problems.append(f'{suite}: listed in suites.json but backend/tests/{suite} is missing')

    for suite, entry in registered.items():
        if entry.get('ci_matrix') and matrix_driven:
            continue
        # What must actually appear in an executed step: a dedicated runner, else
        # the suite file itself.
        wanted = entry.get('ci_runner') or suite
        if wanted not in executed:
            problems.append(f'{suite}: registered but no CI step executes {wanted}')

    for check in sorted(path.name for path in TESTS.glob('check_*.py')):
        if check not in executed:
            problems.append(f'{check}: exists but no CI step executes it')

    if 'make check' not in CONTRIBUTING.read_text():
        problems.append('CONTRIBUTING.md does not document `make check`')

    if problems:
        print('test inventory drift:', file=sys.stderr)
        for problem in problems:
            print(f'  - {problem}', file=sys.stderr)
        return 1
    print(f'PASS: {len(on_disk)} integration suites registered on disk and executed by CI')
    return 0


if __name__ == '__main__':
    sys.exit(main())
