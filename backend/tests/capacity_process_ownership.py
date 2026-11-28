"""Private ownership receipts for detached generator children (not a service)."""
import contextlib
import ctypes
import json
import os
from pathlib import Path
import platform
import re
import secrets
import signal
import stat
import subprocess
import sys
import time


def require_posix_process_groups():
    if os.name != 'posix':
        raise RuntimeError('generator_process_groups_unsupported')


def birth_identity(pid):
    """OS start identity, not second-resolution ps output or a reusable PID."""
    require_posix_process_groups()
    if platform.system() == 'Linux':
        try:
            raw = Path(f'/proc/{pid}/stat').read_text()
        except (FileNotFoundError, ProcessLookupError):
            # procfs can return ESRCH if the task is reaped after opening stat.
            return None
        fields = raw[raw.rindex(')')+2:].split()
        return None if fields[0] == 'Z' else 'linux:' + fields[19]
    if platform.system() == 'Darwin':
        # PROC_PIDTBSDINFO's last two uint64 fields are pbi_start_tvsec/usec.
        info = ctypes.create_string_buffer(136)
        lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
        size = lib.proc_pidinfo(pid, 3, 0, info, len(info))
        if size == 0:
            if ctypes.get_errno() == 3:  # ESRCH
                return None
            raise RuntimeError('generator_identity_unavailable')
        if size != len(info):
            raise RuntimeError('generator_identity_unavailable')
        status = int.from_bytes(info.raw[4:8], sys.byteorder)
        if status == 5:  # SZOMB
            return None
        return 'darwin:' + ':'.join(str(int.from_bytes(info.raw[i:i+8], sys.byteorder)) for i in (120, 128))
    raise RuntimeError('generator_identity_unsupported')


def group_members(group):
    require_posix_process_groups()
    # The inspector must not count itself as a browser helper in this group.
    rows = subprocess.check_output(['ps', '-axo', 'pid=,pgid=,stat='], text=True, timeout=2,
                                   start_new_session=True).splitlines()
    return [int(parts[0]) for row in rows if (parts := row.split()) and
            int(parts[1]) == group and not parts[2].startswith(('Z', 'X'))]


class ProcessRegistry:
    def __init__(self, root, create=False):
        require_posix_process_groups()
        self.root = Path(root)
        self.cleaned = set()
        if create:
            self.root.mkdir(mode=0o700)
            fd = os.open(self.root/'nonce', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, 'w') as out:
                out.write(secrets.token_hex(16))
        info = self.root.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700 or self.root.resolve() != self.root.absolute():
            raise RuntimeError('generator_registry_not_private')
        marker = self.root/'nonce'
        info = marker.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size != 32:
            raise RuntimeError('generator_registry_invalid_nonce')
        self.nonce = marker.read_text()
        if not re.fullmatch('[a-f0-9]{32}', self.nonce):
            raise RuntimeError('generator_registry_invalid_nonce')

    @contextlib.contextmanager
    def lock(self):
        require_posix_process_groups()
        # Windows must still import the capacity drivers and discover their
        # platform-independent tests. Only a POSIX lock needs this module.
        import fcntl

        fd = os.open(self.root/'lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            yield

    def register(self, ticket):
        if not re.fullmatch('[a-f0-9]{32}', ticket):
            raise RuntimeError('generator_ticket_invalid')
        pending = self.root/(ticket+'.pending')
        with self.lock():
            if pending.read_text() != self.nonce:
                raise RuntimeError('generator_ticket_invalid')
            record = {'nonce': self.nonce, 'pid': os.getpid(), 'birth': birth_identity(os.getpid()),
                      'state': 'closed' if (self.root/'closing').exists() else 'ready'}
            if os.getpgrp() != os.getpid() or not record['birth']:
                raise RuntimeError('generator_not_group_leader')
            path = self.root/(ticket+'.json')
            path.write_text(json.dumps(record))
            pending.unlink()
            return record['state'] == 'ready'

    def stop(self, wait_seconds=3):
        # A child cannot start the real browser after this boundary. Pending
        # wrappers either publish their identity or observe closing and exit.
        with self.lock():
            (self.root/'closing').touch(mode=0o600, exist_ok=True)
        deadline = time.monotonic()+5
        while list(self.root.glob('*.pending')) and time.monotonic() < deadline:
            time.sleep(.02)
        errors = ([RuntimeError('generator_pending_ownership_unconfirmed')]
                  if list(self.root.glob('*.pending')) else [])
        for path in self.root.glob('*.json'):
            try:
                self.stop_record(path, wait_seconds=wait_seconds)
            except (Exception, KeyboardInterrupt) as error:
                errors.append(error)
        if errors:
            raise RuntimeError('generator_group_cleanup_unconfirmed') from None

    def stop_record(self, path, wait_seconds=3):
        if path.name in self.cleaned:
            return
        record = json.loads(path.read_text())
        pid = record.get('pid')
        if record.get('nonce') != self.nonce or type(pid) is not int or pid <= 1 or not record.get('birth'):
            raise RuntimeError('generator_ownership_invalid')
        current = birth_identity(pid)
        if current != record['birth']:
            if record.get('state') == 'closed' or path.with_suffix('.done').exists():
                self.cleaned.add(path.name)
                return
            # Never signal a recycled PID/PGID. A vanished guardian without
            # a done receipt cannot prove detached descendants were reaped.
            raise RuntimeError('generator_guardian_identity_lost')
        if os.getpgid(pid) != pid:
            raise RuntimeError('generator_guardian_group_changed')
        # Birth checks detect stale receipts; they do NOT authorize signaling a
        # saved PID. The guardian may exit immediately after a check. Only the
        # still-live guardian can safely signal its own anchored process group.
        path.with_suffix('.stop').write_text(self.nonce)
        for _ in range(max(1, round(wait_seconds/.02))):
            current = birth_identity(pid)
            if current != record['birth']:
                if (record.get('state') == 'closed' or path.with_suffix('.done').exists() or
                    (path.with_suffix('.killing').exists() and not group_members(pid))):
                    self.cleaned.add(path.name)
                    break
                raise RuntimeError('generator_guardian_identity_lost')
            time.sleep(.02)
        else:
            raise RuntimeError('generator_group_cleanup_unconfirmed')


def guardian(root, ticket, command, interrupt=False):
    require_posix_process_groups()
    os.umask(0o077)
    registry = ProcessRegistry(root)
    if not registry.register(ticket):
        return 0
    child = None
    terminating = False
    def terminate(*_):
        nonlocal terminating
        terminating = True
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    try:
        # Playwright passes its remote-debugging pipes as fd 3/4. Preserve all
        # inherited descriptors, cwd, environment and argv through the wrapper.
        child = subprocess.Popen(command, close_fds=False)
        stop = registry.root/(ticket+'.stop')
        while child.poll() is None and not terminating:
            if stop.exists():
                if stop.read_text() != registry.nonce:
                    raise RuntimeError('generator_stop_nonce_invalid')
                break
            time.sleep(.02)
        result = child.poll()
    finally:
        # Keep this leader alive until all same-group children are gone, even
        # when the real browser exits before its helpers. The generator's own
        # lifetime is irrelevant to this ownership anchor.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        # Python fault suites need SIGINT for their existing finally blocks.
        os.killpg(os.getpid(), signal.SIGINT if interrupt else signal.SIGTERM)
        deadline = time.monotonic()+(5 if interrupt else 2)
        while time.monotonic() < deadline:
            if child is not None:
                child.poll()
            if group_members(os.getpid()) == [os.getpid()]:
                (registry.root/(ticket+'.done')).touch(mode=0o600)
                break
            time.sleep(.02)
        else:
            # The controller can distinguish intentional whole-group SIGKILL
            # from a guardian disappearing without proving descendant cleanup.
            (registry.root/(ticket+'.killing')).write_text(registry.nonce)
            os.killpg(os.getpid(), signal.SIGKILL)
    if result is not None and result < 0:
        # Preserve the wrapped child's signal exit status after proving its
        # group is drained. In particular, a deliberately crashed suite must
        # not be relabelled as exit 247 (Python's SystemExit(-9) conversion).
        original_signal = -result
        if original_signal not in (signal.SIGKILL, signal.SIGSTOP):
            signal.signal(original_signal, signal.SIG_DFL)
        os.kill(os.getpid(), original_signal)
    return result if result is not None else 0


if __name__ == '__main__':
    interrupt = len(sys.argv) > 3 and sys.argv[3] == '--interrupt'
    separator = 4 if interrupt else 3
    if len(sys.argv) < separator+2 or sys.argv[separator] != '--':
        raise SystemExit(2)
    try:
        raise SystemExit(guardian(sys.argv[1], sys.argv[2], sys.argv[separator+1:], interrupt=interrupt))
    except Exception:
        # No child argv, paths, credentials or traceback in generator logs.
        raise SystemExit(2) from None
