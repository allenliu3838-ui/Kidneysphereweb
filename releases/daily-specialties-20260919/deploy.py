#!/usr/bin/env python3
"""Guarded, offline static update. Default is read-only check; no service restart."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import sys
import zipfile
from datetime import datetime, timezone

HERE = Path(__file__).resolve().parent

def resource(name):
    executable = Path(sys.argv[0]).resolve()
    if zipfile.is_zipfile(executable):
        with zipfile.ZipFile(executable) as archive:
            return archive.read(name)
    return (HERE / name).read_bytes()

def digest(data):
    return hashlib.sha256(data).hexdigest()

def current(path):
    if path.is_symlink():
        raise RuntimeError(f'Refusing symlink: {path}')
    return digest(path.read_bytes()) if path.exists() else None

def atomic(path, data, mode=0o644, owner=None):
    fd, temp = tempfile.mkstemp(prefix='.specialty-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(temp, mode)
        if owner is not None and os.geteuid() == 0:
            os.chown(temp, *owner)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)

def check(root, manifest):
    result = []
    for name, spec in manifest['files'].items():
        if Path(name).name != name:
            raise RuntimeError('Invalid payload filename')
        after = resource('payload/' + name)
        if digest(after) != spec['after']:
            raise RuntimeError(f'Payload checksum mismatch: {name}')
        actual = current(root / name)
        if actual not in (spec['before'], spec['after']):
            raise RuntimeError(f'File has changed since preparation: {name}. Stop and rebuild from current files.')
        result.append((name, actual))
    states = [actual == manifest['files'][name]['after'] for name, actual in result]
    if any(states) and not all(states):
        raise RuntimeError('Mixed release detected; inspect or roll back first.')
    return all(states)

def apply(root, manifest):
    if check(root, manifest):
        print('NO_CHANGE: release already installed')
        return
    backup_root = Path('/root/kidneysphere-specialty-backups') if os.geteuid() == 0 else Path.home() / 'kidneysphere-specialty-backups'
    backup_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-')
    backup = Path(tempfile.mkdtemp(prefix=stamp, dir=backup_root))
    record = {'root': str(root), 'files': {}}
    for name, spec in manifest['files'].items():
        target = root / name
        exists = target.exists()
        info = target.stat() if exists else (root / 'index.html').stat()
        record['files'][name] = {**spec, 'existed': exists, 'mode': stat.S_IMODE(info.st_mode) if exists else 0o644, 'uid': info.st_uid, 'gid': info.st_gid}
        if exists:
            shutil.copy2(target, backup / name)
    (backup / 'record.json').write_text(json.dumps(record, indent=2), encoding='utf-8')
    written = []
    try:
        # Assets first, HTML last. Recheck immediately before each mutation.
        for name in sorted(record['files'], key=lambda x: x == 'index.html'):
            spec = record['files'][name]
            if current(root / name) != spec['before']:
                raise RuntimeError(f'Concurrent change: {name}')
            atomic(root / name, resource('payload/' + name), spec['mode'], (spec['uid'], spec['gid']))
            written.append(name)
        if not check(root, manifest):
            raise RuntimeError('Post-write checksum verification failed')
    except Exception:
        for name in reversed(written):
            spec = record['files'][name]
            if current(root / name) != spec['after']:
                raise RuntimeError(f'Concurrent change during failure; inspect backup: {backup}')
            if spec['existed']:
                atomic(root / name, (backup / name).read_bytes(), spec['mode'], (spec['uid'], spec['gid']))
            else:
                (root / name).unlink()
        raise
    print(f'APPLIED: {len(written)} files; backup={backup}')

def rollback(backup):
    record = json.loads((backup / 'record.json').read_text())
    root = Path(record['root'])
    for name, spec in record['files'].items():
        if Path(name).name != name or current(root / name) != spec['after']:
            raise RuntimeError(f'Cannot roll back modified file: {name}')
        if spec['existed'] and digest((backup / name).read_bytes()) != spec['before']:
            raise RuntimeError(f'Backup checksum mismatch: {name}')
    # Restore HTML first so it stops referring to the new assets.
    for name in sorted(record['files'], key=lambda x: x != 'index.html'):
        spec = record['files'][name]
        if current(root / name) != spec['after']:
            raise RuntimeError(f'Concurrent change: {name}')
        if spec['existed']:
            atomic(root / name, (backup / name).read_bytes(), spec['mode'], (spec['uid'], spec['gid']))
        else:
            (root / name).unlink()
    print(f'ROLLED_BACK: {root}')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'apply', 'rollback'], nargs='?', default='check')
    parser.add_argument('backup', nargs='?')
    parser.add_argument('--root', default='/var/www/kidneysphere')
    args = parser.parse_args()
    try:
        if args.action == 'rollback':
            if not args.backup:
                parser.error('rollback requires backup path')
            rollback(Path(args.backup).resolve())
            return
        root = Path(args.root).resolve(strict=True)
        manifest = json.loads(resource('manifest.json'))
        if args.action == 'check':
            installed = check(root, manifest)
            print('NO_CHANGE: release already installed' if installed else 'READY: current files match; apply is safe')
        else:
            apply(root, manifest)
    except Exception as exc:
        raise SystemExit(f'STOP: {exc}')

if __name__ == '__main__':
    main()
