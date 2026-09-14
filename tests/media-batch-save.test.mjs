import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { saveBatchCourse } = await import('data:text/javascript;base64,' + Buffer.from(
  readFileSync(new URL('../media-batch-save.js', import.meta.url), 'utf8')
).toString('base64'));

const ADMIN = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const SPECIALTY = '33333333-3333-4333-8333-333333333333';
const OTHER_SPECIALTY = '44444444-4444-4444-8444-444444444444';
const clone = value => JSON.parse(JSON.stringify(value));
const baseItem = () => ({ id: ID, title: '第1章 肾脏生理', chapterNumber: 1, order: 1, uploadResult: { videoId: 'vod-chapter-1' } });
const baseSettings = () => ({ category: 'general', speaker: '刘松', specialtyIds: [SPECIALTY], accessType: 'paid_specialty',
  price: 0, description: '系统课程', coverImage: 'https://example.com/cover.jpg', source: 'kidneysphere', publish: false, sortStart: 0, createdBy: ADMIN });

function database(options = {}) {
  const records = new Map();
  const inserts = [], selects = [];
  let first = true;
  const client = {
    auth: { async getSession() { return options.authError ? { error: new Error('session unavailable') }
      : { data: { session: options.loggedOut ? null : { user: { id: options.userId || ADMIN } } } }; } },
    from(table) {
      assert.equal(table, 'learning_videos');
      return {
        async insert(row) {
          inserts.push(clone(row));
          if (options.insertError) return { error: options.insertError };
          if (records.has(row.id)) return { error: { code: '23505', message: 'duplicate key' } };
          records.set(row.id, clone(row));
          if (first && options.loseResponse) {
            first = false;
            if (options.mutateCommitted) options.mutateCommitted(records.get(row.id));
            if (options.throwAfterCommit) throw new Error('network interrupted');
            return { error: { message: 'network interrupted' } };
          }
          first = false;
          return { data: null, error: null };
        },
        select(columns) {
          return { eq(key, id) {
            assert.equal(key, 'id');
            selects.push({ columns, id });
            return { async maybeSingle() {
              if (options.queryThrows) throw new Error('offline');
              if (options.queryError) return { data: null, error: options.queryError };
              const record = records.get(id);
              return { data: record ? clone(record) : null, error: null };
            } };
          } };
        },
      };
    },
  };
  return { client, records, inserts, selects };
}

test('saves one protected draft per stable UUID with complete existing schema fields', async () => {
  const db = database();
  const item = baseItem(), settings = baseSettings();
  const before = JSON.stringify({ item, settings });
  assert.deepEqual(await saveBatchCourse(db.client, item, settings), { id: ID, videoId: 'vod-chapter-1', status: 'saved' });
  assert.equal(db.records.size, 1);
  const row = db.records.get(ID);
  assert.deepEqual(row, {
    id: ID, title: item.title, category: 'general', kind: 'aliyun', aliyun_vid: 'vod-chapter-1',
    source_url: null, mp4_url: null, bvid: null, source: 'kidneysphere', created_by: ADMIN,
    enabled: false, is_published: false, deleted_at: null, access_type: 'paid_specialty', is_paid: true,
    membership_accessible: false, specialty_id: SPECIALTY, specialty_ids: [SPECIALTY], price: 0,
    speaker: '刘松', description: '系统课程', cover_image: 'https://example.com/cover.jpg', sort_order: 0,
  });
  assert.equal(JSON.stringify({ item, settings }), before);
});

test('a committed insert with a lost or thrown response is verified rather than duplicated', async () => {
  for (const throwAfterCommit of [false, true]) {
    const db = database({ loseResponse: true, throwAfterCommit });
    assert.equal((await saveBatchCourse(db.client, baseItem(), baseSettings())).status, 'saved');
    assert.equal(db.records.size, 1);
    assert.equal(db.inserts.length, 1);
    assert.equal(db.selects[0].id, ID);
    for (const column of ['title', 'aliyun_vid', 'created_by', 'source', 'access_type', 'is_paid', 'membership_accessible',
      'is_published', 'enabled', 'specialty_id', 'specialty_ids', 'price', 'sort_order', 'deleted_at']) {
      assert.ok(db.selects[0].columns.split(',').includes(column));
    }
  }
});

test('retry and duplicate concurrent saves keep a single record using the same primary key', async () => {
  const db = database();
  const results = await Promise.all([saveBatchCourse(db.client, baseItem(), baseSettings()), saveBatchCourse(db.client, baseItem(), baseSettings())]);
  assert.ok(results.every(result => result.status === 'saved'));
  assert.equal(db.records.size, 1);
  assert.deepEqual(db.inserts.map(row => row.id), [ID, ID]);
});

test('verification failures remain unresolved and a subsequent retry does not re-upload or duplicate', async () => {
  const options = { loseResponse: true, queryError: { message: 'offline' } };
  const db = database(options);
  const item = baseItem();
  await assert.rejects(saveBatchCourse(db.client, item, baseSettings()), { code: 'batch_save_unconfirmed' });
  assert.equal(db.records.size, 1);
  assert.equal(item.uploadResult.videoId, 'vod-chapter-1');
  delete options.queryError;
  assert.equal((await saveBatchCourse(db.client, item, baseSettings())).status, 'saved');
  assert.equal(db.records.size, 1);
  assert.deepEqual(db.inserts.map(row => row.id), [ID, ID]);
});

test('missing or unreadable records after failure cannot be reported as saved', async () => {
  for (const options of [
    { insertError: { code: '42501', message: 'permission denied' } },
    { insertError: { code: '23505', message: 'unrelated unique constraint' } },
    { loseResponse: true, queryThrows: true },
  ]) {
    const db = database(options);
    await assert.rejects(saveBatchCourse(db.client, baseItem(), baseSettings()));
    assert.equal(db.inserts.length, 1);
  }
});

test('same UUID with any different protected field is rejected without overwriting it', async () => {
  const changes = {
    title: 'Other lesson', category: 'other', aliyun_vid: 'other-vod', created_by: OTHER_SPECIALTY,
    kind: 'mp4', source: 'external', access_type: 'registered_free', is_paid: false,
    membership_accessible: true, enabled: true, is_published: true, specialty_id: OTHER_SPECIALTY,
    specialty_ids: [OTHER_SPECIALTY], price: '50.00', sort_order: 22, speaker: 'Other lecturer',
    description: 'Other description', cover_image: 'https://example.com/other.jpg',
    source_url: 'https://example.com/public.mp3', mp4_url: 'https://example.com/public.mp3', bvid: 'BVother',
  };
  for (const [key, value] of Object.entries(changes)) {
    const db = database({ loseResponse: true, mutateCommitted: row => { row[key] = value; } });
    await assert.rejects(saveBatchCourse(db.client, baseItem(), baseSettings()), { code: 'batch_record_conflict' });
    assert.deepEqual(db.records.get(ID)[key], value, key);
    assert.equal(db.inserts.length, 1);
  }
});

test('deleted records are not automatically restored on retry', async () => {
  const db = database({ loseResponse: true, mutateCommitted: row => { row.deleted_at = '2026-09-15T00:00:00Z'; } });
  await assert.rejects(saveBatchCourse(db.client, baseItem(), baseSettings()), { code: 'batch_record_deleted' });
  assert.equal(db.records.get(ID).deleted_at, '2026-09-15T00:00:00Z');
});

test('GlomCon records normalize to membership access with no specialty assignments', async () => {
  const db = database();
  await saveBatchCourse(db.client, baseItem(), { ...baseSettings(), source: 'glomcon', accessType: 'registered_free', publish: true });
  const row = db.records.get(ID);
  assert.equal(row.access_type, 'paid_membership');
  assert.equal(row.is_paid, true);
  assert.equal(row.membership_accessible, true);
  assert.deepEqual(row.specialty_ids, []);
  assert.equal(row.specialty_id, null);
  assert.equal(row.enabled, true);
  assert.equal(row.is_published, true);
});

test('single-course pricing and numeric response values verify without losing cents', async () => {
  const db = database({ loseResponse: true, mutateCommitted: row => { row.price = String(row.price); row.sort_order = String(row.sort_order); } });
  await saveBatchCourse(db.client, baseItem(), { ...baseSettings(), accessType: 'paid_single', price: 49.99, specialtyIds: [] });
  assert.equal(db.records.get(ID).price, '49.99');
  assert.equal(db.records.get(ID).membership_accessible, false);
});

test('registered-free records do not inherit stale payment metadata', async () => {
  const db = database();
  await saveBatchCourse(db.client, baseItem(), { ...baseSettings(), accessType: 'registered_free', price: 999, specialtyIds: [] });
  const row = db.records.get(ID);
  assert.equal(row.is_paid, false);
  assert.equal(row.membership_accessible, false);
  assert.equal(row.price, 0);
});

test('chapter number or one-based item order determines a stable sort order', async () => {
  for (const [chapterNumber, order, sortStart, expected] of [[27, 1, 0, 26], [1, 7, 100, 100], [null, 3, 100, 102], [0, 2, 0, 1], [undefined, 1, undefined, 0]]) {
    const db = database();
    await saveBatchCourse(db.client, { ...baseItem(), chapterNumber, order }, { ...baseSettings(), sortStart });
    assert.equal(db.records.get(ID).sort_order, expected);
  }
});

test('invalid identity, access, specialty, price or ordering never reaches the database', async () => {
  const invalid = [
    [{ id: 'not-uuid' }, {}], [{ title: '' }, {}], [{ uploadResult: null }, {}], [{ chapterNumber: null, order: 0 }, {}],
    [{ chapterNumber: null, order: 1.5 }, {}], [{}, { createdBy: 'not-uuid' }], [{}, { category: '' }],
    [{}, { accessType: 'unknown' }], [{}, { source: 'unknown' }], [{}, { specialtyIds: null }],
    [{}, { specialtyIds: ['not-uuid'] }], [{}, { accessType: 'paid_specialty', specialtyIds: [] }],
    [{}, { accessType: 'paid_single', price: 0 }], [{}, { accessType: 'paid_single', price: -1 }],
    [{}, { accessType: 'paid_single', price: Infinity }], [{}, { accessType: 'paid_single', price: 1.005 }],
    [{}, { accessType: 'paid_single', price: 100000000 }], [{}, { publish: 'false' }],
    [{}, { sortStart: -1 }], [{}, { sortStart: 2147483648 }],
  ];
  for (const [item, settings] of invalid) {
    const db = database();
    await assert.rejects(saveBatchCourse(db.client, { ...baseItem(), ...item }, { ...baseSettings(), ...settings }));
    assert.equal(db.inserts.length, 0);
  }
});

test('logout, unreadable session and account changes preserve the queue and block saving', async () => {
  for (const options of [{ loggedOut: true }, { authError: true }, { userId: OTHER_SPECIALTY }]) {
    const db = database(options), item = baseItem();
    await assert.rejects(saveBatchCourse(db.client, item, baseSettings()));
    assert.equal(db.inserts.length, 0);
    assert.equal(item.id, ID);
    assert.equal(item.uploadResult.videoId, 'vod-chapter-1');
  }
});

test('schema errors never remove access fields or downgrade VOD records', async () => {
  const db = database({ insertError: { message: 'column access_type does not exist' } });
  await assert.rejects(saveBatchCourse(db.client, baseItem(), baseSettings()), { code: 'batch_save_failed' });
  assert.equal(db.inserts.length, 1);
  assert.equal(db.inserts[0].access_type, 'paid_specialty');
  assert.equal(db.inserts[0].kind, 'aliyun');
  assert.equal(db.inserts[0].aliyun_vid, 'vod-chapter-1');
});
