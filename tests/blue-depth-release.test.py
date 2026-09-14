#!/usr/bin/env python3
"""Deep-blue release scope and rollback verification in temporary site trees."""
import contextlib
import copy
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

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


class BlueDepthReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.builder = import_file('depth_builder_safety', REPOSITORY / 'deploy/build-blue-depth-release.py')
        cls.prior = {
            revision: {name: cls.builder.git_bytes(revision, name, optional=True)
                       for name in cls.builder.FILES}
            for revision in cls.builder.BASELINES
        }
        latest = cls.prior[cls.builder.BASELINE]
        cls.new = {name: latest[name] for name in cls.builder.FILES}
        cls.new.update((name, cls.builder.updated_html(latest[name])) for name in cls.builder.HTML_FILES)
        cls.new['styles.css'] = cls.builder.updated_styles(latest['styles.css'])
        cls.new['portal-motion.js'] = b'// Fixture presentation-only motion module.\nexport {};\n'
        for name in ('site-light.css', 'site-page-themes.css', 'portal-home.css'):
            cls.new[name] += b'\n/* Deep-blue fixture visual update. */\n'
        homepage = cls.builder.updated_html(latest['index.html'])
        homepage = homepage.replace(b'portal-home.css?v=20260914_001', b'portal-home.css?v=20260914_depth1')
        cls.new['index.html'] = homepage.replace(b'</body>', cls.builder.MOTION_SCRIPT + b'\n</body>')
        cls.dependencies = {name: cls.builder.git_bytes(cls.builder.BASELINE, name)
                            for name in cls.builder.REQUIRED_FILES}
        cls.builder.validate_depth_payload(cls.new)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='blue-depth-release-test-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / 'www'
        self.root.mkdir()
        self.backups = self.base / 'backups'
        self.vhost = self.base / 'nginx.conf'
        self.other_site = self.base / 'registry.html'
        self.other_site.write_bytes(b'Unrelated registry website')
        self.vhost.write_text('server {\n server_name kidneysphere.com www.kidneysphere.com;\n'
                             ' root ' + str(self.root) + ';\n}\n')
        self.install_before(self.builder.BASELINE)
        self.runner = import_file('depth_runner_safety', REPOSITORY / 'deploy/portal-release.py')
        patcher = mock.patch.multiple(self.runner, ROOT=self.root, BACKUP_ROOT=self.backups,
            VHOST=self.vhost, GUARD_PATHS=(self.vhost, self.other_site, self.root / 'styles.css',
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
            'schema': 1, 'release_profile': 'blue-depth-v1', 'domain': self.runner.DOMAIN,
            'root': str(self.root), 'commit': self.builder.BASELINE,
            'required_files': list(self.builder.REQUIRED_FILES),
            'files': [{
                'path': name, 'sha256': self.runner.digest(self.new[name]), 'size': len(self.new[name]),
                'allowed_before': sorted({self.runner.digest(values[name]) for values in self.prior.values()
                                           if values[name] is not None}),
                'allow_missing': name in self.builder.OPTIONAL_BEFORE,
            } for name in self.builder.FILES],
        }, 'payload': dict(self.new)}

    def install_before(self, revision):
        for name, data in {**self.dependencies, **self.prior[revision]}.items():
            path = self.root / name
            if data is None:
                path.unlink(missing_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                path.chmod(0o644)

    def quiet(self, callback, *args):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            value = callback(*args)
        return value, output.getvalue()

    def reject_unchanged(self, callback, *args):
        before = snapshot(self.base)
        with self.assertRaises(self.runner.ReleaseError):
            self.quiet(callback, *args)
        self.assertEqual(snapshot(self.base), before)

    def test_exact_fixed_allowlist_and_existing_resources_cannot_be_optional(self):
        self.assertEqual(self.builder.FILES, self.runner.BLUE_DEPTH_FILES)
        self.assertEqual(len(self.builder.FILES), 77)
        self.assertEqual(self.builder.FILES[-1], 'index.html')
        self.runner.validate_manifest(self.package['manifest'])
        for name in ('index.html', 'login.html', 'styles.css', 'app.js', 'portal-home.css'):
            with self.subTest(path=name):
                package = copy.deepcopy(self.package)
                next(e for e in package['manifest']['files'] if e['path'] == name)['allow_missing'] = True
                self.reject_unchanged(self.runner.preflight, package)
        extra = copy.deepcopy(self.package)
        extra['manifest']['files'].append(dict(extra['manifest']['files'][-1], path='server/index.js'))
        self.reject_unchanged(self.runner.preflight, extra)

    def test_preflight_is_read_only_for_all_supported_prior_releases(self):
        for revision in self.builder.BASELINES:
            with self.subTest(revision=revision):
                self.install_before(revision)
                before = snapshot(self.base)
                result, _ = self.quiet(self.runner.preflight, self.package)
                self.assertFalse(result['no_change'])
                self.assertEqual(snapshot(self.base), before)
                self.assertFalse(self.backups.exists())

    def test_all_four_prior_states_upgrade_and_restore_exactly(self):
        for revision in self.builder.BASELINES:
            with self.subTest(revision=revision):
                self.install_before(revision)
                before = snapshot(self.root)
                backup, _ = self.quiet(self.runner.apply_release, self.package)
                self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
                for name in self.builder.FILES:
                    self.assertEqual((self.root / name).read_bytes(), self.new[name], name)
                self.assertEqual(self.other_site.read_bytes(), b'Unrelated registry website')
                for name, data in self.dependencies.items():
                    self.assertEqual((self.root / name).read_bytes(), data, name)
                self.quiet(self.runner.rollback_release, backup, self.package)
                self.assertEqual(snapshot(self.root), before)

    def test_dependency_first_homepage_last_and_second_apply_no_change(self):
        order = []
        replace = os.replace
        targets = {self.root / name for name in self.builder.FILES}

        def capture(source, target, *args, **kwargs):
            if Path(target) in targets:
                order.append(str(Path(target).relative_to(self.root)))
            return replace(source, target, *args, **kwargs)
        with mock.patch.object(self.runner.os, 'replace', side_effect=capture):
            self.quiet(self.runner.apply_release, self.package)
        self.assertEqual(order, list(self.builder.FILES))
        self.assertEqual(order[-1], 'index.html')
        self.assertLess(order.index('portal-motion.js'), order.index('index.html'))
        self.assertLess(order.index('site-light.css'), order.index('styles.css'))
        before = snapshot(self.base)
        result, output = self.quiet(self.runner.apply_release, self.package)
        self.assertIsNone(result)
        self.assertIn('NO_CHANGE', output)
        self.assertEqual(snapshot(self.base), before)

    def test_unknown_shared_script_homepage_and_theme_are_never_overwritten(self):
        latest = self.prior[self.builder.BASELINE]
        for name in ('app.js', 'home.js', 'index.html', 'login.html', 'site-light.css'):
            with self.subTest(path=name):
                (self.root / name).write_bytes(latest[name] + b'\nUnknown server edit')
                self.reject_unchanged(self.runner.apply_release, self.package)
                (self.root / name).write_bytes(latest[name])
        (self.root / 'portal-motion.js').write_bytes(b'Unknown preexisting motion implementation')
        self.reject_unchanged(self.runner.apply_release, self.package)

    def test_partial_promotion_failures_restore_the_old_homepage_and_missing_assets(self):
        self.install_before(self.builder.BASELINES[0])
        original = snapshot(self.root)
        replace = os.replace
        for target_name in ('portal-motion.js', 'styles.css', 'watch.html', 'index.html'):
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

    def test_rollback_refuses_changed_homepage_or_corrupted_original(self):
        backup, _ = self.quiet(self.runner.apply_release, self.package)
        (self.root / 'index.html').write_bytes(b'Independent post-release homepage change')
        self.reject_unchanged(self.runner.rollback_release, backup, self.package)
        (self.root / 'index.html').write_bytes(self.new['index.html'])
        (backup / 'old' / 'home.js').write_bytes(b'Corrupted original script')
        self.reject_unchanged(self.runner.rollback_release, backup, self.package)

    def test_authentication_dependency_drift_aborts_and_restores_release(self):
        protected = self.root / 'supabaseClient.js'
        before = snapshot(self.root)
        replace = os.replace
        changed = False

        def change_guard(source, target, *args, **kwargs):
            nonlocal changed
            result = replace(source, target, *args, **kwargs)
            if Path(target) == self.root / 'index.html' and not changed:
                changed = True
                protected.write_bytes(b'Concurrent authentication dependency update')
            return result
        with mock.patch.object(self.runner.os, 'replace', side_effect=change_guard):
            with self.assertRaisesRegex(self.runner.ReleaseError, 'ROLLED_BACK'):
                self.quiet(self.runner.apply_release, self.package)
        expected = dict(before)
        expected['supabaseClient.js'] = (b'Concurrent authentication dependency update', 0o644)
        self.assertEqual(snapshot(self.root), expected)

    def test_common_lock_prevents_overlapping_homepage_theme_or_depth_updates(self):
        with self.runner.release_lock():
            self.reject_unchanged(self.runner.apply_release, self.package)


class BlueDepthBuilderProofTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        BlueDepthReleaseTests.setUpClass()
        cls.builder = BlueDepthReleaseTests.builder
        cls.new = BlueDepthReleaseTests.new

    def test_unmodified_fixture_passes_and_nonhome_html_is_query_only(self):
        self.builder.validate_depth_payload(self.new)
        for name in ('login.html', 'watch.html', 'checkout.html', 'admin-commerce.html'):
            changed = dict(self.new)
            changed[name] += b'\n<script>alterBusinessLogic()</script>'
            with self.assertRaisesRegex(ValueError, 'HTML changes beyond'):
                self.builder.validate_depth_payload(changed)

    def test_shared_script_and_legacy_css_changes_are_rejected(self):
        for name in ('app.js', 'home.js', 'portal-home.js'):
            changed = dict(self.new)
            changed[name] += b'\n// Unapproved shared script change.'
            with self.assertRaisesRegex(ValueError, 'Shared business JavaScript'):
                self.builder.validate_depth_payload(changed)
        changed = dict(self.new)
        changed['styles.css'] += b'\nbody { display: none; }'
        with self.assertRaisesRegex(ValueError, 'styles.css changes beyond'):
            self.builder.validate_depth_payload(changed)

    def test_homepage_script_additions_replacement_and_missing_motion_are_rejected(self):
        variants = (
            self.new['index.html'] + b'<script>alterBusinessLogic()</script>',
            self.new['index.html'].replace(b'app.js?v=20260913_003', b'unknown-auth.js'),
            self.new['index.html'].replace(self.builder.MOTION_SCRIPT, b''),
        )
        for homepage in variants:
            changed = dict(self.new, **{'index.html': homepage})
            with self.assertRaisesRegex(ValueError, 'Homepage scripts must preserve'):
                self.builder.validate_depth_payload(changed)

    def test_mutable_commit_and_unknown_payload_are_rejected(self):
        with self.assertRaises(ValueError):
            self.builder.immutable_commit('HEAD')
        changed = dict(self.new, **{'server/index.js': b'Unexpected backend change'})
        with self.assertRaisesRegex(ValueError, 'fixed 77-file allowlist'):
            self.builder.validate_depth_payload(changed)


if __name__ == '__main__':
    unittest.main(verbosity=2)
