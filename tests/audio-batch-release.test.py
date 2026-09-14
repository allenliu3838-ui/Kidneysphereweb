#!/usr/bin/env python3
"""Batch release profiles, older installation upgrades, and original-runner rollback."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
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


class AudioBatchReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.builder = load('audio_batch_builder_test', REPO / 'deploy/build-audio-batch-release.py')
        cls.audio_tests = load('audio_batch_legacy_fixtures', REPO / 'tests/audio-release.test.py')
        cls.audio_tests.AudioReleaseTests.setUpClass()
        cls.prior = {revision: {name: cls.builder.git_bytes(revision, name, optional=True)
                               for name in cls.builder.FILES} for revision in cls.builder.BASELINES}
        latest = cls.prior[cls.builder.BASELINES[-1]]
        # The original audio payload is read from its actual committed release,
        # not from business files that other agents may now be modifying.
        cls.audio_tests.AudioReleaseTests.new = {
            name: latest[name] for name in cls.audio_tests.AudioReleaseTests.builder.FILES}
        cls.new = {name: latest[name] if latest[name] is not None else
                   (b'/* Batch stylesheet fixture. */\n' if name.endswith('.css') else b'export const batchFixture = true;\n')
                   for name in cls.builder.FILES}
        cls.new['learning-center.js'] += b'\n// Batch queue activation fixture.\n'
        cls.new['learning.html'] += b'\n<!-- Batch upload interface fixture. -->\n'
        cls.resources = cls.builder.manifest_resources(cls.new)

    def setUp(self):
        self.fixture = self.audio_tests.AudioReleaseTests(methodName='runTest')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        for name in ('base', 'web', 'api', 'runtime', 'runner', 'entry', 'vhost', 'commands'):
            setattr(self, name, getattr(self.fixture, name))
        self.audio_package = self.fixture.package
        self.package = {'manifest': {
            'schema': 1, 'profile': 'audio-batch-v1', 'domain': 'kidneysphere.com',
            'root': str(self.web), 'commit': self.builder.BASELINES[-1],
            'files': copy.deepcopy(self.resources),
            'server_entry_hashes': list(self.audio_package['manifest']['server_entry_hashes']),
        }, 'payload': dict(self.new)}
        self.install_before(self.builder.BASELINES[-1])

    def install_before(self, revision):
        for name, data in self.prior[revision].items():
            path = (self.api if name.startswith('netlify/') else self.web) / name
            if data is None:
                path.unlink(missing_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                path.chmod(0o644)

    def quiet(self, function, *args):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            result = function(*args)
        return result, output.getvalue()

    def apply(self, package=None):
        package = package or self.package
        report = self.runner.inspect_release(package)
        return self.quiet(self.runner.apply_release, package, report['inspection_sha256'])

    def archive(self, manifest=None, extra=None):
        path = self.base / 'test-batch.pyz'
        runner = (REPO / 'deploy/audio-release.py').read_bytes()
        core = (REPO / 'deploy/portal-release.py').read_bytes()
        manifest = copy.deepcopy(manifest or self.package['manifest'])
        manifest.update(runner_sha256=self.runner.digest(runner), core_sha256=self.runner.digest(core))
        with zipfile.ZipFile(path, 'w') as archive:
            archive.writestr('__main__.py', runner)
            archive.writestr('release_core.py', core)
            archive.writestr('manifest.json', json.dumps(manifest))
            for name, data in self.package['payload'].items():
                archive.writestr('payload/' + name, data)
            if extra:
                archive.writestr(extra, b'Unapproved resource')
        return path

    def test_profiles_have_exact_independent_file_order_and_only_optional_assets_can_be_absent(self):
        self.assertEqual(self.runner.release_files(self.package['manifest']), self.builder.FILES)
        self.assertEqual(len(self.builder.FILES), 13)
        self.assertEqual(self.runner.release_files(self.audio_package['manifest']), self.runner.FILES)
        self.assertEqual(len(self.runner.FILES), 8)
        resources = {entry['path']: entry for entry in self.resources}
        self.assertEqual({name for name, entry in resources.items() if entry['allow_missing']}, self.builder.OPTIONAL_FILES)
        for name in ('media-upload.js', 'media-player.js', 'media-player.css'):
            self.assertTrue(resources[name]['allow_missing'])
            self.assertIn(self.runner.digest(self.prior[self.builder.BASELINES[-1]][name]), resources[name]['allowed_before'])
        archive = self.archive()
        self.assertEqual(self.runner.load_package(archive)['payload'], self.new)
        for name in ('learning.html', 'watch.html', 'learning-center.js', self.runner.BACKEND_FILES[0]):
            manifest = copy.deepcopy(self.package['manifest'])
            next(entry for entry in manifest['files'] if entry['path'] == name)['allow_missing'] = True
            with self.assertRaises(self.runner.ReleaseError):
                self.runner.load_package(self.archive(manifest))

    def test_unknown_profile_and_extra_backend_payload_are_rejected(self):
        manifest = dict(self.package['manifest'], profile='arbitrary-files')
        with self.assertRaises(self.runner.ReleaseError):
            self.runner.load_package(self.archive(manifest))
        with self.assertRaises(self.runner.ReleaseError):
            self.runner.load_package(self.archive(extra='payload/server/index.js'))

    def test_inspection_is_read_only_for_all_three_prior_versions(self):
        for revision in self.builder.BASELINES:
            with self.subTest(revision=revision):
                self.install_before(revision)
                before = snapshot(self.base)
                report = self.runner.inspect_release(self.package)
                self.assertEqual(len(report['targets']), 13)
                self.assertEqual(snapshot(self.base), before)
                self.assertFalse(self.runner.BACKUP_ROOT.exists())

    def test_all_three_versions_upgrade_and_restore_exactly_including_asset_absence(self):
        for revision in self.builder.BASELINES:
            with self.subTest(revision=revision):
                self.install_before(revision)
                before_web, before_api = snapshot(self.web), snapshot(self.api)
                backup, output = self.apply()
                self.assertIn('AUDIO_BATCH_RELEASE_OK', output)
                targets = self.runner.target_paths(self.runtime, self.package['manifest'])
                for name in self.builder.FILES:
                    self.assertEqual(targets[name].read_bytes(), self.new[name], name)
                self.quiet(self.runner.rollback_release, backup, self.package)
                self.assertEqual(snapshot(self.web), before_web)
                self.assertEqual(snapshot(self.api), before_api)

    def test_new_dependencies_are_promoted_before_learning_code_and_pages(self):
        targets = self.runner.target_paths(self.runtime, self.package['manifest'])
        names = {path: name for name, path in targets.items()}
        replace = os.replace
        order = []

        def track(source, target, *args, **kwargs):
            if Path(target) in names:
                order.append(names[Path(target)])
            return replace(source, target, *args, **kwargs)
        with mock.patch.object(self.runner.os, 'replace', side_effect=track):
            self.apply()
        self.assertEqual(order, list(self.builder.FILES))
        for name in self.builder.OPTIONAL_FILES:
            self.assertLess(order.index(name), order.index('learning-center.js'))
        self.assertEqual(order[-1], 'learning.html')

    def test_existing_audio_backend_is_not_restarted_for_batch_upgrade_or_restore(self):
        self.install_before(self.builder.BASELINES[-1])
        before_web, before_api = snapshot(self.web), snapshot(self.api)
        with mock.patch.object(self.runner, 'restart_backend') as restart:
            backup, output = self.apply()
            self.assertIn('API restart not required', output)
            self.quiet(self.runner.rollback_release, backup, self.package)
            restart.assert_not_called()
            self.assertEqual(snapshot(self.web), before_web)
            self.assertEqual(snapshot(self.api), before_api)
            replace = os.replace
            fired = False

            def fail(source, target, *args, **kwargs):
                nonlocal fired
                if Path(target) == self.web / 'learning.html' and not fired:
                    fired = True
                    raise OSError('Injected frontend promotion failure')
                return replace(source, target, *args, **kwargs)
            with mock.patch.object(self.runner.os, 'replace', side_effect=fail):
                with self.assertRaisesRegex(self.runner.ReleaseError, 'ROLLED_BACK'):
                    self.apply()
            self.assertTrue(fired)
            restart.assert_not_called()
        self.assertEqual(snapshot(self.web), before_web)
        self.assertEqual(snapshot(self.api), before_api)

    def test_unknown_batch_file_and_changed_original_files_are_never_overwritten(self):
        for name in ('media-batch.js', 'learning-center.js'):
            with self.subTest(path=name):
                target = self.web / name
                previous = target.read_bytes() if target.exists() else None
                target.write_bytes(b'Independent unknown server edit')
                before = snapshot(self.base)
                with self.assertRaises(self.runner.ReleaseError):
                    self.runner.inspect_release(self.package)
                self.assertEqual(snapshot(self.base), before)
                if previous is None:
                    target.unlink()
                else:
                    target.write_bytes(previous)

    def test_batch_dependency_or_html_failure_restores_both_roots(self):
        self.install_before(self.builder.BASELINES[0])
        before_web, before_api = snapshot(self.web), snapshot(self.api)
        replace = os.replace
        for name in ('media-batch-save.js', 'learning.html'):
            fired = False

            def fail(source, target, *args, **kwargs):
                nonlocal fired
                if Path(target) == self.web / name and not fired:
                    fired = True
                    raise OSError('Injected batch promotion failure')
                return replace(source, target, *args, **kwargs)
            with mock.patch.object(self.runner.os, 'replace', side_effect=fail):
                with self.assertRaisesRegex(self.runner.ReleaseError, 'ROLLED_BACK'):
                    self.apply()
            self.assertTrue(fired)
            self.assertEqual(snapshot(self.web), before_web)
            self.assertEqual(snapshot(self.api), before_api)

    def test_original_audio_runner_refuses_batch_drift_then_rolls_back_after_batch_restore(self):
        self.install_before(self.builder.BASELINES[1])
        before_web, before_api = snapshot(self.web), snapshot(self.api)
        audio_backup, _ = self.apply(self.audio_package)
        batch_backup, _ = self.apply()
        directory = self.base / 'original-audio-runner'
        directory.mkdir()
        old_runner = directory / 'audio-release.py'
        old_runner.write_bytes(self.builder.git_bytes(self.builder.BASELINES[-1], 'deploy/audio-release.py'))
        (directory / 'portal-release.py').write_bytes(self.builder.git_bytes(self.builder.BASELINES[-1], 'deploy/portal-release.py'))
        legacy = load('frozen_audio_runner_881', old_runner)
        patcher = mock.patch.multiple(legacy, ROOT=self.web, BACKUP_ROOT=self.runner.BACKUP_ROOT, VHOST=self.vhost,
            verify_restart_target=lambda runtime: None, restart_backend=lambda runtime: None,
            wait_for_backend=lambda *args: None)
        core_patcher = mock.patch.multiple(legacy.core, ROOT=self.web, BACKUP_ROOT=self.runner.core.BACKUP_ROOT, VHOST=self.vhost)
        with patcher, core_patcher:
            before = snapshot(self.base)
            with self.assertRaises(legacy.ReleaseError):
                self.quiet(legacy.rollback_release, audio_backup, self.audio_package)
            self.assertEqual(snapshot(self.base), before)
            self.quiet(self.runner.rollback_release, batch_backup, self.package)
            self.quiet(legacy.rollback_release, audio_backup, self.audio_package)
        self.assertEqual(snapshot(self.web), before_web)
        self.assertEqual(snapshot(self.api), before_api)


if __name__ == '__main__':
    unittest.main(verbosity=2)
