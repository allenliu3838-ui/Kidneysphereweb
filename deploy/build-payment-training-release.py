#!/usr/bin/env python3
"""Build one pinned payment/training release: frontend pyz and a single SQL entry."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile

REPOSITORY = Path(__file__).resolve().parent.parent
BASELINES = ('4a3e70af6fecf9ec59daee4e731b464154ece573',
             'dca7f2c23d2d90358268b4df008f95f3f7063ecd')
VERSION = '20260914_payment1'
FILES = (
    'training-commerce.js', 'my-learning-display.js', 'admin-commerce-review.js',
    'academy.js', 'trainingprograms.js', 'checkout.js', 'learning-center.js',
    'admin-commerce-orders.js', 'admin-commerce-products.js', 'admin-commerce-config.js',
    'admin-commerce-entitlements.js', 'admin-commerce-projects.js',
    'admin-commerce-cohorts.js', 'admin-commerce-groups.js', 'admin-commerce-templates.js',
    'admin-commerce-audit.js', 'admin-commerce.js', 'my-learning.js',
    'academy.html', 'checkout.html', 'learning.html', 'training-icu.html',
    'training-tx.html', 'training-patho.html', 'training-glom.html', 'training-da.html',
    'videos.html', 'admin-commerce.html', 'my-learning.html',
)
NEW_FILES = ('training-commerce.js', 'my-learning-display.js', 'admin-commerce-review.js')
REQUIRED_FILES = ('supabaseClient.js', 'assets/config.js', 'assets/lib/supabase.min.js',
    'app.js', 'styles.css', 'vod-upload.js', 'media-batch.js', 'media-batch-save.js',
    'media-batch-ui.js', 'media-batch.css')
PRESERVED = REQUIRED_FILES + (
    'server/index.js', 'server/package.json', 'netlify/functions/video-access.js',
    'netlify/functions/dev-grant-access.js', 'netlify/functions/video-upload-auth.js',
    'netlify/functions/video-play-auth.js', 'assets/videos.js', 'home.js',
    'portal-home.js', 'portal-home.css', 'index.html', 'login.html', 'register.html',
    'auth-callback.html', 'watch.html', 'media-upload.js', 'media-player.js', 'media-player.css',
)
SQL_FILES = ('migration_20260914_training_prices.sql', 'migration_20260914_payment_enrollment.sql',
    'deploy/training-pricing-inspect.sql', 'deploy/payment-enrollment-inspect.sql',
    'deploy/training-pricing-rollback.sql', 'deploy/payment-enrollment-rollback.sql')
RELEASE_KEY = 'payment-training-20260914-v1'
PRICE_KEY = 'training-prices-20260914-v1'
PAYMENT_KEY = 'payment-enrollment-20260914-v1'
RELEASE_README = 'deploy/PAYMENT-TRAINING-RELEASE.md'


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


def validate_payload(payload):
    if tuple(payload) != FILES or any(not data.strip() for data in payload.values()):
        raise ValueError('Payment/training payload must match the fixed 29-file allowlist')
    # Unchanged pricing and video resources must remain byte-for-byte reviewed.
    for name in ('training-commerce.js', 'academy.js', 'trainingprograms.js',
                 'learning-center.js', 'academy.html', 'learning.html', 'training-icu.html',
                 'training-tx.html', 'training-patho.html', 'training-glom.html',
                 'training-da.html', 'videos.html'):
        if payload[name] != git_bytes(BASELINES[1], name):
            raise ValueError('Unexpected change to reviewed pricing resource: ' + name)
    for html, script in (('checkout.html', 'checkout.js'),
                         ('admin-commerce.html', 'admin-commerce.js'),
                         ('my-learning.html', 'my-learning.js')):
        if payload[html].count((script + '?v=' + VERSION).encode()) != 1:
            raise ValueError('Missing unique versioned entry module: ' + html)
    for name in FILES:
        if not name.endswith('.js'):
            continue
        source = payload[name].decode('utf-8')
        for module, version in re.findall(r'[\"\']\./(admin-commerce(?:-[a-z-]+)?|my-learning-display)\.js\?v=([^\"\']+)[\"\']', source):
            if version != VERSION:
                raise ValueError('Stale payment module reference in ' + name + ': ' + module)
    for parent, child in (('admin-commerce-orders.js', 'admin-commerce-review.js'),
                          ('my-learning.js', 'my-learning-display.js')):
        if payload[parent].count(('./' + child + '?v=' + VERSION).encode()) != 1:
            raise ValueError('Missing payment helper: ' + parent)
    for name in ('checkout.js', 'admin-commerce-review.js'):
        if payload[name].count(b'./training-commerce.js?v=20260914_pricing1') != 1:
            raise ValueError('Pricing helper must remain pinned: ' + name)


def manifest_resources(payload):
    validate_payload(payload)
    groups = []
    for commit in BASELINES:
        hashes = {}
        for name in FILES:
            before = git_bytes(commit, name, optional=name in NEW_FILES)
            hashes[name] = digest(before) if before is not None else None
        groups.append({'commit': commit, 'files': hashes})
    resources = []
    for name in FILES:
        before = [group['files'][name] for group in groups]
        resources.append({'path': name, 'sha256': digest(payload[name]), 'size': len(payload[name]),
            'allowed_before': list(dict.fromkeys(value for value in before if value is not None)),
            'allow_missing': None in before})
    return resources, groups


def sql_mask(source):
    """Hide comments and quoted SQL so only top-level statement delimiters remain."""
    pattern = re.compile(r"--[^\n]*|/\*|\$[A-Za-z_0-9]*\$|'|\"")
    out, cursor = list(source), 0
    while True:
        match = pattern.search(source, cursor)
        if not match:
            break
        start, token = match.start(), match.group()
        if token.startswith('--'):
            end = match.end()
        elif token == '/*':
            depth, end = 1, match.end()
            while depth:
                nested = re.search(r'/\*|\*/', source[end:])
                if not nested:
                    raise ValueError('Unterminated SQL comment')
                depth += 1 if nested.group() == '/*' else -1
                end += nested.end()
        elif token in ("'", '"'):
            end = match.end()
            while True:
                found = source.find(token, end)
                if found < 0:
                    raise ValueError('Unterminated SQL string')
                end = found + 1
                if source[end:end + 1] != token:
                    break
                end += 1
        else:
            found = source.find(token, match.end())
            if found < 0:
                raise ValueError('Unterminated SQL dollar quote')
            end = found + len(token)
        out[start:end] = ['\n' if char == '\n' else ' ' for char in source[start:end]]
        cursor = end
    return ''.join(out)


def transaction_body(data, readonly=False):
    source = data.decode('utf-8')
    mask = sql_mask(source)
    statements, start = [], 0
    for end, char in enumerate(mask):
        if char == ';':
            if mask[start:end].strip():
                statements.append((start, end + 1, mask[start:end].strip().lower()))
            start = end + 1
    if mask[start:].strip() or len(statements) < 2:
        raise ValueError('SQL must contain one complete explicit transaction')
    expected = 'begin transaction isolation level repeatable read read only' if readonly else 'begin'
    if statements[0][2] != expected or statements[-1][2] != 'commit':
        raise ValueError('Unexpected SQL transaction wrapper')
    for unused, unused2, text in statements[1:-1]:
        if re.match(r'^(begin|commit|rollback|start\s+transaction|end|prepare\s+transaction)\b', text):
            raise ValueError('Nested or additional SQL transaction refused')
        if re.search(r'^\s*\\', text, flags=re.M):
            raise ValueError('psql command refused')
    first_start = re.search(r'\bbegin\b', mask, flags=re.I).start()
    return source[:first_start] + source[statements[0][1]:statements[-1][0]] + '\n'


def combined_sql(sources):
    pricing = transaction_body(sources[SQL_FILES[0]])
    payment = transaction_body(sources[SQL_FILES[1]])
    fingerprint = digest(sources[SQL_FILES[0]] + b'\n' + sources[SQL_FILES[1]])
    journal = f"""
create schema if not exists kidneysphere_release_private;
revoke all on schema kidneysphere_release_private from public, anon, authenticated;
create table if not exists kidneysphere_release_private.payment_training_releases (
  release_key text primary key, source_sha256 text not null,
  state text not null check (state in ('applied', 'rolled_back')),
  pricing_before text, payment_before text,
  applied_at timestamptz not null default now(), rolled_back_at timestamptz
);
revoke all on table kidneysphere_release_private.payment_training_releases from public, anon, authenticated;
lock table kidneysphere_release_private.payment_training_releases in exclusive mode;
do $combined_before$
declare p text; m text; r record;
begin
  if to_regclass('kidneysphere_release_private.training_price_releases') is not null then
    execute 'select state from kidneysphere_release_private.training_price_releases where release_key = $1'
      into p using '{PRICE_KEY}';
  end if;
  if to_regclass('kidneysphere_release_private.payment_enrollment_releases') is not null then
    execute 'select state from kidneysphere_release_private.payment_enrollment_releases where release_key = $1'
      into m using '{PAYMENT_KEY}';
  end if;
  if coalesce(p, 'absent') not in ('absent', 'applied', 'rolled_back')
     or coalesce(m, 'absent') not in ('absent', 'applied', 'rolled_back') then
    raise exception 'COMBINED_UNKNOWN_BASELINE';
  end if;
  select * into r from kidneysphere_release_private.payment_training_releases
    where release_key = '{RELEASE_KEY}' for update;
  if found then
    if r.source_sha256 <> '{fingerprint}' then raise exception 'COMBINED_SOURCE_CHANGED'; end if;
    if r.state = 'applied' and (p is distinct from 'applied' or m is distinct from 'applied') then
      raise exception 'COMBINED_PARTIAL_RELEASE_REFUSED';
    elsif r.state = 'rolled_back' and
      (p is distinct from coalesce(r.pricing_before, 'rolled_back')
       or m is distinct from coalesce(r.payment_before, 'rolled_back')) then
      raise exception 'COMBINED_BASELINE_CHANGED_AFTER_ROLLBACK';
    end if;
  else
    insert into kidneysphere_release_private.payment_training_releases
      (release_key, source_sha256, state, pricing_before, payment_before)
    values ('{RELEASE_KEY}', '{fingerprint}', 'applied', p, m);
  end if;
end $combined_before$;
"""
    finish = f"""
do $combined_verify$
begin
  if public.get_payment_enrollment_release() is distinct from
    '{{"payment_release":"{PAYMENT_KEY}","payment_state":"applied","pricing_release":"{PRICE_KEY}","pricing_state":"applied"}}'::jsonb then
    raise exception 'COMBINED_VERSION_VERIFICATION_FAILED';
  end if;
  update kidneysphere_release_private.payment_training_releases
    set state = 'applied', applied_at = now(), rolled_back_at = null
    where release_key = '{RELEASE_KEY}';
end $combined_verify$;
"""
    migration = '-- Combined payment/training entry. Apply this file once as database owner.\n' \
        'begin;\nset local lock_timeout = \'5s\';\nset local statement_timeout = \'120s\';\n' + journal \
        + '\n-- Reviewed pricing migration.\n' + pricing + '\n-- Reviewed payment migration.\n' \
        + payment + finish + '\ncommit;\n'
    inspect = '-- Read-only combined inspection; no user or payment records are queried.\n' \
        'begin transaction isolation level repeatable read read only;\n' \
        + transaction_body(sources[SQL_FILES[2]], readonly=True) \
        + transaction_body(sources[SQL_FILES[3]], readonly=True) + '\ncommit;\n'
    rollback = combined_rollback(sources, fingerprint)
    return {'.sql': migration.encode(), '.inspect.sql': inspect.encode(), '.rollback.sql': rollback.encode()}


def rollback_call(data):
    body = transaction_body(data)
    statements = [s.strip() for s in sql_mask(body).split(';') if s.strip()]
    calls = [s for s in statements if s.lower().startswith('select ')]
    if len(calls) != 1 or not re.fullmatch(
            r'select\s+kidneysphere_release_private\.restore_[a-z0-9_]+\(\)', calls[0], flags=re.I):
        raise ValueError('Rollback must call one reviewed private restore function')
    if any(not s.lower().startswith(('set local ', 'select ')) for s in statements):
        raise ValueError('Unexpected rollback statement')
    return re.sub(r'^select\s+', 'perform ', calls[0], flags=re.I) + ';'


def combined_rollback(sources, fingerprint):
    price_call = rollback_call(sources[SQL_FILES[4]])
    payment_call = rollback_call(sources[SQL_FILES[5]])
    return f"""-- Roll back frontend first, then execute this file as database owner.
-- Restore only migrations first applied by the combined entry. Preserve prior pricing.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
lock table kidneysphere_release_private.payment_training_releases in exclusive mode;
do $combined_rollback$
declare r record; p text; m text;
begin
  select * into r from kidneysphere_release_private.payment_training_releases
    where release_key = '{RELEASE_KEY}' for update;
  if not found or r.source_sha256 <> '{fingerprint}' then raise exception 'COMBINED_BACKUP_MISSING_OR_CHANGED'; end if;
  select state into p from kidneysphere_release_private.training_price_releases where release_key = '{PRICE_KEY}';
  select state into m from kidneysphere_release_private.payment_enrollment_releases where release_key = '{PAYMENT_KEY}';
  if r.state = 'rolled_back' then
    if p is distinct from coalesce(r.pricing_before, 'rolled_back')
       or m is distinct from coalesce(r.payment_before, 'rolled_back') then
      raise exception 'COMBINED_ROLLBACK_STATE_CHANGED';
    end if;
    raise notice 'NO_CHANGE: combined release already rolled back'; return;
  end if;
  if p is distinct from 'applied' or m is distinct from 'applied' then
    raise exception 'COMBINED_PARTIAL_RELEASE_REFUSED';
  end if;
  if r.payment_before is distinct from 'applied' then {payment_call} end if;
  if r.pricing_before is distinct from 'applied' then {price_call} end if;
  update kidneysphere_release_private.payment_training_releases set state = 'rolled_back', rolled_back_at = now()
    where release_key = '{RELEASE_KEY}';
end $combined_rollback$;
commit;
"""


def build(commit, output):
    commit = immutable_commit(commit)
    payload = {name: git_bytes(commit, name) for name in FILES}
    for name in dict.fromkeys(PRESERVED):
        source = git_bytes(commit, name)
        if any(source != git_bytes(baseline, name) for baseline in BASELINES):
            raise ValueError('Payment release changes a protected resource: ' + name)
    resources, groups = manifest_resources(payload)
    runner = git_bytes(commit, 'deploy/portal-release.py')
    compile(runner, 'portal-release.py', 'exec')
    sources = {name: git_bytes(commit, name) for name in SQL_FILES}
    sql_outputs = combined_sql(sources)
    release_readme = git_bytes(commit, RELEASE_README)
    manifest = {'schema': 1, 'release_profile': 'payment-training-v1',
        'domain': 'kidneysphere.com', 'root': '/var/www/kidneysphere', 'commit': commit,
        'files': resources, 'baseline_groups': groups, 'required_files': list(REQUIRED_FILES),
        'runner_sha256': digest(runner)}
    entries = [('__main__.py', runner), ('manifest.json',
        (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode())]
    entries.extend(('payload/' + name, payload[name]) for name in FILES)
    output = Path(output).absolute()
    if output.suffix != '.pyz':
        raise ValueError('--output must end in .pyz')
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=(2026, 9, 14, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None or archive.namelist() != [name for name, unused in entries]:
            raise RuntimeError('Package entries or CRC verification failed')
        if any(archive.read(name) != data for name, data in entries):
            raise RuntimeError('Package content verification failed')
    artifacts = [{'file': output.name, 'sha256': digest(output.read_bytes()), 'bytes': output.stat().st_size}]
    for suffix, data in sql_outputs.items():
        path = output.with_suffix(suffix)
        path.write_bytes(data)
        artifacts.append({'file': path.name, 'sha256': digest(data), 'bytes': len(data)})
    readme_path = output.with_suffix('.README.md')
    readme_path.write_bytes(release_readme)
    artifacts.append({'file': readme_path.name, 'sha256': digest(release_readme), 'bytes': len(release_readme)})
    report = {'commit': commit, 'profile': 'payment-training-v1', 'accepted_baselines': list(BASELINES),
        'files': list(FILES), 'artifacts': artifacts,
        'sql_sources': [{'path': name, 'sha256': digest(data)} for name, data in sources.items()],
        'readme_source': {'path': RELEASE_README, 'sha256': digest(release_readme)},
        'sequence': 'Read-only inspection; apply combined .sql once; pyz --check; pyz --apply.',
        'scope': 'pyz updates only frontend files; public GET checks only catalog and release metadata. No SQL or service execution.',
        'rollback': 'pyz --rollback BACKUP first; combined .rollback.sql then restores original functions/ACL and only newly applied pricing.'}
    output.with_suffix('.sources.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    build(args.commit, args.output)
