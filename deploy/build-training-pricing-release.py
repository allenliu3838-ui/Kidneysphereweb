#!/usr/bin/env python3
"""Build a pinned 14-file training-price frontend release; SQL is applied separately."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile

REPOSITORY = Path(__file__).resolve().parent.parent
BASELINE = '4a3e70af6fecf9ec59daee4e731b464154ece573'
VERSION = '20260914_pricing1'
FILES = (
    'training-commerce.js', 'academy.js', 'trainingprograms.js', 'checkout.js',
    'learning-center.js', 'academy.html', 'checkout.html', 'learning.html',
    'training-icu.html', 'training-tx.html', 'training-patho.html',
    'training-glom.html', 'training-da.html', 'videos.html',
)
REQUIRED_FILES = ('supabaseClient.js', 'assets/config.js',
    'assets/lib/supabase.min.js', 'app.js', 'styles.css', 'vod-upload.js',
    'media-batch.js', 'media-batch-save.js', 'media-batch-ui.js', 'media-batch.css')
PRESERVED = REQUIRED_FILES + (
    'server/index.js', 'server/package.json', 'netlify/functions/video-access.js',
    'netlify/functions/dev-grant-access.js', 'netlify/functions/video-upload-auth.js',
    'netlify/functions/video-play-auth.js', 'assets/videos.js', 'home.js',
    'portal-home.js', 'portal-home.css', 'index.html', 'login.html', 'register.html',
    'auth-callback.html', 'watch.html', 'my-learning.html',
    'media-upload.js', 'media-player.js', 'media-player.css',
)
ENTRY_MODULES = {'academy.html': 'academy.js', 'checkout.html': 'checkout.js',
                 'learning.html': 'learning-center.js'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def immutable_commit(value):
    if re.fullmatch(r'[0-9a-f]{40}', value) is None:
        raise ValueError('--commit must be a full immutable Git commit SHA')
    result = subprocess.run(['git', 'rev-parse', '--verify', value + '^{commit}'],
        cwd=str(REPOSITORY), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode or result.stdout.strip() != value:
        raise ValueError('Pinned source commit does not exist')
    return value


def git_bytes(commit, name, optional=False):
    result = subprocess.run(['git', 'show', commit + ':' + name], cwd=str(REPOSITORY),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        if optional:
            immutable_commit(commit)
            return None
        raise ValueError('Pinned source resource unavailable: ' + name)
    return result.stdout


def updated_videos_html(before):
    old = '¥780 起 · 系统化课程 + 直播互动 + 学习群 + 回放'.encode('utf-8')
    new = '¥1,580 · 系统化课程 + 直播互动 + 学习群 + 回放'.encode('utf-8')
    if before.count(old) != 1:
        raise ValueError('Expected one legacy training promotion in videos.html')
    return before.replace(old, new)


def validate_payload(payload):
    if tuple(payload) != FILES:
        raise ValueError('Training price payload must match the fixed fourteen-file allowlist')
    if any(not data.strip() for data in payload.values()):
        raise ValueError('Empty pricing resource')
    if payload['videos.html'] != updated_videos_html(git_bytes(BASELINE, 'videos.html')):
        raise ValueError('videos.html changes beyond the training promotion price')
    for html, script in ENTRY_MODULES.items():
        expected = (script + '?v=' + VERSION).encode('ascii')
        if payload[html].count(expected) != 1:
            raise ValueError('Missing unique updated entry module reference: ' + html)
    expected = ('./training-commerce.js?v=' + VERSION).encode('ascii')
    for script in ('academy.js', 'trainingprograms.js', 'checkout.js', 'learning-center.js'):
        if payload[script].count(expected) != 1:
            raise ValueError('Missing unique updated pricing helper reference: ' + script)
    # Existing batch-upload dependencies keep their proven implementation/version.
    for module in ('vod-upload', 'media-batch', 'media-batch-ui', 'media-batch-save'):
        expected = ("./" + module + '.js?v=20260914_batch1').encode('ascii')
        if payload['learning-center.js'].count(expected) != 1:
            raise ValueError('Batch upload dependency changed: ' + module)


def manifest_resources(payload):
    validate_payload(payload)
    resources = []
    for name in FILES:
        before = git_bytes(BASELINE, name, optional=name == 'training-commerce.js')
        resources.append({'path': name, 'sha256': digest(payload[name]), 'size': len(payload[name]),
            'allowed_before': [digest(before)] if before is not None else [],
            'allow_missing': name == 'training-commerce.js' and before is None})
    return resources


def build(commit, output):
    commit = immutable_commit(commit)
    payload = {name: git_bytes(commit, name) for name in FILES}
    for name in dict.fromkeys(PRESERVED):
        if git_bytes(commit, name) != git_bytes(BASELINE, name):
            raise ValueError('Training price release changes a protected resource: ' + name)
    resources = manifest_resources(payload)
    runner = git_bytes(commit, 'deploy/portal-release.py')
    compile(runner, 'portal-release.py', 'exec')
    manifest = {'schema': 1, 'release_profile': 'training-pricing-v1',
        'domain': 'kidneysphere.com', 'root': '/var/www/kidneysphere',
        'commit': commit, 'files': resources, 'required_files': list(REQUIRED_FILES),
        'runner_sha256': digest(runner)}
    entries = [('__main__.py', runner), ('manifest.json',
        (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))]
    entries.extend(('payload/' + name, payload[name]) for name in FILES)
    output = Path(output).absolute()
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=(2026, 9, 14, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None or archive.namelist() != [name for name, _ in entries]:
            raise RuntimeError('Package entries or CRC verification failed')
        for name, data in entries:
            if archive.read(name) != data:
                raise RuntimeError('Package content mismatch: ' + name)
    print(json.dumps({'file': str(output), 'sha256': digest(output.read_bytes()),
        'bytes': output.stat().st_size, 'commit': commit, 'files': list(FILES),
        'profile': 'training-pricing-v1', 'accepted_baseline': BASELINE,
        'first_step': 'Apply the reviewed SQL migration separately, then run --check (read-only).',
        'scope': 'Frontend files only. Public catalog verification uses anonymous GET requests. No service restart.',
        'rollback_scope': 'File rollback restores frontend files only; SQL rollback is a separate operation.'},
        ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    build(args.commit, args.output)
