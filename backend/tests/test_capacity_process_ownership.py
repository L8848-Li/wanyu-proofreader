import json
import os
from pathlib import Path
import shutil
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import capacity_process_ownership as ownership
from capacity_process_ownership import ProcessRegistry, birth_identity, group_members
from run_capacity_remote import stop_generator_group
from capacity_fixture import source_manifest
import harness


class ProcessOwnershipImportTest(unittest.TestCase):
    def test_linux_process_reaped_while_reading_stat(self):
        with patch.object(ownership.os, 'name', 'posix'), \
             patch.object(ownership.platform, 'system', return_value='Linux'), \
             patch.object(ownership.Path, 'read_text', side_effect=ProcessLookupError):
            self.assertIsNone(birth_identity(123))

    def test_test_discovery_without_fcntl(self):
        # Isolate imports from this test runner's module cache. This simulates
        # the missing Windows module, not the rest of a Windows runtime.
        program = r'''
import builtins, sys, unittest
sys.modules.pop('fcntl', None)
real_import = builtins.__import__
def without_fcntl(name, *args, **kwargs):
    if name == 'fcntl':
        raise ModuleNotFoundError("No module named 'fcntl'", name='fcntl')
    return real_import(name, *args, **kwargs)
builtins.__import__ = without_fcntl
try:
    import fcntl
except ModuleNotFoundError:
    pass
else:
    raise AssertionError('fcntl import was not blocked')
loader = unittest.TestLoader()
for module in ('test_capacity_faults', 'test_capacity_remote', 'test_capacity_process_ownership'):
    suite = loader.discover('.', pattern=module+'.py')
    assert suite.countTestCases() > 0, module
assert not loader.errors, '\n'.join(loader.errors)
# An existing platform-independent check must remain runnable as well.
suite = loader.loadTestsFromName('test_capacity_remote.CapacityRemoteTest.'
    'test_fault_evidence_requires_frozen_source_and_complete_real_window')
result = unittest.TextTestRunner().run(suite)
assert result.wasSuccessful()
'''
        result = subprocess.run([sys.executable, '-c', program], cwd=Path(__file__).parent,
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)

    def test_non_posix_operations_refuse_before_side_effects(self):
        with patch.object(ownership, 'os') as platform_os, \
             patch.object(ownership, 'Path') as path, \
             patch.object(ownership.subprocess, 'Popen') as spawn:
            platform_os.name = 'nt'
            process = unittest.mock.Mock()
            registry = object.__new__(ProcessRegistry)
            operations = (
                lambda: ProcessRegistry('unused', create=True),
                lambda: birth_identity(123),
                lambda: group_members(123),
                lambda: registry.lock().__enter__(),
                lambda: ownership.guardian('unused', 'unused', ['unused']),
                lambda: stop_generator_group(process, registry),
            )
            for operation in operations:
                with self.assertRaisesRegex(RuntimeError, '^generator_process_groups_unsupported$'):
                    operation()
            path.assert_not_called()
            spawn.assert_not_called()
            process.poll.assert_not_called()
            platform_os.umask.assert_not_called()
            platform_os.open.assert_not_called()
            platform_os.killpg.assert_not_called()


@unittest.skipUnless(os.name == 'posix' and shutil.which('node'), 'POSIX Node generator contract')
class ProcessOwnershipTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='wanyu-owned-process-test-')
        self.root = Path(self.temporary.name).resolve()
        self.registry = ProcessRegistry(self.root/'registry', create=True)
        self.processes = []

    def tearDown(self):
        for process in self.processes:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
            for pipe in (process.stdout, process.stderr):
                if pipe: pipe.close()
        try:
            self.registry.stop()
        finally:
            self.temporary.cleanup()

    def launch(self, mode='wait', seconds=30):
        # The real child reports only its own PID; no port, DB or business data.
        child = f'import os,time;print(os.getpid(),flush=True);time.sleep({seconds})'
        program = """
const {spawn}=require('node:child_process');
const child=spawn(process.env.CAPACITY_GUARDIAN_PYTHON,['-c',process.argv[1]],
 {detached:true,stdio:['ignore','pipe','inherit']});
child.stdout.once('data',data=>{process.stdout.write(data);if(process.argv[2]==='exit')process.exit(7)});
child.on('exit',code=>process.exit(code||0));
"""
        env = {**os.environ, 'CAPACITY_PROCESS_REGISTRY': str(self.registry.root),
               'CAPACITY_GUARDIAN_PYTHON': sys.executable}
        process = subprocess.Popen(['node', '--require', str(Path(__file__).with_name('capacity_owned_spawn.cjs')),
            '-e', program, child, mode], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True, text=True)
        self.processes.append(process)
        child_pid = int(process.stdout.readline())
        return process, child_pid

    def assert_gone(self, pid):
        self.assertIsNone(birth_identity(pid))
        for receipt in self.registry.root.glob('*.json'):
            self.assertEqual(group_members(json.loads(receipt.read_text())['pid']), [])

    def test_parent_exits_before_detached_child(self):
        process, child = self.launch('exit')
        self.assertEqual(process.wait(timeout=5), 7)
        self.assertIsNotNone(birth_identity(child))
        with self.assertRaisesRegex(RuntimeError, 'generator_registry_required'):
            stop_generator_group(process)
        stop_generator_group(process, self.registry)
        self.assert_gone(child)
        stop_generator_group(process, self.registry)  # idempotent finally

    def test_parent_sigkill_before_cleanup(self):
        process, child = self.launch()
        process.kill(); process.wait(timeout=5)
        stop_generator_group(process, self.registry)
        self.assert_gone(child)

    def test_timeout_and_interruption_stop_live_parent(self):
        process, child = self.launch()
        with self.assertRaises(subprocess.TimeoutExpired):
            process.wait(timeout=.02)
        try:
            raise KeyboardInterrupt()
        except KeyboardInterrupt:
            stop_generator_group(process, self.registry)
        self.assert_gone(child)

    def test_normal_child_exit_preserves_parent_success(self):
        process, child = self.launch(seconds=.05)
        self.assertEqual(process.wait(timeout=5), 0)
        stop_generator_group(process, self.registry)
        self.assert_gone(child)

    def test_reused_identity_is_never_signalled(self):
        foreign = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(20)'], start_new_session=True)
        try:
            receipt = self.registry.root/('f'*32+'.json')
            receipt.write_text(json.dumps({'nonce':self.registry.nonce,'pid':foreign.pid,'birth':'not-current','state':'ready'}))
            with patch('capacity_process_ownership.os.killpg') as kill:
                with self.assertRaisesRegex(RuntimeError, 'cleanup_unconfirmed'):
                    self.registry.stop()
                kill.assert_not_called()
            self.assertIsNone(foreign.poll())
            receipt.unlink()
        finally:
            foreign.terminate(); foreign.wait(timeout=5)

    def test_one_invalid_receipt_does_not_skip_other_owned_groups(self):
        process, child = self.launch('exit')
        process.wait(timeout=5)
        invalid = self.registry.root/('0'*32+'.json')
        invalid.write_text('{}')
        try:
            with self.assertRaisesRegex(RuntimeError, 'cleanup_unconfirmed'):
                stop_generator_group(process,self.registry)
            self.assertIsNone(birth_identity(child))
        finally:
            invalid.unlink()

    def test_exit_or_pid_reuse_after_identity_check_cannot_signal_foreign_group(self):
        path = self.registry.root/('e'*32+'.json')
        path.write_text(json.dumps({'nonce':self.registry.nonce,'pid':999999,'birth':'original','state':'ready'}))
        try:
            with patch('capacity_process_ownership.birth_identity',side_effect=['original','reused']), \
                 patch('capacity_process_ownership.os.getpgid',return_value=999999), \
                 patch('capacity_process_ownership.os.killpg') as kill:
                with self.assertRaisesRegex(RuntimeError,'identity_lost'):
                    self.registry.stop_record(path)
                kill.assert_not_called()
            self.assertEqual(path.with_suffix('.stop').read_text(),self.registry.nonce)
        finally:
            path.unlink()

    def test_unresponsive_process_is_unconfirmed_not_signalled_by_controller(self):
        foreign = subprocess.Popen([sys.executable,'-c','import time;time.sleep(20)'],start_new_session=True)
        path = self.registry.root/('d'*32+'.json')
        try:
            path.write_text(json.dumps({'nonce':self.registry.nonce,'pid':foreign.pid,
                                        'birth':birth_identity(foreign.pid),'state':'ready'}))
            with patch('capacity_process_ownership.time.sleep'), \
                 patch('capacity_process_ownership.os.killpg') as kill:
                with self.assertRaisesRegex(RuntimeError,'cleanup_unconfirmed'):
                    self.registry.stop()
                kill.assert_not_called()
            self.assertIsNone(foreign.poll())
        finally:
            path.unlink()
            foreign.terminate();foreign.wait(timeout=5)

    def test_closed_registry_never_launches_child(self):
        self.registry.stop()
        # Child launch is rejected before executing an arbitrary payload.
        ticket = 'a'*32
        (self.registry.root/(ticket+'.pending')).write_text(self.registry.nonce)
        sentinel = self.root/'must-not-exist'
        process = subprocess.Popen([sys.executable, str(Path(__file__).with_name('capacity_process_ownership.py')),
            str(self.registry.root), ticket, '--', sys.executable, '-c',
            'from pathlib import Path;Path('+repr(str(sentinel))+').touch()'], start_new_session=True)
        self.assertEqual(process.wait(timeout=5), 0)
        self.assertFalse(sentinel.exists())
        self.registry.stop()


    def test_registry_rejects_public_directory_symlink_and_invalid_nonce(self):
        candidate = ProcessRegistry(self.root/'boundary', create=True)
        alias = self.root/'registry-alias'
        alias.symlink_to(candidate.root, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, '^generator_registry_not_private$'):
            ProcessRegistry(alias)
        candidate.root.chmod(0o755)
        with self.assertRaisesRegex(RuntimeError, '^generator_registry_not_private$'):
            ProcessRegistry(candidate.root)
        candidate.root.chmod(0o700)
        marker = candidate.root/'nonce'
        marker.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, '^generator_registry_invalid_nonce$'):
            ProcessRegistry(candidate.root)
        marker.chmod(0o600)
        marker.write_text('z'*32)
        with self.assertRaisesRegex(RuntimeError, '^generator_registry_invalid_nonce$'):
            ProcessRegistry(candidate.root)
        marker.unlink()
        marker.symlink_to(self.registry.root/'nonce')
        with self.assertRaisesRegex(RuntimeError, '^generator_registry_invalid_nonce$'):
            ProcessRegistry(candidate.root)

    def test_invalid_receipt_or_ticket_never_signals_or_echoes_payload(self):
        receipt = self.registry.root/('b'*32+'.json')
        for payload in ('{"secret":"synthetic-do-not-echo"', json.dumps({'nonce':'wrong','pid':999999,'birth':'fake'})):
            receipt.write_text(payload)
            with patch('capacity_process_ownership.os.killpg') as kill:
                with self.assertRaisesRegex(RuntimeError, '^generator_group_cleanup_unconfirmed$') as caught:
                    self.registry.stop()
                self.assertNotIn('synthetic-do-not-echo', str(caught.exception))
                kill.assert_not_called()
        receipt.unlink()
        with self.assertRaisesRegex(RuntimeError, '^generator_ticket_invalid$'):
            self.registry.register('../outside')
        self.assertFalse((self.root/'outside.pending').exists())

    def test_stdio_extra_fd_argv_environment_and_working_directory(self):
        program = """
const {spawn}=require('node:child_process');
const child=spawn(process.env.CAPACITY_GUARDIAN_PYTHON,['-c',process.argv[1],'a b','--literal'],
 {detached:true,cwd:process.argv[2],env:{...process.env,GUARDIAN_TEST:'kept'},stdio:['ignore','pipe','pipe','pipe']});
child.stdio[3].pipe(process.stdout);child.stderr.pipe(process.stderr);
child.on('exit',code=>process.exit(code||0));
"""
        code = "import os,sys,json;os.write(3,json.dumps([sys.argv[1:],os.environ['GUARDIAN_TEST'],os.getcwd()]).encode())"
        result = subprocess.run(['node','--require',str(Path(__file__).with_name('capacity_owned_spawn.cjs')),
            '-e',program,code,str(self.root)], capture_output=True,text=True,timeout=5,start_new_session=True,
            env={**os.environ,'CAPACITY_PROCESS_REGISTRY':str(self.registry.root),'CAPACITY_GUARDIAN_PYTHON':sys.executable})
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout),[['a b','--literal'],'kept',str(self.root)])
        self.registry.stop()

    def test_guardian_and_preload_are_in_source_freeze(self):
        files = source_manifest(harness.BACKEND)['source_sha256']
        for path in ('backend/tests/capacity_process_ownership.py','backend/tests/capacity_owned_spawn.cjs'):
            self.assertIn(path, files)

    @unittest.skipUnless(os.environ.get('CAPACITY_OWNERSHIP_PLAYWRIGHT') == '1',
                         'optional real installed browser compatibility probe')
    def test_real_playwright_close_and_parent_crash(self):
        for mode in ('close', 'crash'):
            with self.subTest(mode=mode):
                registry = ProcessRegistry(self.root/('browser-'+mode), create=True)
                program = """
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{const browser=await chromium.launch({headless:true,
 ...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:{})});
 const page=await browser.newPage();await page.setContent('<p>Owned browser probe</p>');
 assert.equal(await page.locator('p').textContent(),'Owned browser probe');
 console.log('ready');
 if(process.argv[1]==='close'){await browser.close();process.exit(0)}
 setInterval(()=>{},1000);
})().catch(()=>process.exit(2));
"""
                process = subprocess.Popen(['node','--require',str(Path(__file__).with_name('capacity_owned_spawn.cjs')),
                    '-e',program,mode],env={**os.environ,'CAPACITY_PROCESS_REGISTRY':str(registry.root),
                    'CAPACITY_GUARDIAN_PYTHON':sys.executable},stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                    start_new_session=True,text=True)
                try:
                    self.assertTrue(select.select([process.stdout],[],[],25)[0], 'browser readiness timeout')
                    self.assertEqual(process.stdout.readline().strip(),'ready', 'browser did not render fixture')
                    if mode == 'crash': process.kill()
                    self.assertEqual(process.wait(timeout=10), -signal.SIGKILL if mode=='crash' else 0)
                    stop_generator_group(process,registry)
                    records = list(registry.root.glob('*.json'))
                    self.assertGreaterEqual(len(records),1)
                    for record in records:
                        self.assertEqual(group_members(json.loads(record.read_text())['pid']),[])
                finally:
                    if process.poll() is None: process.kill(); process.wait(timeout=5)
                    registry.stop()
                    process.stdout.close();process.stderr.close()


if __name__ == '__main__':
    unittest.main()
