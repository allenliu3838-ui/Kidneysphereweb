#!/usr/bin/env python3
"""Theme release scope and rollback tests; all deployment paths are temporary."""
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

REPOSITORY = Path(__file__).resolve().parent.parent


def import_file(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def snapshot(directory):
    result = {}
    for path in directory.rglob('*'):
        if path.is_file():
            result[str(path.relative_to(directory))] = (path.read_bytes(), path.stat().st_mode & 0o777)
    return result


class SiteThemeReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.builder = import_file('site_theme_builder_test', REPOSITORY / 'deploy/build-site-theme-release.py')
        cls.old = {name: cls.builder.git_bytes(cls.builder.BASELINE, name, optional=True)
                   for name in cls.builder.FILES}
        cls.new = {name: cls.builder.updated_html(cls.old[name]) for name in cls.builder.HTML_FILES}
        cls.new.update({
            'site-light.css': b'body { color: navy; background: white; }\n',
            'site-page-themes.css': b'.page { border-color: lightblue; }\n',
            'styles.css': (b'@import url("site-light.css?v=20260914_light1");\n'
                           b'@import url("site-page-themes.css?v=20260914_light1");\n' + cls.old['styles.css']),
        })
        cls.new = {name: cls.new[name] for name in cls.builder.FILES}
        cls.dependencies = {name: cls.builder.git_bytes(cls.builder.BASELINE, name)
                            for name in cls.builder.REQUIRED_FILES}

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='site-theme-release-test-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / 'www'
        self.root.mkdir()
        self.backups = self.base / 'backups'
        self.vhost = self.base / 'nginx.conf'
        self.vhost.write_text('server {\n server_name kidneysphere.com www.kidneysphere.com;\n'
                             ' root ' + str(self.root) + ';\n}\n')
        for name, data in {**self.dependencies, **self.old}.items():
            if data is not None:
                path = self.root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                path.chmod(0o644)
        self.runner = import_file('site_theme_runner_test', REPOSITORY / 'deploy/portal-release.py')
        patcher = mock.patch.multiple(self.runner, ROOT=self.root, BACKUP_ROOT=self.backups,
            VHOST=self.vhost, GUARD_PATHS=(self.vhost, self.root / 'styles.css',
                                          self.root / 'login.html', self.root / 'supabaseClient.js'))
        patcher.start()
        self.addCleanup(patcher.stop)
        configuration = '# configuration file ' + str(self.vhost) + ':\n' + self.vhost.read_text()

        def nginx_only(command, *args, **kwargs):
            if command != ['nginx', '-T']:
                raise AssertionError('Unexpected subprocess: ' + repr(command))
            return subprocess.CompletedProcess(command, 0, stdout=configuration, stderr='')
        patcher = mock.patch.object(self.runner.subprocess, 'run', side_effect=nginx_only)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.package = {'manifest': {
            'schema': 1, 'release_profile': 'site-theme-v1', 'domain': self.runner.DOMAIN,
            'root': str(self.root), 'commit': self.builder.BASELINE,
            'required_files': list(self.builder.REQUIRED_FILES),
            'files': [{
                'path': name, 'sha256': self.runner.digest(self.new[name]), 'size': len(self.new[name]),
                'allowed_before': [self.runner.digest(self.old[name])] if self.old[name] else [],
                'allow_missing': self.old[name] is None,
            } for name in self.builder.FILES],
        }, 'payload': dict(self.new)}

    def quiet(self, callback, *args):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            value = callback(*args)
        return value, output.getvalue()

    def reject_unchanged(self, callback, *args):
        before = snapshot(self.base)
        with self.assertRaises(self.runner.ReleaseError):
            self.quiet(callback, *args)
        self.assertEqual(snapshot(self.base), before)

    def test_allowlist_is_fixed_and_excludes_homepage_and_javascript(self):
        self.assertEqual(self.runner.SITE_THEME_FILES, self.builder.FILES)
        self.assertEqual(len(self.builder.FILES), 68)
        self.assertNotIn('index.html', self.builder.FILES)
        self.assertFalse(any(name.endswith('.js') for name in self.builder.FILES))
        self.runner.validate_manifest(self.package['manifest'])
        for profile in ('arbitrary', None):
            package = copy.deepcopy(self.package)
            package['manifest']['release_profile'] = profile
            self.reject_unchanged(self.runner.preflight, package)
        extra = copy.deepcopy(self.package)
        extra['manifest']['files'].append(dict(extra['manifest']['files'][-1], path='app.js'))
        self.reject_unchanged(self.runner.preflight, extra)

    def test_preflight_is_read_only_and_new_css_can_be_missing(self):
        before = snapshot(self.base)
        result, _ = self.quiet(self.runner.preflight, self.package)
        self.assertFalse(result['no_change'])
        self.assertEqual(snapshot(self.base), before)
        self.assertFalse(self.backups.exists())

    def test_apply_order_guards_and_complete_rollback(self):
        before = snapshot(self.root)
        order = []
        replace = os.replace
        targets = {self.root / name for name in self.builder.FILES}

        def capture(source, target, *args, **kwargs):
            if Path(target) in targets:
                order.append(Path(target).name)
            return replace(source, target, *args, **kwargs)

        with mock.patch.object(self.runner.os, 'replace', side_effect=capture):
            backup, _ = self.quiet(self.runner.apply_release, self.package)
        self.assertEqual(order, list(self.builder.FILES))
        self.assertEqual(order[:3], ['site-light.css', 'site-page-themes.css', 'styles.css'])
        self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.root / 'index.html').read_bytes(), self.dependencies['index.html'])
        self.assertEqual((self.root / 'app.js').read_bytes(), self.dependencies['app.js'])
        for name in self.builder.FILES:
            self.assertEqual((self.root / name).read_bytes(), self.new[name])
        unchanged = snapshot(self.base)
        result, output = self.quiet(self.runner.apply_release, self.package)
        self.assertIsNone(result)
        self.assertIn('NO_CHANGE', output)
        self.assertEqual(snapshot(self.base), unchanged)
        self.quiet(self.runner.rollback_release, backup, self.package)
        self.assertEqual(snapshot(self.root), before)

    def test_unknown_existing_css_or_html_prevents_writes(self):
        for name in ('styles.css', 'login.html', 'watch.html'):
            with self.subTest(path=name):
                path = self.root / name
                path.write_bytes(self.old[name] + b'\nserver-specific edit')
                self.reject_unchanged(self.runner.apply_release, self.package)
                path.write_bytes(self.old[name])
        (self.root / 'site-light.css').write_bytes(b'unknown older stylesheet')
        self.reject_unchanged(self.runner.apply_release, self.package)

    def test_missing_existing_html_and_invalid_missing_permission_are_rejected(self):
        (self.root / 'watch.html').unlink()
        self.reject_unchanged(self.runner.apply_release, self.package)
        package = copy.deepcopy(self.package)
        package['manifest']['files'][-1]['allow_missing'] = True
        self.reject_unchanged(self.runner.preflight, package)

    def test_css_and_html_promotion_failures_restore_originals(self):
        original = snapshot(self.root)
        replace = os.replace
        for target_name in ('site-light.css', 'styles.css', 'watch.html'):
            with self.subTest(target=target_name):
                injected = False

                def failing_replace(source, target, *args, **kwargs):
                    nonlocal injected
                    if Path(target) == self.root / target_name and not injected:
                        injected = True
                        raise OSError('Injected promotion failure')
                    return replace(source, target, *args, **kwargs)

                with mock.patch.object(self.runner.os, 'replace', side_effect=failing_replace):
                    with self.assertRaises(self.runner.ReleaseError):
                        self.quiet(self.runner.apply_release, self.package)
                self.assertTrue(injected)
                self.assertEqual(snapshot(self.root), original)

    def test_rollback_refuses_user_edits_or_corrupted_backup(self):
        backup, _ = self.quiet(self.runner.apply_release, self.package)
        (self.root / 'login.html').write_bytes(b'Independent login edit')
        self.reject_unchanged(self.runner.rollback_release, backup, self.package)
        (self.root / 'login.html').write_bytes(self.new['login.html'])
        (backup / 'old' / 'styles.css').write_bytes(b'Corrupted backup')
        self.reject_unchanged(self.runner.rollback_release, backup, self.package)

    def test_shared_lock_prevents_theme_and_homepage_release_overlap(self):
        with self.runner.release_lock():
            self.reject_unchanged(self.runner.apply_release, self.package)

    def test_archive_load_accepts_theme_and_rejects_added_homepage_payload(self):
        runner = (REPOSITORY / 'deploy/portal-release.py').read_bytes()
        manifest = copy.deepcopy(self.package['manifest'])
        manifest['runner_sha256'] = self.runner.digest(runner)
        archive_path = self.base / 'theme.pyz'

        def write_archive(extra=False):
            with zipfile.ZipFile(archive_path, 'w') as archive:
                archive.writestr('__main__.py', runner)
                archive.writestr('manifest.json', json.dumps(manifest))
                for name, data in self.new.items():
                    archive.writestr('payload/' + name, data)
                if extra:
                    archive.writestr('payload/index.html', b'unapproved homepage')
        write_archive()
        loaded = self.runner.load_package(archive_path)
        self.assertEqual(loaded['payload'], self.new)
        write_archive(extra=True)
        self.reject_unchanged(self.runner.load_package, archive_path)


class ThemeBuilderProofTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.builder = import_file('theme_builder_proof', REPOSITORY / 'deploy/build-site-theme-release.py')
        cls.before = {name: cls.builder.git_bytes(cls.builder.BASELINE, name) for name in cls.builder.HTML_FILES}
        cls.css = cls.builder.git_bytes(cls.builder.BASELINE, 'styles.css')

    def payload(self):
        files = {'site-light.css': b'body { color: navy; }',
                 'site-page-themes.css': b'.page { color: blue; }',
                 'styles.css': (b'@import url("site-light.css?v=20260914_light1");\n'
                                 b'@import url("site-page-themes.css?v=20260914_light1");\n' + self.css)}
        files.update((name, self.builder.updated_html(self.before[name])) for name in self.builder.HTML_FILES)
        return files

    def test_html_has_only_one_versioned_stylesheet_href_change(self):
        self.builder.validate_theme_payload(self.payload())
        for name in ('login.html', 'watch.html', 'admin-commerce.html'):
            changed = self.payload()
            changed[name] += b'\n<script>alterAuthentication()</script>'
            with self.assertRaisesRegex(ValueError, 'beyond the stylesheet link'):
                self.builder.validate_theme_payload(changed)

    def test_legacy_css_edits_and_missing_import_are_rejected(self):
        changed = self.payload()
        changed['styles.css'] += b'\nbody { display: none; }'
        with self.assertRaisesRegex(ValueError, 'beyond the two pinned imports'):
            self.builder.validate_theme_payload(changed)
        changed = self.payload()
        changed['styles.css'] = changed['styles.css'].replace(b'site-light.css?v=', b'site-light.css?old=', 1)
        with self.assertRaisesRegex(ValueError, 'Missing pinned stylesheet import'):
            self.builder.validate_theme_payload(changed)

    def test_mutable_commit_and_ambiguous_stylesheet_link_are_rejected(self):
        with self.assertRaises(ValueError):
            self.builder.immutable_commit('HEAD')
        with self.assertRaises(ValueError):
            self.builder.updated_html(self.before['login.html'] + b'<link href="styles.css">')


if __name__ == '__main__':
    unittest.main(verbosity=2)
