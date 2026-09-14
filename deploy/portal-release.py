#!/usr/bin/env python3
"""Pinned, offline portal releases with fixed scopes. Python 3.8+, stdlib only."""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile

DOMAIN = 'kidneysphere.com'
ROOT = Path('/var/www/kidneysphere')
BACKUP_ROOT = Path('/root/kidneysphere-home-releases')
VHOST = Path('/etc/nginx/sites-enabled/kidneysphere.com')
FILES = ('assets/portal/critical-v1.webp', 'assets/portal/pathology-v1.webp',
         'assets/portal/transplant-v1.webp', 'portal-home.css', 'portal-home.js',
         'home.js', 'app.js', 'index.html')
SITE_THEME_HTML = (
    '404.html', 'about.html', 'academy.html', 'admin-atlas.html', 'admin-commerce.html',
    'admin.html', 'article-editor.html', 'article.html', 'articles.html',
    'atlas-category.html', 'atlas-series.html', 'atlas-topic.html', 'atlas.html',
    'auth-callback.html', 'board.html', 'case.html', 'checkout.html', 'community.html',
    'core-team.html', 'disclaimer.html', 'events.html', 'expert-ppt.html',
    'experts-cn.html', 'experts-intl.html', 'experts.html', 'favorites.html',
    'flagship.html', 'forgot.html', 'frontier.html', 'glomcon-guangzhou.html',
    'health.html', 'learning.html', 'login.html', 'membership.html', 'moment.html',
    'moments.html', 'my-learning.html', 'nephro-pro-module.html', 'nephro-pro.html',
    'notes.html', 'notifications.html', 'partners.html', 'post-case.html',
    'ppt-viewer.html', 'privacy.html', 'profile.html', 'qbank-admin.html',
    'qbank-test.html', 'qbank.html', 'register.html', 'research-pilot.html',
    'research.html', 'reset.html', 'search.html', 'sponsor.html', 'sponsors.html',
    'terms.html', 'training-da.html', 'training-glom.html', 'training-icu.html',
    'training-patho.html', 'training-tx.html', 'verify-doctor.html', 'videos.html',
    'watch.html',
)
SITE_THEME_FILES = ('site-light.css', 'site-page-themes.css', 'styles.css') + SITE_THEME_HTML
BLUE_DEPTH_FILES = (
    'assets/portal/critical-v1.webp', 'assets/portal/pathology-v1.webp',
    'assets/portal/transplant-v1.webp', 'site-light.css', 'site-page-themes.css',
    'portal-home.css', 'portal-home.js', 'home.js', 'app.js', 'portal-motion.js',
    'styles.css',
) + SITE_THEME_HTML + ('index.html',)
GUARD_PATHS = tuple(ROOT / p for p in ('login.html', 'register.html', 'watch.html',
    'my-learning.html', 'videos.html', 'academy.html', 'supabaseClient.js', 'styles.css')) + (
    Path('/var/www/kidneysphere-doctor/dist/index.html'),
    Path('/var/www/kidneysphere-registry/index.html'),
    Path('/var/www/kidneysphere-remote/index.html'), VHOST,
    Path('/etc/nginx/conf.d/kidneyspheredoctorapp.cn.conf'),
    Path('/etc/nginx/conf.d/kidneysphereregistry.conf'),
    Path('/etc/nginx/conf.d/kidneysphereremote.conf'))
DISK_RESERVE_BYTES = 16 * 1024 * 1024


class ReleaseError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise ReleaseError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def relative_path(value):
    require(isinstance(value, str) and value and '\\' not in value,
            'INVALID_RELATIVE_PATH')
    p = PurePosixPath(value)
    require(not p.is_absolute() and '..' not in p.parts and str(p) == value,
            'INVALID_RELATIVE_PATH: ' + value)
    return value


def safe_path(path, missing=False):
    """Reject links at every existing component, including a missing leaf's parents."""
    path = Path(path)
    require(path.is_absolute() and '..' not in path.parts, 'INVALID_ABSOLUTE_PATH')
    current = Path(path.anchor)
    for component in path.parts[1:]:
        current /= component
        try:
            info = current.lstat()
        except FileNotFoundError:
            require(missing, 'MISSING_PATH: ' + str(current))
            return path
        require(not stat.S_ISLNK(info.st_mode), 'SYMLINK_REFUSED: ' + str(current))
        if current != path:
            require(stat.S_ISDIR(info.st_mode), 'NON_DIRECTORY: ' + str(current))
    return path


def read_state(path):
    safe_path(path, missing=True)
    try:
        fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return {'exists': False}, None
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode), 'NON_REGULAR_FILE: ' + str(path))
        data = stream.read()
    return {'exists': True, 'sha256': digest(data), 'size': len(data),
            'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid}, data


def release_files(manifest):
    profile = manifest.get('release_profile', 'homepage-v1')
    profiles = {'homepage-v1': FILES, 'site-theme-v1': SITE_THEME_FILES,
                'blue-depth-v1': BLUE_DEPTH_FILES}
    require(profile in profiles, 'UNKNOWN_RELEASE_PROFILE')
    return profiles[profile]


def guard_states(manifest=None):
    result = {}
    paths = list(GUARD_PATHS)
    if manifest is not None and manifest.get('release_profile') in ('site-theme-v1', 'blue-depth-v1'):
        payload_paths = {ROOT / name for name in release_files(manifest)}
        paths.extend(ROOT / name for name in (
            'index.html', 'home.js', 'portal-home.js', 'portal-home.css', 'app.js',
            'assets/config.js', 'assets/videos.js', 'assets/lib/supabase.min.js',
        ))
        paths = [path for path in paths if path not in payload_paths]
    for path in dict.fromkeys(paths):
        # Configs in sites-enabled may legitimately be links; guards are read-only.
        target = path.resolve(strict=False)
        entry = {'target': str(target), 'exists': path.exists()}
        if entry['exists']:
            state, unused = read_state(target)
            entry.update(state)
        result[str(path)] = entry
    return result


def validate_manifest(manifest):
    require(manifest.get('schema') == 1 and manifest.get('domain') == DOMAIN and
            manifest.get('root') == str(ROOT), 'PACKAGE_TARGET_MISMATCH')
    require(re.fullmatch(r'[0-9a-f]{40}', manifest.get('commit', '')) is not None,
            'INVALID_COMMIT')
    entries = manifest.get('files', [])
    require([e.get('path') for e in entries] == list(release_files(manifest)),
            'PACKAGE_FILE_ALLOWLIST_MISMATCH')
    for entry in entries:
        require(re.fullmatch(r'[0-9a-f]{64}', entry.get('sha256', '')) is not None and
                type(entry.get('size')) is int and 0 <= entry['size'] <= 8 * 1024 * 1024,
                'INVALID_FILE_MANIFEST: ' + entry['path'])
        require(type(entry.get('allow_missing')) is bool and
                isinstance(entry.get('allowed_before'), list) and
                all(isinstance(h, str) and re.fullmatch(r'[0-9a-f]{64}', h)
                    for h in entry['allowed_before']), 'INVALID_BASELINE_MANIFEST')
        require(entry['path'] not in ('index.html', 'app.js', 'home.js') or
                not entry['allow_missing'], 'SHARED_FILE_MUST_EXIST')
        if manifest.get('release_profile') == 'site-theme-v1':
            require(entry['path'] in ('site-light.css', 'site-page-themes.css') or
                    not entry['allow_missing'], 'EXISTING_THEME_RESOURCE_MUST_EXIST')
        if manifest.get('release_profile') == 'blue-depth-v1':
            require(entry['path'] in ('site-light.css', 'site-page-themes.css', 'portal-motion.js') or
                    not entry['allow_missing'], 'EXISTING_DEPTH_RESOURCE_MUST_EXIST')
    require(isinstance(manifest.get('required_files'), list), 'INVALID_REQUIRED_FILES')
    for name in manifest['required_files']:
        relative_path(name)


def load_package(package_path=None):
    source = Path(package_path or sys.argv[0])
    with zipfile.ZipFile(str(source)) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)), 'PACKAGE_ENTRY_MISMATCH')
        require(all(e.file_size <= 8 * 1024 * 1024 for e in archive.infolist()),
                'PACKAGE_ENTRY_TOO_LARGE')
        manifest = json.loads(archive.read('manifest.json').decode('utf-8'))
        validate_manifest(manifest)
        files = release_files(manifest)
        expected = {'__main__.py', 'manifest.json'} | {'payload/' + p for p in files}
        require(set(names) == expected, 'PACKAGE_ENTRY_MISMATCH')
        if 'runner_sha256' in manifest:
            require(digest(archive.read('__main__.py')) == manifest['runner_sha256'],
                    'RUNNER_HASH_MISMATCH')
        payload = {p: archive.read('payload/' + p) for p in files}
    for entry in manifest['files']:
        content = payload[entry['path']]
        require(len(content) == entry['size'] and digest(content) == entry['sha256'],
                'PAYLOAD_HASH_MISMATCH: ' + entry['path'])
    return {'manifest': manifest, 'payload': payload}


def check_nginx():
    proc = subprocess.run(['nginx', '-T'], stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, universal_newlines=True, timeout=30)
    require(proc.returncode == 0, 'NGINX_READ_CHECK_FAILED (configuration not printed)')
    pieces = re.split(r'^# configuration file (.+):\s*$', proc.stdout, flags=re.M)
    sections = [pieces[i + 1] for i in range(1, len(pieces), 2)
                if Path(pieces[i]).resolve() == VHOST.resolve()]
    require(len(sections) == 1, 'NGINX_VHOST_NOT_UNIQUE: ' + str(VHOST))
    section = re.sub(r'#[^\n]*', '', sections[0])
    # The separately verified HTTPS installer adds this exact challenge webroot.
    # Exempt only its complete location; other roots, aliases and ACME variants
    # must still fail the portal target check. This does not edit Nginx.
    managed_acme = (
        r'\blocation\s+\^~\s+/\.well-known/acme-challenge/\s*\{\s*'
        r'root\s+/var/lib/kidneysphere-acme\s*;\s*'
        r'default_type\s+text/plain\s*;\s*'
        r'try_files\s+\$uri\s+=404\s*;\s*\}'
    )
    section, acme_count = re.subn(managed_acme, '', section)
    require(acme_count <= 1 and 'acme-challenge' not in section and
            '/var/lib/kidneysphere-acme' not in section, 'NGINX_UNEXPECTED_ACME_ROUTE')
    names = [token.strip('"\'') for value in re.findall(r'\bserver_name\s+([^;]+);', section)
             for token in value.split()]
    roots = {value.strip().strip('"\'') for value in re.findall(r'\broot\s+([^;]+);', section)}
    require(DOMAIN in names and roots == {str(ROOT)} and
            re.search(r'\balias\s+[^;]+;', section) is None, 'NGINX_TARGET_MISMATCH')


def disk_check(old_bytes, new_bytes):
    needs = {}
    for path, amount in ((ROOT, max(old_bytes, new_bytes)),
                         (BACKUP_ROOT, old_bytes + 256 * 1024)):
        safe_path(path, missing=True)
        while not path.exists():
            path = path.parent
        device = path.stat().st_dev
        previous = needs.get(device, (path, 0))
        needs[device] = (path, previous[1] + amount)
    for path, amount in needs.values():
        require(shutil.disk_usage(str(path)).free >= amount + DISK_RESERVE_BYTES,
                'INSUFFICIENT_DISK_SPACE: ' + str(path))


def preflight(package):
    manifest = package['manifest']
    validate_manifest(manifest)
    for entry in manifest['files']:
        content = package['payload'][entry['path']]
        require(len(content) == entry['size'] and digest(content) == entry['sha256'],
                'PAYLOAD_HASH_MISMATCH: ' + entry['path'])
    safe_path(ROOT)
    require(ROOT.is_dir() and ROOT.resolve() == ROOT, 'ROOT_MUST_BE_REAL_DIRECTORY')
    require(ROOT not in BACKUP_ROOT.parents and ROOT != BACKUP_ROOT,
            'BACKUP_MUST_BE_OUTSIDE_WEBROOT')
    safe_path(BACKUP_ROOT, missing=True)
    check_nginx()
    for name in manifest['required_files']:
        state, unused = read_state(ROOT / name)
        require(state['exists'], 'MISSING_DEPENDENCY: ' + name)
    states, unknown = {}, []
    for entry in manifest['files']:
        state, unused = read_state(ROOT / entry['path'])
        states[entry['path']] = state
        accepted = (state.get('sha256') in entry['allowed_before'] + [entry['sha256']]
                    if state['exists'] else entry['allow_missing'])
        if not accepted:
            unknown.append(entry['path'])
            print('UNKNOWN_BASELINE ' + entry['path'] + ' ' + state.get('sha256', 'MISSING'), flush=True)
    require(not unknown, 'BASELINE_CHECK_FAILED; no website files written')
    disk_check(sum(s.get('size', 0) for s in states.values()),
               sum(e['size'] for e in manifest['files']))
    return {'states': states, 'guards': guard_states(manifest),
            'no_change': all(states[e['path']].get('sha256') == e['sha256']
                             for e in manifest['files'])}


def fsync_directory(path):
    fd = os.open(str(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def make_directories(path, mode=0o755):
    safe_path(path, missing=True)
    if not path.exists():
        make_directories(path.parent, mode)
        path.mkdir(mode=mode)
        fsync_directory(path.parent)
    require(path.is_dir(), 'NON_DIRECTORY: ' + str(path))


def stage_file(path, data, metadata):
    safe_path(path, missing=True)
    make_directories(path.parent)
    fd, temporary = tempfile.mkstemp(prefix='.kidneysphere-home-', dir=str(path.parent))
    temporary = Path(temporary)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fchown(stream.fileno(), metadata['uid'], metadata['gid'])
            os.fchmod(stream.fileno(), metadata['mode'])
            os.fsync(stream.fileno())
        actual, unused = read_state(temporary)
        require(actual['sha256'] == digest(data), 'STAGE_HASH_MISMATCH')
        return temporary
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def write_json(path, value):
    data = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    temporary = stage_file(path, data, {'mode': 0o600, 'uid': os.geteuid(), 'gid': os.getegid()})
    os.replace(str(temporary), str(path))
    fsync_directory(path.parent)


@contextlib.contextmanager
def release_lock():
    make_directories(BACKUP_ROOT, 0o700)
    info = BACKUP_ROOT.stat()
    require(info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700,
            'BACKUP_ROOT_MUST_BE_OWNED_PRIVATE_DIRECTORY')
    lock = BACKUP_ROOT / '.release.lock'
    safe_path(lock, missing=True)
    fd = os.open(str(lock), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        require(stat.S_ISREG(os.fstat(fd).st_mode), 'INVALID_LOCK_FILE')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ReleaseError('ANOTHER_RELEASE_IS_RUNNING')
        yield
    finally:
        os.close(fd)


def same_state(path, expected):
    actual, unused = read_state(path)
    require(actual == expected, 'FILE_CHANGED_DURING_RELEASE: ' + str(path))


def verify_backup(backup, record, package=None):
    require(backup.parent == BACKUP_ROOT, 'BACKUP_NOT_A_DIRECT_CHILD')
    safe_path(backup)
    require(backup.is_dir() and stat.S_IMODE(backup.stat().st_mode) == 0o700 and
            backup.stat().st_uid == os.geteuid(),
            'INVALID_BACKUP_DIRECTORY')
    validate_manifest(record['release'])
    require(record.get('schema') == 1 and
            set(record.get('before', {})) == set(release_files(record['release'])),
            'INVALID_BACKUP_MANIFEST')
    if package is not None:
        require(record['release'] == package['manifest'], 'BACKUP_RELEASE_MISMATCH')
    for name, before in record['before'].items():
        require(type(before.get('exists')) is bool, 'INVALID_BACKUP_FILE_STATE')
        if before['exists']:
            state, unused = read_state(backup / 'old' / name)
            require(state.get('sha256') == before['sha256'] and
                    state.get('size') == before['size'], 'BACKUP_HASH_MISMATCH: ' + name)
            require(all(type(before.get(k)) is int for k in ('mode', 'uid', 'gid')) and
                    0 <= before['mode'] <= 0o7777 and min(before['uid'], before['gid']) >= 0,
                    'INVALID_BACKUP_METADATA')


def _rollback(backup, record, package=None):
    verify_backup(backup, record, package)
    files = release_files(record['release'])
    entries = {e['path']: e for e in record['release']['files']}
    current = {}
    for name in files:
        state, unused = read_state(ROOT / name)
        current[name] = state
        before = record['before'][name]
        allowed = {entries[name]['sha256'], before.get('sha256')}
        require((state.get('sha256') in allowed if state['exists'] else not before['exists']),
                'ROLLBACK_REFUSED_MODIFIED_FILE: ' + name)
        if before['exists'] and state['exists']:
            require(all(state[key] == before[key] for key in ('mode', 'uid', 'gid')),
                    'ROLLBACK_REFUSED_CHANGED_METADATA: ' + name)
    old_bytes = sum(s.get('size', 0) for s in record['before'].values())
    disk_check(0, old_bytes)
    journal = {'schema': 1, 'phase': 'rolling_back', 'pending': None, 'restored': []}
    write_json(backup / 'journal.json', journal)
    staged = {}
    try:
        for name in files:
            before = record['before'][name]
            if before['exists'] and current[name] != before:
                unused, data = read_state(backup / 'old' / name)
                staged[name] = stage_file(ROOT / name, data, before)
        # Restore entry references before withdrawing their new dependencies.
        for name in reversed(files):
            target, before = ROOT / name, record['before'][name]
            same_state(target, current[name])
            journal['pending'] = name
            write_json(backup / 'journal.json', journal)
            if name in staged:
                os.replace(str(staged[name]), str(target))
                del staged[name]
                fsync_directory(target.parent)
            elif not before['exists'] and current[name]['exists']:
                target.unlink()
                fsync_directory(target.parent)
            same_state(target, before)
            journal['restored'].append(name)
            journal['pending'] = None
            write_json(backup / 'journal.json', journal)
        journal['phase'] = 'rolled_back'
        write_json(backup / 'journal.json', journal)
    finally:
        for temporary in staged.values():
            temporary.unlink(missing_ok=True)
    if guard_states(record['release']) != record['guards']:
        print('GUARD_CHANGED: files outside this release changed; none were restored', flush=True)
    print('ROLLBACK_OK: all ' + str(len(files)) +
          ' original file states verified; no services restarted', flush=True)


def rollback_release(backup_dir, package=None):
    backup = Path(backup_dir).absolute()
    require(backup.parent == BACKUP_ROOT, 'BACKUP_NOT_A_DIRECT_CHILD')
    safe_path(ROOT)
    safe_path(backup)
    with release_lock():
        unused, data = read_state(backup / 'backup.json')
        require(data is not None, 'BACKUP_MANIFEST_MISSING')
        _rollback(backup, json.loads(data.decode('utf-8')), package)


def apply_release(package):
    files = release_files(package['manifest'])
    # Reject an invalid target without creating even the private lock directory.
    preliminary = preflight(package)
    if preliminary['no_change']:
        print('NO_CHANGE: all ' + str(len(files)) + ' resources already match this release', flush=True)
        return None
    with release_lock():
        checked = preflight(package)
        if checked['no_change']:
            print('NO_CHANGE: all ' + str(len(files)) + ' resources already match this release', flush=True)
            return None
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ-')
        backup = Path(tempfile.mkdtemp(prefix=stamp, dir=str(BACKUP_ROOT)))
        fsync_directory(BACKUP_ROOT)
        record = {'schema': 1, 'release': package['manifest'],
                  'before': checked['states'], 'guards': checked['guards']}
        for name, before in record['before'].items():
            same_state(ROOT / name, before)
            if before['exists']:
                unused, content = read_state(ROOT / name)
                require(digest(content) == before['sha256'], 'SOURCE_CHANGED_BEFORE_BACKUP')
                destination = backup / 'old' / name
                make_directories(destination.parent, 0o700)
                temporary = stage_file(destination, content,
                    {'mode': 0o600, 'uid': os.geteuid(), 'gid': os.getegid()})
                os.replace(str(temporary), str(destination))
                fsync_directory(destination.parent)
        write_json(backup / 'backup.json', record)
        verify_backup(backup, record, package)
        print('BACKUP=' + str(backup), flush=True)
        print('ROLLBACK_COMMAND: python3 ' + shlex.quote(str(Path(sys.argv[0]).absolute())) +
              ' --rollback ' + shlex.quote(str(backup)), flush=True)
        staged = {}
        journal = {'schema': 1, 'phase': 'staging', 'pending': None, 'promoted': []}
        write_json(backup / 'journal.json', journal)
        try:
            root_info = ROOT.stat()
            for entry in package['manifest']['files']:
                name = entry['path']
                metadata = record['before'][name] if record['before'][name]['exists'] else {
                    'mode': 0o644, 'uid': root_info.st_uid, 'gid': root_info.st_gid}
                staged[name] = stage_file(ROOT / name, package['payload'][name], metadata)
            for name, before in record['before'].items():
                same_state(ROOT / name, before)
            require(guard_states(package['manifest']) == record['guards'], 'GUARD_CHANGED_BEFORE_PROMOTION')
            journal['phase'] = 'applying'
            for name in files:
                same_state(ROOT / name, record['before'][name])
                journal['pending'] = name
                write_json(backup / 'journal.json', journal)
                os.replace(str(staged[name]), str(ROOT / name))
                del staged[name]
                fsync_directory((ROOT / name).parent)
                journal['promoted'].append(name)
                journal['pending'] = None
                write_json(backup / 'journal.json', journal)
            for entry in package['manifest']['files']:
                actual, unused = read_state(ROOT / entry['path'])
                require(actual.get('sha256') == entry['sha256'] and actual.get('size') == entry['size'],
                        'POST_RELEASE_HASH_MISMATCH: ' + entry['path'])
            require(guard_states(package['manifest']) == record['guards'], 'GUARD_CHANGED_AFTER_PROMOTION')
            journal['phase'] = 'applied'
            write_json(backup / 'journal.json', journal)
        except BaseException as error:
            print('RELEASE_FAILED; attempting rollback from ' + str(backup), flush=True)
            try:
                _rollback(backup, record, package)
            except BaseException as rollback_error:
                raise ReleaseError('AUTOMATIC_ROLLBACK_INCOMPLETE; use backup ' + str(backup) +
                                   '; reason: ' + str(rollback_error)) from error
            raise ReleaseError('RELEASE_FAILED_AND_ROLLED_BACK: ' + str(error)) from error
        finally:
            for temporary in staged.values():
                temporary.unlink(missing_ok=True)
        print('RELEASE_OK: all ' + str(len(files)) +
              ' local file hashes and unchanged guards verified; no services restarted', flush=True)
        print('Public website and authenticated video checks remain to be completed.', flush=True)
        return backup


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--check', action='store_true', help='read-only preflight (default)')
    actions.add_argument('--apply', action='store_true')
    actions.add_argument('--rollback', metavar='BACKUP_DIRECTORY')
    arguments = parser.parse_args(argv)
    try:
        package = load_package()
        if arguments.apply:
            apply_release(package)
        elif arguments.rollback:
            rollback_release(arguments.rollback, package)
        else:
            checked = preflight(package)
            print('NO_CHANGE' if checked['no_change'] else 'CHECK_OK: ' +
                  str(len(release_files(package['manifest']))) + '-file release ready; no files written')
        return 0
    except (ReleaseError, OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile,
            subprocess.SubprocessError) as error:
        print('ERROR: ' + str(error), file=sys.stderr, flush=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
