import { ensureSupabase, supabase, getCurrentUser, getUserProfile, isAdminRole, normalizeRole } from './supabaseClient.js?v=20260401_fix';

const $ = (id)=>document.getElementById(id);
const esc = (s)=>String(s||'').replace(/[&<>\"]/g, m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[m]));

function extOf(file){
  const name = file?.name || '';
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.substring(idx).toLowerCase() : '';
}

function slugifyName(name){
  return String(name||'')
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9\-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50);
}

async function uploadToBucket(bucket, path, file){
  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    upsert: false,
    contentType: file.type || undefined,
  });
  if(error) throw error;
}

function publicUrl(bucket, path){
  if(!path) return '';
  try {
    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    return data?.publicUrl || '';
  } catch {
    return '';
  }
}

function formatDeletedAgo(iso){
  if(!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if(ms < 60000) return '刚刚删除';
  const m = Math.floor(ms / 60000);
  if(m < 60) return `${m} 分钟前删除`;
  const h = Math.floor(ms / 3600000);
  if(h < 24) return `${h} 小时前删除`;
  const d = Math.floor(ms / 86400000);
  return `${d} 天前删除`;
}

async function deleteAsset(asset){
  if(!confirm(`确定删除「${asset.title || '未命名'}」？\n会移动到回收站，30 天内可恢复。`)) return;
  const { error } = await supabase.from('atlas_assets').update({ deleted_at: new Date().toISOString() }).eq('id', asset.id);
  if(error){ alert('删除失败：' + (error.message || 'unknown')); return; }
  await refreshAll();
}

async function restoreAsset(asset){
  const { error } = await supabase.from('atlas_assets').update({ deleted_at: null }).eq('id', asset.id);
  if(error){ alert('恢复失败：' + (error.message || 'unknown')); return; }
  await refreshAll();
}

async function purgeAsset(asset){
  if(!confirm(`永久删除「${asset.title || '未命名'}」？\n图片文件和数据库记录都会立刻清除，不可恢复。`)) return;
  const tasks = [];
  if(asset.image_path) tasks.push(supabase.storage.from('atlas_hd').remove([asset.image_path]));
  if(asset.preview_image_path) tasks.push(supabase.storage.from('atlas_previews').remove([asset.preview_image_path]));
  if(asset.thumbnail_path && asset.thumbnail_path !== asset.preview_image_path){
    tasks.push(supabase.storage.from('atlas_previews').remove([asset.thumbnail_path]));
  }
  await Promise.allSettled(tasks);
  const { error } = await supabase.from('atlas_assets').delete().eq('id', asset.id);
  if(error){ alert('永久删除失败：' + (error.message || 'unknown')); return; }
  await refreshAll();
}

async function moveAsset(asset, direction){
  const { data: rows } = await supabase
    .from('atlas_assets')
    .select('id,sequence_no')
    .eq('series_id', asset.series_id)
    .order('sequence_no', { ascending: true });
  if(!rows?.length) return;
  const idx = rows.findIndex(r => r.id === asset.id);
  if(idx < 0) return;
  const swapIdx = idx + direction;
  if(swapIdx < 0 || swapIdx >= rows.length) return;
  const neighbor = rows[swapIdx];
  await Promise.all([
    supabase.from('atlas_assets').update({ sequence_no: neighbor.sequence_no }).eq('id', asset.id),
    supabase.from('atlas_assets').update({ sequence_no: asset.sequence_no }).eq('id', neighbor.id),
  ]);
  await refreshAll();
}

function setupQuickUploadDropZone(){
  const zone = $('quickDropZone');
  const input = $('quickFiles');
  const summary = $('quickFileSummary');
  if(!zone || !input || !summary) return;

  const refreshSummary = ()=>{
    const n = input.files?.length || 0;
    summary.textContent = n ? `已选择 ${n} 个文件` : '尚未选择文件';
  };
  input.addEventListener('change', refreshSummary);
  $('quickUploadForm')?.addEventListener('reset', ()=>setTimeout(refreshSummary, 0));

  const setActive = (on)=>{
    zone.style.borderColor = on ? '#4a90e2' : '#888';
    zone.style.backgroundColor = on ? 'rgba(74,144,226,0.1)' : '';
  };

  ['dragenter','dragover'].forEach(evt=>{
    zone.addEventListener(evt, (e)=>{ e.preventDefault(); e.stopPropagation(); setActive(true); });
  });
  ['dragleave','dragend'].forEach(evt=>{
    zone.addEventListener(evt, (e)=>{ e.preventDefault(); e.stopPropagation(); setActive(false); });
  });
  zone.addEventListener('drop', (e)=>{
    e.preventDefault(); e.stopPropagation(); setActive(false);
    const dropped = Array.from(e.dataTransfer?.files || []);
    const images = dropped.filter(f => f.type && f.type.startsWith('image/'));
    if(!images.length){ summary.textContent = '只支持图片文件'; return; }
    try {
      const dt = new DataTransfer();
      images.forEach(f => dt.items.add(f));
      input.files = dt.files;
    } catch {
      // Older browsers without constructable DataTransfer fall back to picker
    }
    refreshSummary();
  });
}

async function init(){
  await ensureSupabase();
  const user = await getCurrentUser();
  const profile = user ? await getUserProfile(user) : null;
  const ok = !!(user && isAdminRole(normalizeRole(profile?.role)));
  $('atlasAdminGate').textContent = ok ? '权限校验通过。' : '仅管理员可访问此页面。';
  $('atlasAdminPanel').hidden = !ok;
  if(!ok) return;

  await refreshAll();

  setupQuickUploadDropZone();

  $('quickUploadForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const seriesId = Number(fd.get('series_id'));
    const files = Array.from(($('quickFiles')?.files || []));
    const prefix = String(fd.get('prefix') || '').trim();
    const firstPreview = !!$('quickFirstPreview')?.checked;
    const progress = $('quickUploadProgress');
    if(!seriesId || !files.length){ alert('请选择系列并上传图片'); return; }

    const { data: maxRows } = await supabase.from('atlas_assets').select('sequence_no').eq('series_id', seriesId).order('sequence_no',{ascending:false}).limit(1);
    let seq = Number(maxRows?.[0]?.sequence_no || 0);

    try {
      for(let i=0;i<files.length;i++){
        const f = files[i];
        seq += 1;
        const ext = extOf(f);
        const base = `${Date.now()}-${i+1}-${slugifyName(f.name)}`;
        const hdPath = `series-${seriesId}/${base}${ext}`;
        const prevPath = `series-${seriesId}/preview-${base}${ext}`;
        const thumbPath = `series-${seriesId}/thumb-${base}${ext}`;
        progress.textContent = `上传中 ${i+1}/${files.length}：${f.name}`;

        await uploadToBucket('atlas_hd', hdPath, f);
        await uploadToBucket('atlas_previews', prevPath, f);
        await uploadToBucket('atlas_previews', thumbPath, f);

        const title = `${prefix ? prefix + ' ' : ''}${String(seq).padStart(2,'0')}`;
        const { error: insErr } = await supabase.from('atlas_assets').insert({
          series_id: seriesId,
          title,
          sequence_no: seq,
          image_path: hdPath,
          preview_image_path: prevPath,
          thumbnail_path: thumbPath,
          visibility: (firstPreview && i===0) ? 'free' : 'pro',
          is_preview: !!(firstPreview && i===0),
          deidentified_status: 'confirmed',
          copyright_status: 'original',
          review_status: 'reviewed',
        });
        if(insErr) throw insErr;
      }
      progress.textContent = `完成：共上传 ${files.length} 张`;
      form.reset();
      await refreshAll();
    } catch(err){
      progress.textContent = `上传失败：${err?.message || '未知错误'}`;
    }
  });

  $('refForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    await supabase.from('atlas_references').insert({ series_id: Number(fd.get('series_id')), citation_text: fd.get('citation_text'), source_type: 'paper' });
    e.currentTarget.reset();
    await refreshAll();
  });

  $('assetForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    await supabase.from('atlas_assets').insert({
      series_id: Number(fd.get('series_id')),
      title: fd.get('title'),
      visibility: fd.get('visibility') || 'pro',
      deidentified_status: fd.get('deidentified_status') || 'confirmed',
      copyright_status: 'original',
      review_status: 'reviewed',
      sequence_no: 1,
      is_preview: fd.get('visibility') === 'free'
    });
    e.currentTarget.reset();
    await refreshAll();
  });

  $('catForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    await supabase.from('atlas_categories').insert({ name: fd.get('name'), slug: fd.get('slug'), status: 'published' });
    e.currentTarget.reset();
    await refreshAll();
  });

  $('topicForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    await supabase.from('atlas_topics').insert({ category_id: Number(fd.get('category_id')), name: fd.get('name'), slug: fd.get('slug'), status: 'draft' });
    e.currentTarget.reset();
    await refreshAll();
  });

  $('seriesForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    await supabase.from('atlas_series').insert({ topic_id: Number(fd.get('topic_id')), title: fd.get('title'), slug: fd.get('slug'), visibility: 'pro', status: 'draft' });
    e.currentTarget.reset();
    await refreshAll();
  });
}

async function refreshAll(){
  const assetFields = 'id,title,series_id,sequence_no,image_path,preview_image_path,thumbnail_path,visibility,deidentified_status,copyright_status,review_status,deleted_at';
  const [cat, topic, series, assets, trash, refs] = await Promise.all([
    supabase.from('atlas_categories').select('id,name,slug,status').order('sort_order'),
    supabase.from('atlas_topics').select('id,name,slug,status,category_id').order('updated_at',{ascending:false}).limit(50),
    supabase.from('atlas_series').select('id,title,slug,status,visibility,topic_id').order('updated_at',{ascending:false}).limit(50),
    supabase.from('atlas_assets').select(assetFields).is('deleted_at', null).order('series_id',{ascending:true}).order('sequence_no',{ascending:true}).limit(500),
    supabase.from('atlas_assets').select(assetFields).not('deleted_at','is',null).order('deleted_at',{ascending:false}).limit(200),
    supabase.from('atlas_references').select('id,series_id,citation_text,source_type').order('created_at',{ascending:false}).limit(50),
  ]);
  const cats = cat.data || [];
  const topics = topic.data || [];
  const listSeries = series.data || [];
  const listAssets = assets.data || [];
  const trashAssets = trash.data || [];
  const listRefs = refs.data || [];

  $('topicCategory').innerHTML = cats.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $('seriesTopic').innerHTML = topics.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('');
  $('assetSeries').innerHTML = listSeries.map(x=>`<option value="${x.id}">${esc(x.title)}</option>`).join('');
  $('quickSeriesId').innerHTML = listSeries.map(x=>`<option value="${x.id}">${esc(x.title)}</option>`).join('');
  $('refSeries').innerHTML = listSeries.map(x=>`<option value="${x.id}">${esc(x.title)}</option>`).join('');

  $('catList').innerHTML = cats.map(c=>`<div class="card" style="padding:8px;"><b>${esc(c.name)}</b> · ${esc(c.slug)} · ${esc(c.status)}</div>`).join('') || '<div class="note">暂无分类</div>';
  $('topicList').innerHTML = topics.map(t=>`<div class="card" style="padding:8px;"><b>${esc(t.name)}</b> · ${esc(t.slug)} · ${esc(t.status)}</div>`).join('') || '<div class="note">暂无专题</div>';
  $('seriesList').innerHTML = listSeries.map(s=>`<div class="card" style="padding:8px;"><b>${esc(s.title)}</b> · ${esc(s.slug)} · ${esc(s.visibility)} / ${esc(s.status)} <button class="btn tiny" data-publish-series="${s.id}">发布</button></div>`).join('') || '<div class="note">暂无系列</div>';
  const seriesById = Object.fromEntries(listSeries.map(s=>[s.id, s.title]));
  $('assetList').innerHTML = listAssets.map(a=>{
    const thumb = publicUrl('atlas_previews', a.thumbnail_path || a.preview_image_path);
    const seriesName = seriesById[a.series_id] || `系列#${a.series_id}`;
    return `<div class="card" style="padding:8px;display:flex;align-items:center;gap:10px;">
      <img src="${esc(thumb)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" style="width:60px;height:60px;object-fit:cover;border-radius:4px;background:#1a2230;flex-shrink:0;" />
      <div style="flex:1;min-width:0;">
        <div style="font-weight:bold;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(a.title||'未命名')}</div>
        <div class="small muted">${esc(seriesName)} · #${a.sequence_no} · ${esc(a.visibility)} · 去标识:${esc(a.deidentified_status)} · 审核:${esc(a.review_status)}</div>
      </div>
      <button class="btn tiny" data-asset-up="${a.id}" title="上移">↑</button>
      <button class="btn tiny" data-asset-down="${a.id}" title="下移">↓</button>
      <button class="btn tiny danger" data-asset-delete="${a.id}" title="删除">🗑</button>
    </div>`;
  }).join('') || '<div class="note">暂无图谱卡</div>';

  if($('trashCount')) $('trashCount').textContent = trashAssets.length ? `(${trashAssets.length})` : '';
  if($('trashList')) $('trashList').innerHTML = trashAssets.map(a=>{
    const thumb = publicUrl('atlas_previews', a.thumbnail_path || a.preview_image_path);
    const seriesName = seriesById[a.series_id] || `系列#${a.series_id}`;
    return `<div class="card" style="padding:8px;display:flex;align-items:center;gap:10px;opacity:0.7;">
      <img src="${esc(thumb)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" style="width:60px;height:60px;object-fit:cover;border-radius:4px;background:#1a2230;flex-shrink:0;filter:grayscale(0.5);" />
      <div style="flex:1;min-width:0;">
        <div style="font-weight:bold;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(a.title||'未命名')}</div>
        <div class="small muted">${esc(seriesName)} · #${a.sequence_no} · ${esc(formatDeletedAgo(a.deleted_at))}</div>
      </div>
      <button class="btn tiny" data-asset-restore="${a.id}" title="恢复">↺ 恢复</button>
      <button class="btn tiny danger" data-asset-purge="${a.id}" title="永久删除">永久删除</button>
    </div>`;
  }).join('') || '<div class="note">回收站为空</div>';

  $('refList').innerHTML = listRefs.map(r=>`<div class="card" style="padding:8px;">${esc(r.citation_text)} <span class="badge">${esc(r.source_type||'paper')}</span></div>`).join('') || '<div class="note">暂无参考文献</div>';

  document.querySelectorAll('[data-publish-series]').forEach(btn=>{
    btn.onclick = async ()=>{
      const id = Number(btn.getAttribute('data-publish-series'));
      const { error } = await supabase.from('atlas_series').update({ status: 'published', published_at: new Date().toISOString() }).eq('id', id);
      if(error) alert('发布失败：'+ (error.message||'unknown'));
      await refreshAll();
    };
  });

  const assetById = Object.fromEntries([...listAssets, ...trashAssets].map(a=>[String(a.id), a]));
  document.querySelectorAll('[data-asset-delete]').forEach(btn=>{
    btn.onclick = ()=> deleteAsset(assetById[btn.getAttribute('data-asset-delete')]);
  });
  document.querySelectorAll('[data-asset-up]').forEach(btn=>{
    btn.onclick = ()=> moveAsset(assetById[btn.getAttribute('data-asset-up')], -1);
  });
  document.querySelectorAll('[data-asset-down]').forEach(btn=>{
    btn.onclick = ()=> moveAsset(assetById[btn.getAttribute('data-asset-down')], +1);
  });
  document.querySelectorAll('[data-asset-restore]').forEach(btn=>{
    btn.onclick = ()=> restoreAsset(assetById[btn.getAttribute('data-asset-restore')]);
  });
  document.querySelectorAll('[data-asset-purge]').forEach(btn=>{
    btn.onclick = ()=> purgeAsset(assetById[btn.getAttribute('data-asset-purge')]);
  });
}

init();
