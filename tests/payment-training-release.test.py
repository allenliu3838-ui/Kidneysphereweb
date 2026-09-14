#!/usr/bin/env python3
"""Offline payment/pricing release gates, exact baseline groups and safe recovery."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import urllib.error
import zipfile

REPOSITORY = Path(__file__).resolve().parent.parent


def import_file(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


pricing_tests = import_file('pricing_release_helpers', REPOSITORY / 'tests/training-pricing-release.test.py')
quiet, snapshot = pricing_tests.quiet, pricing_tests.snapshot


class PaymentTrainingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.builder = import_file('payment_training_builder', REPOSITORY / 'deploy/build-payment-training-release.py')
        cls.before = {commit: {name: cls.builder.git_bytes(commit, name, optional=name in cls.builder.NEW_FILES)
            for name in cls.builder.FILES} for commit in cls.builder.BASELINES}
        cls.payload = dict(cls.before[cls.builder.BASELINES[1]])
        changed = ('checkout.js', 'checkout.html', 'my-learning.js', 'my-learning.html')
        for name in cls.builder.FILES:
            if name not in changed and not name.startswith('admin-commerce') and cls.payload[name] is not None:
                continue
            data = cls.payload[name] or b'export {};'
            if name.endswith('.js'):
                data = re.sub(rb'(admin-commerce(?:-[a-z-]+)?\.js\?v=)[^\"\']+',
                    lambda m: m[1] + cls.builder.VERSION.encode(), data)
                data += b'\n/* Payment release fixture. */\n'
            cls.payload[name] = data
        for html, module in (('checkout.html', 'checkout.js'),
                             ('admin-commerce.html', 'admin-commerce.js'), ('my-learning.html', 'my-learning.js')):
            cls.payload[html] = ('<script type="module" src="' + module + '?v=' + cls.builder.VERSION + '"></script>').encode()
        for parent, child in (('admin-commerce-orders.js', 'admin-commerce-review.js'),
                              ('my-learning.js', 'my-learning-display.js')):
            cls.payload[parent] += ("\nimport './" + child + '?v=' + cls.builder.VERSION + "';\n").encode()
        cls.payload['admin-commerce-review.js'] += b"\nimport './training-commerce.js?v=20260914_pricing1';\n"
        cls.resources, cls.groups = cls.builder.manifest_resources(cls.payload)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='payment-training-release-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root, self.backups = self.base / 'www', self.base / 'backups'
        self.root.mkdir()
        self.vhost = self.base / 'nginx.conf'
        self.vhost.write_text('server { server_name kidneysphere.com; root ' + str(self.root) + '; }')
        self.other = self.base / 'other.html'
        self.other.write_bytes(b'Another production site')
        self.runner = import_file('payment_training_runner', REPOSITORY / 'deploy/portal-release.py')
        patcher = mock.patch.multiple(self.runner, ROOT=self.root, BACKUP_ROOT=self.backups,
            VHOST=self.vhost, GUARD_PATHS=(self.vhost, self.other, self.root / 'my-learning.html'))
        patcher.start(); self.addCleanup(patcher.stop)
        for name in self.builder.REQUIRED_FILES:
            self.write(name, self.builder.git_bytes(self.builder.BASELINES[0], name))
        for name in self.runner.TRAINING_PRICING_GUARDS:
            if not (self.root / name).exists():
                self.write(name, b'Protected fixture: ' + name.encode())
        self.install_baseline(self.builder.BASELINES[0])
        config = '# configuration file ' + str(self.vhost) + ':\n' + self.vhost.read_text()

        def nginx_only(command, *args, **kwargs):
            self.assertEqual(command, ['nginx', '-T'], 'No service, database, or unexpected subprocess permitted')
            return subprocess.CompletedProcess(command, 0, stdout=config, stderr='')
        patcher = mock.patch.object(self.runner.subprocess, 'run', side_effect=nginx_only)
        patcher.start(); self.addCleanup(patcher.stop)
        self.catalog = pricing_tests.catalog_fixture(self.runner.TRAINING_PREFIXES)
        self.version = dict(self.runner.PAYMENT_TRAINING_VERSION)
        self.requests = []

        def catalog_get(config, table, query):
            self.requests.append((table, query))
            return copy.deepcopy(self.catalog[table])
        patcher = mock.patch.object(self.runner, 'public_catalog_get', side_effect=catalog_get)
        patcher.start(); self.addCleanup(patcher.stop)
        self.version_patcher = mock.patch.object(self.runner, 'public_payment_release_get',
                                                side_effect=lambda config: copy.deepcopy(self.version))
        self.version_patcher.start(); self.addCleanup(self.version_patcher.stop)
        self.package = {'manifest': {'schema': 1, 'release_profile': 'payment-training-v1',
            'domain': self.runner.DOMAIN, 'root': str(self.root), 'commit': 'a' * 40,
            'required_files': list(self.builder.REQUIRED_FILES), 'files': copy.deepcopy(self.resources),
            'baseline_groups': copy.deepcopy(self.groups)}, 'payload': dict(self.payload)}

    def write(self, name, data):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.chmod(0o644)

    def install_baseline(self, commit):
        for name, data in self.before[commit].items():
            if data is None:
                (self.root / name).unlink(missing_ok=True)
            else:
                self.write(name, data)

    def assert_rejected_unchanged(self, action, *args):
        before = snapshot(self.base)
        with self.assertRaises(self.runner.ReleaseError):
            quiet(action, *args)
        self.assertEqual(snapshot(self.base), before)

    def test_both_complete_baselines_pass_readonly_and_public_queries_exclude_users(self):
        for commit in self.builder.BASELINES:
            self.install_baseline(commit)
            before = snapshot(self.base)
            checked, unused = quiet(self.runner.preflight, self.package)
            self.assertEqual(checked['matched_baseline'], commit)
            self.assertEqual(checked['catalog']['releases'], self.version)
            self.assertEqual(snapshot(self.base), before)
            self.assertFalse(self.backups.exists())
        self.assertEqual({table for table, unused in self.requests},
                         {'products', 'learning_projects', 'product_price_versions'})

    def test_mixed_known_baselines_and_partial_target_are_refused_before_any_write(self):
        self.write('academy.js', self.before[self.builder.BASELINES[1]]['academy.js'])
        self.assert_rejected_unchanged(self.runner.apply_release, self.package)
        self.install_baseline(self.builder.BASELINES[1])
        self.write('checkout.js', self.payload['checkout.js'])
        self.assert_rejected_unchanged(self.runner.apply_release, self.package)
        self.assertFalse(self.backups.exists())

    def test_unknown_file_and_symlink_are_never_overwritten(self):
        self.write('checkout.js', b'Independent production fix')
        self.assert_rejected_unchanged(self.runner.apply_release, self.package)
        (self.root / 'checkout.js').unlink()
        (self.root / 'checkout.js').symlink_to(self.other)
        self.assert_rejected_unchanged(self.runner.apply_release, self.package)

    def test_missing_sql_version_wrong_price_and_unavailable_version_block_apply(self):
        original = dict(self.version)
        for key in self.version:
            self.version = {**original, key: 'wrong-or-rolled-back'}
            self.assert_rejected_unchanged(self.runner.apply_release, self.package)
        self.version = original
        self.catalog['products'][0]['price_cny'] = 1280
        self.assert_rejected_unchanged(self.runner.apply_release, self.package)
        with mock.patch.object(self.runner, 'public_payment_release_get',
                               side_effect=self.runner.ReleaseError('PAYMENT_VERSION_UNAVAILABLE')):
            before = snapshot(self.base)
            checked, unused = quiet(self.runner.preflight, self.package, require_catalog=False)
            self.assertEqual(checked['catalog']['status'], 'CATALOG_NOT_READY')
            self.assertEqual(snapshot(self.base), before)
            self.assert_rejected_unchanged(self.runner.apply_release, self.package)

    def test_check_exits_nonzero_when_sql_is_not_ready_without_writing(self):
        self.version['payment_state'] = 'rolled_back'
        before = snapshot(self.base)
        with mock.patch.object(self.runner, 'load_package', return_value=self.package):
            status, output = quiet(self.runner.main, ['--check'])
        self.assertEqual(status, 2)
        self.assertIn('apply is blocked', output)
        self.assertNotIn('release ready', output)
        self.assertEqual(snapshot(self.base), before)

    def test_scope_and_correlated_baseline_manifest_cannot_expand(self):
        self.assertEqual(self.builder.FILES, self.runner.PAYMENT_TRAINING_FILES)
        self.assertEqual(len(self.builder.FILES), 29)
        for mutate in (
            lambda p: p['manifest']['files'][0].update(path='migration.sql'),
            lambda p: p['manifest']['required_files'].append('server/.env'),
            lambda p: p['manifest']['baseline_groups'][0].update(commit='b' * 40),
            lambda p: p['manifest']['baseline_groups'][0]['files'].update({'checkout.js': None}),
            lambda p: p['manifest']['files'][0]['allowed_before'].append('0' * 64),
        ):
            package = copy.deepcopy(self.package)
            mutate(package)
            self.assert_rejected_unchanged(self.runner.preflight, package)

    def test_apply_private_backup_no_change_and_offline_rollback_for_both_baselines(self):
        for commit in self.builder.BASELINES:
            self.install_baseline(commit)
            before = snapshot(self.root)
            backup, output = quiet(self.runner.apply_release, self.package)
            self.assertIn('This package did not change the database', output)
            self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
            self.assertEqual((backup / 'backup.json').stat().st_mode & 0o777, 0o600)
            self.assertEqual(self.other.read_bytes(), b'Another production site')
            current = snapshot(self.base)
            result, output = quiet(self.runner.apply_release, self.package)
            self.assertIsNone(result)
            self.assertIn('NO_CHANGE', output)
            self.assertEqual(snapshot(self.base), current)
            with mock.patch.object(self.runner, 'public_payment_release_get', side_effect=AssertionError('Offline rollback')):
                quiet(self.runner.rollback_release, backup, self.package)
            self.assertEqual(snapshot(self.root), before)

    def test_partial_failure_restores_original_and_rollback_refuses_later_edit(self):
        before = snapshot(self.root)
        replace, injected = os.replace, False

        def failure(source, target, *args, **kwargs):
            nonlocal injected
            if Path(target) == self.root / 'checkout.html' and not injected:
                injected = True
                raise OSError('Injected failure')
            return replace(source, target, *args, **kwargs)
        with mock.patch.object(self.runner.os, 'replace', side_effect=failure):
            with self.assertRaisesRegex(self.runner.ReleaseError, 'ROLLED_BACK'):
                quiet(self.runner.apply_release, self.package)
        self.assertEqual(snapshot(self.root), before)
        backup, unused = quiet(self.runner.apply_release, self.package)
        self.write('admin-commerce-orders.js', b'Later production fix')
        self.assert_rejected_unchanged(self.runner.rollback_release, backup, self.package)

    def test_fixed_metadata_rpc_is_bounded_get_without_user_arguments_or_redirects(self):
        self.version_patcher.stop()
        config = self.runner.public_catalog_config()
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.read.return_value = json.dumps(self.version).encode()
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch.object(self.runner.urllib.request, 'build_opener', return_value=opener):
            self.assertEqual(self.runner.public_payment_release_get(config), self.version)
            request = opener.open.call_args.args[0]
            self.assertEqual(request.get_method(), 'GET')
            self.assertIsNone(request.data)
            self.assertEqual(request.full_url, 'https://' + self.runner.CATALOG_HOST +
                             '/rest/v1/rpc/get_payment_enrollment_release')
            response.read.assert_called_once_with(8193)
            opener.open.side_effect = urllib.error.URLError('PRIVATE_SERVER_DETAILS')
            with self.assertRaises(self.runner.ReleaseError) as caught:
                self.runner.public_payment_release_get(config)
            self.assertNotIn('PRIVATE_SERVER_DETAILS', str(caught.exception))


class PaymentTrainingBuilderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        PaymentTrainingTests.setUpClass()
        cls.builder, cls.payload = PaymentTrainingTests.builder, PaymentTrainingTests.payload
        cls.sources = {
            cls.builder.SQL_FILES[0]: cls.builder.git_bytes(cls.builder.BASELINES[1], cls.builder.SQL_FILES[0]),
            cls.builder.SQL_FILES[1]: b"begin;\ndo $$ begin perform 1; end $$;\ncommit;\n",
            cls.builder.SQL_FILES[2]: cls.builder.git_bytes(cls.builder.BASELINES[1], cls.builder.SQL_FILES[2]),
            cls.builder.SQL_FILES[3]: b"begin transaction isolation level repeatable read read only; select 1; commit;",
            cls.builder.SQL_FILES[4]: cls.builder.git_bytes(cls.builder.BASELINES[1], cls.builder.SQL_FILES[4]),
            cls.builder.SQL_FILES[5]: b"begin; set local lock_timeout = '5s'; select kidneysphere_release_private.restore_payment_enrollment_20260914(); commit;",
        }

    def test_sql_composition_has_one_transaction_and_records_prior_versions_for_rollback(self):
        combined = self.builder.combined_sql(self.sources)
        for suffix, data in combined.items():
            mask = self.builder.sql_mask(data.decode())
            statements = [part.strip().lower() for part in mask.split(';') if part.strip()]
            self.assertEqual(sum(s.startswith('begin') for s in statements), 1, suffix)
            self.assertEqual(sum(s == 'commit' for s in statements), 1, suffix)
            self.assertTrue(statements[-1] == 'commit')
        rollback = combined['.rollback.sql'].decode()
        self.assertIn("if r.pricing_before is distinct from 'applied'", rollback)
        self.assertLess(rollback.index('perform kidneysphere_release_private.restore_payment_'),
                        rollback.index('perform kidneysphere_release_private.restore_training_'))
        self.assertIn('source_sha256', combined['.sql'].decode())
        self.assertIn('COMBINED_PARTIAL_RELEASE_REFUSED', combined['.sql'].decode())

    def test_sql_splitter_rejects_extra_transactions_but_preserves_quoted_code(self):
        good = b"-- intro\nbegin; do $x$ begin perform 'commit;'; end $x$; select 'begin;'; commit;"
        body = self.builder.transaction_body(good)
        self.assertIn("perform 'commit;'", body)
        for source in (b'begin; select 1; commit; begin; select 2; commit;',
                       b'begin; select 1; rollback; commit;', b'select 1;',
                       b'begin; do $$broken; commit;', b'begin; /*broken; commit;'):
            with self.assertRaises(ValueError):
                self.builder.transaction_body(source)

    def test_payload_rejects_unreviewed_video_change_or_stale_new_import(self):
        for name, data in (('videos.html', self.payload['videos.html'] + b'player change'),
                           ('my-learning.js', self.payload['my-learning.js'].replace(b'20260914_payment1', b'old'))):
            payload = dict(self.payload)
            payload[name] = data
            with self.assertRaises(ValueError):
                self.builder.validate_payload(payload)
        with self.assertRaises(ValueError):
            self.builder.immutable_commit('HEAD')

    def test_build_is_reproducible_and_sql_sources_are_pinned_outside_frontend_archive(self):
        commit, original = 'a' * 40, self.builder.git_bytes
        runner = (REPOSITORY / 'deploy/portal-release.py').read_bytes()

        def pinned(commit_arg, name, optional=False):
            if commit_arg == commit:
                if name in self.payload:
                    return self.payload[name]
                if name == 'deploy/portal-release.py':
                    return runner
                if name in self.sources:
                    return self.sources[name]
                if name == self.builder.RELEASE_README:
                    return b'# Pinned release instructions\n'
                return original(self.builder.BASELINES[1], name, optional)
            return original(commit_arg, name, optional)
        with tempfile.TemporaryDirectory() as directory:
            first, second = Path(directory) / 'first.pyz', Path(directory) / 'second.pyz'
            with mock.patch.object(self.builder, 'immutable_commit', return_value=commit), \
                 mock.patch.object(self.builder, 'git_bytes', side_effect=pinned):
                quiet(self.builder.build, commit, first)
                quiet(self.builder.build, commit, second)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            for suffix in ('.sql', '.inspect.sql', '.rollback.sql'):
                self.assertEqual(first.with_suffix(suffix).read_bytes(), second.with_suffix(suffix).read_bytes())
            with zipfile.ZipFile(first) as archive:
                self.assertEqual(len(archive.namelist()), 31)
                self.assertFalse(any(name.endswith('.sql') or '/server/' in name for name in archive.namelist()))
                manifest = json.loads(archive.read('manifest.json'))
                self.assertEqual([g['commit'] for g in manifest['baseline_groups']], list(self.builder.BASELINES))
            checked_runner = import_file('payment_archive_runner', REPOSITORY / 'deploy/portal-release.py')
            self.assertEqual(checked_runner.load_package(first)['payload'], self.payload)
            sources = json.loads(first.with_suffix('.sources.json').read_text())
            self.assertEqual(sources['commit'], commit)
            self.assertEqual({row['path'] for row in sources['sql_sources']}, set(self.builder.SQL_FILES))
            self.assertEqual(first.with_suffix('.README.md').read_bytes(), b'# Pinned release instructions\n')
            self.assertEqual(sources['readme_source']['path'], self.builder.RELEASE_README)


if __name__ == '__main__':
    unittest.main(verbosity=2)
