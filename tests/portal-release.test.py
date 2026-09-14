#!/usr/bin/env python3
"""Offline portal release safety tests; every site path lives in a temporary directory."""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
import zipfile


REPOSITORY = Path(__file__).resolve().parent.parent


def import_file(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def file_snapshot(directory):
    """Ignore empty directories; track content hashes, modes and symlink targets."""
    if not directory.exists():
        return {}
    result = {}
    for path in directory.rglob('*'):
        relative = path.relative_to(directory).as_posix()
        if path.is_symlink():
            result[relative] = ('link', os.readlink(path))
        elif path.is_file():
            data = path.read_bytes()
            result[relative] = ('file', hashlib.sha256(data).hexdigest(), len(data), path.stat().st_mode & 0o777)
    return result


class PortalReleaseSafetyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = import_file('portal_release_builder_tests', REPOSITORY / 'deploy/build-portal-release.py')
        cls.shared_temp = tempfile.TemporaryDirectory(prefix='portal-release-fixture-')
        cls.addClassCleanup(cls.shared_temp.cleanup)
        cls.package_path = Path(cls.shared_temp.name) / 'portal.pyz'
        with contextlib.redirect_stdout(io.StringIO()):
            cls.build.build(cls.package_path)
        cls.old_files = {
            path: cls.build.git_bytes(cls.build.BASELINES[0], path, optional=True)
            for path in cls.build.FILES
        }
        cls.dependencies = {
            path: cls.build.git_bytes(cls.build.COMMIT, path)
            for path in cls.build.REQUIRED_FILES
        }
        cls.new_files = {
            path: cls.build.git_bytes(cls.build.COMMIT, path)
            for path in cls.build.FILES
        }

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='portal-release-test-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'www' / 'kidneysphere'
        self.backups = self.base / 'backups'
        self.vhost = self.base / 'nginx' / 'kidneysphere.com'
        self.other_site = self.base / 'www' / 'kidneysphere-registry'
        self.root.mkdir(parents=True)
        self.other_site.mkdir(parents=True)
        self.vhost.parent.mkdir(parents=True)
        self.vhost.write_text(
            'server {\n listen 443 ssl;\n server_name kidneysphere.com www.kidneysphere.com;\n'
            ' root ' + str(self.root) + ';\n location / { try_files $uri $uri.html =404; }\n}\n',
            encoding='utf-8',
        )
        (self.other_site / 'index.html').write_text('UNRELATED REGISTRY SITE', encoding='utf-8')
        (self.other_site / 'config.json').write_text('{"unchanged":true}', encoding='utf-8')
        for name, data in {**self.dependencies, **self.old_files}.items():
            if data is not None:
                destination = self.root / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(data)
                destination.chmod(0o644)
        self.runner = import_file('portal_release_runner_tests', REPOSITORY / 'deploy/portal-release.py')
        self.guards = (
            self.root / 'login.html', self.root / 'watch.html',
            self.other_site / 'index.html', self.other_site / 'config.json', self.vhost,
        )
        patcher = mock.patch.multiple(
            self.runner, ROOT=self.root, BACKUP_ROOT=self.backups,
            VHOST=self.vhost, GUARD_PATHS=self.guards,
        )
        patcher.start()
        self.addCleanup(patcher.stop)

        def nginx_only(command, *args, **kwargs):
            if not isinstance(command, (tuple, list)) or Path(command[0]).name != 'nginx':
                raise AssertionError('Test tried unexpected system command: ' + repr(command))
            configuration = '# configuration file ' + str(self.vhost) + ':\n' + self.vhost.read_text()
            if not kwargs.get('text') and not kwargs.get('universal_newlines') and not kwargs.get('encoding'):
                configuration = configuration.encode('utf-8')
            return subprocess.CompletedProcess(command, 0, stdout=configuration, stderr=configuration[:0])

        process_patcher = mock.patch.object(self.runner.subprocess, 'run', side_effect=nginx_only)
        self.nginx = process_patcher.start()
        self.addCleanup(process_patcher.stop)
        with zipfile.ZipFile(self.package_path) as archive:
            manifest = json.loads(archive.read('manifest.json'))
        manifest['root'] = str(self.root)
        self.local_package_path = self.repack({'manifest.json': json.dumps(manifest).encode('utf-8')})
        self.package = self.runner.load_package(self.local_package_path)

    def quiet(self, callback, *args):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            value = callback(*args)
        return value, output.getvalue()

    def repack(self, changes):
        destination = self.base / ('changed-package-' + str(len(list(self.base.glob('*.pyz')))) + '.pyz')
        source_path = getattr(self, 'local_package_path', self.package_path)
        with zipfile.ZipFile(source_path) as source:
            entries = {name: source.read(name) for name in source.namelist()}
        entries.update(changes)
        with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED) as target:
            for name, data in entries.items():
                target.writestr(name, data)
        return destination

    def assert_rejected_without_writes(self, callback, *args):
        before = file_snapshot(self.base)
        with self.assertRaises(self.runner.ReleaseError):
            self.quiet(callback, *args)
        self.assertEqual(file_snapshot(self.base), before)

    def test_preflight_is_read_only_and_reports_pending_update(self):
        before = file_snapshot(self.base)
        result, _ = self.quiet(self.runner.preflight, self.package)
        self.assertFalse(result['no_change'])
        self.assertEqual(file_snapshot(self.base), before)
        self.assertFalse(self.backups.exists())

    def test_apply_promotes_entry_last_and_roundtrip_restores_existing_files(self):
        before = file_snapshot(self.root)
        guards_before = {str(path): path.read_bytes() for path in self.guards}
        promotions = []
        replace = os.replace

        def capture_replace(source, target, *args, **kwargs):
            if Path(target) in {self.root / path for path in self.build.FILES}:
                promotions.append(Path(target).relative_to(self.root).as_posix())
            return replace(source, target, *args, **kwargs)

        with mock.patch.object(self.runner.os, 'replace', side_effect=capture_replace):
            backup, _ = self.quiet(self.runner.apply_release, self.package)
        self.assertIsInstance(backup, Path)
        self.assertTrue(backup.is_dir())
        self.assertEqual(backup.parent, self.backups)
        self.assertEqual(promotions, list(self.build.FILES))
        self.assertEqual(promotions[-1], 'index.html')
        for name, expected in self.new_files.items():
            self.assertEqual((self.root / name).read_bytes(), expected, name)
        self.assertEqual({str(path): path.read_bytes() for path in self.guards}, guards_before)
        self.assertEqual(backup.stat().st_mode & 0o077, 0, 'Backup must be private')
        self.quiet(self.runner.rollback_release, backup, self.package)
        self.assertEqual(file_snapshot(self.root), before)
        self.assertEqual({str(path): path.read_bytes() for path in self.guards}, guards_before)

    def test_reapplying_same_release_is_no_change(self):
        self.quiet(self.runner.apply_release, self.package)
        before = file_snapshot(self.base)
        backup, output = self.quiet(self.runner.apply_release, self.package)
        self.assertIsNone(backup)
        self.assertIn('NO_CHANGE', output)
        self.assertEqual(file_snapshot(self.base), before)

    def test_unknown_server_modification_is_not_overwritten(self):
        for name in ('index.html', 'app.js', 'home.js'):
            with self.subTest(path=name):
                path = self.root / name
                original = path.read_bytes()
                path.write_bytes(original + b'\nSERVER-ONLY-CHANGE')
                self.assert_rejected_without_writes(self.runner.apply_release, self.package)
                path.write_bytes(original)

    def test_missing_required_dependency_prevents_any_release(self):
        for name in ('login.html', 'assets/config.js', 'training-patho.html'):
            with self.subTest(path=name):
                path = self.root / name
                original = path.read_bytes()
                path.unlink()
                self.assert_rejected_without_writes(self.runner.apply_release, self.package)
                path.write_bytes(original)
                path.chmod(0o644)

    def test_tampered_payload_is_rejected_at_load(self):
        broken = self.repack({'payload/index.html': b'unreviewed replacement'})
        self.assert_rejected_without_writes(self.runner.load_package, broken)

    def test_nginx_failure_stops_before_touching_site_files(self):
        self.nginx.side_effect = None
        self.nginx.return_value = subprocess.CompletedProcess(['nginx', '-T'], 1, stdout='', stderr='invalid configuration')
        self.assert_rejected_without_writes(self.runner.apply_release, self.package)

    def test_vhost_for_different_root_cannot_authorize_release(self):
        configuration = self.vhost.read_text()
        self.vhost.write_text(configuration.replace(str(self.root), str(self.other_site)))
        self.assert_rejected_without_writes(self.runner.apply_release, self.package)

    def test_installed_https_acme_location_allows_release_and_stays_unchanged(self):
        acme = (
            ' location ^~ /.well-known/acme-challenge/ {\n'
            '  root /var/lib/kidneysphere-acme;\n'
            '  default_type text/plain;\n'
            '  try_files $uri =404;\n }\n'
        )
        self.vhost.write_text(self.vhost.read_text().replace('server {\n', 'server {\n' + acme, 1))
        original = self.vhost.read_bytes()
        backup, _ = self.quiet(self.runner.apply_release, self.package)
        self.assertIsInstance(backup, Path)
        self.assertEqual(self.vhost.read_bytes(), original)
        self.quiet(self.runner.rollback_release, backup, self.package)
        self.assertEqual(self.vhost.read_bytes(), original)

    def test_unexpected_acme_or_nested_root_cannot_authorize_release(self):
        original = self.vhost.read_text()
        valid = (
            ' location ^~ /.well-known/acme-challenge/ {\n'
            '  root /var/lib/kidneysphere-acme;\n'
            '  default_type text/plain;\n'
            '  try_files $uri =404;\n }\n'
        )
        variants = (
            valid.replace('/var/lib/kidneysphere-acme', str(self.other_site)),
            valid.replace('root ', 'alias '),
            valid.replace('^~ /.well-known/acme-challenge/', '/'),
            valid.replace('$uri =404', '$uri /index.html'),
            valid.replace('try_files', 'proxy_pass http://127.0.0.1:3001; try_files'),
            valid + valid,
            valid + ' location /other/ { root ' + str(self.other_site) + '; }\n',
        )
        for route in variants:
            with self.subTest(route=route):
                self.vhost.write_text(original.replace('server {\n', 'server {\n' + route, 1))
                self.assert_rejected_without_writes(self.runner.apply_release, self.package)
        self.vhost.write_text(original.replace('server {\n', 'server {\n' + valid, 1)
                              .replace(' root ' + str(self.root), ' root ' + str(self.other_site)))
        self.assert_rejected_without_writes(self.runner.apply_release, self.package)

    def test_unexpected_archive_entry_is_rejected(self):
        broken = self.repack({'payload/../../outside.txt': b'escape'})
        self.assert_rejected_without_writes(self.runner.load_package, broken)

    def test_symlink_document_root_is_rejected(self):
        actual = self.base / 'actual-site'
        self.root.rename(actual)
        self.root.symlink_to(actual, target_is_directory=True)
        before = file_snapshot(actual)
        self.assert_rejected_without_writes(self.runner.apply_release, self.package)
        self.assertEqual(file_snapshot(actual), before)

    def test_symlink_parent_of_target_is_rejected(self):
        actual = self.base / 'actual-assets'
        (self.root / 'assets').rename(actual)
        (self.root / 'assets').symlink_to(actual, target_is_directory=True)
        before = file_snapshot(actual)
        self.assert_rejected_without_writes(self.runner.apply_release, self.package)
        self.assertEqual(file_snapshot(actual), before)

    def test_symlink_target_is_rejected_even_when_content_matches(self):
        actual = self.base / 'actual-app.js'
        (self.root / 'app.js').rename(actual)
        (self.root / 'app.js').symlink_to(actual)
        original = actual.read_bytes()
        self.assert_rejected_without_writes(self.runner.apply_release, self.package)
        self.assertEqual(actual.read_bytes(), original)

    def test_symlink_backup_directory_is_rejected(self):
        actual = self.base / 'redirected-backups'
        actual.mkdir()
        self.backups.symlink_to(actual, target_is_directory=True)
        self.assert_rejected_without_writes(self.runner.apply_release, self.package)
        self.assertEqual(file_snapshot(actual), {})

    def test_failure_at_each_resource_promotion_restores_all_previous_files(self):
        replace = os.replace
        targets = {self.root / path for path in self.build.FILES}
        before = file_snapshot(self.root)
        guards_before = {str(path): path.read_bytes() for path in self.guards}
        for failure_at in range(1, len(self.build.FILES) + 1):
            with self.subTest(promotion=failure_at):
                count = 0
                injected = False

                def failing_replace(source, target, *args, **kwargs):
                    nonlocal count, injected
                    if Path(target) in targets:
                        count += 1
                        if count == failure_at and not injected:
                            injected = True
                            raise OSError('Injected resource promotion failure')
                    return replace(source, target, *args, **kwargs)

                with mock.patch.object(self.runner.os, 'replace', side_effect=failing_replace):
                    with self.assertRaises(self.runner.ReleaseError):
                        self.quiet(self.runner.apply_release, self.package)
                self.assertTrue(injected, 'Fault injection did not reach the target operation')
                self.assertEqual(file_snapshot(self.root), before)
                self.assertEqual({str(path): path.read_bytes() for path in self.guards}, guards_before)

    def test_rollback_refuses_whole_batch_if_one_file_changed_since_release(self):
        backup, _ = self.quiet(self.runner.apply_release, self.package)
        (self.root / 'app.js').write_bytes(b'An independent production update after this release')
        self.assert_rejected_without_writes(self.runner.rollback_release, backup, self.package)

    def test_rollback_refuses_permission_change_even_when_content_matches(self):
        backup, _ = self.quiet(self.runner.apply_release, self.package)
        (self.root / 'app.js').chmod(0o600)
        self.assert_rejected_without_writes(self.runner.rollback_release, backup, self.package)

    def test_insufficient_disk_space_stops_before_staging(self):
        with mock.patch.object(self.runner.shutil, 'disk_usage', return_value=SimpleNamespace(free=0)):
            self.assert_rejected_without_writes(self.runner.apply_release, self.package)

    def test_another_release_holding_lock_prevents_concurrent_update(self):
        with self.runner.release_lock():
            self.assert_rejected_without_writes(self.runner.apply_release, self.package)

    def test_corrupt_backup_is_rejected_before_any_file_is_restored(self):
        backup, _ = self.quiet(self.runner.apply_release, self.package)
        (backup / 'old' / 'app.js').write_bytes(b'CORRUPTED BACKUP DATA')
        self.assert_rejected_without_writes(self.runner.rollback_release, backup, self.package)


if __name__ == '__main__':
    unittest.main(verbosity=2)
