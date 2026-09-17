#!/usr/bin/env python3
"""Offline static release. No source reset, build, service restart, or secret access."""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import uuid
import zipfile

ROOTS = {'doctor': Path('/var/www/kidneysphere-doctor/dist'),
         'portal': Path('/var/www/kidneysphere')}
REPO = Path('/var/www/kidneysphere-doctor')
BACKUPS = Path('/root/kidneysphere-release-backups')
DOMAINS = {'doctor': 'kidneyspheredoctorapp.cn', 'portal': 'kidneysphere.com'}
OLD_DOCTOR = '0a4a160474e48441ad886d3774030f6d8b6caf2e'
NEW_DOCTOR = 'e28760e2f0695785822962632844799d8645031d'
PORTAL_FILES = {'app.js', 'index.html', 'portal-home.css', 'qbank-data.js',
                'qbank.js', 'qbank-test.js', 'qbank-parser.js', 'qbank-admin.js',
                'qbank.html', 'qbank-test.html', 'qbank-admin.html'}
DOCTOR_FIXED = {'index.html', 'build.json', 'metadata.json', 'qbank.html',
                'favicon.ico', '_headers', '_redirects', 'content/manifest.json'}
HEX = re.compile(r'^[0-9a-f]{64}$')
MAX_FILE = 64 * 1024 * 1024
MAX_TOTAL = 256 * 1024 * 1024


class ReleaseError(RuntimeError):
    pass


def require(ok, message):
    if not ok:
        raise ReleaseError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def safe(path, missing=False):
    path = Path(path)
    require(path.is_absolute() and '..' not in path.parts, 'INVALID_PATH')
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        try:
            info = current.lstat()
        except FileNotFoundError:
            require(missing, 'MISSING_PATH: ' + str(current))
            return path
        require(not stat.S_ISLNK(info.st_mode), 'SYMLINK_REFUSED: ' + str(current))
        if current != path:
            require(stat.S_ISDIR(info.st_mode), 'NOT_DIRECTORY: ' + str(current))
    return path


def relative(name):
    require(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_./@+-]+', name),
            'INVALID_RELATIVE_PATH')
    value = PurePosixPath(name)
    require(not value.is_absolute() and '..' not in value.parts and
            str(value) == name and not any(p.startswith('.') for p in value.parts),
            'INVALID_RELATIVE_PATH: ' + name)
    return name


def allowed(site, name, guard=False):
    relative(name)
    if site == 'doctor':
        return name in DOCTOR_FIXED or (
            name.startswith(('_expo/static/', 'assets/')) and
            Path(name).suffix.lower() in {'.js', '.css', '.png', '.jpg', '.jpeg',
                                         '.webp', '.svg', '.ico', '.woff', '.woff2', '.ttf'})
    if site == 'portal':
        return name in PORTAL_FILES or (guard and
            not name.startswith(('server/', 'netlify/', 'deploy/', 'docs/')) and
            Path(name).suffix.lower() in {'.html', '.js', '.css', '.png', '.jpg', '.webp'})
    return False


def immutable(name):
    return bool(re.search(r'[.-][0-9a-f]{32,64}\.', name))


def state(path):
    safe(path, missing=True)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return {'exists': False}, None
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_size <= MAX_FILE,
                'NOT_A_REGULAR_STATIC_FILE: ' + str(path))
        data = stream.read(MAX_FILE + 1)
    require(len(data) <= MAX_FILE, 'FILE_TOO_LARGE')
    return {'exists': True, 'sha256': sha(data), 'size': len(data),
            'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid}, data


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic(path, data, metadata=None):
    safe(path, missing=True)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    safe(path.parent)
    metadata = metadata or {'mode': 0o600, 'uid': os.geteuid(), 'gid': os.getegid()}
    fd, name = tempfile.mkstemp(prefix='.ks-release-', dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fchown(stream.fileno(), metadata['uid'], metadata['gid'])
            os.fchmod(stream.fileno(), metadata['mode'])
            os.fsync(stream.fileno())
        require(state(temporary)[0]['sha256'] == sha(data), 'STAGING_HASH_FAILED')
        os.replace(temporary, path)
        sync_dir(path.parent)
    finally:
        if temporary.exists():
            temporary.unlink()


def write_json(path, value):
    atomic(path, (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode())


def ordered(entries):
    # Complete doctor first. Each site: dependencies, HTML, index, build marker.
    return sorted(entries, key=lambda e: (
        0 if e['site'] == 'doctor' else 1,
        4 if e['path'] == 'build.json' else 3 if e['path'] == 'index.html'
        else 2 if e['path'].endswith('.html') else 1, e['path']))


def load_package(path):
    safe(path)
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        names = [i.filename for i in infos]
        require(len(names) == len(set(names)) and 'manifest.json' in names,
                'INVALID_ARCHIVE_ENTRIES')
        require(all(not i.is_dir() and i.file_size <= MAX_FILE for i in infos) and
                sum(i.file_size for i in infos) <= MAX_TOTAL, 'ARCHIVE_TOO_LARGE')
        manifest = json.loads(archive.read('manifest.json'))
        require(manifest.get('schema') == 1 and
                re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', manifest.get('release_id', '')),
                'INVALID_MANIFEST')
        doctor = manifest['doctor']
        require(doctor['expected_git_head'] == OLD_DOCTOR and
                doctor['target_commit'] == NEW_DOCTOR and
                doctor['expected_build_id'] == OLD_DOCTOR[:8], 'DOCTOR_REF_MISMATCH')
        require(re.fullmatch(r'[0-9a-f]{40}', manifest['portal']['target_commit']),
                'INVALID_PORTAL_COMMIT')
        entries = manifest['entries']
        require(isinstance(entries, list) and 11 < len(entries) < 2000, 'INVALID_FILE_COUNT')
        payload = {}
        for entry in entries:
            site, name = entry['site'], entry['path']
            require(allowed(site, name), 'PAYLOAD_SCOPE_REFUSED: ' + name)
            key = site + '/' + name
            require(key not in payload and HEX.fullmatch(entry['sha256']), 'INVALID_FILE_HASH')
            before = entry.get('allowed_before')
            require((site == 'doctor' and before is None) or
                    (isinstance(before, list) and before and all(
                        x is None or (isinstance(x, str) and HEX.fullmatch(x)) for x in before)),
                    'BASELINE_ALLOWLIST_REQUIRED: ' + key)
            data = archive.read('payload/' + key)
            require(sha(data) == entry['sha256'] and
                    ('size' not in entry or len(data) == entry['size']), 'PAYLOAD_HASH_FAILED: ' + key)
            payload[key] = data
        require({e['path'] for e in entries if e['site'] == 'portal'} == PORTAL_FILES,
                'PORTAL_SCOPE_MISMATCH')
        require({'doctor/index.html', 'doctor/build.json'}.issubset(payload), 'DOCTOR_ENTRY_MISSING')
        require(json.loads(payload['doctor/build.json'])['build_id'] == NEW_DOCTOR[:8],
                'PAYLOAD_BUILD_ID_MISMATCH')
        require(set(names) == {'manifest.json'} | {'payload/' + k for k in payload},
                'UNDECLARED_ARCHIVE_FILES')
        for site in ROOTS:
            guards = manifest[site].get('guards', [])
            require(isinstance(guards, list), 'INVALID_GUARDS')
            for guard in guards:
                require(allowed(site, guard['path'], guard=True) and HEX.fullmatch(guard['sha256']),
                        'INVALID_GUARD')
        require(any(g['path'] == 'index.html' for g in doctor.get('guards', [])),
                'DOCTOR_OLD_INDEX_GUARD_REQUIRED')
    return manifest, payload


def git_check():
    safe(REPO)
    command = ['git', '--no-optional-locks', '-C', str(REPO)]
    head = subprocess.run(command + ['rev-parse', 'HEAD'], capture_output=True, text=True, timeout=20)
    changed = subprocess.run(command + ['status', '--porcelain', '--untracked-files=no'],
                             capture_output=True, text=True, timeout=20)
    tracked_dist = subprocess.run(command + ['ls-files', '--', 'dist'],
                                  capture_output=True, text=True, timeout=20)
    require(head.returncode == 0 and head.stdout.strip() == OLD_DOCTOR,
            'DOCTOR_SOURCE_HEAD_CHANGED')
    require(changed.returncode == 0 and not changed.stdout.strip(), 'DOCTOR_TRACKED_SOURCE_NOT_CLEAN')
    require(tracked_dist.returncode == 0 and not tracked_dist.stdout.strip(),
            'DOCTOR_DIST_MUST_NOT_BE_GIT_TRACKED')


def probe(site, name, expected, local=True):
    domain = DOMAINS[site]
    with tempfile.TemporaryDirectory(prefix='ks-probe-') as temporary:
        output = Path(temporary) / 'response'
        args = ['curl', '--disable', '--silent', '--fail', '--max-time', '20',
                '--max-filesize', str(MAX_FILE), '--noproxy', '*', '--compressed',
                '--proto', '=https', '--header', 'Cache-Control: no-cache']
        if local:
            args += ['--resolve', domain + ':443:127.0.0.1']
        args += ['--output', str(output), 'https://' + domain + '/' +
                 ('' if name == 'index.html' else name) + '?ks_release_probe=' + uuid.uuid4().hex]
        result = subprocess.run(args, capture_output=True, timeout=25)
        require(result.returncode == 0 and output.is_file() and state(output)[0]['sha256'] == expected,
                ('LOCAL_HTTPS' if local else 'PUBLIC_HTTPS') + '_MISMATCH: ' + site + '/' + name)


def guards_now(manifest):
    result = {}
    for site in ROOTS:
        for guard in manifest[site].get('guards', []):
            key = site + '/' + guard['path']
            actual, unused = state(ROOTS[site] / guard['path'])
            require(actual.get('sha256') == guard['sha256'], 'BASELINE_GUARD_FAILED: ' + key)
            result[key] = actual
    return result


def same(path, expected):
    require(state(path)[0] == expected, 'FILE_CHANGED: ' + str(path))


def check(manifest, payload):
    for root in ROOTS.values():
        safe(root)
        require(root.is_dir(), 'ROOT_NOT_DIRECTORY')
    safe(BACKUPS, missing=True)
    require(all(BACKUPS != r and r not in BACKUPS.parents for r in ROOTS.values()), 'BACKUP_INSIDE_WEBROOT')
    git_check()
    old_build = json.loads(state(ROOTS['doctor'] / 'build.json')[1] or b'{}')
    require(old_build.get('build_id') == manifest['doctor']['expected_build_id'], 'LIVE_BUILD_ID_MISMATCH')
    guards = guards_now(manifest)
    snapshots = {}
    for entry in ordered(manifest['entries']):
        key = entry['site'] + '/' + entry['path']
        before, unused = state(ROOTS[entry['site']] / entry['path'])
        permitted = entry.get('allowed_before')
        require(permitted is None or before.get('sha256') in permitted + [entry['sha256']],
                'UNKNOWN_BASELINE: ' + key + ' ' + str(before.get('sha256')))
        if before['exists'] and immutable(entry['path']):
            require(before['sha256'] == entry['sha256'], 'HASHED_ASSET_COLLISION: ' + key)
        snapshots[key] = before
    # Proves both local TLS vhosts actually serve the expected filesystem roots.
    for site, names in {'doctor': ('index.html', 'build.json'),
                        'portal': ('index.html', 'app.js', 'qbank.html')}.items():
        for name in names:
            before, unused = state(ROOTS[site] / name)
            require(before['exists'], 'MISSING_HTTP_BASELINE: ' + site + '/' + name)
            probe(site, name, before['sha256'])
    old_size = sum(s.get('size', 0) for s in snapshots.values())
    new_size = sum(len(v) for v in payload.values())
    needed = old_size + new_size + 64 * 1024 * 1024
    for path in (*ROOTS.values(), BACKUPS):
        while not path.exists():
            path = path.parent
        require(shutil.disk_usage(path).free >= needed, 'INSUFFICIENT_DISK_SPACE')
    print('CHECK_OK: approved baselines, clean source, payload hashes and local HTTPS roots', flush=True)
    return snapshots, guards


@contextlib.contextmanager
def locked():
    safe(BACKUPS, missing=True)
    BACKUPS.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = BACKUPS.stat()
    require(info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700,
            'BACKUP_ROOT_MUST_BE_PRIVATE_AND_OWNED')
    lock = BACKUPS / 'release.lock'
    safe(lock, missing=True)
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ReleaseError('ANOTHER_RELEASE_IS_RUNNING') from error
        yield
    finally:
        os.close(fd)


def destination(entry):
    return ROOTS[entry['site']] / entry['path']


def verify_backup(backup, record):
    require(backup.parent == BACKUPS and record.get('schema') == 1 and
            record.get('roots') == {s: str(p) for s, p in ROOTS.items()}, 'INVALID_BACKUP_LOCATION')
    safe(backup)
    require(stat.S_IMODE(backup.stat().st_mode) == 0o700 and backup.stat().st_uid == os.geteuid(),
            'BACKUP_NOT_PRIVATE_AND_OWNED')
    seen = set()
    for entry in record['entries']:
        key = entry['site'] + '/' + entry['path']
        require(allowed(entry['site'], entry['path']) and key not in seen and
                HEX.fullmatch(entry['after_sha256']), 'INVALID_BACKUP_RECORD')
        seen.add(key)
        before = entry['before']
        if before['exists']:
            actual, unused = state(backup / 'files' / key)
            require(actual.get('sha256') == before['sha256'] and actual.get('size') == before['size'],
                    'BACKUP_HASH_FAILED: ' + key)


def restore(backup, record):
    verify_backup(backup, record)
    # Check the entire rollback scope before the first restoration. Do not erase a later edit.
    for entry in record['entries']:
        current, unused = state(destination(entry))
        require(current == entry['before'] or current.get('sha256') == entry['after_sha256'],
                'ROLLBACK_REFUSED_LATER_EDIT: ' + entry['site'] + '/' + entry['path'])
    for entry in reversed(record['entries']):
        path = destination(entry)
        current, unused = state(path)
        require(current == entry['before'] or current.get('sha256') == entry['after_sha256'],
                'ROLLBACK_REFUSED_LATER_EDIT: ' + entry['site'] + '/' + entry['path'])
        if current == entry['before']:
            continue
        before = entry['before']
        if before['exists']:
            data = state(backup / 'files' / entry['site'] / entry['path'])[1]
            atomic(path, data, before)
        elif entry['path'].endswith('.html') or entry['path'] == 'build.json':
            path.unlink()
            sync_dir(path.parent)
        # Newly added static resources are deliberately retained for cached/new tabs.
    record['status'] = 'rolled_back'
    write_json(backup / 'record.json', record)
    for site, names in {'doctor': ('index.html', 'build.json'), 'portal': ('index.html', 'app.js')}.items():
        for name in names:
            expected = next(e['before'] for e in record['entries'] if e['site'] == site and e['path'] == name)
            probe(site, name, expected['sha256'])
    print('ROLLBACK_OK: previous entry files restored; added static assets retained', flush=True)


def health(manifest):
    hashes = {(e['site'], e['path']): e['sha256'] for e in manifest['entries']}
    doctor_js = [e['path'] for e in manifest['entries'] if e['site'] == 'doctor'
                 and e['path'].startswith('_expo/static/js/web/') and e['path'].endswith('.js')]
    require(doctor_js, 'DOCTOR_BUNDLE_MISSING')
    for local in (True, False):
        print('VERIFYING: ' + ('local HTTPS' if local else 'public HTTPS'), flush=True)
        for site, names in {'doctor': ('index.html', 'build.json', doctor_js[0]),
                            'portal': ('index.html', 'app.js', 'qbank.html', 'qbank-data.js')}.items():
            for name in names:
                probe(site, name, hashes[(site, name)], local=local)


@contextlib.contextmanager
def release_signals(ignore=False):
    def interrupted(signum, frame):
        raise ReleaseError('DEPLOYMENT_INTERRUPTED_SIGNAL_' + str(signum))
    signals = (signal.SIGHUP, signal.SIGTERM, signal.SIGINT)
    previous = {s: signal.getsignal(s) for s in signals}
    try:
        for s in signals:
            signal.signal(s, signal.SIG_IGN if ignore else interrupted)
        yield
    finally:
        for s, handler in previous.items():
            signal.signal(s, handler)


def apply(manifest, payload):
    with locked():
        snapshots, guards = check(manifest, payload)
        name = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
        backup = BACKUPS / name
        backup.mkdir(mode=0o700)
        record = {'schema': 1, 'release_id': manifest['release_id'], 'status': 'preparing',
                  'roots': {s: str(p) for s, p in ROOTS.items()}, 'entries': [],
                  'source_commits': {'doctor_before': manifest['doctor']['expected_git_head'],
                                     'doctor_payload': manifest['doctor']['target_commit'],
                                     'portal_payload': manifest['portal']['target_commit']},
                  'build_ids': {'doctor_before': manifest['doctor']['expected_build_id'],
                                'doctor_payload': manifest['doctor']['target_commit'][:8]},
                  'source_checkout_updated': False}
        for entry in ordered(manifest['entries']):
            key = entry['site'] + '/' + entry['path']
            before, data = state(destination(entry))
            require(before == snapshots[key], 'FILE_CHANGED_DURING_BACKUP: ' + key)
            if before['exists']:
                atomic(backup / 'files' / key, data)
            record['entries'].append({'site': entry['site'], 'path': entry['path'],
                                      'before': before, 'after_sha256': entry['sha256']})
        record['status'] = 'prepared'
        write_json(backup / 'record.json', record)
        verify_backup(backup, record)
        for entry in record['entries']:
            same(destination(entry), entry['before'])
        require(guards_now(manifest) == guards, 'GUARD_CHANGED_DURING_BACKUP')
        git_check()
        print('VERIFIED_BACKUP: ' + str(backup), flush=True)
        print('ROLLBACK: python3 deploy.py rollback ' + str(backup), flush=True)
        # The durable record is complete before any production write. SIGHUP/TERM
        # trigger restoration; SIGKILL/power loss require the printed rollback command.
        signal_context = release_signals()
        signal_context.__enter__()
        try:
            record['status'] = 'applying'
            write_json(backup / 'record.json', record)
            for entry in record['entries']:
                path = destination(entry)
                same(path, entry['before'])
                if entry['before'].get('sha256') == entry['after_sha256']:
                    continue
                key = entry['site'] + '/' + entry['path']
                root_info = ROOTS[entry['site']].stat()
                metadata = entry['before'] if entry['before']['exists'] else {
                    'mode': 0o644, 'uid': root_info.st_uid, 'gid': root_info.st_gid}
                atomic(path, payload[key], metadata)
            for entry in record['entries']:
                require(state(destination(entry))[0].get('sha256') == entry['after_sha256'],
                        'POST_WRITE_HASH_FAILED')
            # Guards that were intentionally released have their new hashes now.
            changed_keys = {e['site'] + '/' + e['path'] for e in record['entries']}
            for key, old_state in guards.items():
                if key not in changed_keys:
                    site, name = key.split('/', 1)
                    same(ROOTS[site] / name, old_state)
            git_check()
            health(manifest)
            record['status'] = 'applied'
            write_json(backup / 'record.json', record)
        except BaseException:
            print('APPLY_FAILED: restoring verified backup', file=sys.stderr, flush=True)
            try:
                with release_signals(ignore=True):
                    restore(backup, record)
            except BaseException as error:
                print('AUTOMATIC_ROLLBACK_STOPPED: ' + str(error) + '\nBackup: ' + str(backup),
                      file=sys.stderr, flush=True)
            raise
        finally:
            signal_context.__exit__(None, None, None)
        print('DEPLOYMENT_OK: static files verified locally and publicly; source/services unchanged', flush=True)
        return backup


def main():
    argv = sys.argv[1:]
    if argv and argv[0] == '--check':
        argv[0] = 'check'
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('check', 'apply', 'rollback'))
    parser.add_argument('path', help='release.zip, or the exact backup directory for rollback')
    args = parser.parse_args(argv)
    try:
        path = Path(args.path).absolute()
        if args.action == 'rollback':
            safe(path)
            record = json.loads(state(path / 'record.json')[1] or b'{}')
            with locked():
                with release_signals(ignore=True):
                    restore(path, record)
        else:
            manifest, payload = load_package(path)
            if args.action == 'check':
                check(manifest, payload)
                print('READ_ONLY: no website files changed and no backups created')
            else:
                apply(manifest, payload)
    except (ReleaseError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        print('STOPPED: ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
