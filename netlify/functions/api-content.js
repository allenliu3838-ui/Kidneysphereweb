const json = (statusCode, payload) => ({ statusCode, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload) });

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

// ── Simple in-memory rate limiter (per-IP, resets on cold start) ──
const rateMap = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
function rateCheck(ip){
  const now = Date.now();
  let entry = rateMap.get(ip);
  if(!entry || now - entry.ts > RATE_WINDOW_MS){
    entry = { ts: now, count: 0 };
    rateMap.set(ip, entry);
  }
  entry.count++;
  if(rateMap.size > 5000){
    for(const [k,v] of rateMap){ if(now - v.ts > RATE_WINDOW_MS) rateMap.delete(k); }
  }
  return entry.count <= RATE_MAX;
}

function getClientIp(event){
  const h = event.headers || {};
  return h['x-nf-client-connection-ip'] || h['x-forwarded-for']?.split(',')[0]?.trim() || h['client-ip'] || 'unknown';
}

function pickToken(event){
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || '';
  if(/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return '';
}

async function sb(path, { method='GET', token='', body=null }={}){
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const key = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
  const headers = {
    apikey: key,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY || key}`,
    Accept: 'application/json',
  };
  if(method !== 'GET') headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return res;
}

async function getUserFromToken(token){
  if(!token || !SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if(!res.ok) return null;
  return res.json();
}

async function isMember(userId){
  if(!userId) return false;
  const r = await sb(`memberships?user_id=eq.${encodeURIComponent(userId)}&select=status,current_period_end&limit=1`);
  if(r.ok){
    const rows = await r.json();
    const m = rows?.[0];
    if(m?.status === 'active'){
      if(!m.current_period_end) return true;
      return new Date(m.current_period_end).getTime() > Date.now();
    }
  }
  const p = await sb(`profiles?id=eq.${encodeURIComponent(userId)}&select=membership_status&limit=1`);
  if(!p.ok) return false;
  const prow = (await p.json())?.[0];
  return String(prow?.membership_status || '').toLowerCase() === 'member';
}

function normalizeItem(row){
  return {
    id: row.id,
    legacy_article_id: row.legacy_article_id,
    type: row.type,
    title_zh: row.title_zh,
    title_en: row.title_en,
    summary_zh: row.summary_zh,
    tags: row.tags || [],
    status: row.status,
    paywall: row.paywall,
    author_name: row.author_name,
    version: row.version,
    published_at: row.published_at,
    updated_at: row.updated_at,
    preview_body: row.preview_body || '',
  };
}

exports.handler = async (event) => {
  try{
    const ip = getClientIp(event);
    if(!rateCheck(ip)){
      return json(429, { error: 'rate_limited', message: '请求过于频繁，请稍后再试。' });
    }

    if(!SUPABASE_URL || !(SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY)){
      return json(500, { error: 'server_not_configured' });
    }

    const path = String(event.path || '');
    const token = pickToken(event);
    const user = await getUserFromToken(token);

    const tail = path.split('/api/content')[1] || '';
    const maybeId = tail.replace(/^\//, '').trim();

    if(maybeId){
      const id = decodeURIComponent(maybeId);
      const mode = String(event.queryStringParameters?.mode || 'preview').toLowerCase() === 'full' ? 'full' : 'preview';

      let itemRes = await sb(`content_items?id=eq.${encodeURIComponent(id)}&select=*`);
      let items = itemRes.ok ? await itemRes.json() : [];
      if(!items?.length){
        itemRes = await sb(`content_items?legacy_article_id=eq.${encodeURIComponent(id)}&select=*`);
        items = itemRes.ok ? await itemRes.json() : [];
      }
      const item = items?.[0];
      if(!item || item.status !== 'published' || !item.last_published_version_id) return json(404, { error: 'not_found' });

      const vr = await sb(`content_versions?id=eq.${encodeURIComponent(item.last_published_version_id)}&select=id,version,preview_body,full_body,source_format,toc_json,references_json,created_at`);
      if(!vr.ok) return json(500, { error: 'version_fetch_failed' });
      const v = (await vr.json())?.[0];
      if(!v) return json(404, { error: 'version_not_found' });

      if(mode === 'full' && item.paywall === 'members_only'){
        const member = await isMember(user?.id || '');
        if(!member){
          return json(user ? 402 : 403, {
            error: 'membership_required',
            paywall: {
              required_plan: 'member',
              action: 'upgrade_membership',
              preview_body: v.preview_body || '',
            },
          });
        }
      }

      return json(200, {
        item: {
          id: item.id,
          legacy_article_id: item.legacy_article_id,
          type: item.type,
          title_zh: item.title_zh,
          title_en: item.title_en,
          summary_zh: item.summary_zh,
          tags: item.tags || [],
          paywall: item.paywall,
          author_name: item.author_name,
          published_at: item.published_at,
          updated_at: item.updated_at,
        },
        version: v.version,
        source_format: v.source_format,
        toc_json: v.toc_json,
        references_json: v.references_json,
        body: mode === 'full' ? v.full_body : v.preview_body,
        mode,
      });
    }

    const q = event.queryStringParameters || {};
    const type = String(q.type || '').trim();
    const searchQ = String(q.q || '').trim();
    const tag = String(q.tag || '').trim();
    const limit = Math.max(1, Math.min(50, Number(q.limit || 20)));
    const cursor = String(q.cursor || '').trim();
    const updatedSince = String(q.updated_since || '').trim();

    let query = 'select=id,legacy_article_id,type,title_zh,title_en,summary_zh,tags,status,paywall,author_name,published_at,updated_at,last_published_version_id&status=eq.published&order=updated_at.desc';
    if(type) query += `&type=eq.${encodeURIComponent(type)}`;
    if(tag) query += `&tags=cs.{${encodeURIComponent(tag)}}`;
    if(updatedSince) query += `&updated_at=gte.${encodeURIComponent(updatedSince)}`;
    if(cursor) query += `&updated_at=lt.${encodeURIComponent(cursor)}`;
    if(searchQ) query += `&search_text=ilike.*${encodeURIComponent(searchQ)}*`;
    query += `&limit=${limit}`;

    const res = await sb(`content_items?${query}`);
    if(!res.ok){
      return json(500, { error: 'content_list_failed' });
    }
    const rows = await res.json();

    const out = [];
    for(const row of rows){
      if(!row.last_published_version_id) continue;
      const vr = await sb(`content_versions?id=eq.${encodeURIComponent(row.last_published_version_id)}&select=version,preview_body&limit=1`);
      const v = vr.ok ? (await vr.json())?.[0] : null;
      out.push(normalizeItem({ ...row, version: v?.version || null, preview_body: v?.preview_body || '' }));
    }

    return json(200, {
      items: out,
      next_cursor: out.length ? out[out.length - 1].updated_at : null,
      limit,
    });
  }catch(e){
    return json(500, { error: 'internal_error', message: e?.message || String(e) });
  }
};
