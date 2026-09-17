#!/usr/bin/env python3
"""Bounded KidneySphere HTTPS activation; Python 3.8+, stdlib only."""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time

NGINX_ROOT = Path('/etc/nginx')
VHOST = NGINX_ROOT / 'sites-enabled/kidneysphere.com'
ROOT = Path('/var/www/kidneysphere')
BACKUP_ROOT = Path('/root/kidneysphere-https-releases')
ACME_ROOT = Path('/var/lib/kidneysphere-acme')
CERT = Path('/etc/letsencrypt/live/kidneysphere.com/fullchain.pem')
KEY = Path('/etc/letsencrypt/live/kidneysphere.com/privkey.pem')
PRIVATE_IP = '172.24.33.51'
DOMAINS = ('kidneysphere.com', 'www.kidneysphere.com')
MARKER = '# KidneySphere HTTPS managed addition v1'


class ReleaseError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise ReleaseError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def run(args, data=None):
    return subprocess.run(args, input=data, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=35)


def safe_path(path, missing=False):
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
        require(current == path or stat.S_ISDIR(info.st_mode), 'NON_DIRECTORY')
    return path


def state(path):
    safe_path(path)
    fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode), 'NOT_REGULAR_FILE: ' + str(path))
        require(info.st_size <= 8 * 1024 * 1024, 'FILE_TOO_LARGE')
        data = stream.read()
    return {'sha256': digest(data), 'mode': stat.S_IMODE(info.st_mode),
            'uid': info.st_uid, 'gid': info.st_gid}, data


def target_path():
    safe_path(VHOST.parent)
    require(VHOST.exists(), 'VHOST_MISSING')
    target = VHOST.resolve(strict=True)
    require(NGINX_ROOT in target.parents, 'VHOST_TARGET_OUTSIDE_NGINX')
    safe_path(target)
    info, data = state(target)
    require(info['uid'] == 0 and not info['mode'] & 0o022, 'UNSAFE_CONFIG_OWNER_OR_MODE')
    return target, {'target': str(target), 'link': os.readlink(str(VHOST))
                    if VHOST.is_symlink() else None}, info, data


def parse_config(data):
    """Conservative lexer/parser with byte-preserving token offsets."""
    text = data.decode('utf-8') if isinstance(data, bytes) else data
    tokens, i = [], 0
    while i < len(text):
        if text[i].isspace():
            i += 1
            continue
        if text[i] == '#':
            end = text.find('\n', i)
            i = len(text) if end < 0 else end + 1
            continue
        start = i
        if text[i] in '{};':
            tokens.append((text[i], i, i + 1))
            i += 1
            continue
        value, quote = '', None
        while i < len(text):
            char = text[i]
            if char == '\\' and i + 1 < len(text):
                value += text[i:i + 2]
                i += 2
                continue
            if quote:
                if char == quote:
                    quote = None
                else:
                    value += char
                i += 1
                continue
            if char in '\"\'':
                quote = char
                i += 1
                continue
            if char.isspace() or char in '{};#':
                break
            value += char
            i += 1
        require(quote is None and i > start, 'UNSUPPORTED_NGINX_TOKEN')
        tokens.append((value, start, i))

    def group(pos, nested=False):
        result = []
        while pos < len(tokens):
            if tokens[pos][0] == '}':
                require(nested, 'UNEXPECTED_CLOSING_BRACE')
                return result, pos + 1
            words = []
            while pos < len(tokens) and tokens[pos][0] not in '{};':
                words.append(tokens[pos][0])
                pos += 1
            require(words and pos < len(tokens), 'INCOMPLETE_NGINX_DIRECTIVE')
            delimiter, start, end = tokens[pos]
            pos += 1
            node = {'words': words, 'open': end, 'children': None}
            if delimiter == '{':
                node['children'], pos = group(pos, True)
            else:
                require(delimiter == ';', 'UNEXPECTED_NGINX_DELIMITER')
            result.append(node)
        require(not nested, 'UNCLOSED_NGINX_BLOCK')
        return result, pos
    return group(0)[0]


def flatten(nodes):
    for node in nodes:
        yield node
        yield from flatten(node['children'] or [])


def addition():
    return ('\n    ' + MARKER + '\n'
            '    listen 443 ssl;\n    listen [::]:443 ssl;\n'
            '    ssl_certificate ' + str(CERT) + ';\n'
            '    ssl_certificate_key ' + str(KEY) + ';\n'
            '    ssl_protocols TLSv1.2 TLSv1.3;\n'
            '    location ^~ /.well-known/acme-challenge/ {\n'
            '        root ' + str(ACME_ROOT) + ';\n'
            '        default_type text/plain;\n        try_files $uri =404;\n'
            '    }\n    # End KidneySphere HTTPS managed addition v1\n')


def patch_config(data):
    text = data.decode('utf-8')
    block = addition()
    if MARKER in text:
        require(text.count(block) == 1, 'MANAGED_ADDITION_CHANGED')
        original = text.replace(block, '', 1).encode('utf-8')
        require(patch_config(original) == data, 'MANAGED_ADDITION_POSITION_CHANGED')
        return data
    nodes = parse_config(text)
    require(len(nodes) == 1 and nodes[0]['words'] == ['server'] and
            nodes[0]['children'] is not None, 'EXPECTED_SINGLE_SERVER_BLOCK')
    children = nodes[0]['children']
    by_name = lambda name: [n['words'][1:] for n in children if n['words'][0] == name]
    require(by_name('listen') == [['80'], ['[::]:80']] or
            by_name('listen') == [['[::]:80'], ['80']], 'UNEXPECTED_LISTEN_DIRECTIVES')
    require(by_name('server_name') == [list(DOMAINS)], 'UNEXPECTED_SERVER_NAMES')
    require(by_name('root') == [[str(ROOT)]], 'UNEXPECTED_PORTAL_ROOT')
    require(by_name('index') == [['index.html']], 'UNEXPECTED_INDEX')
    for node in flatten(nodes):
        words = node['words']
        require(words[0] != 'include' and not words[0].startswith('ssl_'),
                'EXISTING_TLS_OR_INCLUDE_REQUIRES_REVIEW')
        require(words[0] not in ('alias', 'server') or node is nodes[0],
                'NESTED_SERVER_OR_ALIAS_REQUIRES_REVIEW')
        require(words[0] != 'root' or words[1:] == [str(ROOT)], 'NESTED_ROOT_REQUIRES_REVIEW')
        require(not any('.well-known' in v or 'acme-challenge' in v for v in words),
                'EXISTING_ACME_ROUTE_REQUIRES_REVIEW')
    offset = nodes[0]['open']
    return (text[:offset] + block + text[offset:]).encode('utf-8')


def validate_certificates():
    for path in (CERT, KEY):
        require(path.exists(), 'CERTIFICATE_OR_KEY_MISSING')
        target = path.resolve(strict=True)
        allowed = path.parents[2]
        require(target == path or allowed in target.parents, 'CERTIFICATE_LINK_OUTSIDE_LETSENCRYPT')
        safe_path(target)
        info = target.stat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and
                not stat.S_IMODE(info.st_mode) & 0o022, 'UNSAFE_CERTIFICATE_FILE')
    result = run(['openssl', 'x509', '-in', str(CERT), '-noout', '-checkend', '86400'])
    require(result.returncode == 0, 'CERTIFICATE_EXPIRED_OR_EXPIRING')
    for domain in DOMAINS:
        result = run(['openssl', 'x509', '-in', str(CERT), '-noout', '-checkhost', domain])
        require(result.returncode == 0 and result.stdout.decode().strip() ==
                'Hostname ' + domain + ' does match certificate', 'CERTIFICATE_NAME_MISMATCH: ' + domain)
    result = run(['openssl', 'verify', '-untrusted', str(CERT), str(CERT)])
    require(result.returncode == 0, 'CERTIFICATE_CHAIN_UNTRUSTED')
    public_cert = run(['openssl', 'x509', '-in', str(CERT), '-pubkey', '-noout'])
    public_key = run(['openssl', 'pkey', '-in', str(KEY), '-pubout'])
    require(public_cert.returncode == public_key.returncode == 0 and
            digest(public_cert.stdout) == digest(public_key.stdout), 'CERTIFICATE_KEY_MISMATCH')


def nginx_snapshot():
    result = run(['nginx', '-T'])
    require(result.returncode == 0, 'NGINX_CONFIGURATION_CHECK_FAILED')
    pieces = re.split(r'^# configuration file (.+):\s*$', result.stdout.decode(), flags=re.M)
    require(len(pieces) > 1, 'NGINX_CONFIGURATION_SOURCES_MISSING')
    target = VHOST.resolve(strict=True)
    guards, names_seen, target_seen = {}, 0, 0
    for i in range(1, len(pieces), 2):
        path = Path(pieces[i])
        resolved = path.resolve(strict=True)
        metadata, contents = state(resolved)
        require(contents.decode().strip() == pieces[i + 1].strip(), 'NGINX_CONFIG_READ_DRIFT')
        nodes = parse_config(contents)
        for node in flatten(nodes):
            if node['words'][0] != 'server_name':
                continue
            names = node['words'][1:]
            touches = any('kidneysphere.com' in name for name in names)
            if touches:
                require(resolved == target and names == list(DOMAINS), 'CONFLICTING_PORTAL_SERVER_NAME')
                names_seen += 1
        if resolved == target:
            target_seen += 1
        else:
            guards[str(path)] = {'target': str(resolved), 'state': metadata}
    require(target_seen == names_seen == 1, 'PORTAL_VHOST_NOT_UNIQUE')
    return guards


def check_guards(guards):
    for path, expected in guards.items():
        resolved = Path(path).resolve(strict=True)
        require(str(resolved) == expected['target'] and state(resolved)[0] == expected['state'],
                'OTHER_CONFIG_DRIFT: ' + path)


def preflight():
    require(os.geteuid() == 0, 'ROOT_REQUIRED')
    result = run(['ip', '-j', '-4', 'address', 'show', 'scope', 'global'])
    require(result.returncode == 0 and any(a.get('local') == PRIVATE_IP
            for interface in json.loads(result.stdout) for a in interface.get('addr_info', [])),
            'SERVER_PRIVATE_IP_MISMATCH')
    safe_path(ROOT)
    require(ROOT.is_dir(), 'PORTAL_ROOT_MISSING')
    target, mapping, metadata, data = target_path()
    patched = patch_config(data)
    validate_certificates()
    guards = nginx_snapshot()
    safe_path(BACKUP_ROOT, missing=True)
    safe_path(ACME_ROOT, missing=True)
    for path in (ACME_ROOT, ACME_ROOT / '.well-known', ACME_ROOT / '.well-known/acme-challenge'):
        safe_path(path, missing=True)
        if path.exists():
            info = path.stat()
            require(path.is_dir() and info.st_uid == 0 and not stat.S_IMODE(info.st_mode) & 0o022,
                    'UNSAFE_ACME_DIRECTORY')
    for path in (target.parent, BACKUP_ROOT.parent):
        require(shutil.disk_usage(str(path)).free > 16 * 1024 * 1024, 'INSUFFICIENT_DISK_SPACE')
    return {'mapping': mapping, 'before': metadata, 'old': data, 'new': patched,
            'guards': guards, 'no_change': data == patched}


def sync_directory(path):
    fd = os.open(str(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_write(path, data, metadata):
    safe_path(path, missing=True)
    fd, temp = tempfile.mkstemp(prefix='.kidneysphere-https-', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fchown(stream.fileno(), metadata['uid'], metadata['gid'])
            os.fchmod(stream.fileno(), metadata['mode'])
            os.fsync(stream.fileno())
        os.replace(temp, str(path))
        sync_directory(path.parent)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


PRIVATE = {'uid': 0, 'gid': 0, 'mode': 0o600}


def journal(backup, record, phase):
    record['phase'] = phase
    atomic_write(backup / 'backup.json', json.dumps(record, sort_keys=True).encode(), PRIVATE)


@contextlib.contextmanager
def release_lock():
    safe_path(BACKUP_ROOT, missing=True)
    BACKUP_ROOT.mkdir(mode=0o700, exist_ok=True)
    info = BACKUP_ROOT.stat()
    require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'UNSAFE_BACKUP_DIRECTORY')
    path = BACKUP_ROOT / '.release.lock'
    safe_path(path, missing=True)
    fd = os.open(str(path), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        require(stat.S_ISREG(os.fstat(fd).st_mode), 'INVALID_LOCK_FILE')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ReleaseError('ANOTHER_HTTPS_RELEASE_IS_RUNNING')
        yield
    finally:
        os.close(fd)


def reload_nginx():
    require(run(['nginx', '-t']).returncode == 0, 'NGINX_TEST_FAILED')
    require(run(['systemctl', 'reload', 'nginx']).returncode == 0, 'NGINX_RELOAD_FAILED')


def curl_request(domain, path, port=443, post=False):
    scheme = 'https' if port == 443 else 'http'
    args = ['curl', '--noproxy', '*', '-sS', '--connect-timeout', '3', '--max-time', '10',
            '--max-redirs', '0', '--resolve', domain + ':' + str(port) + ':127.0.0.1',
            '-w', '\n%{http_code}', scheme + '://' + domain + path]
    if post:
        args += ['-X', 'POST']
    result = run(args)
    require(result.returncode == 0, 'LOCAL_HTTP_OR_TLS_CHECK_FAILED: ' + domain + path)
    body, code = result.stdout.rsplit(b'\n', 1)
    return int(code), body


def runtime_checks():
    for domain in DOMAINS:
        code, body = curl_request(domain, '/index.html')
        require(code == 200 and b'portal-home.css' in body and
                '肾脏专科视频课程与培训报名'.encode() in body, 'NEW_HOMEPAGE_CHECK_FAILED')
    code, body = curl_request(DOMAINS[0], '/api/health')
    require(code == 200 and json.loads(body).get('status') == 'ok', 'API_HEALTH_CHECK_FAILED')
    code, body = curl_request(DOMAINS[0],
        '/api/videos/00000000-0000-0000-0000-000000000000/play-auth', post=True)
    require(code == 401 and json.loads(body).get('error') == 'unauthorized', 'VIDEO_AUTH_GATE_CHECK_FAILED')
    challenge = ACME_ROOT / '.well-known/acme-challenge'
    for path in (ACME_ROOT, ACME_ROOT / '.well-known', challenge):
        safe_path(path, missing=True)
        path.mkdir(mode=0o755, exist_ok=True)
        info = path.stat()
        require(info.st_uid == 0 and not stat.S_IMODE(info.st_mode) & 0o022, 'UNSAFE_ACME_DIRECTORY')
    fd, name = tempfile.mkstemp(prefix='kidneysphere-check-', dir=str(challenge))
    probe = Path(name)
    token = os.urandom(24).hex().encode()
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(token)
            stream.flush()
            os.fchmod(stream.fileno(), 0o644)
            os.fsync(stream.fileno())
        for domain in DOMAINS:
            for port in (80, 443):
                code, body = curl_request(domain, '/.well-known/acme-challenge/' + probe.name, port)
                require(code == 200 and body == token, 'ACME_ROUTE_CHECK_FAILED')
    finally:
        if probe.exists() and not probe.is_symlink() and probe.read_bytes() == token:
            probe.unlink()


def restore(backup):
    backup = Path(backup)
    safe_path(backup)
    require(backup.parent == BACKUP_ROOT, 'INVALID_BACKUP_LOCATION')
    info = backup.stat()
    require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'UNSAFE_BACKUP_DIRECTORY')
    record = json.loads(state(backup / 'backup.json')[1])
    require(record.get('schema') == 1 and record.get('vhost') == str(VHOST), 'INVALID_BACKUP_RECORD')
    old = state(backup / 'original.conf')[1]
    new = state(backup / 'updated.conf')[1]
    require(digest(old) == record['before']['sha256'] and digest(new) == record['after_sha256'] and
            patch_config(old) == new, 'BACKUP_CONTENT_MISMATCH')
    target, mapping, current, unused = target_path()
    require(mapping == record['mapping'], 'VHOST_TARGET_DRIFT')
    for key in ('uid', 'gid', 'mode'):
        require(current[key] == record['before'][key], 'CONFIG_METADATA_DRIFT')
    require(current['sha256'] in (record['before']['sha256'], record['after_sha256']),
            'CONFIG_CHANGED_BY_ANOTHER_ACTOR; no rollback writes performed')
    check_guards(record['guards'])
    journal(backup, record, 'restoring')
    atomic_write(target, old, record['before'])
    require(state(target)[0] == record['before'], 'RESTORE_HASH_OR_METADATA_FAILED')
    check_guards(record['guards'])
    reload_nginx()
    journal(backup, record, 'rolled_back')
    print('ROLLBACK_OK: original portal config restored; nginx gracefully reloaded', flush=True)


def rollback_release(backup):
    require(os.geteuid() == 0, 'ROOT_REQUIRED')
    with release_lock():
        restore(backup)


def apply_release():
    preflight()
    with release_lock():
        prepared = preflight()
        if prepared['no_change']:
            runtime_checks()
            print('NO_CHANGE: managed HTTPS addition and local checks verified')
            return
        backup = Path(tempfile.mkdtemp(prefix=datetime.datetime.utcnow().strftime('%Y%m%dT%H%M%SZ-'),
                                      dir=str(BACKUP_ROOT)))
        atomic_write(backup / 'original.conf', prepared['old'], PRIVATE)
        atomic_write(backup / 'updated.conf', prepared['new'], PRIVATE)
        record = {'schema': 1, 'vhost': str(VHOST), 'mapping': prepared['mapping'],
                  'before': prepared['before'], 'after_sha256': digest(prepared['new']),
                  'guards': prepared['guards']}
        journal(backup, record, 'backed_up')
        require(state(backup / 'original.conf')[1] == prepared['old'] and
                state(backup / 'updated.conf')[1] == prepared['new'], 'BACKUP_VERIFICATION_FAILED')
        print('BACKUP=' + str(backup), flush=True)
        print('ROLLBACK_COMMAND: python3 ' + shlex.quote(str(Path(sys.argv[0]).resolve())) +
              ' --rollback ' + shlex.quote(str(backup)), flush=True)
        try:
            target, mapping, current, unused = target_path()
            require(mapping == prepared['mapping'] and current == prepared['before'], 'CONFIG_DRIFT_BEFORE_WRITE')
            check_guards(prepared['guards'])
            journal(backup, record, 'promoting')
            atomic_write(target, prepared['new'], prepared['before'])
            require(state(target)[1] == prepared['new'], 'PROMOTED_CONFIG_HASH_MISMATCH')
            check_guards(prepared['guards'])
            journal(backup, record, 'reloading')
            reload_nginx()
            journal(backup, record, 'checking')
            try:
                runtime_checks()
            except (ReleaseError, ValueError):
                time.sleep(1)
                runtime_checks()
            unused, final_mapping, final_state, unused = target_path()
            expected = dict(prepared['before'], sha256=record['after_sha256'])
            require(final_mapping == prepared['mapping'] and final_state == expected,
                    'CONFIG_DRIFT_AFTER_CHECKS')
            check_guards(prepared['guards'])
            journal(backup, record, 'complete')
        except Exception as error:
            print('APPLY_FAILED: ' + str(error), flush=True)
            try:
                restore(backup)
            except Exception as restore_error:
                raise ReleaseError('ROLLBACK_REQUIRES_REVIEW: ' + str(restore_error)) from error
            raise ReleaseError('HTTPS activation failed; original configuration restored') from error
        print('HTTPS_OK: both local TLS names, homepage, API, auth gate and ACME route verified', flush=True)
        print('DNS cutover, public checks, paid video playback and automatic renewal remain to be completed.', flush=True)
        return backup


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--check', action='store_true')
    group.add_argument('--apply', action='store_true')
    group.add_argument('--rollback', metavar='BACKUP_DIRECTORY')
    args = parser.parse_args()
    try:
        if args.rollback:
            rollback_release(args.rollback)
        elif args.apply:
            apply_release()
        else:
            prepared = preflight()
            print('CHECK_OK: ' + ('managed addition already present' if prepared['no_change'] else
                  'ready to add portal HTTPS; no files written'))
        return 0
    except Exception as error:
        print('ERROR: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
