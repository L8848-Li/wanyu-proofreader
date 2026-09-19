#!/usr/bin/env python3
"""Run a backend integration script against a disposable, fully migrated server.

Usage:
  python3 backend/tests/run_integration.py <suite>.mjs [--env KEY=VALUE ...]
"""
import argparse
import subprocess
import sys
from pathlib import Path

import harness


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('suite', help='file name inside backend/tests, or an absolute path')
    parser.add_argument('--env', action='append', default=[], metavar='KEY=VALUE',
                        help='extra environment for both the server and the suite')
    parser.add_argument('--race', action='store_true', help='build the server with the race detector')
    parser.add_argument('--keep', action='store_true', help='leave the temporary data directory in place')
    args = parser.parse_args(argv)
    extra = {}
    for item in args.env:
        if '=' not in item:
            parser.error(f'--env expects KEY=VALUE, got {item}')
        key, value = item.split('=', 1)
        extra[key] = value
    return args, extra


def main(argv=None):
    args, extra = parse_args(argv)
    from pathlib import Path
    suite = Path(args.suite)
    script = suite if suite.is_absolute() else harness.BACKEND / 'tests' / suite.name
    if not script.exists():
        sys.exit(f'no such suite: {script}')
    with harness.temporary_root(keep=args.keep) as root:
        binary = harness.build_binary(root / 'pocketbase', race=args.race)
        with harness.server(binary, root, extra_env=extra) as env:
            try:
                subprocess.run(['node', str(script)], env=env, check=True)
            except subprocess.CalledProcessError as failure:
                # Emit diagnostics before the temporary directory removes the evidence.
                # This server only contains generated, disposable test identities.
                print(f'FAILED integration: {script.name} (exit {failure.returncode})', file=sys.stderr)
                print(harness._log_tail(root), file=sys.stderr)
                raise
    print(f'PASS integration: {script.name}', flush=True)


if __name__ == '__main__':
    main()
