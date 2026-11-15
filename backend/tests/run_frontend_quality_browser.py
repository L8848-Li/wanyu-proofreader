#!/usr/bin/env python3
"""Mounted Vue regressions + formerly orphaned scripts, disposable data only.

Requires frontend npm ci and Playwright/Chromium (NODE_PATH may supply it).
No browser script silently skips. Font HTTP caching is separately checked on
Containers' actual Nginx image, because Vite is not the production HTTP server.
"""
import argparse
from pathlib import Path
import subprocess
import urllib.request
import time

import harness

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--only', nargs='+', choices=['review', 'modal', 'fonts', 'profile', 'pagination', 'unicode', 'members', 'editor', 'repository', 'workbench', 'components', 'delivery', 'startup'])
selected = parser.parse_args().only
ROOT = harness.BACKEND.parent
FRONTEND = ROOT / 'frontend'

def node(script, env):
    subprocess.run(['node', str(ROOT / script)], env=harness.with_research_notice_preload(env), check=True, timeout=180)

with harness.temporary_root() as temporary:
    binary = harness.build_binary(temporary / 'pocketbase')
    with harness.server(binary, temporary) as backend_env:
        port = harness.free_port()
        origin = f'http://localhost:{port}'
        output = ROOT / 'output/playwright/frontend-quality'
        output.mkdir(parents=True, exist_ok=True)
        env = {**backend_env, 'FRONTEND_URL': origin, 'REVIEW_BASE_URL': origin,
               'VITE_DEV_SERVER_PORT': str(port), 'VITE_PB_URL': origin,
               'FANGJI_TEST_DATA_DIR': str(temporary / 'data'), 'FANGJI_DEMO_SUFFIX': 'workbench-browser',
               'SCREENSHOT_DIR': str(output), 'SCREENSHOT_PATH': str(output / 'profile-session.png'),
               'RARE_BROWSER_FIXTURE': str(temporary / 'rare.json'), 'FONT_ENGINES': 'chromium', 'REPOSITORY_REVIEW_OUTPUT': str(output / 'repository-review'),
               'DRAFT_LOGOUT_OUTPUT': str(output / 'draft-logout'),
               'PDF_LIFECYCLE_OUTPUT': str(output / 'pdf-lifecycle'),
               'ADMIN_INVALIDATION_OUTPUT': str(output / 'admin-invalidation')}
        with (temporary / 'vite.log').open('w') as log:
            vite = subprocess.Popen(['npm', 'run', 'dev', '--', '--host', '127.0.0.1'], cwd=FRONTEND, env=env, stdout=log, stderr=log)
            try:
                for _ in range(100):
                    try:
                        with urllib.request.urlopen(origin + '/tests/fixtures/review.html', timeout=1):
                            break
                    except OSError:
                        if vite.poll() is not None:
                            raise RuntimeError((temporary / 'vite.log').read_text())
                        time.sleep(.1)
                else:
                    raise RuntimeError('Quality fixture Vite did not start')
                checks = {
                    'startup': ['frontend/tests/browser/application-startup.cjs'],
                    'components': ['frontend/tests/browser/reka-controls.cjs', 'frontend/tests/browser/disclosure.cjs', 'frontend/tests/browser/job-observer.cjs', 'frontend/tests/browser/admin-invalidation.cjs', 'frontend/tests/browser/workspace-ready.cjs'],
                    'repository': ['frontend/tests/browser/repository-review.cjs', 'frontend/tests/browser/draft-logout.cjs', 'frontend/tests/browser/pdf-lifecycle.cjs', 'frontend/tests/browser/source-fidelity.cjs', 'frontend/tests/browser/normalization-draft.cjs'],
                    'review': ['frontend/tests/browser/review.cjs', 'frontend/tests/browser/arbitration-queue.cjs',
                               'frontend/tests/browser/arbitration-field-navigation.cjs'],
                    'modal': ['frontend/tests/browser/modal.cjs'],
                    'members': ['frontend/tests/browser/member-candidates.cjs'],
                    'editor': ['frontend/tests/browser/font-feedback.cjs', 'frontend/tests/browser/editor-keyboard-flow.cjs', 'frontend/tests/browser/editor-states.cjs', 'frontend/tests/browser/editor-experience.cjs', 'frontend/tests/browser/mobile-field-flow.cjs'],
                    'fonts': ['frontend/scripts/test-rare-fonts.cjs'],
                    'profile': ['frontend/scripts/test-profile-session.cjs'],
                    'delivery': ['backend/tests/delivery_integration.mjs'],
                    'pagination': ['frontend/scripts/test-pagination.cjs'],
                    'unicode': ['backend/tests/rare_characters_integration.mjs', 'frontend/scripts/test-rare-workflow.cjs'],
                    'workbench': ['frontend/tests/browser/auth-navigation.cjs', 'frontend/tests/browser/discovery.cjs', 'backend/tests/seed_demo.mjs', 'frontend/tests/browser/workbench.cjs', 'frontend/tests/browser/entry-list-experience.cjs', 'frontend/tests/browser/review-bundle.cjs', 'frontend/tests/browser/import-errors.cjs', 'frontend/tests/browser/tone-batch.cjs', 'frontend/tests/browser/batch-report.cjs'],
                }
                for name, scripts in checks.items():
                    if selected and name not in selected:
                        continue
                    for script in scripts:
                        print('RUN mounted browser: ' + script, flush=True)
                        script_env = env
                        if name == 'delivery':
                            script_env = {**env,
                                'DELIVERY_BROWSER_SCRIPT': str(FRONTEND / 'scripts/test-delivery-workspace.cjs'),
                                'DELIVERY_BROWSER_FIXTURE': str(temporary / 'delivery-browser.json'),
                                'DELIVERY_BROWSER_OUTPUT': str(output / 'delivery')}
                        node(script, script_env)
            finally:
                vite.terminate()
                try:
                    vite.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    vite.kill()
                    vite.wait()
print('PASS: frontend quality browser checks (' + (', '.join(selected) if selected else 'all') + ')')
