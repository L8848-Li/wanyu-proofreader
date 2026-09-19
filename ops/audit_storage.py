#!/usr/bin/env python3
"""Report on the storage a running instance accumulates. Read-only, never deletes.

docs/operations.md gives single uploads a 1 GiB budget and /tmp 512 MiB, but
nothing watched the data directory as a whole. --budget is that whole-directory
limit and defaults well above one upload; point it at a data directory from cron
and this exits non-zero once the watermark is crossed, leaving a human to decide
what to prune.

  python3 ops/audit_storage.py --data-dir ./pb_data
  python3 ops/audit_storage.py --data-dir /var/lib/fangji/pb_data --json
"""
import argparse
import json
import shutil
import sys
import time
from pathlib import Path

# Mirrors backend/pdf_cache.go and backend/pdf_uploads.go.
TTLs = {
    'pdf-preview-cache-v1': 24 * 3600,
    'pdf-upload-staging-v1': 3600,
}
DEFAULT_BUDGET = 2 * 1024 ** 3


def human(size):
    for unit in ('B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'):
        if abs(size) < 1024 or unit == 'PiB':
            return f'{size:,.1f} {unit}'
        size /= 1024
    return f'{size:,.1f} PiB'


def size_of(path):
    try:
        return path.stat().st_size
    except OSError:
        return 0  # the in-process sweep may have just reclaimed it


def directory_size(path):
    total = 0
    try:
        entries = list(path.rglob('*'))
    except OSError:
        return total
    for entry in entries:
        try:
            if entry.is_file() and not entry.is_symlink():
                total += size_of(entry)
        except OSError:
            continue
    return total


def audit(data_dir, now, budget):
    findings = []
    if not data_dir.is_dir():
        return [{'level': 'error', 'what': f'{data_dir} is not a directory'}], {}

    total = directory_size(data_dir)
    free = shutil.disk_usage(data_dir).free
    summary = {'data_dir': str(data_dir), 'total_bytes': total, 'free_bytes': free,
               'budget_bytes': budget}

    if total > budget:
        findings.append({'level': 'error',
                         'what': f'{data_dir} holds {human(total)}, over the {human(budget)} budget'})
    elif total > budget * 0.8:
        findings.append({'level': 'warn', 'what': f'{data_dir} is at {total / budget:.0%} of budget ({human(total)})'})
    if free < max(budget, 1024 ** 3):
        findings.append({'level': 'error', 'what': f'only {human(free)} free on the {data_dir} filesystem'})
    elif free < 5 * 1024 ** 3:
        findings.append({'level': 'warn', 'what': f'only {human(free)} free on the {data_dir} filesystem'})

    for name, ttl in TTLs.items():
        root = data_dir / name
        if not root.is_dir():
            # A renamed directory would otherwise switch these findings off silently.
            findings.append({'level': 'note', 'what': f'{name} is absent, so its TTL is not audited'})
            continue
        size = directory_size(root)
        summary[name] = {'bytes': size, 'entries': len([p for p in root.iterdir() if p.is_dir() or p.is_file()])}
        for entry in sorted(root.iterdir()):
            try:
                age = now - entry.stat().st_mtime
            except OSError:
                continue
            if entry.name.startswith('building-') and age > 3600:
                findings.append({'level': 'warn',
                                 'what': f'{entry} is a crashed page-split left for {age / 3600:.0f}h'})
            elif age > 2 * ttl:
                findings.append({'level': 'warn',
                                 'what': f'{entry} is {age / ttl:.1f} TTLs old; the in-process sweep has not reclaimed it'})

    database = data_dir / 'data.db'
    if database.exists():
        summary['data.db'] = {'bytes': database.stat().st_size}
    storage = data_dir / 'storage'
    if storage.is_dir():
        summary['storage'] = {'bytes': directory_size(storage)}

    try:
        files = [path for path in data_dir.rglob('*') if path.is_file()]
    except OSError:
        files = []
    largest = sorted(files, key=size_of, reverse=True)[:10]
    summary['largest'] = [{'path': str(path), 'bytes': size_of(path)} for path in largest]
    return findings, summary


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--data-dir', default='pb_data', type=Path)
    parser.add_argument('--budget', type=int, default=DEFAULT_BUDGET, help='bytes allowed before this alerts')
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--now', type=float, default=time.time(), help=argparse.SUPPRESS)
    args = parser.parse_args()

    findings, summary = audit(args.data_dir, args.now, args.budget)
    if args.json:
        print(json.dumps({'summary': summary, 'findings': findings}, ensure_ascii=False, indent=2))
    else:
        for key, value in sorted(summary.items()):
            if key in ('largest',):
                continue
            if isinstance(value, dict):
                print(f'{key:28} {human(value["bytes"])}')
            elif isinstance(value, int):
                print(f'{key:28} {human(value)}')
        for entry in summary.get('largest', [])[:5]:
            print(f'{"  " + Path(entry["path"]).name:30} {human(entry["bytes"])}')
        for finding in findings:
            stream = sys.stderr if finding['level'] == 'error' else sys.stdout
            print(f'{finding["level"].upper():5} {finding["what"]}', file=stream)
        if not findings:
            print('no storage findings')
    return 1 if any(finding['level'] == 'error' for finding in findings) else 0


if __name__ == '__main__':
    sys.exit(main())
