#!/usr/bin/env python3
"""Inspect and release fixed audio profiles against a verified live API process."""
import argparse
import hashlib
import importlib.util
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
import zipfile

try:
    import release_core as core
except ModuleNotFoundError:
    spec = importlib.util.spec_from_file_location('audio_release_core', Path(__file__).with_name('portal-release.py'))
    core = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(core)

ReleaseError = core.ReleaseError
require = core.require
digest = core.digest
ROOT = Path('/var/www/kidneysphere')
BACKUP_ROOT = Path('/root/kidneysphere-audio-releases')
PROC = Path('/proc')
VHOST = Path('/etc/nginx/sites-enabled/kidneysphere.com')
BACKEND_FILES = ('netlify/functions/video-upload-auth.js', 'netlify/functions/video-play-auth.js')
FRONTEND_FILES = ('media-upload.js', 'media-player.js', 'media-player.css',
                  'learning-center.js', 'watch.html', 'learning.html')
FILES = BACKEND_FILES + FRONTEND_FILES
NEW_FILES = frozenset(('media-upload.js', 'media-player.js', 'media-player.css'))
BATCH_FRONTEND_FILES = ('media-upload.js', 'media-player.js', 'media-player.css',
                        'vod-upload.js', 'media-batch.js', 'media-batch-save.js',
                        'media-batch.css', 'media-batch-ui.js',
                        'learning-center.js', 'watch.html', 'learning.html')
BATCH_NEW_FILES = NEW_FILES | frozenset(('vod-upload.js', 'media-batch.js', 'media-batch-save.js',
                                       'media-batch.css', 'media-batch-ui.js'))
PROFILES = {'audio-v1': (FRONTEND_FILES, NEW_FILES),
            'audio-batch-v1': (BATCH_FRONTEND_FILES, BATCH_NEW_FILES)}
SAFE_ENV = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8'}

# Only the transport libraries are loaded: PM2's public Client auto-initializes
# files and can spawn a daemon, so it must never be used by --inspect.
PM2_RPC_JS = r'''
const fs = require('fs');
const [root, socketPath, operation, expectedText] = process.argv.slice(2);
let socket, timer, finished = false;
const finish = (code, value) => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (socket) { try { socket.close(); } catch (_) {} }
  if (value) process.stdout.write(JSON.stringify(value));
  setTimeout(() => process.exit(code), 5);
};
try {
  const expected = JSON.parse(expectedText);
  const axon = require(require.resolve('pm2-axon', {paths:[root]}));
  const rpc = require(require.resolve('pm2-axon-rpc', {paths:[root]}));
  socket = axon.socket('req');
  socket.set('retry timeout', 0);
  socket.on('error', () => finish(2));
  const client = new rpc.Client(socket);
  timer = setTimeout(() => finish(3), 5000);
  socket.connect(socketPath);
  client.call('getMonitorData', {}, (error, rows) => {
    if (error || !Array.isArray(rows)) return finish(4);
    const matches = rows.filter(row => expected.id === undefined ? row.pid === expected.pid : row.pm_id === expected.id);
    if (matches.length !== 1) return finish(5);
    const row = matches[0], env = row.pm2_env || {};
    const target = {pid:row.pid, id:row.pm_id, name:env.name || row.name,
      cwd:env.pm_cwd, entry:env.pm_exec_path, status:env.status, mode:env.exec_mode, watch:Boolean(env.watch)};
    if (operation === 'inspect') return finish(0, target);
    if (operation !== 'restart' || target.id !== expected.id || target.pid !== expected.pid ||
        target.cwd !== expected.cwd || target.entry !== expected.entry || target.mode !== 'fork_mode' || target.watch) return finish(6);
    client.call('restartProcessId', {id:target.id}, error => finish(error ? 7 : 0, error ? null : {restarted:target.id}));
  });
} catch (_) { finish(8); }
'''


def run(command, data=None, timeout=15):
    result = subprocess.run(command, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, env=SAFE_ENV)
    require(result.returncode == 0, 'COMMAND_FAILED: ' + Path(command[0]).name + ' (details withheld)')
    return result.stdout


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def release_profile(manifest=None):
    name = manifest.get('profile') if manifest is not None else 'audio-v1'
    require(name in PROFILES, 'UNKNOWN_AUDIO_RELEASE_PROFILE')
    return PROFILES[name]


def release_files(manifest=None):
    return BACKEND_FILES + release_profile(manifest)[0]


def backend_changes(before, package):
    return any(before[name].get('sha256') != digest(package['payload'][name]) for name in BACKEND_FILES)


def load_package(source=None):
    with zipfile.ZipFile(str(source or sys.argv[0])) as archive:
        require(len(archive.namelist()) == len(set(archive.namelist())), 'PACKAGE_ENTRY_MISMATCH')
        require(all(e.file_size <= 8 * 1024 * 1024 for e in archive.infolist()), 'PACKAGE_ENTRY_TOO_LARGE')
        manifest = json.loads(archive.read('manifest.json'))
        files = release_files(manifest)
        optional_files = release_profile(manifest)[1]
        expected = {'__main__.py', 'release_core.py', 'manifest.json'} | {'payload/' + p for p in files}
        require(set(archive.namelist()) == expected, 'PACKAGE_ENTRY_MISMATCH')
        require(manifest.get('schema') == 1 and
                manifest.get('root') == str(ROOT) and manifest.get('domain') == 'kidneysphere.com',
                'PACKAGE_TARGET_MISMATCH')
        require(re.fullmatch('[0-9a-f]{40}', manifest.get('commit', '')) is not None, 'INVALID_COMMIT')
        require([e.get('path') for e in manifest.get('files', [])] == list(files), 'PACKAGE_FILE_ALLOWLIST_MISMATCH')
        for name, key in (('__main__.py', 'runner_sha256'), ('release_core.py', 'core_sha256')):
            require(digest(archive.read(name)) == manifest.get(key), 'PACKAGE_CODE_HASH_MISMATCH')
        for entry in manifest['files']:
            require(re.fullmatch('[0-9a-f]{64}', entry.get('sha256', '')) is not None and
                    type(entry.get('size')) is int and 0 <= entry['size'] <= 8 * 1024 * 1024,
                    'INVALID_RESOURCE_MANIFEST')
            require(type(entry.get('allow_missing')) is bool and
                    (entry['path'] in optional_files or not entry['allow_missing']) and
                    isinstance(entry.get('allowed_before'), list) and
                    all(re.fullmatch('[0-9a-f]{64}', h) for h in entry['allowed_before']), 'INVALID_BASELINE_MANIFEST')
        require(manifest.get('server_entry_hashes') and all(re.fullmatch('[0-9a-f]{64}', h)
                for h in manifest['server_entry_hashes']), 'INVALID_SERVER_ENTRY_HASHES')
        payload = {name: archive.read('payload/' + name) for name in files}
    for entry in manifest['files']:
        require(len(payload[entry['path']]) == entry['size'] and digest(payload[entry['path']]) == entry['sha256'],
                'PAYLOAD_HASH_MISMATCH: ' + entry['path'])
    return {'manifest': manifest, 'payload': payload}


def listener_pid(optional=False):
    output = run(['ss', '-H', '-ltnp', 'sport = :3001']).decode('utf-8')
    pids = {int(value) for value in re.findall(r'\bpid=(\d+)', output)}
    if optional and not output.strip():
        return None
    require(len(pids) == 1 and output.strip(), 'PORT_3001_LISTENER_NOT_UNIQUE_OR_VISIBLE')
    return pids.pop()


def process_info(pid):
    directory = PROC / str(pid)
    info = (directory / 'stat').read_text().split(') ', 1)[1].split()
    uid_match = re.search(r'^Uid:\s+(\d+)\s+(\d+)', (directory / 'status').read_text(), re.M)
    require(uid_match and uid_match[1] == uid_match[2] == '0', 'API_MANAGER_MUST_RUN_AS_ROOT')
    argv = (directory / 'cmdline').read_bytes().rstrip(b'\0').split(b'\0')
    return {'pid': pid, 'parent': int(info[1]), 'start': info[19],
            'cwd': str((directory / 'cwd').resolve(strict=True)),
            'node': str((directory / 'exe').resolve(strict=True)),
            'argv': [value.decode('utf-8') for value in argv]}


def safe_executable(path):
    resolved = Path(path).resolve(strict=True)
    core.safe_path(resolved)
    state = resolved.stat()
    require(stat.S_ISREG(state.st_mode) and state.st_uid == 0 and not state.st_mode & 0o022,
            'UNTRUSTED_EXECUTABLE')
    return str(resolved)


def pm2_descriptor(daemon):
    match = re.fullmatch(r'PM2 v[^:]+: God Daemon \((/[^\r\n)]+)\)', daemon['argv'][0])
    require(match, 'PM2_DAEMON_TITLE_UNRECOGNIZED')
    directory = Path(match[1])
    core.safe_path(directory)
    require(directory.stat().st_uid == 0, 'PM2_HOME_OWNER_MISMATCH')
    require((directory / 'pm2.pid').read_text().strip() == str(daemon['pid']), 'PM2_PID_FILE_MISMATCH')
    socket = directory / 'rpc.sock'
    socket_state = socket.lstat()
    require(stat.S_ISSOCK(socket_state.st_mode) and socket_state.st_uid == 0, 'PM2_RPC_SOCKET_INVALID')
    kernel_inodes = {row.split(maxsplit=7)[6] for row in (PROC / 'net/unix').read_text().splitlines()[1:]
                     if len(row.split(maxsplit=7)) == 8 and row.split(maxsplit=7)[7] == str(socket)}
    sockets = {os.readlink(str(path)) for path in (PROC / str(daemon['pid']) / 'fd').iterdir()}
    require(any('socket:[' + inode + ']' in sockets for inode in kernel_inodes), 'PM2_SOCKET_NOT_OWNED_BY_DAEMON')
    search_path = str(Path(daemon['node']).parent) + ':' + SAFE_ENV['PATH']
    binary = shutil.which('pm2', path=search_path)
    require(binary is not None, 'EXISTING_PM2_INSTALLATION_NOT_FOUND')
    package_root = Path(safe_executable(binary)).parent.parent
    metadata = json.loads((package_root / 'package.json').read_text())
    require(metadata.get('name') == 'pm2', 'PM2_PACKAGE_NOT_IDENTIFIED')
    return {'kind': 'pm2', 'daemon_pid': daemon['pid'], 'daemon_start': daemon['start'],
            'node': safe_executable(daemon['node']), 'home': str(directory), 'package': str(package_root),
            'socket': str(socket), 'socket_inode': socket_state.st_ino, 'socket_device': socket_state.st_dev}


def pm2_rpc(descriptor, operation, expected):
    require(pm2_descriptor(process_info(descriptor['daemon_pid'])) == descriptor, 'PM2_DAEMON_OR_SOCKET_CHANGED')
    raw = run([descriptor['node'], '-', descriptor['package'], descriptor['socket'], operation,
               json.dumps(expected, separators=(',', ':'))], PM2_RPC_JS.encode('utf-8'), timeout=8)
    return json.loads(raw)


def unit_info(unit):
    require(re.fullmatch(r'[A-Za-z0-9_.@:-]+\.service', unit), 'INVALID_SYSTEMD_UNIT')
    properties = ('Id', 'MainPID', 'User', 'WorkingDirectory', 'FragmentPath', 'DropInPaths', 'ExecStart')
    raw = run(['systemctl', 'show', unit, '--property=' + ','.join(properties)]).decode('utf-8')
    values = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
    require(values.get('Id') == unit and values.get('User', '') in ('', 'root'), 'SYSTEMD_UNIT_IDENTITY_MISMATCH')
    fragments = [values.get('FragmentPath', '')] + shlex.split(values.get('DropInPaths', ''))
    require(fragments[0], 'SYSTEMD_UNIT_WITHOUT_PERSISTENT_CONFIG_REFUSED')
    states = {str(Path(name).resolve(strict=True)): core.read_state(Path(name).resolve(strict=True))[0]
              for name in fragments if name}
    # ExecStart's human-readable value also contains volatile PID/timestamps.
    # Parse only one direct Node launch and exclude runtime fields from identity.
    launch = values.get('ExecStart', '')
    executable = re.search(r'\bpath=([^;]+?)\s*;', launch)
    arguments = re.search(r'\bargv\[\]=([^;]+?)\s*;', launch)
    require(launch.count('{') == 1 and executable and arguments, 'UNSUPPORTED_SYSTEMD_LAUNCH')
    argv = shlex.split(arguments[1])
    require(len(argv) == 2 and not argv[1].startswith('-'), 'UNSUPPORTED_SYSTEMD_ARGUMENTS (withheld)')
    node = str(Path(executable[1]).resolve(strict=True))
    require(Path(node).name in ('node', 'nodejs') and str(Path(argv[0]).resolve(strict=True)) == node,
            'SYSTEMD_NODE_EXECUTABLE_MISMATCH')
    cwd = str(Path(values.get('WorkingDirectory') or '/').resolve(strict=True))
    entry = Path(argv[1]) if Path(argv[1]).is_absolute() else Path(cwd) / argv[1]
    entry = str(entry.resolve(strict=True))
    config = {k: v for k, v in values.items() if k != 'MainPID'}
    config['ExecStart'] = {'node': node, 'entry': entry}
    return {'kind': 'systemd', 'unit': unit, 'pid': int(values.get('MainPID', '0')),
            'cwd': cwd, 'launch_node': node, 'launch_entry': entry,
            'config_sha256': digest(canonical_json({'properties': config, 'files': states}))}


def direct_entry(process):
    argv = process['argv']
    require(Path(process['node']).name in ('node', 'nodejs') and len(argv) == 2 and
            not argv[1].startswith('-'), 'UNSUPPORTED_NODE_COMMAND (raw arguments withheld)')
    entry = Path(argv[1])
    if not entry.is_absolute():
        entry = Path(process['cwd']) / entry
    return str(entry.resolve(strict=True))


def discover_runtime(package):
    pid = listener_pid()
    process = process_info(pid)
    ancestor = process
    descriptor = None
    for _ in range(10):
        if ancestor['argv'] and ancestor['argv'][0].startswith('PM2 '):
            descriptor = pm2_descriptor(ancestor)
            break
        if ancestor['parent'] <= 1:
            break
        ancestor = process_info(ancestor['parent'])
    if descriptor:
        target = pm2_rpc(descriptor, 'inspect', {'pid': pid})
        require(target.get('pid') == pid and type(target.get('id')) is int and target['id'] >= 0 and
                target.get('mode') == 'fork_mode' and target.get('status') == 'online' and
                target.get('watch') is False, 'UNSUPPORTED_PM2_TARGET_OR_WATCH_MODE')
        entry = str(Path(target['entry']).resolve(strict=True))
        require(str(Path(target['cwd']).resolve(strict=True)) == process['cwd'], 'PM2_WORKING_DIRECTORY_MISMATCH')
        manager = {'descriptor': descriptor, 'target': target}
    else:
        cgroup = (PROC / str(pid) / 'cgroup').read_text()
        units = set(re.findall(r'/([^/\n]+\.service)(?:/|$)', cgroup, flags=re.M))
        require(len(units) == 1, 'UNSUPPORTED_PROCESS_MANAGER; manual/nohup processes are not restarted')
        manager = unit_info(units.pop())
        require(manager['pid'] == pid, 'SYSTEMD_UNIT_MAINPID_MISMATCH; shared manager units are refused')
        entry = direct_entry(process)
        require(manager['cwd'] == process['cwd'] and manager['launch_node'] == process['node'] and
                manager['launch_entry'] == entry, 'SYSTEMD_LAUNCH_DOES_NOT_MATCH_RUNNING_API')
    state, source = core.read_state(Path(entry))
    require(state.get('sha256') in package['manifest']['server_entry_hashes'], 'UNKNOWN_SERVER_ENTRY_HASH: ' + entry)
    require(b"require('../netlify/functions/video-upload-auth.js')" in source and
            b"require('../netlify/functions/video-play-auth.js')" in source, 'BACKEND_REQUIRE_LAYOUT_MISMATCH')
    node = safe_executable(process['node'])
    return {'pid': pid, 'start': process['start'], 'cwd': process['cwd'], 'node': node,
            'entry': entry, 'entry_state': state, 'manager': manager}


def target_paths(runtime, manifest=None):
    backend_root = Path(runtime['entry']).parent.parent
    result = {name: backend_root / name for name in BACKEND_FILES}
    result.update((name, ROOT / name) for name in release_profile(manifest)[0])
    require(len(set(result.values())) == len(release_files(manifest)), 'DUPLICATE_TARGET_PATHS')
    for path in result.values():
        core.safe_path(path, missing=True)
    return result


def guard_states(runtime):
    paths = [VHOST.resolve(strict=True), Path(runtime['entry'])]
    paths.extend(ROOT / name for name in ('index.html', 'app.js', 'home.js', 'portal-home.js',
        'supabaseClient.js', 'assets/config.js', 'assets/videos.js', 'login.html', 'register.html'))
    backend_root = Path(runtime['entry']).parent.parent
    paths.extend(backend_root / 'netlify/functions' / name for name in ('video-access.js', 'dev-grant-access.js'))
    return {str(path): core.read_state(path)[0] for path in paths}


def runtime_identity(runtime):
    manager = json.loads(json.dumps(runtime['manager']))
    if 'descriptor' in manager:
        for name in ('pid', 'status'):
            manager['target'].pop(name, None)
    else:
        manager.pop('pid', None)
    identity = {name: runtime[name] for name in ('cwd', 'node', 'entry', 'entry_state')}
    identity['manager'] = manager
    return identity


def check_nginx():
    core.check_nginx()
    _, source = core.read_state(VHOST.resolve(strict=True))
    text = re.sub(rb'#[^\n]*', b'', source)
    require(re.search(rb'location\s+/api/\s*\{[^}]*proxy_pass\s+http://127\.0\.0\.1:3001/api/\s*;', text),
            'PORTAL_API_PROXY_NOT_CONFIRMED')


def inspect_release(package):
    require(os.geteuid() == 0, 'RUN_AS_ROOT')
    core.safe_path(ROOT)
    check_nginx()
    runtime = discover_runtime(package)
    targets = target_paths(runtime, package['manifest'])
    states, unknown = {}, []
    for entry in package['manifest']['files']:
        state, _ = core.read_state(targets[entry['path']])
        states[entry['path']] = state
        accepted = (state.get('sha256') in entry['allowed_before'] + [entry['sha256']]
                    if state['exists'] else entry['allow_missing'])
        if not accepted:
            unknown.append({'resource': entry['path'], 'sha256': state.get('sha256', 'MISSING')})
    report = {'runtime': runtime, 'targets': {k: str(v) for k, v in targets.items()},
              'states': states, 'guards': guard_states(runtime),
              'package_sha256': digest(canonical_json(package['manifest']))}
    report['inspection_sha256'] = digest(canonical_json(report))
    require(not unknown, 'UNKNOWN_RESOURCE_BASELINE: ' + json.dumps(unknown, separators=(',', ':')))
    return report


def check_syntax(package, runtime):
    for name, data in package['payload'].items():
        if name.endswith('.js'):
            mode = 'commonjs' if name in BACKEND_FILES else 'module'
            run([runtime['node'], '--input-type=' + mode, '--check'], data)


def request(path, method='GET'):
    command = ['curl', '--noproxy', '*', '-sS', '--connect-timeout', '3', '--max-time', '8',
               '--resolve', 'kidneysphere.com:443:127.0.0.1', '-X', method,
               'https://kidneysphere.com' + path, '-w', '\n%{http_code}']
    raw = run(command, timeout=10)
    body, status_code = raw.rsplit(b'\n', 1)
    return int(status_code), body


def health_checks(frontend=None):
    status_code, body = request('/api/health')
    require(status_code == 200 and json.loads(body).get('status') == 'ok', 'API_HEALTH_CHECK_FAILED')
    for path in ('/api/videos/00000000-0000-0000-0000-000000000000/play-auth', '/api/videos/upload-credentials'):
        status_code, body = request(path, 'POST')
        require(status_code == 401 and json.loads(body).get('error') == 'unauthorized', 'API_AUTH_GATE_CHECK_FAILED')
    for name, expected_hash in (frontend or {}).items():
        status_code, body = request('/' + name + '?release_check=' + expected_hash[:16])
        require(status_code == 200 and digest(body) == expected_hash, 'FRONTEND_HTTP_HASH_MISMATCH: ' + name)


def verify_restart_target(runtime):
    core.same_state(Path(runtime['entry']), runtime['entry_state'])
    manager = runtime['manager']
    if 'descriptor' in manager:
        target = pm2_rpc(manager['descriptor'], 'inspect', {'id': manager['target']['id']})
        require(all(target.get(key) == manager['target'][key] for key in ('id', 'name', 'cwd', 'entry', 'mode', 'watch')) and
                target.get('watch') is False,
                'PM2_TARGET_CHANGED')
        if target.get('pid', 0) > 0:
            current_process = process_info(target['pid'])
            require(current_process['cwd'] == runtime['cwd'] and current_process['node'] == runtime['node'],
                    'PM2_PROCESS_IDENTITY_CHANGED')
        return target
    else:
        current = unit_info(manager['unit'])
        require({k: v for k, v in current.items() if k != 'pid'} ==
                {k: v for k, v in manager.items() if k != 'pid'}, 'SYSTEMD_CONFIG_CHANGED')
        if current['pid'] > 0:
            current_process = process_info(current['pid'])
            require(current_process['cwd'] == runtime['cwd'] and current_process['node'] == runtime['node'] and
                    direct_entry(current_process) == runtime['entry'], 'SYSTEMD_PROCESS_IDENTITY_CHANGED')
        return current


def restart_backend(runtime):
    current = verify_restart_target(runtime)
    manager = runtime['manager']
    if 'descriptor' in manager:
        pm2_rpc(manager['descriptor'], 'restart', {k: current[k] for k in ('id', 'pid', 'cwd', 'entry')})
    else:
        run(['systemctl', 'restart', manager['unit']], timeout=25)


def wait_for_backend(package, original_runtime):
    last_error = None
    for _ in range(12):
        try:
            current = discover_runtime(package)
            require(runtime_identity(current) == runtime_identity(original_runtime), 'RESTARTED_API_IDENTITY_MISMATCH')
            health_checks()
            return
        except (ReleaseError, OSError, ValueError, subprocess.SubprocessError) as error:
            last_error = error
            time.sleep(0.5)
    raise ReleaseError('API_DID_NOT_RECOVER_AFTER_TARGETED_RESTART') from last_error


def enough_disk(report, package):
    needs = {}
    for name, path_string in report['targets'].items():
        path = Path(path_string).parent
        while not path.exists():
            path = path.parent
        key = path.stat().st_dev
        amount = report['states'][name].get('size', 0) + len(package['payload'][name])
        needs[key] = (path, needs.get(key, (path, 0))[1] + amount)
    path = BACKUP_ROOT
    while not path.exists():
        path = path.parent
    key = path.stat().st_dev
    amount = sum(state.get('size', 0) for state in report['states'].values())
    needs[key] = (path, needs.get(key, (path, 0))[1] + amount)
    for path, amount in needs.values():
        require(shutil.disk_usage(path).free > amount + 16 * 1024 * 1024, 'INSUFFICIENT_DISK_SPACE')


def verify_backup(backup, record, package):
    require(backup.parent == BACKUP_ROOT, 'BACKUP_NOT_A_DIRECT_CHILD')
    core.safe_path(backup)
    require(backup.stat().st_uid == 0 and stat.S_IMODE(backup.stat().st_mode) == 0o700, 'INVALID_BACKUP_DIRECTORY')
    require(record.get('manifest') == package['manifest'] and
            set(record.get('before', {})) == set(release_files(package['manifest'])),
            'BACKUP_RELEASE_MISMATCH')
    require(record['runtime']['entry_state'].get('sha256') in package['manifest']['server_entry_hashes'],
            'BACKUP_SERVER_ENTRY_NOT_RECOGNIZED')
    require(record['targets'] == {k: str(v) for k, v in target_paths(record['runtime'], record['manifest']).items()},
            'BACKUP_TARGET_MISMATCH')
    for name, state in record['before'].items():
        if state['exists']:
            saved, _ = core.read_state(backup / 'old' / name)
            require(saved.get('sha256') == state['sha256'] and saved.get('size') == state['size'], 'CORRUPTED_BACKUP: ' + name)


def restore(backup, record, package, restart=True):
    verify_backup(backup, record, package)
    verify_restart_target(record['runtime'])
    restart = restart and backend_changes(record['before'], package)
    files = release_files(package['manifest'])
    targets = {k: Path(v) for k, v in record['targets'].items()}
    current = {}
    for entry in package['manifest']['files']:
        name, before = entry['path'], record['before'][entry['path']]
        state, _ = core.read_state(targets[name])
        require(state.get('sha256') in {entry['sha256'], before.get('sha256')} and
                (state['exists'] or not before['exists']), 'ROLLBACK_REFUSED_MODIFIED_RESOURCE: ' + name)
        if before['exists'] and state['exists']:
            require(all(state[k] == before[k] for k in ('mode', 'uid', 'gid')), 'ROLLBACK_REFUSED_METADATA_DRIFT')
        current[name] = state
    staged = {}
    try:
        for name in files:
            before = record['before'][name]
            if before['exists'] and before != current[name]:
                _, data = core.read_state(backup / 'old' / name)
                staged[name] = core.stage_file(targets[name], data, before)
        for name in reversed(files):
            core.same_state(targets[name], current[name])
            if name in staged:
                os.replace(staged[name], targets[name])
                del staged[name]
                core.fsync_directory(targets[name].parent)
            elif not record['before'][name]['exists'] and current[name]['exists']:
                targets[name].unlink()
                core.fsync_directory(targets[name].parent)
            core.same_state(targets[name], record['before'][name])
        if restart:
            restart_backend(record['runtime'])
            wait_for_backend(package, record['runtime'])
        core.write_json(backup / 'journal.json', {'phase': 'rolled_back'})
    finally:
        for path in staged.values():
            path.unlink(missing_ok=True)
    restart_note = 'only the verified API target restarted.' if restart else 'API restart not required.'
    print('ROLLBACK_OK: ' + str(len(files)) + ' original resource states restored; ' + restart_note, flush=True)


def rollback_release(backup_path, package):
    backup = Path(backup_path).absolute()
    core.safe_path(backup)
    with core.release_lock():
        _, data = core.read_state(backup / 'backup.json')
        require(data is not None, 'BACKUP_MANIFEST_MISSING')
        restore(backup, json.loads(data), package)


def apply_release(package, expected_inspection):
    files = release_files(package['manifest'])
    require(expected_inspection and re.fullmatch('[0-9a-f]{64}', expected_inspection), 'INSPECTION_SHA_REQUIRED')
    report = inspect_release(package)
    require(report['inspection_sha256'] == expected_inspection, 'INSPECTION_CHANGED; run --inspect again')
    check_syntax(package, report['runtime'])
    health_checks()
    enough_disk(report, package)
    if all(report['states'][entry['path']].get('sha256') == entry['sha256'] for entry in package['manifest']['files']):
        print('NO_CHANGE: all ' + str(len(files)) + ' resources already match; API auth checks passed; no restart.', flush=True)
        return None
    with core.release_lock():
        current = inspect_release(package)
        require(current['inspection_sha256'] == expected_inspection, 'INSPECTION_CHANGED; no resources written')
        core.make_directories(BACKUP_ROOT, 0o700)
        require(BACKUP_ROOT.stat().st_uid == 0 and stat.S_IMODE(BACKUP_ROOT.stat().st_mode) == 0o700,
                'BACKUP_ROOT_MUST_BE_PRIVATE')
        stamp = time.strftime('%Y%m%dT%H%M%SZ-', time.gmtime())
        backup = Path(tempfile.mkdtemp(prefix=stamp, dir=BACKUP_ROOT))
        core.fsync_directory(BACKUP_ROOT)
        record = {'manifest': package['manifest'], 'runtime': report['runtime'], 'targets': report['targets'],
                  'before': report['states'], 'guards': report['guards']}
        targets = {k: Path(v) for k, v in report['targets'].items()}
        for name, before in record['before'].items():
            core.same_state(targets[name], before)
            if before['exists']:
                _, content = core.read_state(targets[name])
                destination = backup / 'old' / name
                core.make_directories(destination.parent, 0o700)
                temporary = core.stage_file(destination, content, {'mode': 0o600, 'uid': 0, 'gid': 0})
                os.replace(temporary, destination)
                core.fsync_directory(destination.parent)
        core.write_json(backup / 'backup.json', record)
        verify_backup(backup, record, package)
        print('BACKUP=' + str(backup), flush=True)
        print('ROLLBACK_COMMAND: python3 ' + shlex.quote(str(Path(sys.argv[0]).absolute())) +
              ' --rollback ' + shlex.quote(str(backup)), flush=True)
        staged = {}
        promoted = []
        restarted = False
        restart_required = backend_changes(record['before'], package)
        try:
            for name in files:
                before = record['before'][name]
                metadata = before if before['exists'] else {'mode': 0o644, 'uid': ROOT.stat().st_uid, 'gid': ROOT.stat().st_gid}
                staged[name] = core.stage_file(targets[name], package['payload'][name], metadata)
            require(inspect_release(package)['inspection_sha256'] == expected_inspection, 'INSPECTION_CHANGED_DURING_STAGING')
            for name in files:
                core.same_state(targets[name], record['before'][name])
                core.write_json(backup / 'journal.json', {'phase': 'applying', 'pending': name, 'promoted': promoted})
                os.replace(staged[name], targets[name])
                del staged[name]
                core.fsync_directory(targets[name].parent)
                promoted.append(name)
                if name == BACKEND_FILES[-1] and restart_required:
                    restarted = True
                    restart_backend(report['runtime'])
                    wait_for_backend(package, report['runtime'])
            require(guard_states(report['runtime']) == record['guards'], 'PROTECTED_RESOURCE_CHANGED')
            for entry in package['manifest']['files']:
                actual, _ = core.read_state(targets[entry['path']])
                require(actual.get('sha256') == entry['sha256'], 'POST_RELEASE_HASH_MISMATCH')
            health_checks({name: digest(package['payload'][name]) for name in release_profile(package['manifest'])[0]})
            core.write_json(backup / 'journal.json', {'phase': 'applied', 'promoted': promoted})
        except BaseException as error:
            print('RELEASE_FAILED: restoring backed-up resources.', flush=True)
            try:
                restore(backup, record, package, restart=restarted or any(name in promoted for name in BACKEND_FILES))
            except BaseException as rollback_error:
                raise ReleaseError('AUTOMATIC_ROLLBACK_INCOMPLETE: ' + str(backup)) from rollback_error
            raise ReleaseError('RELEASE_FAILED_AND_ROLLED_BACK') from error
        finally:
            for path in staged.values():
                path.unlink(missing_ok=True)
        marker = 'AUDIO_BATCH_RELEASE_OK' if package['manifest']['profile'] == 'audio-batch-v1' else 'AUDIO_RELEASE_OK'
        restart_note = 'verified API restart' if restarted else 'API restart not required'
        print(marker + ': ' + str(len(files)) +
              ' resources, ' + restart_note + ', health/auth gates and frontend delivery passed.', flush=True)
        print('Authenticated audio upload/playback and existing paid video playback still require account testing.', flush=True)
        return backup


def public_report(report):
    runtime = report['runtime']
    manager = runtime['manager']
    target = manager.get('target', {})
    return {'status': 'INSPECT_OK', 'pid': runtime['pid'], 'cwd': runtime['cwd'],
            'node': runtime['node'], 'server_entry': runtime['entry'],
            'manager': ({'kind': 'pm2', 'id': target['id'], 'name': target['name'], 'cwd': target['cwd']}
                        if 'descriptor' in manager else {'kind': 'systemd', 'unit': manager['unit'], 'cwd': manager['cwd']}),
            'targets': report['targets'], 'inspection_sha256': report['inspection_sha256']}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--inspect', action='store_true', help='read-only discovery (default)')
    actions.add_argument('--apply', action='store_true')
    actions.add_argument('--rollback', metavar='BACKUP_DIRECTORY')
    parser.add_argument('--expect-inspection', metavar='SHA256')
    args = parser.parse_args(argv)
    try:
        package = load_package()
        if args.apply:
            apply_release(package, args.expect_inspection)
        elif args.rollback:
            rollback_release(args.rollback, package)
        else:
            report = inspect_release(package)
            print(json.dumps(public_report(report), ensure_ascii=False, indent=2))
            print('APPLY_COMMAND: python3 ' + shlex.quote(str(Path(sys.argv[0]).absolute())) +
                  ' --apply --expect-inspection ' + report['inspection_sha256'])
        return 0
    except (ReleaseError, OSError, ValueError, KeyError, TypeError, IndexError,
            subprocess.SubprocessError, zipfile.BadZipFile) as error:
        print('ERROR: ' + str(error), file=sys.stderr)
        if not args.apply and not args.rollback:
            try:
                process = process_info(listener_pid())
                print('DISCOVERY_HINT: ' + json.dumps({key: process[key] for key in ('pid', 'cwd', 'node')},
                      ensure_ascii=False), file=sys.stderr)
            except (ReleaseError, OSError, ValueError, KeyError, IndexError, subprocess.SubprocessError):
                pass
        return 1


if __name__ == '__main__':
    sys.exit(main())
