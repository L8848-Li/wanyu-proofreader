#!/usr/bin/env python3
"""Tests for the compose guard's own substitution logic and failure paths.

check_compose_structure.py reimplements enough of compose's ${VAR:-default} and
${VAR:?err} handling to act as a privilege gate, so that reimplementation needs
its own tests; without them a wrong regex silently turns the gate into a no-op.
"""
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SPEC = importlib.util.spec_from_file_location(
    'compose_guard', Path(__file__).resolve().parents[1] / 'scripts' / 'check_compose_structure.py')
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)


class Interpolation(unittest.TestCase):
    def setUp(self):
        self.environment = {
            'SET': 'x',
            'EMPTY': '',
            'TRAEFIK_HOST': 'fangji.example.com',
        }
        patcher = mock.patch.dict(os.environ, self.environment, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop('UNSET', None)

    def resolved(self, text):
        missing = set()
        return guard.resolve(text, missing), missing

    def test_default_forms(self):
        self.assertEqual(self.resolved('${UNSET:-fallback}'), ('fallback', set()))
        self.assertEqual(self.resolved('${SET:-fallback}'), ('x', set()))
        self.assertEqual(self.resolved('${UNSET}'), ('', set()))

    def test_colon_forms_treat_empty_as_unset(self):
        self.assertEqual(self.resolved('${EMPTY:-fallback}'), ('fallback', set()))
        self.assertEqual(self.resolved('${EMPTY}'), ('', set()))

    def test_required_forms_error_only_in_their_documented_cases(self):
        # ${VAR?} errors when unset; ${VAR:?} also errors when empty.
        self.assertEqual(self.resolved('${UNSET?}'), ('', {'UNSET'}))
        self.assertEqual(self.resolved('${EMPTY?}'), ('', set()))
        self.assertEqual(self.resolved('${EMPTY:?msg}'), ('', {'EMPTY'}))

    def test_router_rule_resolves_inside_backticks(self):
        text = 'Host(`${TRAEFIK_HOST:?Set TRAEFIK_HOST, for example x}`)'
        self.assertEqual(self.resolved(text), ('Host(`fangji.example.com`)', set()))

    def test_unsupported_form_is_reported_not_silently_ignored(self):
        # ${VAR=x} (no colon) is valid compose but unparsable here; failing loudly
        # beats substituting a wrong value into a security assertion.
        value, missing = self.resolved('${UNSET=fallback}')
        self.assertEqual(value, '')
        self.assertTrue(any('unparsable' in item for item in missing), missing)

    def test_literals_pass_through(self):
        self.assertEqual(self.resolved('127.0.0.1:8090:8090'), ('127.0.0.1:8090:8090', set()))


class Mapping(unittest.TestCase):
    def test_accepts_both_compose_forms(self):
        self.assertEqual(guard.mapping(['A=1', 'B=2']), {'A': '1', 'B': '2'})
        self.assertEqual(guard.mapping({'A': 1}), {'A': '1'})
        self.assertEqual(guard.mapping(None), {})
        self.assertEqual(guard.mapping(['FLAG']), {'FLAG': ''})


class GuardFailsOnRealViolations(unittest.TestCase):
    """The gate must be capable of failing; a vacuous pass is worse than no gate."""

    def run_guard(self, root):
        with mock.patch.object(guard, 'ROOT', root):
            return guard.main()

    def write(self, root, name, text):
        (root / name).write_text(text, encoding='utf-8')

    def scaffold(self):
        root = Path(tempfile.mkdtemp())
        base = (guard.ROOT / 'docker-compose.yml').read_text()
        self.write(root, 'docker-compose.yml', base)
        for name in ('docker-compose.dev.yml', 'docker-compose.traefik.yml', 'docker-compose.named-volume.yml'):
            self.write(root, name, (guard.ROOT / name).read_text())
        return root

    def test_clean_checkout_passes(self):
        self.assertEqual(self.run_guard(self.scaffold()), 0)

    def test_exposed_backend_port_fails(self):
        root = self.scaffold()
        broken = (guard.ROOT / 'docker-compose.yml').read_text().replace(
            '    read_only: true\n', '    read_only: true\n    ports:\n      - "9090:8090"\n', 1)
        self.write(root, 'docker-compose.yml', broken)
        self.assertEqual(self.run_guard(root), 1)

    def test_lost_capability_drop_fails(self):
        root = self.scaffold()
        broken = (guard.ROOT / 'docker-compose.yml').read_text().replace(
            '    cap_drop: [ALL]\n', '', 1)
        self.write(root, 'docker-compose.yml', broken)
        self.assertEqual(self.run_guard(root), 1)

    def test_admin_ui_on_by_default_fails(self):
        root = self.scaffold()
        broken = (guard.ROOT / 'docker-compose.yml').read_text().replace(
            'ENABLE_POCKETBASE_ADMIN_UI:-false', 'ENABLE_POCKETBASE_ADMIN_UI:-true')
        self.write(root, 'docker-compose.yml', broken)
        self.assertEqual(self.run_guard(root), 1)

    def test_privileged_frontend_fails(self):
        # `privileged` was once checked for the backend only, so a frontend
        # override passed every assertion in this file.
        root = self.scaffold()
        broken = (guard.ROOT / 'docker-compose.yml').read_text().replace(
            '  frontend:\n', '  frontend:\n    privileged: true\n', 1)
        assert broken != (guard.ROOT / 'docker-compose.yml').read_text()
        self.write(root, 'docker-compose.yml', broken)
        self.assertEqual(self.run_guard(root), 1)

    def test_missing_commit_stamp_fails(self):
        root = self.scaffold()
        broken = (guard.ROOT / 'docker-compose.yml').read_text().replace(
            '        COMMIT: ${FANGJI_COMMIT:-unknown}\n', '', 1)
        self.write(root, 'docker-compose.yml', broken)
        self.assertEqual(self.run_guard(root), 1)


if __name__ == '__main__':
    unittest.main()
