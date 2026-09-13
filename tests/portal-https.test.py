#!/usr/bin/env python3
"""Portal HTTPS deployment safety tests. All filesystem state is temporary."""

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
import unittest
from unittest import mock


REPOSITORY = Path(__file__).resolve().parent.parent
REAL_RUN = subprocess.run


def import_runner():
    spec = importlib.util.spec_from_file_location(
        'portal_https_under_test', REPOSITORY / 'deploy/portal-https.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def snapshot(directory):
    result = {}
    for path in sorted(directory.rglob('*')):
        name = path.relative_to(directory).as_posix()
        if path.is_symlink():
            result[name] = ('symlink', os.readlink(path))
        elif path.is_file():
            st = path.stat()
            result[name] = ('file', hashlib.sha256(path.read_bytes()).hexdigest(),
                            st.st_mode & 0o777, st.st_uid, st.st_gid)
        elif path.is_dir():
            result[name] = ('directory', path.stat().st_mode & 0o777)
    return result


def original_vhost(root):
    return ('''# Existing portal configuration; keep comments and formatting.
server {
    listen 80;
    listen [::]:80;
    server_name kidneysphere.com www.kidneysphere.com;
    root ROOT_PLACEHOLDER;
    index index.html;
    location /api/ {
        proxy_pass http://127.0.0.1:3001/api/;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location = /auth/callback {
        try_files /auth-callback.html =404;
    }
    location / {
        try_files $uri $uri.html $uri/ /index.html;
    }
    location ~* \\.html$ {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }
    location ~ /\\. { deny all; }
}
''').replace('ROOT_PLACEHOLDER', str(root)).encode()


class PortalHttpsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='portal-https-test-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.nginx_root = self.base / 'nginx'
        self.root = self.base / 'www/kidneysphere'
        self.backups = self.base / 'backups'
        self.acme = self.base / 'acme'
        self.available = self.nginx_root / 'sites-available/kidneysphere.com'
        self.vhost = self.nginx_root / 'sites-enabled/kidneysphere.com'
        self.cert = self.base / 'certificates/fullchain.pem'
        self.key = self.base / 'certificates/privkey.pem'
        for path in (self.root, self.available.parent, self.vhost.parent, self.cert.parent):
            path.mkdir(parents=True)
        self.original = original_vhost(self.root)
        self.available.write_bytes(self.original)
        self.available.chmod(0o640)
        self.vhost.symlink_to(self.available)
        self.cert.write_text('TEST CERTIFICATE\n')
        self.key.write_text('TEST PRIVATE KEY PLACEHOLDER\n')
        (self.root / 'index.html').write_text('<title>KidneySphere 肾域 | 肾脏专科视频课程与培训报名</title>')
        (self.root / 'login.html').write_text('ORIGINAL LOGIN')
        (self.root / 'watch.html').write_text('ORIGINAL VIDEO PLAYER')
        self.other = self.nginx_root / 'conf.d/registry.conf'
        self.other.parent.mkdir()
        self.other.write_text('server { listen 443 ssl; server_name kidneysphereregistry.cn; }\n')
        self.runner = import_runner()
        patcher = mock.patch.multiple(
            self.runner, VHOST=self.vhost, NGINX_ROOT=self.nginx_root,
            ROOT=self.root, BACKUP_ROOT=self.backups, ACME_ROOT=self.acme,
            PRIVATE_IP='172.24.33.51', CERT=self.cert, KEY=self.key,
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        self.commands = []
        self.allow_fixture_ca = True
        process_patch = mock.patch.object(self.runner.subprocess, 'run', side_effect=self.fake_command)
        process_patch.start()
        self.addCleanup(process_patch.stop)
        sleep_patch = mock.patch.object(self.runner.time, 'sleep')
        sleep_patch.start()
        self.addCleanup(sleep_patch.stop)

    def fake_command(self, command, *args, **kwargs):
        self.commands.append(list(command))
        binary = Path(command[0]).name
        payload = b''
        if binary == 'openssl':
            if command[1] == 'verify' and self.allow_fixture_ca:
                # The disposable self-signed cert stands in for a trusted test CA.
                return subprocess.CompletedProcess(command, 0, stdout=b'OK\n', stderr=b'')
            return REAL_RUN(command, *args, **kwargs)
        if binary == 'ip':
            payload = json.dumps([{'addr_info': [{'local': '172.24.33.51'}]}]).encode()
        elif command == ['nginx', '-T']:
            payload = b''.join(('# configuration file ' + str(path) + ':\n').encode()
                               + path.read_bytes() + b'\n' for path in (self.vhost, self.other))
        elif command in (['nginx', '-t'], ['systemctl', 'reload', 'nginx']):
            pass
        elif binary == 'curl':
            self.assertNotIn('-k', command)
            self.assertNotIn('--insecure', command)
            url = next(value for value in command if value.startswith(('https://', 'http://')))
            if url.endswith('/index.html'):
                payload = ('<title>肾脏专科视频课程与培训报名</title>portal-home.css\n200').encode()
            elif url.endswith('/api/health'):
                payload = b'{"status":"ok"}\n200'
            elif url.endswith('/play-auth'):
                payload = b'{"error":"unauthorized"}\n401'
            elif '/.well-known/acme-challenge/' in url:
                probe = self.acme / '.well-known/acme-challenge' / url.rsplit('/', 1)[1]
                payload = probe.read_bytes() + b'\n200'
            else:
                raise AssertionError('Unexpected test URL: ' + url)
        else:
            raise AssertionError('Unexpected system command: ' + repr(command))
        return subprocess.CompletedProcess(command, 0, stdout=payload, stderr=b'')

    def quiet(self, callback, *args):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            result = callback(*args)
        return result, output.getvalue()

    def test_patch_preserves_existing_http_api_and_auth_callback_bytes(self):
        patched = self.runner.patch_config(self.original)
        self.assertIsInstance(patched, bytes)
        # The original directives and whitespace must be unchanged and remain in order.
        position = 0
        for line in self.original.splitlines(keepends=True):
            found = patched.find(line, position)
            self.assertGreaterEqual(found, position, repr(line))
            position = found + len(line)
        self.assertIn(b'listen 80;', patched)
        self.assertIn(b'443 ssl', patched)
        self.assertIn(str(self.cert).encode(), patched)
        self.assertIn(str(self.key).encode(), patched)
        self.assertIn(b'/.well-known/acme-challenge/', patched)
        self.assertEqual(patched.count(b'proxy_pass http://127.0.0.1:3001/api/;'), 1)

    def test_patch_is_idempotent(self):
        once = self.runner.patch_config(self.original)
        self.assertEqual(self.runner.patch_config(once), once)

    def test_unsafe_or_ambiguous_existing_configurations_are_rejected(self):
        fixtures = {
            'wrong root': self.original.replace(str(self.root).encode(), b'/var/www/other-site'),
            'wrong hostname': self.original.replace(b'kidneysphere.com www.kidneysphere.com', b'other.example www.other.example'),
            'additional hostname': self.original.replace(b'server_name kidneysphere.com', b'server_name another.example kidneysphere.com'),
            'second portal block': self.original + self.original,
            'existing TLS listener': self.original.replace(b'listen 80;', b'listen 80;\n    listen 443 ssl;'),
            'nested root override': self.original.replace(b'location / {', b'location / {\n        root /var/www/other;'),
            'unrecognized include': self.original.replace(b'index index.html;', b'index index.html;\n    include /etc/nginx/unknown.conf;'),
        }
        for name, data in fixtures.items():
            with self.subTest(name=name), self.assertRaises(self.runner.ReleaseError):
                self.runner.patch_config(data)

    def create_certificate(self, names):
        # Synthetic certificates and keys stay under this test's temporary root.
        command = ['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                   '-days', '30', '-subj', '/CN=' + names[0],
                   '-addext', 'subjectAltName=' + ','.join('DNS:' + name for name in names),
                   '-keyout', str(self.key), '-out', str(self.cert)]
        REAL_RUN(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def test_certificate_hostname_failure_is_not_mistaken_for_exit_zero_success(self):
        self.create_certificate(['other.example'])
        # OpenSSL checkhost returns zero even when its text reports a mismatch.
        probe = subprocess.run(
            ['openssl', 'x509', '-in', str(self.cert), '-noout', '-checkhost', 'kidneysphere.com'],
            check=True, capture_output=True, text=True)
        self.assertIn('does NOT match certificate', probe.stdout)
        with self.assertRaises(self.runner.ReleaseError):
            self.runner.validate_certificates()

    def test_certificate_covering_both_portal_names_is_accepted(self):
        self.create_certificate(['kidneysphere.com', 'www.kidneysphere.com'])
        self.runner.validate_certificates()

    def test_certificate_missing_www_is_rejected(self):
        self.create_certificate(['kidneysphere.com'])
        with self.assertRaises(self.runner.ReleaseError):
            self.runner.validate_certificates()

    def test_mismatched_certificate_private_key_is_rejected(self):
        self.create_certificate(['kidneysphere.com', 'www.kidneysphere.com'])
        old_certificate = self.cert.read_bytes()
        self.create_certificate(['kidneysphere.com', 'www.kidneysphere.com'])
        self.cert.write_bytes(old_certificate)
        with self.assertRaises(self.runner.ReleaseError):
            self.runner.validate_certificates()

    def test_runtime_checks_reject_tls_verification_failure(self):
        def reject_tls(command, *args, **kwargs):
            self.assertEqual(Path(command[0]).name, 'curl')
            self.assertNotIn('-k', command)
            self.assertNotIn('--insecure', command)
            return subprocess.CompletedProcess(command, 60, stdout='', stderr='certificate hostname mismatch')

        with mock.patch.object(self.runner.subprocess, 'run', side_effect=reject_tls):
            with self.assertRaises(self.runner.ReleaseError):
                self.runner.runtime_checks()

    def test_untrusted_certificate_chain_is_rejected(self):
        self.create_certificate(['kidneysphere.com', 'www.kidneysphere.com'])
        self.allow_fixture_ca = False
        with self.assertRaises(self.runner.ReleaseError):
            self.runner.validate_certificates()

    def test_read_only_preflight_accepts_sites_enabled_symlink(self):
        before = snapshot(self.base)
        with mock.patch.object(self.runner, 'validate_certificates'):
            prepared = self.runner.preflight()
        self.assertFalse(prepared['no_change'])
        self.assertEqual(snapshot(self.base), before)
        self.assertFalse(self.backups.exists())
        self.assertFalse(self.acme.exists())

    def test_vhost_symlink_outside_nginx_is_rejected_without_writes(self):
        outside = self.base / 'outside.conf'
        outside.write_bytes(self.original)
        self.vhost.unlink()
        self.vhost.symlink_to(outside)
        before = snapshot(self.base)
        with mock.patch.object(self.runner, 'validate_certificates'):
            with self.assertRaises(self.runner.ReleaseError):
                self.runner.preflight()
        self.assertEqual(snapshot(self.base), before)

    def apply_fixture(self):
        with mock.patch.object(self.runner, 'validate_certificates'):
            result, output = self.quiet(self.runner.apply_release)
        backup_line = next(line for line in output.splitlines() if line.startswith('BACKUP='))
        backup = Path(backup_line.split('=', 1)[1])
        return backup, output

    def test_apply_and_rollback_preserve_symlink_metadata_and_other_sites(self):
        old_metadata = self.available.stat()
        guards = {str(path): path.read_bytes() for path in
                  (self.other, self.root / 'login.html', self.root / 'watch.html')}
        link = os.readlink(self.vhost)
        backup, output = self.apply_fixture()
        self.assertIn('HTTPS_OK:', output)
        self.assertEqual(self.available.read_bytes(), self.runner.patch_config(self.original))
        self.assertEqual(os.readlink(self.vhost), link)
        self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
        self.assertEqual((backup / 'original.conf').read_bytes(), self.original)
        self.assertEqual((backup / 'original.conf').stat().st_mode & 0o777, 0o600)
        self.assertFalse(list(self.acme.rglob('kidneysphere-check-*')))
        self.quiet(self.runner.rollback_release, backup)
        self.assertEqual(self.available.read_bytes(), self.original)
        restored = self.available.stat()
        self.assertEqual((restored.st_mode, restored.st_uid, restored.st_gid),
                         (old_metadata.st_mode, old_metadata.st_uid, old_metadata.st_gid))
        self.assertEqual(os.readlink(self.vhost), link)
        self.assertEqual({str(path): path.read_bytes() for path in
                          (self.other, self.root / 'login.html', self.root / 'watch.html')}, guards)

    def test_repeated_apply_does_not_create_another_release(self):
        self.apply_fixture()
        before = snapshot(self.base)
        with mock.patch.object(self.runner, 'validate_certificates'):
            _, output = self.quiet(self.runner.apply_release)
        self.assertIn('NO_CHANGE:', output)
        self.assertEqual(snapshot(self.base), before)

    def test_post_write_nginx_test_or_reload_failure_restores_original(self):
        for failed_command in (['nginx', '-t'], ['systemctl', 'reload', 'nginx']):
            with self.subTest(command=failed_command):
                failed = False
                def fail_once(command, *args, **kwargs):
                    nonlocal failed
                    if command == failed_command and not failed:
                        failed = True
                        return subprocess.CompletedProcess(command, 1, stdout=b'', stderr=b'test failure')
                    return self.fake_command(command, *args, **kwargs)
                with mock.patch.object(self.runner, 'validate_certificates'), \
                     mock.patch.object(self.runner.subprocess, 'run', side_effect=fail_once):
                    with self.assertRaises(self.runner.ReleaseError):
                        self.quiet(self.runner.apply_release)
                self.assertTrue(failed)
                self.assertEqual(self.available.read_bytes(), self.original)
                self.assertTrue(self.vhost.is_symlink())

    def test_failed_runtime_checks_restore_original_config(self):
        with mock.patch.object(self.runner, 'validate_certificates'), \
             mock.patch.object(self.runner, 'runtime_checks', side_effect=self.runner.ReleaseError('test failed')):
            with self.assertRaises(self.runner.ReleaseError):
                self.quiet(self.runner.apply_release)
        self.assertEqual(self.available.read_bytes(), self.original)
        record = json.loads(next(self.backups.glob('*/backup.json')).read_text())
        self.assertEqual(record['phase'], 'rolled_back')

    def test_automatic_rollback_does_not_overwrite_concurrent_admin_edit(self):
        admin_version = self.original + b'# concurrent admin edit\n'
        def fail_after_admin_edit():
            self.available.write_bytes(admin_version)
            raise self.runner.ReleaseError('runtime failure after administrator change')
        with mock.patch.object(self.runner, 'validate_certificates'), \
             mock.patch.object(self.runner, 'runtime_checks', side_effect=fail_after_admin_edit):
            with self.assertRaisesRegex(self.runner.ReleaseError, 'ROLLBACK_REQUIRES_REVIEW'):
                self.quiet(self.runner.apply_release)
        self.assertEqual(self.available.read_bytes(), admin_version)
        self.assertTrue(self.vhost.is_symlink())

    def test_rollback_refuses_later_configuration_or_permission_edits(self):
        backup, _ = self.apply_fixture()
        updated = self.available.read_bytes()
        for mutate in (lambda: self.available.write_bytes(updated + b'# third-party change\n'),
                       lambda: self.available.chmod(0o600)):
            self.available.write_bytes(updated)
            self.available.chmod(0o640)
            mutate()
            before = snapshot(self.base)
            with self.assertRaises(self.runner.ReleaseError):
                self.quiet(self.runner.rollback_release, backup)
            self.assertEqual(snapshot(self.base), before)

    def test_rollback_refuses_corrupt_backup_before_modifying_config(self):
        backup, _ = self.apply_fixture()
        (backup / 'original.conf').write_bytes(b'CORRUPT BACKUP')
        before = snapshot(self.base)
        with self.assertRaises(self.runner.ReleaseError):
            self.quiet(self.runner.rollback_release, backup)
        self.assertEqual(snapshot(self.base), before)

    def test_rollback_refuses_other_site_config_drift(self):
        backup, _ = self.apply_fixture()
        self.other.write_text(self.other.read_text() + '# OTHER SITE ADMIN EDIT\n')
        before = snapshot(self.base)
        with self.assertRaises(self.runner.ReleaseError):
            self.quiet(self.runner.rollback_release, backup)
        self.assertEqual(snapshot(self.base), before)


if __name__ == '__main__':
    unittest.main(verbosity=2)
