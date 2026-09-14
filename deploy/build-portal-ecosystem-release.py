#!/usr/bin/env python3
"""Build the pinned ecosystem update with the existing eight-file release runner."""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import zipfile

REPOSITORY = Path(__file__).resolve().parent.parent
BASELINE = 'a0b8bba3b71784533c5696f55569fe5ee073e2aa'
CHANGED_FILES = frozenset(('portal-home.css', 'home.js', 'index.html'))


def existing_builder():
    path = REPOSITORY / 'deploy' / 'build-portal-release.py'
    spec = importlib.util.spec_from_file_location('portal_release_builder', str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def immutable_commit(value):
    if re.fullmatch(r'[0-9a-f]{40}', value) is None:
        raise ValueError('--commit must be a full, immutable 40-character Git commit SHA')
    result = subprocess.run(
        ['git', 'rev-parse', '--verify', value + '^{commit}'], cwd=str(REPOSITORY),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True,
    )
    if result.returncode or result.stdout.strip() != value:
        raise ValueError('The pinned commit does not exist in this repository: ' + value)
    return value


def build(commit, output):
    commit = immutable_commit(commit)
    original = existing_builder()
    payload = {path: original.git_bytes(commit, path) for path in original.FILES}
    previous = {path: original.git_bytes(BASELINE, path) for path in original.FILES}
    changed = [path for path in original.FILES if previous[path] != payload[path]]
    unexpected = set(changed) - CHANGED_FILES
    if unexpected:
        raise ValueError('Ecosystem release changes an unapproved resource: ' + ', '.join(sorted(unexpected)))
    files = [{
        'path': path,
        'sha256': original.digest(payload[path]),
        'size': len(payload[path]),
        'allowed_before': sorted({original.digest(previous[path]), original.digest(payload[path])}),
        'allow_missing': False,
    } for path in original.FILES]
    for path in original.REQUIRED_FILES:
        original.git_bytes(commit, path)
    # Freeze the runner together with the website, rather than packaging working-tree edits.
    runner = original.git_bytes(commit, 'deploy/portal-release.py')
    compile(runner, 'portal-release.py', 'exec')
    manifest = {
        'schema': 1, 'domain': 'kidneysphere.com', 'root': '/var/www/kidneysphere',
        'commit': commit, 'runner_sha256': original.digest(runner),
        'files': files, 'required_files': list(original.REQUIRED_FILES),
    }
    entries = [('__main__.py', runner), ('manifest.json',
        (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))]
    entries.extend(('payload/' + path, payload[path]) for path in original.FILES)
    output = Path(output).absolute()
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(str(output), 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=(2026, 9, 14, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    with zipfile.ZipFile(str(output)) as archive:
        if archive.testzip() is not None or archive.namelist() != [name for name, _ in entries]:
            raise RuntimeError('Package entries or CRC verification failed')
        for name, data in entries:
            if archive.read(name) != data:
                raise RuntimeError('Package content mismatch: ' + name)
    print(json.dumps({
        'file': str(output), 'sha256': original.digest(output.read_bytes()),
        'bytes': output.stat().st_size, 'commit': commit, 'baseline': BASELINE,
        'files': list(original.FILES), 'changed_files': changed,
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--output', required=True)
    arguments = parser.parse_args()
    build(arguments.commit, arguments.output)
