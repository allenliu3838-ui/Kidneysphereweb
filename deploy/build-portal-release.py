#!/usr/bin/env python3
"""Build an offline, pinned eight-file homepage release using only stdlib."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

REPOSITORY = Path(__file__).resolve().parent.parent
COMMIT = 'a0b8bba3b71784533c5696f55569fe5ee073e2aa'
BASELINES = (
    'd22d96fe6b19590195906740bbd264ba1be702ed',
    'e5e7b4434a2696adf7cf970244131b3e2dd75985',
    'ea4d252b3ec28ffe53170107daee6ebf7eb75952',
    'beff3175ea1f3a87f43852044878f73303255c01',
    COMMIT,
)
# Resource promotion order. The new entry document is always last.
FILES = (
    'assets/portal/critical-v1.webp',
    'assets/portal/pathology-v1.webp',
    'assets/portal/transplant-v1.webp',
    'portal-home.css',
    'portal-home.js',
    'home.js',
    'app.js',
    'index.html',
)
REQUIRED_FILES = (
    'supabaseClient.js', 'assets/config.js', 'assets/videos.js',
    'assets/lib/supabase.min.js', 'styles.css', 'assets/logo.png',
    'login.html', 'register.html', 'watch.html', 'videos.html',
    'my-learning.html', 'academy.html', 'training-patho.html',
    'training-icu.html', 'training-tx.html', 'training-glom.html',
    'training-da.html', 'experts-cn.html', 'experts-intl.html',
    'partners.html', 'about.html', 'privacy.html', 'terms.html',
    'disclaimer.html',
)


def git_bytes(revision, path, optional=False):
    result = subprocess.run(
        ['git', 'show', revision + ':' + path], cwd=str(REPOSITORY),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if result.returncode:
        if optional:
            exists = subprocess.run(
                ['git', 'cat-file', '-e', revision + '^{commit}'],
                cwd=str(REPOSITORY), stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if exists.returncode == 0:
                return None
        raise RuntimeError('Cannot read pinned Git resource: ' + revision + ':' + path)
    return result.stdout


def digest(data):
    return hashlib.sha256(data).hexdigest()


def build(output):
    payload = {path: git_bytes(COMMIT, path) for path in FILES}
    files = []
    for path in FILES:
        previous = [git_bytes(revision, path, optional=True) for revision in BASELINES]
        files.append({
            'path': path, 'sha256': digest(payload[path]), 'size': len(payload[path]),
            'allowed_before': sorted({digest(data) for data in previous if data is not None}),
            'allow_missing': path not in ('index.html', 'app.js', 'home.js') and any(data is None for data in previous),
        })
    for path in REQUIRED_FILES:
        git_bytes(COMMIT, path)
    runner = (REPOSITORY / 'deploy' / 'portal-release.py').read_bytes()
    compile(runner, 'portal-release.py', 'exec')
    manifest = {
        'schema': 1, 'domain': 'kidneysphere.com', 'root': '/var/www/kidneysphere',
        'commit': COMMIT, 'runner_sha256': digest(runner),
        'files': files, 'required_files': list(REQUIRED_FILES),
    }
    entries = [('__main__.py', runner),
               ('manifest.json', (json.dumps(manifest, indent=2, ensure_ascii=False) + '\n').encode('utf-8'))]
    entries.extend(('payload/' + path, payload[path]) for path in FILES)
    output = Path(output).absolute()
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(str(output), 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=(2026, 9, 13, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    with zipfile.ZipFile(str(output)) as archive:
        if archive.testzip() is not None:
            raise RuntimeError('Package CRC verification failed')
        for path, data in payload.items():
            if archive.read('payload/' + path) != data:
                raise RuntimeError('Package payload mismatch: ' + path)
    print(json.dumps({'file': str(output), 'sha256': digest(output.read_bytes()),
                      'bytes': output.stat().st_size, 'commit': COMMIT,
                      'files': list(FILES)}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    build(parser.parse_args().output)
