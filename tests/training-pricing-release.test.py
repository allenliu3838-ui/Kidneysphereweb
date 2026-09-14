#!/usr/bin/env python3
"""Pricing package scope, read-only catalog gate, and exact filesystem rollback."""
import base64
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
import urllib.error
import uuid
import zipfile

REPOSITORY = Path(__file__).resolve().parent.parent


def import_file(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def snapshot(directory):
    return {str(p.relative_to(directory)): (p.read_bytes(), p.stat().st_mode & 0o777)
            for p in directory.rglob('*') if p.is_file()}


def quiet(callback, *args, **kwargs):
    with contextlib.redirect_stdout(io.StringIO()) as output:
        result = callback(*args, **kwargs)
    return result, output.getvalue()


def catalog_fixture(prefixes):
    products, projects = [], []
    for prefix in prefixes:
        for suffix, price in (('-REG-FULL-2026', 1580), ('-BUNDLE-2026', 1200), ('-REG-VIDEO-2026', 780)):
            products.append({'id': str(uuid.uuid4()), 'product_code': prefix + suffix,
                'product_type': 'specialty_bundle' if 'BUNDLE' in suffix else 'project_registration',
                'price_cny': price, 'list_price_cny': None, 'early_bird_deadline': None,
                'is_active': False if 'VIDEO' in suffix or prefix == 'GLOM' else True})
        projects.append({'project_code': 'PROJ-' + prefix + '-2026', 'registration_fee_cny': 1580})
    return {'products': products, 'learning_projects': projects, 'product_price_versions': []}


class TrainingPricingReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.builder = import_file('training_price_builder', REPOSITORY / 'deploy/build-training-pricing-release.py')
        cls.before = {name: cls.builder.git_bytes(cls.builder.BASELINE, name, optional=True)
                      for name in cls.builder.FILES}
        cls.dependencies = {name: cls.builder.git_bytes(cls.builder.BASELINE, name)
                            for name in cls.builder.REQUIRED_FILES}
        cls.new = {name: (cls.before[name] or b'export {};') + b'\n/* New pricing fixture. */\n'
                   for name in cls.builder.FILES}
        for html, script in cls.builder.ENTRY_MODULES.items():
            cls.new[html] = ('<script type="module" src="' + script + '?v=' +
                            cls.builder.VERSION + '"></script>').encode()
        for name in ('academy.js', 'trainingprograms.js', 'checkout.js', 'learning-center.js'):
            cls.new[name] += ("\nimport './training-commerce.js?v=" + cls.builder.VERSION + "';\n").encode()
        cls.builder.validate_payload(cls.new)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='training-price-release-test-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'www'
        self.root.mkdir()
        self.backups = self.base / 'backups'
        self.vhost = self.base / 'nginx.conf'
        self.vhost.write_text('server { server_name kidneysphere.com www.kidneysphere.com; '
                             'root ' + str(self.root) + '; }\n')
        self.other = self.base / 'other-site.html'
        self.other.write_bytes(b'Unrelated site')
        for name, data in {**self.dependencies, **self.before}.items():
            if data is not None:
                path = self.root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                path.chmod(0o644)
        self.runner = import_file('training_price_runner', REPOSITORY / 'deploy/portal-release.py')
        for name in self.runner.TRAINING_PRICING_GUARDS:
            path = self.root / name
            if not path.exists():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'Protected fixture: ' + name.encode())
        patcher = mock.patch.multiple(self.runner, ROOT=self.root, BACKUP_ROOT=self.backups,
            VHOST=self.vhost, GUARD_PATHS=(self.vhost, self.other, self.root / 'academy.html',
                                         self.root / 'supabaseClient.js'))
        patcher.start()
        self.addCleanup(patcher.stop)
        configuration = '# configuration file ' + str(self.vhost) + ':\n' + self.vhost.read_text()

        def nginx_only(command, *args, **kwargs):
            if command != ['nginx', '-T']:
                raise AssertionError('Service command or unexpected subprocess: ' + repr(command))
            return subprocess.CompletedProcess(command, 0, stdout=configuration, stderr='')
        patcher = mock.patch.object(self.runner.subprocess, 'run', side_effect=nginx_only)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.catalog = catalog_fixture(self.runner.TRAINING_PREFIXES)
        self.requests = []

        def catalog_get(config, table, query):
            self.requests.append((table, query))
            return copy.deepcopy(self.catalog[table])
        self.catalog_patcher = mock.patch.object(self.runner, 'public_catalog_get', side_effect=catalog_get)
        self.catalog_patcher.start()
        self.addCleanup(self.catalog_patcher.stop)
        self.package = {'manifest': {'schema': 1, 'release_profile': 'training-pricing-v1',
            'domain': self.runner.DOMAIN, 'root': str(self.root), 'commit': self.builder.BASELINE,
            'required_files': list(self.builder.REQUIRED_FILES), 'files': [{
                'path': name, 'sha256': self.runner.digest(self.new[name]), 'size': len(self.new[name]),
                'allowed_before': [self.runner.digest(self.before[name])] if self.before[name] else [],
                'allow_missing': self.before[name] is None,
            } for name in self.builder.FILES]}, 'payload': dict(self.new)}

    def assert_reject_unchanged(self, callback, *args, **kwargs):
        before = snapshot(self.base)
        with self.assertRaises(self.runner.ReleaseError):
            quiet(callback, *args, **kwargs)
        self.assertEqual(snapshot(self.base), before)

    def test_fixed_payload_and_dependencies_cannot_expand_to_backend_or_sql(self):
        self.assertEqual(self.builder.FILES, self.runner.TRAINING_PRICING_FILES)
        self.assertEqual(len(self.builder.FILES), 13)
        self.assertEqual(self.builder.REQUIRED_FILES, self.runner.TRAINING_PRICING_REQUIRED_FILES)
        for bad_path in ('server/index.js', 'migration.sql', '../outside.js'):
            package = copy.deepcopy(self.package)
            package['manifest']['files'][0]['path'] = bad_path
            self.assert_reject_unchanged(self.runner.preflight, package)
        for name in ('academy.html', 'learning-center.js', 'checkout.js'):
            package = copy.deepcopy(self.package)
            next(e for e in package['manifest']['files'] if e['path'] == name)['allow_missing'] = True
            self.assert_reject_unchanged(self.runner.preflight, package)
        package = copy.deepcopy(self.package)
        package['manifest']['required_files'].append('server/.env')
        self.assert_reject_unchanged(self.runner.preflight, package)

    def test_catalog_queries_only_public_pricing_rows_and_keeps_inactive_full_product(self):
        before = snapshot(self.base)
        checked, _ = quiet(self.runner.preflight, self.package)
        self.assertEqual(checked['catalog']['status'], 'CATALOG_OK')
        self.assertEqual(snapshot(self.base), before)
        self.assertFalse(self.backups.exists())
        self.assertEqual([name for name, _ in self.requests],
                         ['products', 'learning_projects', 'product_price_versions'])
        self.assertEqual(self.requests[-1][1]['status'], 'eq.active')
        self.assertEqual(self.requests[-1][1]['limit'], '1')
        self.assertNotIn('is_active', self.requests[0][1])
        self.assertNotIn('orders', repr(self.requests))

    def test_wrong_price_early_price_replay_on_sale_and_missing_rows_block_all_writes(self):
        original = copy.deepcopy(self.catalog)
        variants = []
        changed = copy.deepcopy(original); changed['products'][0]['price_cny'] = 1280; variants.append(changed)
        changed = copy.deepcopy(original); changed['products'][1]['price_cny'] = 980; variants.append(changed)
        changed = copy.deepcopy(original); changed['products'][0]['list_price_cny'] = 1580; variants.append(changed)
        changed = copy.deepcopy(original); changed['products'][0]['early_bird_deadline'] = '2026-05-30'; variants.append(changed)
        changed = copy.deepcopy(original); changed['products'][2]['is_active'] = True; variants.append(changed)
        changed = copy.deepcopy(original); changed['products'].pop(); variants.append(changed)
        changed = copy.deepcopy(original); changed['products'][0] = changed['products'][1]; variants.append(changed)
        changed = copy.deepcopy(original); del changed['products'][0]['list_price_cny']; variants.append(changed)
        changed = copy.deepcopy(original); changed['learning_projects'][0]['registration_fee_cny'] = 1280; variants.append(changed)
        changed = copy.deepcopy(original); changed['product_price_versions'] = [{'status': 'active'}]; variants.append(changed)
        for catalog in variants:
            with self.subTest(catalog=catalog):
                self.catalog = catalog
                self.assert_reject_unchanged(self.runner.apply_release, self.package)
                self.assertFalse(self.backups.exists())

    def test_readonly_inspection_reports_sql_not_ready_without_applying(self):
        self.catalog['products'][0]['price_cny'] = 1280
        before = snapshot(self.base)
        result, _ = quiet(self.runner.preflight, self.package, require_catalog=False)
        self.assertEqual(result['catalog']['status'], 'CATALOG_NOT_READY')
        self.assertEqual(snapshot(self.base), before)
        self.assertFalse(self.backups.exists())
        self.assert_reject_unchanged(self.runner.apply_release, self.package)

    def test_network_failure_blocks_apply_and_inspection_never_says_ready(self):
        with mock.patch.object(self.runner, 'public_catalog_get',
                               side_effect=self.runner.ReleaseError('PUBLIC_CATALOG_UNAVAILABLE')):
            result, _ = quiet(self.runner.preflight, self.package, require_catalog=False)
            self.assertEqual(result['catalog']['status'], 'CATALOG_NOT_READY')
            self.assert_reject_unchanged(self.runner.apply_release, self.package)

    def test_apply_promotes_dependencies_first_and_rollback_restores_files_without_sql(self):
        original = snapshot(self.root)
        order = []
        replace = os.replace
        targets = {self.root / name for name in self.builder.FILES}

        def capture(source, target, *args, **kwargs):
            if Path(target) in targets:
                order.append(str(Path(target).relative_to(self.root)))
            return replace(source, target, *args, **kwargs)
        with mock.patch.object(self.runner.os, 'replace', side_effect=capture):
            backup, output = quiet(self.runner.apply_release, self.package)
        self.assertEqual(order, list(self.builder.FILES))
        self.assertIn('This package did not change the database', output)
        self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.other.read_bytes(), b'Unrelated site')
        for name in self.builder.FILES:
            self.assertEqual((self.root / name).read_bytes(), self.new[name])
        before = snapshot(self.base)
        result, output = quiet(self.runner.apply_release, self.package)
        self.assertIsNone(result)
        self.assertIn('NO_CHANGE', output)
        self.assertEqual(snapshot(self.base), before)
        with mock.patch.object(self.runner, 'public_catalog_get', side_effect=AssertionError('Rollback must be offline')):
            quiet(self.runner.rollback_release, backup, self.package)
        self.assertEqual(snapshot(self.root), original)

    def test_unknown_baseline_and_symlink_never_overwritten(self):
        target = self.root / 'checkout.js'
        target.write_bytes(b'Independent production change')
        self.assert_reject_unchanged(self.runner.apply_release, self.package)
        target.unlink()
        target.symlink_to(self.other)
        self.assert_reject_unchanged(self.runner.apply_release, self.package)

    def test_partial_failure_restores_frontend_and_guard_drift_is_not_overwritten(self):
        original = snapshot(self.root)
        replace = os.replace
        injected = False

        def failure(source, target, *args, **kwargs):
            nonlocal injected
            if Path(target) == self.root / 'checkout.html' and not injected:
                injected = True
                raise OSError('Injected promotion failure')
            return replace(source, target, *args, **kwargs)
        with mock.patch.object(self.runner.os, 'replace', side_effect=failure):
            with self.assertRaisesRegex(self.runner.ReleaseError, 'ROLLED_BACK'):
                quiet(self.runner.apply_release, self.package)
        self.assertEqual(snapshot(self.root), original)
        guard = self.root / 'vod-upload.js'
        injected = False

        def drift(source, target, *args, **kwargs):
            nonlocal injected
            result = replace(source, target, *args, **kwargs)
            if Path(target) == self.root / 'training-da.html' and not injected:
                injected = True
                guard.write_bytes(b'Concurrent upload fix')
            return result
        with mock.patch.object(self.runner.os, 'replace', side_effect=drift):
            with self.assertRaisesRegex(self.runner.ReleaseError, 'ROLLED_BACK'):
                quiet(self.runner.apply_release, self.package)
        original['vod-upload.js'] = (b'Concurrent upload fix', 0o644)
        self.assertEqual(snapshot(self.root), original)

    def test_rollback_refuses_newer_price_edit_and_corrupted_backup(self):
        backup, _ = quiet(self.runner.apply_release, self.package)
        target = self.root / 'checkout.js'
        target.write_bytes(b'Later valid production fix')
        self.assert_reject_unchanged(self.runner.rollback_release, backup, self.package)
        target.write_bytes(self.new['checkout.js'])
        (backup / 'old/academy.js').write_bytes(b'Corrupted backup')
        self.assert_reject_unchanged(self.runner.rollback_release, backup, self.package)

    def test_public_config_rejects_admin_key_wrong_host_and_ambiguous_constants(self):
        config_path = self.root / 'assets/config.js'
        source = config_path.read_text()
        host, key = self.runner.public_catalog_config()
        self.assertEqual(host, 'https://' + self.runner.CATALOG_HOST)
        for text in (source.replace(self.runner.CATALOG_HOST, 'attacker.example'),
                     source + '\nexport const SUPABASE_URL = "https://other.example";'):
            config_path.write_text(text)
            with self.assertRaises(self.runner.ReleaseError):
                self.runner.public_catalog_config()
        claims = base64.urlsafe_b64encode(json.dumps({'role': 'service_role',
            'ref': self.runner.CATALOG_HOST.split('.')[0]}).encode()).decode().rstrip('=')
        config_path.write_text(source.replace(key, 'e30.' + claims + '.c2ln'))
        with self.assertRaisesRegex(self.runner.ReleaseError, 'PUBLIC_ANON_KEY_REQUIRED'):
            self.runner.public_catalog_config()

    def test_catalog_http_is_get_only_uses_bounded_json_and_sanitizes_failure(self):
        self.catalog_patcher.stop()
        config = self.runner.public_catalog_config()
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.read.return_value = b'[]'
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch.object(self.runner.urllib.request, 'build_opener', return_value=opener):
            rows = self.runner.public_catalog_get(config, 'products', {'select': 'product_code'})
            self.assertEqual(rows, [])
            request = opener.open.call_args.args[0]
            self.assertEqual(request.get_method(), 'GET')
            self.assertIsNone(request.data)
            self.assertEqual(request.get_header('Apikey'), config[1])
            response.read.assert_called_once_with(self.runner.CATALOG_RESPONSE_LIMIT + 1)
            opener.open.side_effect = urllib.error.URLError('SENSITIVE_ERROR_DETAIL')
            with self.assertRaises(self.runner.ReleaseError) as error:
                self.runner.public_catalog_get(config, 'products', {})
            self.assertNotIn('SENSITIVE_ERROR_DETAIL', str(error.exception))
            with self.assertRaisesRegex(self.runner.ReleaseError, 'TABLE_NOT_ALLOWED'):
                self.runner.public_catalog_get(config, 'orders', {})
        with self.assertRaisesRegex(self.runner.ReleaseError, 'REDIRECT_REFUSED'):
            self.runner.NoCatalogRedirect().redirect_request(None, None, 302, '', {}, 'https://other.example')


class TrainingPricingBuilderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        TrainingPricingReleaseTests.setUpClass()
        cls.builder = TrainingPricingReleaseTests.builder
        cls.payload = TrainingPricingReleaseTests.new

    def test_builder_rejects_mutable_source_and_missing_versioned_dependency(self):
        with self.assertRaises(ValueError):
            self.builder.immutable_commit('HEAD')
        for name in ('academy.html', 'checkout.js', 'learning-center.js'):
            payload = dict(self.payload)
            payload[name] = payload[name].replace(b'20260914_pricing1', b'old-version')
            with self.assertRaises(ValueError):
                self.builder.validate_payload(payload)
        payload = dict(self.payload)
        payload['learning-center.js'] = payload['learning-center.js'].replace(b'20260914_batch1', b'old-upload')
        with self.assertRaisesRegex(ValueError, 'Batch upload dependency changed'):
            self.builder.validate_payload(payload)

    def test_zip_is_reproducible_contains_only_frontend_and_loads_checked_runner(self):
        runner = (REPOSITORY / 'deploy/portal-release.py').read_bytes()
        test_commit = 'a' * 40
        original = self.builder.git_bytes

        def git_bytes(commit, name, optional=False):
            if commit == test_commit:
                if name in self.payload:
                    return self.payload[name]
                if name == 'deploy/portal-release.py':
                    return runner
                return original(self.builder.BASELINE, name, optional)
            return original(commit, name, optional)
        with tempfile.TemporaryDirectory(prefix='training-pricing-package-') as directory:
            first, second = Path(directory) / 'one.pyz', Path(directory) / 'two.pyz'
            with mock.patch.object(self.builder, 'immutable_commit', return_value=test_commit), \
                    mock.patch.object(self.builder, 'git_bytes', side_effect=git_bytes):
                quiet(self.builder.build, test_commit, first)
                quiet(self.builder.build, test_commit, second)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with zipfile.ZipFile(first) as archive:
                self.assertEqual(len(archive.namelist()), 15)
                self.assertFalse(any(name.endswith('.sql') or '/server/' in name for name in archive.namelist()))
                manifest = json.loads(archive.read('manifest.json'))
                self.assertEqual(manifest['release_profile'], 'training-pricing-v1')
                self.assertEqual([e['path'] for e in manifest['files'] if e['allow_missing']],
                                 ['training-commerce.js'])
            checked_runner = import_file('training_pricing_package_runner', REPOSITORY / 'deploy/portal-release.py')
            package = checked_runner.load_package(first)
            self.assertEqual(package['payload'], self.payload)


if __name__ == '__main__':
    unittest.main(verbosity=2)
