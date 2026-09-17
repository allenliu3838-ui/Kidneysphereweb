#!/usr/bin/env python3
"""Audio release tests: isolated paths, mocked managers, no live service actions."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

REPO = Path(__file__).resolve().parent.parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def snapshot(directory):
    return {str(path.relative_to(directory)): (path.read_bytes(), path.stat().st_mode & 0o777)
            for path in directory.rglob('*') if path.is_file()}


class AudioReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.builder = load('audio_builder_tests', REPO / 'deploy/build-audio-release.py')
        cls.old = {name: cls.builder.git_bytes(cls.builder.BASELINES[-1], name, optional=True)
                   for name in cls.builder.FILES}
        cls.new = {name: (REPO / name).read_bytes() for name in cls.builder.FILES}
        cls.entry_bytes = cls.builder.git_bytes(cls.builder.BASELINES[-1], 'server/index.js')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='audio-release-tests-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.web = self.base / 'portal'
        self.api = self.base / 'actual-api-checkout'
        self.web.mkdir()
        (self.api / 'server').mkdir(parents=True)
        self.entry = self.api / 'server/index.js'
        self.entry.write_bytes(self.entry_bytes)
        self.entry.chmod(0o644)
        self.vhost = self.base / 'portal.conf'
        self.vhost.write_text('server { location /api/ { proxy_pass http://127.0.0.1:3001/api/; } }')
        self.unit_file = self.base / 'actual-api.service'
        self.unit_file.write_text('An existing dedicated API service')
        self.node = self.base / 'node'
        self.node.write_bytes(b'Fixture node executable')
        self.node.chmod(0o755)
        for name, data in self.old.items():
            if data is not None:
                destination = (self.api if name.startswith('netlify/') else self.web) / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(data)
                destination.chmod(0o644)
        for name in ('index.html', 'app.js', 'home.js', 'portal-home.js', 'supabaseClient.js',
                     'assets/config.js', 'assets/videos.js', 'login.html', 'register.html'):
            path = self.web / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(('PROTECTED ' + name).encode())
        for name in ('video-access.js', 'dev-grant-access.js'):
            (self.api / 'netlify/functions' / name).write_bytes(('PROTECTED ' + name).encode())
        self.runner = load('audio_runner_tests', REPO / 'deploy/audio-release.py')
        patcher = mock.patch.multiple(self.runner, ROOT=self.web, BACKUP_ROOT=self.base / 'audio-backups', VHOST=self.vhost)
        patcher.start(); self.addCleanup(patcher.stop)
        patcher = mock.patch.multiple(self.runner.core, ROOT=self.web, BACKUP_ROOT=self.base / 'shared-lock', VHOST=self.vhost)
        patcher.start(); self.addCleanup(patcher.stop)
        entry_state = self.runner.core.read_state(self.entry)[0]
        self.runtime = {'pid': 444, 'start': '100', 'cwd': str(self.api / 'server'), 'node': str(self.node),
                        'entry': str(self.entry), 'entry_state': entry_state,
                        'manager': {'kind': 'systemd', 'unit': 'actual-api.service', 'pid': 444,
                                    'cwd': str(self.api / 'server'), 'launch_node': str(self.node),
                                    'launch_entry': str(self.entry), 'config_sha256': 'f' * 64}}
        self.package = {'manifest': {'schema': 1, 'profile': 'audio-v1', 'domain': 'kidneysphere.com',
            'root': str(self.web), 'commit': self.builder.BASELINES[-1],
            'server_entry_hashes': [self.runner.digest(self.entry_bytes)],
            'files': [{'path': name, 'sha256': self.runner.digest(self.new[name]), 'size': len(self.new[name]),
                       'allow_missing': self.old[name] is None,
                       'allowed_before': [] if self.old[name] is None else [self.runner.digest(self.old[name])]}
                      for name in self.builder.FILES]}, 'payload': self.new}
        patches = {
            'discover_runtime': lambda package: copy.deepcopy(self.runtime),
            'check_nginx': lambda: None,
            'check_syntax': lambda package, runtime: None,
            'health_checks': lambda *args: None,
            'wait_for_backend': lambda *args: None,
            'unit_info': lambda unit: copy.deepcopy(self.runtime['manager']),
            'process_info': lambda pid: dict(self.runtime, parent=1, argv=[str(self.node), str(self.entry)]),
        }
        self.original_discover = self.runner.discover_runtime
        self.original_unit_info = self.runner.unit_info
        for name, replacement in patches.items():
            patcher = mock.patch.object(self.runner, name, side_effect=replacement)
            patcher.start(); self.addCleanup(patcher.stop)
        self.commands = []

        def command(command, *args, **kwargs):
            self.commands.append(command)
            if command != ['systemctl', 'restart', 'actual-api.service']:
                raise AssertionError('Unexpected service operation: ' + repr(command))
            return b''
        patcher = mock.patch.object(self.runner, 'run', side_effect=command)
        patcher.start(); self.addCleanup(patcher.stop)

    def quiet(self, function, *args):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            value = function(*args)
        return value, output.getvalue()

    def apply(self):
        report = self.runner.inspect_release(self.package)
        return self.quiet(self.runner.apply_release, self.package, report['inspection_sha256'])

    def assert_rejected_unchanged(self, function, *args):
        before = snapshot(self.base)
        with self.assertRaises(self.runner.ReleaseError):
            self.quiet(function, *args)
        self.assertEqual(snapshot(self.base), before)

    def test_inspection_is_read_only_and_uses_actual_api_checkout(self):
        before = snapshot(self.base)
        report = self.runner.inspect_release(self.package)
        self.assertEqual(snapshot(self.base), before)
        self.assertEqual(len(report['targets']), 8)
        self.assertTrue(report['targets'][self.runner.BACKEND_FILES[0]].startswith(str(self.api)))
        self.assertEqual(self.commands, [])
        self.assertFalse(self.runner.BACKUP_ROOT.exists())

    def test_apply_requires_the_exact_recent_inspection_and_unknown_hashes_fail_closed(self):
        self.assert_rejected_unchanged(self.runner.apply_release, self.package, '0' * 64)
        (self.web / 'learning.html').write_bytes(b'Unknown production edit')
        self.assert_rejected_unchanged(self.runner.inspect_release, self.package)

    def test_process_restart_or_manager_change_invalidates_inspection(self):
        report = self.runner.inspect_release(self.package)
        self.runtime['pid'] = 445
        self.assert_rejected_unchanged(self.runner.apply_release, self.package, report['inspection_sha256'])

    def test_release_restarts_only_verified_api_after_both_handlers_and_restores_exactly(self):
        before_web, before_api = snapshot(self.web), snapshot(self.api)
        replace = os.replace
        order = []

        def track(source, target, *args, **kwargs):
            target = Path(target)
            if target in {Path(v) for v in self.runner.target_paths(self.runtime).values()}:
                order.append(str(target))
            return replace(source, target, *args, **kwargs)
        with mock.patch.object(self.runner.os, 'replace', side_effect=track):
            backup, output = self.apply()
        targets = self.runner.target_paths(self.runtime)
        self.assertEqual(order, [str(targets[name]) for name in self.runner.FILES])
        self.assertEqual(self.commands, [['systemctl', 'restart', 'actual-api.service']])
        self.assertIn('AUDIO_RELEASE_OK', output)
        self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.web / 'index.html').read_bytes(), b'PROTECTED index.html')
        self.quiet(self.runner.rollback_release, backup, self.package)
        self.assertEqual(snapshot(self.web), before_web)
        self.assertEqual(snapshot(self.api), before_api)

    def test_no_change_does_not_restart(self):
        self.apply()
        self.commands.clear()
        before = snapshot(self.base)
        result, output = self.apply()
        self.assertIsNone(result)
        self.assertIn('NO_CHANGE', output)
        self.assertEqual(self.commands, [])
        self.assertEqual(snapshot(self.base), before)

    def test_backend_and_frontend_promotion_failure_roll_back_both_roots(self):
        before_web, before_api = snapshot(self.web), snapshot(self.api)
        replace = os.replace
        targets = self.runner.target_paths(self.runtime)
        for failure in (self.runner.BACKEND_FILES[-1], 'learning.html'):
            fired = False

            def fail(source, target, *args, **kwargs):
                nonlocal fired
                if Path(target) == targets[failure] and not fired:
                    fired = True
                    raise OSError('Injected promotion failure')
                return replace(source, target, *args, **kwargs)
            with mock.patch.object(self.runner.os, 'replace', side_effect=fail):
                with self.assertRaisesRegex(self.runner.ReleaseError, 'ROLLED_BACK'):
                    self.apply()
            self.assertTrue(fired)
            self.assertEqual(snapshot(self.web), before_web)
            self.assertEqual(snapshot(self.api), before_api)

    def test_failed_restart_restores_files_and_attempts_only_same_manager(self):
        before_web, before_api = snapshot(self.web), snapshot(self.api)
        calls = 0

        def fail_first(*args):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise self.runner.ReleaseError('Injected health failure')
        with mock.patch.object(self.runner, 'wait_for_backend', side_effect=fail_first):
            with self.assertRaisesRegex(self.runner.ReleaseError, 'ROLLED_BACK'):
                self.apply()
        self.assertEqual(snapshot(self.web), before_web)
        self.assertEqual(snapshot(self.api), before_api)
        self.assertEqual(self.commands, [['systemctl', 'restart', 'actual-api.service']] * 2)

    def test_rollback_checks_changed_manager_before_restoring_any_file(self):
        backup, _ = self.apply()
        current = dict(self.runtime['manager'], config_sha256='a' * 64)
        with mock.patch.object(self.runner, 'unit_info', return_value=current):
            self.assert_rejected_unchanged(self.runner.rollback_release, backup, self.package)

    def test_stopped_original_service_can_be_restored_without_touching_other_services(self):
        before_web, before_api = snapshot(self.web), snapshot(self.api)
        backup, _ = self.apply()
        stopped = dict(self.runtime['manager'], pid=0)
        self.commands.clear()
        with mock.patch.object(self.runner, 'unit_info', return_value=stopped):
            self.quiet(self.runner.rollback_release, backup, self.package)
        self.assertEqual(snapshot(self.web), before_web)
        self.assertEqual(snapshot(self.api), before_api)
        self.assertEqual(self.commands, [['systemctl', 'restart', 'actual-api.service']])

    def test_changed_server_entry_prevents_any_restart_or_rollback_writes(self):
        backup, _ = self.apply()
        self.entry.write_bytes(b'Independent server change')
        self.commands.clear()
        self.assert_rejected_unchanged(self.runner.restart_backend, self.runtime)
        self.assert_rejected_unchanged(self.runner.rollback_release, backup, self.package)
        self.assertEqual(self.commands, [])

    def test_public_inspection_does_not_print_environment_or_raw_arguments(self):
        report = self.runner.inspect_release(self.package)
        report['runtime']['argv'] = ['node', '--private=SECRET_TOKEN']
        report['runtime']['environment'] = {'TOKEN': 'SECRET_TOKEN'}
        output = json.dumps(self.runner.public_report(report))
        self.assertNotIn('SECRET_TOKEN', output)
        self.assertNotIn('argv', output)
        self.assertIn('actual-api.service', output)

    def test_systemd_launch_hash_ignores_pid_timestamps_and_rejects_wrappers(self):
        def stdout(pid, stamp, arguments=None):
            argv = arguments or str(self.node) + ' ' + str(self.entry)
            return ('Id=actual-api.service\nMainPID=' + str(pid) + '\nUser=root\nWorkingDirectory=' + str(self.api / 'server') +
                '\nFragmentPath=' + str(self.unit_file) + '\nDropInPaths=\nExecStart={ path=' + str(self.node) +
                ' ; argv[]=' + argv + ' ; ignore_errors=no ; start_time=' + stamp + ' ; pid=' + str(pid) + ' ; }\n').encode()
        with mock.patch.object(self.runner, 'run', return_value=stdout(444, 'old')):
            first = self.original_unit_info('actual-api.service')
        with mock.patch.object(self.runner, 'run', return_value=stdout(445, 'new')):
            second = self.original_unit_info('actual-api.service')
        self.assertEqual(first['config_sha256'], second['config_sha256'])
        with mock.patch.object(self.runner, 'run', return_value=stdout(444, 'old', 'node --secret=SECRET_TOKEN server.js')):
            with self.assertRaises(self.runner.ReleaseError) as raised:
                self.original_unit_info('actual-api.service')
        self.assertNotIn('SECRET_TOKEN', str(raised.exception))

    def test_pm2_restart_requires_watch_disabled_and_uses_exact_id(self):
        target = {'id': 7, 'pid': 444, 'name': 'real-api', 'cwd': self.runtime['cwd'],
                  'entry': self.runtime['entry'], 'mode': 'fork_mode', 'watch': False, 'status': 'online'}
        runtime = dict(self.runtime, manager={'descriptor': {'kind': 'pm2'}, 'target': target})
        calls = []

        def rpc(descriptor, operation, expected):
            calls.append((operation, expected))
            return dict(target) if operation == 'inspect' else {'restarted': 7}
        with mock.patch.object(self.runner, 'pm2_rpc', side_effect=rpc):
            self.runner.restart_backend(runtime)
        self.assertEqual(calls[-1], ('restart', {'id': 7, 'pid': 444, 'cwd': target['cwd'], 'entry': target['entry']}))
        with mock.patch.object(self.runner, 'pm2_rpc', return_value=dict(target, watch=True)):
            self.assert_rejected_unchanged(self.runner.restart_backend, runtime)

    def test_unmanaged_process_is_refused_without_service_operations(self):
        proc = self.base / 'proc'
        (proc / '444').mkdir(parents=True)
        (proc / '444/cgroup').write_text('0::/user.slice/session-3.scope\n')
        with mock.patch.object(self.runner, 'PROC', proc), mock.patch.object(self.runner, 'listener_pid', return_value=444):
            self.assert_rejected_unchanged(self.original_discover, self.package)
        self.assertEqual(self.commands, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
