const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

function json(status, body){ return { statusCode: status, headers: { 'Content-Type':'application/json; charset=utf-8' }, body: JSON.stringify(body)}; }
async function sb(path){
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } });
}

exports.handler = async () => {
  try {
    if(!SUPABASE_URL || !SUPABASE_ANON_KEY) return json(500, { error: 'server_not_configured' });
    const [c,t,s,f] = await Promise.all([
      sb('atlas_categories?select=id,name,slug,description&status=eq.published&order=sort_order.asc'),
      sb('atlas_topics?select=id,name,slug,summary,is_featured&status=eq.published&is_featured=eq.true&order=sort_order.asc&limit=8'),
      sb('atlas_series?select=id,title,slug,summary,visibility,updated_at&status=eq.published&visibility=neq.hidden&order=updated_at.desc&limit=8'),
      sb('atlas_assets?select=id,title,series_id,thumbnail_path,preview_image_path,visibility,is_preview&or=(visibility.eq.free,is_preview.eq.true)&order=updated_at.desc&limit=8')
    ]);
    if(!c.ok || !t.ok || !s.ok || !f.ok) return json(500, { error: 'query_failed' });
    return json(200, {
      categories: await c.json(),
      featuredTopics: await t.json(),
      latestSeries: await s.json(),
      freePreviews: await f.json(),
    });
  } catch (e) {
    return json(500, { error: 'internal_error', message: String(e?.message||e) });
  }
};
