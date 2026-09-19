#!/usr/bin/env python3
"""Fail when runtime versions declared in code, images, CI and prose disagree.

Three real drifts this catches: the frontend image built on Node 26 while
package.json engines allowed only 24, the README advertising PocketBase 0.21.3
next to a go.mod on 0.40, and a dependency-upgrades note describing a schedule
dependabot no longer uses.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def engines_range(text):
    bounds = dict(re.findall(r'([<>]=?)\s*(\d+)', text))
    low = int(bounds.get('>=', bounds.get('>', 0))) + (1 if '>=' not in bounds and '>' in bounds else 0)
    high = int(bounds.get('<', 999)) - 1 if '<' in bounds else 999
    return low, high


def node_majors():
    """Every place a Node major version is declared for build or test."""
    found = {}
    dockerfile = (ROOT / 'frontend' / 'Dockerfile').read_text()
    for match in re.finditer(r'FROM\s+node:(\d+)', dockerfile, re.IGNORECASE):
        found['frontend/Dockerfile'] = match.group(1)
    nvmrc = ROOT / 'frontend' / '.nvmrc'
    if nvmrc.exists():
        found['frontend/.nvmrc'] = nvmrc.read_text().strip().split('.')[0]
    for workflow in sorted((ROOT / '.github' / 'workflows').glob('*.yml')):
        for match in re.finditer(r'node-version:\s*["\']?(\d+)', workflow.read_text()):
            found[f'{workflow.relative_to(ROOT)}:{match.start()}'] = match.group(1)
    return found


def pocketbase_claims(go_mod):
    declared = re.search(r'github.com/pocketbase/pocketbase v(\d+\.\d+\.\d+)', go_mod).group(1)
    problems = []
    found = 0
    # Match 0.40 as well as 0.40.4: prose is allowed to name only the minor line,
    # but a doc that drops to 0.21 must not slip through an over-strict pattern.
    pattern = re.compile(r'PocketBase\s+(\d+\.\d+(?:\.\d+)?)')
    # docs/dependency-upgrades.md is deliberately excluded: it is a dated decision
    # record that quotes the versions it upgraded *from*, which a text match cannot
    # tell apart from a current claim.
    for name in ('README.md', 'docs/operations.md', 'CONTRIBUTING.md'):
        text = (ROOT / name).read_text()
        for match in pattern.finditer(text):
            found += 1
            claim = match.group(1)
            if claim.split('.')[:2] != declared.split('.')[:2]:
                problems.append(f'{name}:{text[:match.start()].count(chr(10)) + 1} says PocketBase {claim} '
                                f'but backend/go.mod pins {declared}')
            elif '.' in claim[4:] and claim != declared:
                problems.append(f'{name} says PocketBase {claim} but backend/go.mod pins {declared}')
    if not found:
        problems.append('no PocketBase version is stated anywhere, so this check proves nothing')
    return problems, declared


def main():
    problems = []
    go_mod = (ROOT / 'backend' / 'go.mod').read_text()
    package = json.loads((ROOT / 'frontend' / 'package.json').read_text())
    engines = package.get('engines', {}).get('node')
    if not engines:
        problems.append('frontend/package.json declares no engines.node range')
    else:
        low, high = engines_range(engines)
        declared = node_majors()
        if not declared:
            problems.append('no Node version is declared in the image, .nvmrc or CI, so engines cannot be verified')
        for source, major in sorted(declared.items()):
            if not low <= int(major) <= high:
                problems.append(f'{source} uses Node {major}, outside engines.node "{engines}"')
        # Whatever the image builds with must also be exercised by CI, or the
        # shipped configuration has never been tested.
        image_major = declared.get('frontend/Dockerfile')
        tested = {major for source, major in declared.items() if 'workflows' in source}
        if image_major and image_major not in tested:
            problems.append(f'frontend/Dockerfile builds on Node {image_major} but CI only tests {sorted(tested)}')

    go_version = re.search(r'^go (\d+)\.(\d+)', go_mod, re.MULTILINE)
    image = re.search(r'FROM\s+golang:(\d+)(?:\.(\d+))?', (ROOT / 'backend' / 'Dockerfile').read_text())
    if not go_version:
        problems.append('backend/go.mod declares no go directive')
    if not image:
        problems.append('backend/Dockerfile pins no golang image version to compare against go.mod')
    if go_version and image:
        minor = int(image.group(2) or 0)
        if (int(image.group(1)), minor) < (int(go_version.group(1)), int(go_version.group(2))):
            problems.append(f'backend/Dockerfile builds with golang {image.group(1)}.{image.group(2) or 0} '
                            f'but go.mod needs {go_version.group(1)}.{go_version.group(2)}')

    version_problems, pocketbase = pocketbase_claims(go_mod)
    problems += version_problems

    sdk = package['dependencies']['pocketbase']
    for name in ('README.md',):
        for match in re.finditer(r'SDK\s+(\d+\.\d+\.\d+)', (ROOT / name).read_text()):
            if sdk.lstrip('^~') != match.group(1):
                problems.append(f'{name} says SDK {match.group(1)} but package.json pins {sdk}')

    intervals = set(re.findall(r'interval:\s*(\w+)', (ROOT / '.github' / 'dependabot.yml').read_text()))
    # Only Dependabot *updates* are the subject here; the audit workflow is
    # deliberately a weekly cron, so scan line by line instead of whole files.
    for name in ('docs/dependency-upgrades.md', 'README.md'):
        for number, line in enumerate((ROOT / name).read_text().splitlines(), start=1):
            if 'Dependabot' not in line and 'dependabot' not in line:
                continue
            if '每周' in line and 'weekly' not in intervals:
                problems.append(f'{name}:{number} says Dependabot is weekly but dependabot.yml uses {sorted(intervals)}')
            if '每日' in line and 'daily' not in intervals:
                problems.append(f'{name}:{number} says Dependabot is daily but dependabot.yml uses {sorted(intervals)}')

    for problem in problems:
        print(f'drift: {problem}', file=sys.stderr)
    if problems:
        return 1
    print(f'PASS: Node, Go, PocketBase {pocketbase} and dependabot declarations agree')
    return 0


if __name__ == '__main__':
    sys.exit(main())
