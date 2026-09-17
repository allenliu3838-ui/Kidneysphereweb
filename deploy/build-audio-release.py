#!/usr/bin/env python3
"""Build the pinned eight-resource audio upgrade, with read-only inspect default."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile

REPOSITORY = Path(__file__).resolve().parent.parent
BASELINES = ('7ede1d73629da4aceebe8e75bb9fa5c3a3d0a858',
             'a75e175d80f616c8c14e1723b346c1fb1710d561')
FILES = ('netlify/functions/video-upload-auth.js', 'netlify/functions/video-play-auth.js',
         'media-upload.js', 'media-player.js', 'media-player.css',
         'learning-center.js', 'watch.html', 'learning.html')
NEW_FILES = frozenset(('media-upload.js', 'media-player.js', 'media-player.css'))
PRESERVED = ('server/index.js', 'server/package.json', 'netlify/functions/video-access.js',
             'netlify/functions/dev-grant-access.js', 'supabaseClient.js', 'assets/config.js',
             'assets/videos.js', 'app.js', 'home.js', 'index.html', 'login.html', 'register.html')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def immutable_commit(value):
    if re.fullmatch(r'[0-9a-f]{40}', value) is None:
        raise ValueError('--commit must be a full immutable Git commit SHA')
    result = subprocess.run(['git', 'rev-parse', '--verify', value + '^{commit}'], cwd=str(REPOSITORY),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
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


def build(commit, output):
    commit = immutable_commit(commit)
    payload = {name: git_bytes(commit, name) for name in FILES}
    for name in PRESERVED:
        if git_bytes(commit, name) != git_bytes(BASELINES[-1], name):
            raise ValueError('Audio release changes a protected business resource: ' + name)
    resources = []
    for name in FILES:
        previous = [git_bytes(revision, name, optional=True) for revision in BASELINES]
        resources.append({'path': name, 'sha256': digest(payload[name]), 'size': len(payload[name]),
            'allowed_before': sorted({digest(data) for data in previous if data is not None}),
            'allow_missing': name in NEW_FILES and all(data is None for data in previous)})
    runner = git_bytes(commit, 'deploy/audio-release.py')
    core = git_bytes(commit, 'deploy/portal-release.py')
    compile(runner, 'audio-release.py', 'exec')
    compile(core, 'portal-release.py', 'exec')
    manifest = {'schema': 1, 'profile': 'audio-v1', 'domain': 'kidneysphere.com',
        'root': '/var/www/kidneysphere', 'commit': commit, 'files': resources,
        'runner_sha256': digest(runner), 'core_sha256': digest(core),
        'server_entry_hashes': sorted({digest(git_bytes(revision, 'server/index.js')) for revision in BASELINES})}
    entries = [('__main__.py', runner), ('release_core.py', core),
               ('manifest.json', (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))]
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
        'first_step': 'python3 package.pyz --inspect (read-only; never assumes an API directory or manager)'},
        ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    build(args.commit, args.output)
