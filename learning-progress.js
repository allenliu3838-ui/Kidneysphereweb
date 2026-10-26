// Device-local convenience history only. Never an entitlement or source of playback URLs.
const PREFIX = 'ks_learning_progress_v1:';
const MAX_RECORDS = 40;
const MAX_AGE = 180 * 24 * 60 * 60 * 1000;
const MAX_DURATION = 7 * 24 * 60 * 60;
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const VALID_USER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function cleanText(value, limit) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';
}

function normalize(record, now) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  if (typeof record.videoId !== 'string' || !VALID_ID.test(record.videoId)) return null;
  const title = cleanText(record.title, 300);
  const position = record.position;
  const duration = record.duration;
  const updatedAt = record.updatedAt;
  if (!title || !Number.isFinite(position) || position < 0 ||
      !Number.isFinite(duration) || duration <= 0 || duration > MAX_DURATION ||
      !Number.isFinite(updatedAt) || updatedAt < now - MAX_AGE || updatedAt > now + 60000) return null;
  return {
    videoId: record.videoId, title, speaker: cleanText(record.speaker, 160),
    kind: record.kind === 'audio' ? 'audio' : 'video',
    position: Math.min(position, duration), duration,
    rate: Number.isFinite(record.rate) && record.rate >= 0.5 && record.rate <= 3 ? record.rate : 1,
    updatedAt, completed: record.completed === true,
  };
}

export function createLearningProgress({ userId, storage, now = Date.now } = {}) {
  const enabled = typeof userId === 'string' && VALID_USER.test(userId);
  const key = enabled ? PREFIX + userId : null;
  let memory = [];
  let memoryOnly = false;
  let target = storage;
  if (storage === undefined && enabled) {
    try { target = globalThis.localStorage; } catch (_) { memoryOnly = true; }
  }
  if (!target || typeof target.getItem !== 'function' || typeof target.setItem !== 'function') memoryOnly = true;

  function sanitize(records) {
    const clock = now();
    const byId = new Map();
    for (const candidate of Array.isArray(records) ? records.slice(0, 200) : []) {
      const record = normalize(candidate, clock);
      if (record && (!byId.has(record.videoId) || byId.get(record.videoId).updatedAt < record.updatedAt)) byId.set(record.videoId, record);
    }
    return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.videoId.localeCompare(b.videoId)).slice(0, MAX_RECORDS);
  }

  function list() {
    if (!enabled) return [];
    if (!memoryOnly) {
      try {
        const raw = target.getItem(key);
        // Bound parsing work when browser storage has been altered outside this module.
        const parsed = raw && raw.length <= 100000 ? JSON.parse(raw) : null;
        memory = sanitize(parsed?.version === 1 ? parsed.records : []);
      } catch (_) { memory = sanitize(memory); }
    } else memory = sanitize(memory);
    return memory.map(record => ({ ...record }));
  }

  function write(records) {
    memory = sanitize(records);
    if (!memoryOnly) {
      try { target.setItem(key, JSON.stringify({ version: 1, records: memory })); }
      catch (_) { memoryOnly = true; }
    }
  }

  return {
    get persistent() { return enabled && !memoryOnly; },
    get(videoId) { return list().find(record => record.videoId === videoId) || null; },
    list,
    save(input) {
      if (!enabled || !input || typeof input !== 'object') return null;
      const records = list();
      const previous = records.find(record => record.videoId === input.videoId);
      const record = normalize({ ...previous, ...input, updatedAt: now() }, now());
      if (!record) return null;
      write([record, ...records.filter(item => item.videoId !== record.videoId)]);
      return { ...record };
    },
    remove(videoId) {
      if (!enabled) return;
      write(list().filter(record => record.videoId !== videoId));
    },
    clear() {
      if (!enabled) return;
      write([]);
    },
  };
}
