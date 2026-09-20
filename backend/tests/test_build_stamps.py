#!/usr/bin/env python3
"""Keep the Dockerfile's build-stamp whitelist in step with what we actually pass.

The guard exists because -X values are expanded by a shell during the image
build, but it initially rejected the RFC 3339 timestamp the Makefile generates by
default, so `make docker-build` failed on its own happy path. This runs the real
`case` clause read out of the Dockerfile rather than a reimplementation, so the
whitelist and its test cannot drift apart.
"""
import re
import subprocess
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
MAKEFILE = BACKEND.parent / 'Makefile'
DOCKERFILE = BACKEND / 'Dockerfile'


def guard():
    """The exact shell clause the image build uses to reject unsafe stamps."""
    text = DOCKERFILE.read_text()
    match = re.search(r'(case "\$stamp" in .*?esac)', text, re.DOTALL)
    if not match:
        raise AssertionError('backend/Dockerfile no longer has a build-stamp guard to test')
    return ' '.join(match.group(1).split())


def accepted(stamp, clause):
    result = subprocess.run(['/bin/sh', '-c', f'stamp="$1"; {clause}; exit 0', '_', stamp])
    return result.returncode == 0


class BuildStamps(unittest.TestCase):
    def setUp(self):
        self.clause = guard()

    def test_makefile_defaults_are_accepted(self):
        date = re.search(r'^BUILD_DATE \?= \$\(shell date -u \+([^)]*)\)$',
                         MAKEFILE.read_text(), re.MULTILINE)
        self.assertTrue(date, 'Makefile lost the BUILD_DATE default this test guards')
        self.assertEqual(date.group(1), '%Y-%m-%dT%H:%M:%SZ',
                         'BUILD_DATE changed format; re-check the Dockerfile whitelist')
        # git describe output and an RFC 3339 timestamp are the two real shapes.
        for sample in ('fangji-v1.0.0', 'v1.0.0-4-g1a2b3c4-dirty', '2026-09-19T13:21:46Z',
                       'unknown', 'dev', '42'):
            self.assertTrue(accepted(sample, self.clause), f'{sample} must be accepted')

    def test_shell_metacharacters_are_rejected(self):
        for sample in ('a$(id)b', 'a`id`b', 'a;echo', 'a|b', 'a&b', 'a b', 'a"b', 'a\\b', '-Xmain'):
            self.assertFalse(accepted(sample, self.clause), f'{sample} must be rejected')

    def test_compose_fallbacks_match_the_defaults(self):
        for name in ('docker-compose.yml', 'docker-compose.dev.yml', 'docker-compose.traefik.yml'):
            text = (BACKEND.parent / name).read_text()
            self.assertIn('FANGJI_VERSION:-dev', text, name)
            self.assertIn('FANGJI_COMMIT:-unknown', text, name)
            self.assertIn('FANGJI_BUILD_DATE:-unknown', text, name)


if __name__ == '__main__':
    unittest.main()
