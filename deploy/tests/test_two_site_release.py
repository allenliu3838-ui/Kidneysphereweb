"""Deployment transaction tests use temporary roots; never contact production."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import signal
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location('release', Path(__file__).parents[1] / 'two-site-release.py')
r = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(r)
REAL_GIT_CHECK = r.git_check


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.roots = {site: self.base / site for site in ('doctor', 'portal')}
        for root in self.roots.values():
            root.mkdir()
        self.patches = [patch.object(r, 'ROOTS', self.roots),
                        patch.object(r, 'BACKUPS', self.base / 'backups'),
                        patch.object(r, 'REPO', self.roots['doctor']),
                        patch.object(r, 'git_check'), patch.object(r, 'probe')]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)
        self.entries = []
        self.payload = {}
        for site, names in [('portal', sorted(r.PORTAL_FILES)), ('doctor', [
                'index.html', 'build.json', 'qbank.html',
                '_expo/static/js/web/AppEntry-' + 'b' * 32 + '.js'])]:
            for name in names:
                new = ('new:' + site + '/' + name).encode()
                old = ('old:' + site + '/' + name).encode()
                if name == 'build.json':
                    old = json.dumps({'build_id': r.OLD_DOCTOR[:8]}).encode()
                    new = json.dumps({'build_id': r.NEW_DOCTOR[:8]}).encode()
                path = self.roots[site] / name
                if name != 'qbank-data.js' and not name.startswith('_expo/'):
                    path.write_bytes(old)
                e = {'site': site, 'path': name, 'sha256': r.sha(new)}
                if site == 'portal':
                    e['allowed_before'] = [r.sha(old) if path.exists() else None]
                self.entries.append(e)
                self.payload[site + '/' + name] = new
        old_asset = self.roots['doctor'] / '_expo/static/js/web/old.js'
        old_asset.parent.mkdir(parents=True)
        old_asset.write_bytes(b'old cached bundle')
        self.old_asset = old_asset
        self.manifest = {
            'schema': 1, 'release_id': 'two-site-test',
            'doctor': {'expected_git_head': r.OLD_DOCTOR, 'target_commit': r.NEW_DOCTOR,
                       'expected_build_id': r.OLD_DOCTOR[:8], 'guards': [
                           {'path': 'index.html', 'sha256': r.state(self.roots['doctor'] / 'index.html')[0]['sha256']}]},
            'portal': {'target_commit': 'c' * 40, 'guards': []},
            'entries': self.entries,
        }
        self.before = {key: r.state(self.roots[key.split('/')[0]] / key.split('/', 1)[1])[0]
                       for key in self.payload}

    def assert_old_entries(self):
        for key, value in self.before.items():
            if value['exists']:
                site, name = key.split('/', 1)
                self.assertEqual(r.state(self.roots[site] / name)[0], value)

    def zipfile(self, extra=None):
        path = self.base / 'release.zip'
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr('manifest.json', json.dumps(self.manifest))
            for key, data in self.payload.items():
                z.writestr('payload/' + key, data)
            if extra:
                z.writestr(extra, 'unlisted')
        return path

    def test_package_validates_hashes_and_rejects_undeclared_paths(self):
        manifest, payload = r.load_package(self.zipfile())
        self.assertEqual(payload, self.payload)
        self.assertEqual(manifest, self.manifest)
        with self.assertRaisesRegex(r.ReleaseError, 'UNDECLARED_ARCHIVE_FILES'):
            r.load_package(self.zipfile('payload/portal/../escape.js'))

    def test_check_is_read_only(self):
        r.check(self.manifest, self.payload)
        self.assertFalse(r.BACKUPS.exists())
        self.assert_old_entries()

    def test_success_backup_restore_preserves_old_and_new_bundles(self):
        backup = r.apply(self.manifest, self.payload)
        for key, data in self.payload.items():
            site, name = key.split('/', 1)
            self.assertEqual((self.roots[site] / name).read_bytes(), data)
        record = json.loads((backup / 'record.json').read_text())
        r.restore(backup, record)
        self.assert_old_entries()
        self.assertEqual(self.old_asset.read_bytes(), b'old cached bundle')
        self.assertTrue((self.roots['doctor'] / ('_expo/static/js/web/AppEntry-' + 'b' * 32 + '.js')).exists())

    def test_health_failure_restores_every_existing_file(self):
        with patch.object(r, 'health', side_effect=r.ReleaseError('simulated public mismatch')):
            with self.assertRaisesRegex(r.ReleaseError, 'simulated public mismatch'):
                r.apply(self.manifest, self.payload)
        self.assert_old_entries()
        records = list(r.BACKUPS.glob('*/record.json'))
        self.assertEqual(json.loads(records[0].read_text())['status'], 'rolled_back')

    def test_interrupted_write_rolls_back_partial_publication(self):
        original = r.atomic
        fired = False
        def fail_once(path, data, metadata=None):
            nonlocal fired
            if path == self.roots['portal'] / 'app.js' and not fired:
                fired = True
                raise OSError('simulated disk error')
            return original(path, data, metadata)
        with patch.object(r, 'atomic', side_effect=fail_once):
            with self.assertRaisesRegex(OSError, 'simulated disk error'):
                r.apply(self.manifest, self.payload)
        self.assert_old_entries()

    def test_unknown_manual_change_blocks_before_mutation(self):
        (self.roots['portal'] / 'portal-home.css').write_bytes(b'manual production improvement')
        with self.assertRaisesRegex(r.ReleaseError, 'UNKNOWN_BASELINE'):
            r.apply(self.manifest, self.payload)
        self.assertEqual((self.roots['portal'] / 'portal-home.css').read_bytes(), b'manual production improvement')
        self.assertFalse(list(r.BACKUPS.glob('*/record.json')))

    def test_changed_build_blocks(self):
        (self.roots['doctor'] / 'build.json').write_text('{"build_id":"different"}')
        with self.assertRaisesRegex(r.ReleaseError, 'LIVE_BUILD_ID_MISMATCH'):
            r.check(self.manifest, self.payload)

    def test_symlink_payload_target_blocks(self):
        target = self.roots['portal'] / 'app.js'
        target.unlink()
        elsewhere = self.base / 'elsewhere.js'
        elsewhere.write_bytes(b'not a deployment file')
        target.symlink_to(elsewhere)
        with self.assertRaisesRegex(r.ReleaseError, 'SYMLINK_REFUSED'):
            r.check(self.manifest, self.payload)
        self.assertEqual(elsewhere.read_bytes(), b'not a deployment file')

    def test_rollback_refuses_later_edit_before_restoring_any_file(self):
        backup = r.apply(self.manifest, self.payload)
        (self.roots['portal'] / 'app.js').write_bytes(b'newer operator edit')
        record = json.loads((backup / 'record.json').read_text())
        with self.assertRaisesRegex(r.ReleaseError, 'ROLLBACK_REFUSED_LATER_EDIT'):
            r.restore(backup, record)
        self.assertEqual((self.roots['doctor'] / 'index.html').read_bytes(), self.payload['doctor/index.html'])

    def test_concurrent_change_between_backup_and_write_is_preserved(self):
        original = r.verify_backup
        def edit_after_backup(backup, record):
            original(backup, record)
            (self.roots['portal'] / 'app.js').write_bytes(b'concurrent edit')
        with patch.object(r, 'verify_backup', side_effect=edit_after_backup):
            with self.assertRaisesRegex(r.ReleaseError, 'FILE_CHANGED'):
                r.apply(self.manifest, self.payload)
        self.assertEqual((self.roots['portal'] / 'app.js').read_bytes(), b'concurrent edit')
        self.assertEqual(r.state(self.roots['doctor'] / 'index.html')[0], self.before['doctor/index.html'])

    def test_sigterm_during_health_triggers_complete_rollback(self):
        previous = signal.getsignal(signal.SIGTERM)
        with patch.object(r, 'health', side_effect=lambda manifest: os.kill(os.getpid(), signal.SIGTERM)):
            with self.assertRaisesRegex(r.ReleaseError, 'INTERRUPTED_SIGNAL'):
                r.apply(self.manifest, self.payload)
        self.assert_old_entries()
        self.assertEqual(signal.getsignal(signal.SIGTERM), previous)

    def test_git_head_and_tracked_dist_are_explicit_guards(self):
        def result(output):
            return subprocess.CompletedProcess([], 0, stdout=output, stderr='')
        with patch.object(r.subprocess, 'run', side_effect=[result('wrong'), result(''), result('')]):
            with self.assertRaisesRegex(r.ReleaseError, 'SOURCE_HEAD_CHANGED'):
                REAL_GIT_CHECK()
        with patch.object(r.subprocess, 'run', side_effect=[result(r.OLD_DOCTOR), result(''), result('dist/index.html')]):
            with self.assertRaisesRegex(r.ReleaseError, 'DIST_MUST_NOT_BE_GIT_TRACKED'):
                REAL_GIT_CHECK()

    def test_rollback_rechecks_each_file_before_restore(self):
        backup = r.apply(self.manifest, self.payload)
        record = json.loads((backup / 'record.json').read_text())
        target = self.roots['portal'] / 'index.html'
        original = r.state
        reads = 0
        def edit_after_initial_check(path):
            nonlocal reads
            if path == target:
                reads += 1
                if reads == 2:
                    target.write_bytes(b'late operator edit')
            return original(path)
        with patch.object(r, 'state', side_effect=edit_after_initial_check):
            with self.assertRaisesRegex(r.ReleaseError, 'ROLLBACK_REFUSED_LATER_EDIT'):
                r.restore(backup, record)
        self.assertEqual(target.read_bytes(), b'late operator edit')


if __name__ == '__main__':
    unittest.main()
