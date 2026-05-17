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

// 用于自动生成实体 slug. 优先 slugify 名字 (英文/拼音输入时可用),
// 中文名 slugify 后是空, 退化成 prefix-base36 时间戳形式.
function autoSlug(name, prefix){
  const s = slugifyName(name);
  if(s) return s;
  return `${prefix}-${Date.now().toString(36)}`;
}

// 保证 slug 在表中唯一. 已存在则加 -2/-3 后缀直到不冲突.
// 超过 50 次后退化成时间戳, 防死循环.
async function ensureUniqueSlug(table, baseSlug){
  let slug = baseSlug;
  let n = 1;
  while(n <= 50){
    const { data } = await supabase.from(table).select('id').eq('slug', slug).maybeSingle();
    if(!data) return slug;
    n += 1;
    slug = `${baseSlug}-${n}`;
  }
  return `${baseSlug}-${Date.now().toString(36)}`;
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

// ──────────────────────────────────────────────────────────
// 通用重命名 / 删除工具（分类 / 专题 / 系列 / 图谱卡共用）
// ──────────────────────────────────────────────────────────
async function renameEntity({ table, id, field, currentName, label }){
  const next = prompt(`重命名${label}：\n（当前：${currentName || '未命名'}）`, currentName || '');
  if(next === null) return;            // 用户取消
  const trimmed = next.trim();
  if(!trimmed){ alert('名称不能为空'); return; }
  if(trimmed === currentName) return;  // 没改
  const { error } = await supabase.from(table).update({ [field]: trimmed }).eq('id', id);
  if(error){ alert('重命名失败：' + (error.message || 'unknown')); return; }
  await refreshAll();
}

async function deleteWithChildCheck({ table, id, name, label, childTable, childFk, childLabel }){
  if(childTable){
    const childQuery = supabase.from(childTable).select('id', { count: 'exact', head: true }).eq(childFk, id);
    // 图谱卡子查询排除回收站
    if(childTable === 'atlas_assets'){
      childQuery.is('deleted_at', null);
    }
    const { count, error: cErr } = await childQuery;
    if(cErr){ alert('校验子项失败：' + (cErr.message || 'unknown')); return; }
    if(count && count > 0){
      alert(`「${name}」下还有 ${count} 个${childLabel}，请先清理或移动后再删除。`);
      return;
    }
  }
  if(!confirm(`永久删除${label}「${name}」？\n不可恢复。`)) return;
  const { error } = await supabase.from(table).delete().eq('id', id);
  if(error){ alert('删除失败：' + (error.message || 'unknown')); return; }
  await refreshAll();
}

async function toggleTopicPublish(topic){
  // atlas_topics 表没有 published_at 列 (跟 atlas_series 不一样), 只更 status
  const next = topic.status === 'published' ? 'draft' : 'published';
  const { error } = await supabase.from('atlas_topics').update({ status: next }).eq('id', topic.id);
  if(error){ alert('切换失败：' + (error.message || 'unknown')); return; }
  await refreshAll();
}

// 把所有 draft 状态的专题和系列一键发布,
// 用于"我以前传过一堆但没点发布,导致首页看不到"的批量补救场景.
async function publishAllDrafts(){
  if(!confirm('一键发布所有草稿状态的专题和系列?\n会让它们立刻出现在 atlas.html 上。')) return;
  const now = new Date().toISOString();
  const [topicRes, seriesRes] = await Promise.all([
    supabase.from('atlas_topics').update({ status:'published' }).eq('status','draft').select('id'),
    supabase.from('atlas_series').update({ status:'published', published_at: now }).eq('status','draft').select('id'),
  ]);
  if(topicRes.error || seriesRes.error){
    alert('发布失败：' + ((topicRes.error||seriesRes.error)?.message || 'unknown'));
    return;
  }
  alert(`已发布: ${topicRes.data?.length || 0} 个专题, ${seriesRes.data?.length || 0} 个系列`);
  await refreshAll();
}

// 上/下移动分类的 sort_order, 决定 atlas.html 板块的展示顺序
async function moveCategory(cat, direction){
  const { data: rows } = await supabase
    .from('atlas_categories')
    .select('id,sort_order')
    .eq('status','published')
    .order('sort_order',{ascending:true})
    .order('id',{ascending:true});
  if(!rows?.length) return;
  const idx = rows.findIndex(r => r.id === cat.id);
  if(idx < 0) return;
  const swapIdx = idx + direction;
  if(swapIdx < 0 || swapIdx >= rows.length) return;
  // 重排所有 sort_order 为 1..N 保证连续 (避免之前手动数据没设 sort_order 都是 0 的情况)
  const reordered = rows.slice();
  [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];
  const updates = reordered.map((r,i) => supabase.from('atlas_categories').update({ sort_order: i+1 }).eq('id', r.id));
  await Promise.all(updates);
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
    .is('deleted_at', null)
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

async function reorderAssetToPosition(source, target){
  if(source.series_id !== target.series_id) return;
  const { data: rows } = await supabase
    .from('atlas_assets')
    .select('id,sequence_no')
    .eq('series_id', source.series_id)
    .is('deleted_at', null)
    .order('sequence_no', { ascending: true });
  if(!rows?.length) return;
  const sourceRow = rows.find(r => r.id === source.id);
  if(!sourceRow) return;
  const filtered = rows.filter(r => r.id !== source.id);
  const targetIdx = filtered.findIndex(r => r.id === target.id);
  if(targetIdx < 0) return;
  filtered.splice(targetIdx, 0, sourceRow);
  const updates = [];
  filtered.forEach((r, i) => {
    const newSeq = i + 1;
    if(r.sequence_no !== newSeq){
      updates.push(supabase.from('atlas_assets').update({ sequence_no: newSeq }).eq('id', r.id));
    }
  });
  if(updates.length) await Promise.all(updates);
  await refreshAll();
}

function setupAssetDragReorder(assetById){
  const list = $('assetList');
  if(!list || list.dataset.dragWired === '1') return;
  list.dataset.dragWired = '1';
  let sourceId = null;
  const clearHighlights = ()=>{
    list.querySelectorAll('[data-asset-card]').forEach(c=>{
      c.style.outline = '';
      c.style.opacity = '';
    });
  };
  list.addEventListener('dragstart', (e)=>{
    const card = e.target.closest('[data-asset-card]');
    if(!card) return;
    sourceId = card.getAttribute('data-asset-card');
    card.style.opacity = '0.4';
    if(e.dataTransfer){
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', sourceId); } catch {}
    }
  });
  list.addEventListener('dragend', ()=>{ clearHighlights(); sourceId = null; });
  list.addEventListener('dragover', (e)=>{
    const card = e.target.closest('[data-asset-card]');
    if(!card || !sourceId) return;
    const src = assetById[sourceId];
    const dst = assetById[card.getAttribute('data-asset-card')];
    if(!src || !dst || src.series_id !== dst.series_id) return;
    e.preventDefault();
    if(e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  });
  list.addEventListener('dragenter', (e)=>{
    const card = e.target.closest('[data-asset-card]');
    if(!card || !sourceId) return;
    const cardId = card.getAttribute('data-asset-card');
    if(cardId === sourceId) return;
    const src = assetById[sourceId];
    const dst = assetById[cardId];
    if(!src || !dst || src.series_id !== dst.series_id) return;
    card.style.outline = '2px solid #4a90e2';
  });
  list.addEventListener('dragleave', (e)=>{
    const card = e.target.closest('[data-asset-card]');
    if(card) card.style.outline = '';
  });
  list.addEventListener('drop', async (e)=>{
    e.preventDefault();
    const card = e.target.closest('[data-asset-card]');
    if(!card || !sourceId) return;
    const targetId = card.getAttribute('data-asset-card');
    if(targetId === sourceId) return;
    const source = assetById[sourceId];
    const target = assetById[targetId];
    if(!source || !target) return;
    clearHighlights();
    await reorderAssetToPosition(source, target);
  });
}

function setupQuickUploadDropZone(){
  const zone = $('quickDropZone');
  const input = $('quickFiles');
  const summary = $('quickFileSummary');
  if(!zone || !input || !summary) return;

  const refreshSummary = ()=>{
    const n = input.files?.length || 0;
    summary.textContent = n ? `已选择 ${n} 个文件（再次拖入会追加，提交后会自动清空）` : '尚未选择文件';
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
      // 追加已有文件 (拖拽追加, 不覆盖)
      const existing = Array.from(input.files || []);
      const existingKeys = new Set(existing.map(f => `${f.name}|${f.size}`));
      existing.forEach(f => dt.items.add(f));
      // 加入新拖入的图片, 跳过同名同大小的重复
      images.forEach(f => {
        const k = `${f.name}|${f.size}`;
        if(!existingKeys.has(k)){
          dt.items.add(f);
          existingKeys.add(k);
        }
      });
      input.files = dt.files;
    } catch {
      // 老浏览器不支持 DataTransfer 构造, 跳过追加, fallback 用 picker
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

  const publishAllBtn = $('publishAllDraftsBtn');
  if(publishAllBtn) publishAllBtn.onclick = ()=> publishAllDrafts();

  $('quickUploadForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const seriesId = Number(fd.get('series_id'));
    const files = Array.from(($('quickFiles')?.files || []));
    const userPrefix = String(fd.get('prefix') || '').trim();
    const firstPreview = !!$('quickFirstPreview')?.checked;
    const progress = $('quickUploadProgress');
    if(!seriesId || !files.length){ alert('请选择系列并上传图片'); return; }

    // 未填前缀时, 用"专题 · 系列" (来自下拉选项 textContent) 当默认前缀,
    // 避免出现单纯 "01" "02" 这种不知道属于谁的标题
    const selectedOpt = $('quickSeriesId').selectedOptions?.[0];
    const autoPrefix = selectedOpt ? selectedOpt.textContent.trim() : '';
    const prefix = userPrefix || autoPrefix;

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
    const name = String(fd.get('name') || '').trim();
    const baseSlug = String(fd.get('slug') || '').trim() || autoSlug(name, 'cat');
    const slug = await ensureUniqueSlug('atlas_categories', baseSlug);
    const description = String(fd.get('description') || '').trim() || null;
    const { error } = await supabase.from('atlas_categories').insert({
      name, slug, description, status: 'published',
    });
    if(error){ alert('新增分类失败：' + (error.message || 'unknown')); return; }
    if(slug !== baseSlug) alert(`slug "${baseSlug}" 已被占用，已自动改为 "${slug}"`);
    e.currentTarget.reset();
    await refreshAll();
  });

  $('topicForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const name = String(fd.get('name') || '').trim();
    const baseSlug = String(fd.get('slug') || '').trim() || autoSlug(name, 'topic');
    const slug = await ensureUniqueSlug('atlas_topics', baseSlug);
    const summary = String(fd.get('summary') || '').trim() || null;
    const { error } = await supabase.from('atlas_topics').insert({
      category_id: Number(fd.get('category_id')), name, slug, summary,
      status: 'published',
    });
    if(error){ alert('新增专题失败：' + (error.message || 'unknown')); return; }
    if(slug !== baseSlug) alert(`slug "${baseSlug}" 已被占用，已自动改为 "${slug}"`);
    e.currentTarget.reset();
    await refreshAll();
  });

  $('seriesForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const title = String(fd.get('title') || '').trim();
    const baseSlug = String(fd.get('slug') || '').trim() || autoSlug(title, 'series');
    const slug = await ensureUniqueSlug('atlas_series', baseSlug);
    const subtitle = String(fd.get('subtitle') || '').trim() || null;
    const summary = String(fd.get('summary') || '').trim() || null;
    const { error } = await supabase.from('atlas_series').insert({
      topic_id: Number(fd.get('topic_id')), title, slug, subtitle, summary,
      visibility: 'pro', status: 'published', published_at: new Date().toISOString(),
    });
    if(error){ alert('新增系列失败：' + (error.message || 'unknown')); return; }
    if(slug !== baseSlug) alert(`slug "${baseSlug}" 已被占用，已自动改为 "${slug}"`);
    e.currentTarget.reset();
    await refreshAll();
  });
}

async function refreshAll(){
  const assetFields = 'id,title,series_id,sequence_no,image_path,preview_image_path,thumbnail_path,visibility,deidentified_status,copyright_status,review_status,deleted_at';
  const [cat, topic, series, assets, trash, refs] = await Promise.all([
    supabase.from('atlas_categories').select('id,name,slug,icon,sort_order,status').order('sort_order',{ascending:true}).order('id',{ascending:true}),
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

  // 专题下拉显示 "分类 · 专题", 系列下拉显示 "专题 · 系列",
  // 这样多个同名的子项可以区分开
  const catNameById = Object.fromEntries(cats.map(c => [c.id, c.name]));
  const topicNameById = Object.fromEntries(topics.map(t => [t.id, t.name]));
  $('topicCategory').innerHTML = cats.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $('seriesTopic').innerHTML = topics.map(t=>{
    const cn = catNameById[t.category_id];
    const label = cn ? `${cn} · ${t.name}` : t.name;
    return `<option value="${t.id}">${esc(label)}</option>`;
  }).join('');
  const seriesOptionsHtml = listSeries.map(x=>{
    const tn = topicNameById[x.topic_id];
    const label = tn ? `${tn} · ${x.title}` : x.title;
    return `<option value="${x.id}" data-topic="${esc(tn||'')}" data-series="${esc(x.title)}">${esc(label)}</option>`;
  }).join('');
  $('assetSeries').innerHTML = seriesOptionsHtml;
  $('quickSeriesId').innerHTML = seriesOptionsHtml;
  $('refSeries').innerHTML = seriesOptionsHtml;

  $('catList').innerHTML = cats.map(c=>`<div class="card" style="padding:8px;display:flex;align-items:center;gap:8px;">
    <span style="font-size:18px;line-height:1;">${esc(c.icon || '📚')}</span>
    <div style="flex:1;min-width:0;"><b>${esc(c.name)}</b> · ${esc(c.slug)} · #${esc(String(c.sort_order ?? 0))} · ${esc(c.status)}</div>
    <button class="btn tiny" data-cat-up="${c.id}" title="上移（影响首页板块顺序）">↑</button>
    <button class="btn tiny" data-cat-down="${c.id}" title="下移">↓</button>
    <button class="btn tiny" data-cat-rename="${c.id}" title="重命名">✏️</button>
    <button class="btn tiny danger" data-cat-delete="${c.id}" title="删除">🗑</button>
  </div>`).join('') || '<div class="note">暂无分类</div>';

  $('topicList').innerHTML = topics.map(t=>`<div class="card" style="padding:8px;display:flex;align-items:center;gap:8px;">
    <div style="flex:1;min-width:0;"><b>${esc(t.name)}</b> · ${esc(t.slug)} · ${esc(t.status)}</div>
    <button class="btn tiny" data-topic-toggle="${t.id}" title="${t.status==='published'?'撤回为草稿':'发布'}">${t.status==='published'?'撤回':'发布'}</button>
    <button class="btn tiny" data-topic-rename="${t.id}" title="重命名">✏️</button>
    <button class="btn tiny danger" data-topic-delete="${t.id}" title="删除">🗑</button>
  </div>`).join('') || '<div class="note">暂无专题</div>';

  $('seriesList').innerHTML = listSeries.map(s=>`<div class="card" style="padding:8px;display:flex;align-items:center;gap:8px;">
    <div style="flex:1;min-width:0;"><b>${esc(s.title)}</b> · ${esc(s.slug)} · ${esc(s.visibility)} / ${esc(s.status)}</div>
    <button class="btn tiny" data-publish-series="${s.id}">${s.status==='published'?'已发布':'发布'}</button>
    <button class="btn tiny" data-series-rename="${s.id}" title="重命名">✏️</button>
    <button class="btn tiny danger" data-series-delete="${s.id}" title="删除">🗑</button>
  </div>`).join('') || '<div class="note">暂无系列</div>';
  const seriesById = Object.fromEntries(listSeries.map(s=>[s.id, s.title]));
  $('assetList').innerHTML = listAssets.map(a=>{
    const thumb = publicUrl('atlas_previews', a.thumbnail_path || a.preview_image_path);
    const seriesName = seriesById[a.series_id] || `系列#${a.series_id}`;
    return `<div class="card" data-asset-card="${a.id}" draggable="true" style="padding:8px;display:flex;align-items:center;gap:10px;cursor:grab;">
      <span style="color:#888;cursor:grab;user-select:none;" title="拖拽以重排">⋮⋮</span>
      <img src="${esc(thumb)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" style="width:60px;height:60px;object-fit:cover;border-radius:4px;background:#1a2230;flex-shrink:0;" />
      <div style="flex:1;min-width:0;">
        <div style="font-weight:bold;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(a.title||'未命名')}</div>
        <div class="small muted">${esc(seriesName)} · #${a.sequence_no} · ${esc(a.visibility)} · 去标识:${esc(a.deidentified_status)} · 审核:${esc(a.review_status)}</div>
      </div>
      <button class="btn tiny" data-asset-rename="${a.id}" title="重命名">✏️</button>
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

  // ── 分类 重命名 / 删除 ──
  const catById = Object.fromEntries(cats.map(c=>[String(c.id), c]));
  document.querySelectorAll('[data-cat-rename]').forEach(btn=>{
    btn.onclick = ()=>{
      const c = catById[btn.getAttribute('data-cat-rename')];
      renameEntity({ table:'atlas_categories', id:c.id, field:'name', currentName:c.name, label:'分类' });
    };
  });
  document.querySelectorAll('[data-cat-delete]').forEach(btn=>{
    btn.onclick = ()=>{
      const c = catById[btn.getAttribute('data-cat-delete')];
      deleteWithChildCheck({ table:'atlas_categories', id:c.id, name:c.name, label:'分类',
        childTable:'atlas_topics', childFk:'category_id', childLabel:'专题' });
    };
  });
  document.querySelectorAll('[data-cat-up]').forEach(btn=>{
    btn.onclick = ()=> moveCategory(catById[btn.getAttribute('data-cat-up')], -1);
  });
  document.querySelectorAll('[data-cat-down]').forEach(btn=>{
    btn.onclick = ()=> moveCategory(catById[btn.getAttribute('data-cat-down')], +1);
  });

  // ── 专题 重命名 / 删除 / 发布切换 ──
  const topicById = Object.fromEntries(topics.map(t=>[String(t.id), t]));
  document.querySelectorAll('[data-topic-rename]').forEach(btn=>{
    btn.onclick = ()=>{
      const t = topicById[btn.getAttribute('data-topic-rename')];
      renameEntity({ table:'atlas_topics', id:t.id, field:'name', currentName:t.name, label:'专题' });
    };
  });
  document.querySelectorAll('[data-topic-delete]').forEach(btn=>{
    btn.onclick = ()=>{
      const t = topicById[btn.getAttribute('data-topic-delete')];
      deleteWithChildCheck({ table:'atlas_topics', id:t.id, name:t.name, label:'专题',
        childTable:'atlas_series', childFk:'topic_id', childLabel:'系列' });
    };
  });
  document.querySelectorAll('[data-topic-toggle]').forEach(btn=>{
    btn.onclick = ()=>{
      const t = topicById[btn.getAttribute('data-topic-toggle')];
      toggleTopicPublish(t);
    };
  });

  // ── 系列 重命名 / 删除 ──
  const seriesById2 = Object.fromEntries(listSeries.map(s=>[String(s.id), s]));
  document.querySelectorAll('[data-series-rename]').forEach(btn=>{
    btn.onclick = ()=>{
      const s = seriesById2[btn.getAttribute('data-series-rename')];
      renameEntity({ table:'atlas_series', id:s.id, field:'title', currentName:s.title, label:'系列' });
    };
  });
  document.querySelectorAll('[data-series-delete]').forEach(btn=>{
    btn.onclick = ()=>{
      const s = seriesById2[btn.getAttribute('data-series-delete')];
      deleteWithChildCheck({ table:'atlas_series', id:s.id, name:s.title, label:'系列',
        childTable:'atlas_assets', childFk:'series_id', childLabel:'图谱卡（不含回收站）' });
    };
  });

  // ── 图谱卡 ──
  const assetById = Object.fromEntries([...listAssets, ...trashAssets].map(a=>[String(a.id), a]));
  document.querySelectorAll('[data-asset-rename]').forEach(btn=>{
    btn.onclick = ()=>{
      const a = assetById[btn.getAttribute('data-asset-rename')];
      renameEntity({ table:'atlas_assets', id:a.id, field:'title', currentName:a.title, label:'图谱卡标题' });
    };
  });
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

  setupAssetDragReorder(assetById);
}

init();
