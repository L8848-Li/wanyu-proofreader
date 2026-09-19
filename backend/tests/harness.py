#!/usr/bin/env python3
"""Shared harness for backend integration suites.

Every suite runs against a throwaway data directory so the suites stay
order-independent, but the Go build is reused across suites by run_all.py.
"""
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from contextlib import contextmanager
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
MIGRATIONS = BACKEND / 'pb_migrations'
HOOKS = BACKEND / 'pb_hooks'

ADMIN_EMAIL = 'unicode-admin@example.com'
ADMIN_PASSWORD = 'UnicodeTest12345!'
SUPER_EMAIL = 'unicode-super@example.com'
SUPER_PASSWORD = 'UnicodeTest12345!'


def integration_env(base_url, extra=None):
    env = {**os.environ,
           'PB_URL': base_url,
           'APP_ADMIN_EMAIL': ADMIN_EMAIL,
           'APP_ADMIN_PASSWORD': ADMIN_PASSWORD,
           'PB_ADMIN_EMAIL': SUPER_EMAIL,
           'PB_ADMIN_PASSWORD': SUPER_PASSWORD,
           'PB_SUPER_EMAIL': SUPER_EMAIL,
           'PB_SUPER_PASSWORD': SUPER_PASSWORD,
           'FANGJI_SKIP_ADMIN_BOOTSTRAP': '0',
           'HINGHWA_IDENTITY_BASE_URL': ''}
    if extra:
        env.update(extra)
    return env


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def build_binary(dest, race=False):
    command = ['go', 'build']
    if race:
        command.append('-race')
    subprocess.run([*command, '-o', str(dest), '.'], cwd=BACKEND, check=True)
    return dest


def apply_migrations_individually(binary, data, migrations=MIGRATIONS):
    """Apply one migration per invocation to prove ordering is self-sufficient."""
    for migration in sorted(migrations.glob('*.js'), key=lambda path: int(path.name.split('_')[0])):
        with tempfile.TemporaryDirectory() as single:
            shutil.copy(migration, single)
            subprocess.run([str(binary), 'migrate', 'up', f'--dir={data}',
                            f'--migrationsDir={single}'],
                           env={**os.environ, 'FANGJI_SKIP_ADMIN_BOOTSTRAP': '1'},
                           check=True, stdout=subprocess.DEVNULL)


@contextmanager
def server(binary, root, extra_env=None, data=None, migrations=MIGRATIONS, hooks=HOOKS, race=False):
    """Serve a freshly migrated instance and yield its base URL."""
    root = Path(root)
    data = Path(data) if data else root / 'data'
    binary = build_binary(root / 'pocketbase', race=race) if binary is None else binary
    apply_migrations_individually(binary, data, migrations)
    port = free_port()
    env = integration_env(f'http://127.0.0.1:{port}', extra_env)
    with (root / 'server.log').open('a') as log:
        process = subprocess.Popen([str(binary), 'serve', f'--http=127.0.0.1:{port}', f'--dir={data}',
                                    f'--hooksDir={hooks}', f'--migrationsDir={migrations}',
                                    '--hooksWatch=false'], env=env, stdout=log, stderr=log)
        try:
            for _ in range(100):
                try:
                    with urllib.request.urlopen(env['PB_URL'] + '/api/health', timeout=1):
                        break
                except OSError:
                    if process.poll() is not None:
                        raise RuntimeError(_log_tail(root))
                    time.sleep(.1)
            else:
                raise RuntimeError('Temporary server did not become ready\n' + _log_tail(root))
            yield env
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
        if process.returncode not in (0, -15, 143):
            raise RuntimeError(f'server exited {process.returncode}\n{_log_tail(root)}')


def run_suite(name, env, cwd=None):
    """Run one node suite (or a python callable) with the server environment."""
    if callable(name):
        return name(env)
    return subprocess.run(['node', str(BACKEND / 'tests' / name)], env=env, check=True, cwd=cwd)


def _log_tail(root, size=20000):
    # Only disposable, generated test identities are present in this log.
    try:
        return (Path(root) / 'server.log').read_text()[-size:]
    except OSError:
        return '<no server.log>'


@contextmanager
def temporary_root(keep=False):
    if keep:
        root = Path(tempfile.mkdtemp(prefix='fangji-integration-'))
        try:
            yield root
        finally:
            print(f'kept temporary root: {root}', flush=True)
    else:
        with tempfile.TemporaryDirectory(prefix='fangji-integration-') as temp:
            yield Path(temp)


def discover_registry():
    """Return the registered suite entries in run order; suites.json is the source of truth."""
    entries = json.loads((BACKEND / 'tests' / 'suites.json').read_text())
    registered = [entry['suite'] for entry in entries]
    missing = [suite for suite in registered if not (BACKEND / 'tests' / suite).exists()]
    if missing:
        raise SystemExit(f'suites.json references missing files: {", ".join(missing)}')
    return entries
