import { ensureSupabase, supabase, getCurrentUser, getUserProfile, isAdminRole, normalizeRole } from './supabaseClient.js?v=20260401_fix';

const $ = (id)=>document.getElementById(id);
const esc = (s)=>String(s||'').replace(/[&<>\"]/g, m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[m]));

async function init(){
  await ensureSupabase();
  const user = await getCurrentUser();
  const profile = user ? await getUserProfile(user) : null;
  const ok = !!(user && isAdminRole(normalizeRole(profile?.role)));
  $('atlasAdminGate').textContent = ok ? '权限校验通过。' : '仅管理员可访问此页面。';
  $('atlasAdminPanel').hidden = !ok;
  if(!ok) return;

  await refreshAll();




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

    for(let i=0;i<files.length;i++){
      const f = files[i];
      seq += 1;
      const ext = extOf(f);
      const base = `${Date.now()}-${i+1}-${slugifyName(f.name)}`;
      const hdPath = `series-${seriesId}/${base}${ext}`;
      const prevPath = `series-${seriesId}/preview-${base}${ext}`;
      const thumbPath = `series-${seriesId}/thumb-${base}${ext}`;
      progress.textContent = `上传中 ${i+1}/${files.length}：${f.name}`;

      // HD private
      await uploadToBucket('atlas_hd', hdPath, f);
      // For MVP speed, preview/thumbnail reuse original file
      await uploadToBucket('atlas_previews', prevPath, f);
      await uploadToBucket('atlas_previews', thumbPath, f);

      const title = `${prefix ? prefix + ' ' : ''}${String(seq).padStart(2,'0')}`;
      await supabase.from('atlas_assets').insert({
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
    }
    progress.textContent = `完成：共上传 ${files.length} 张`;
    form.reset();
    await refreshAll();
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
  const [cat, topic, series, assets, refs] = await Promise.all([
    supabase.from('atlas_categories').select('id,name,slug,status').order('sort_order'),
    supabase.from('atlas_topics').select('id,name,slug,status,category_id').order('updated_at',{ascending:false}).limit(50),
    supabase.from('atlas_series').select('id,title,slug,status,visibility,topic_id').order('updated_at',{ascending:false}).limit(50),
    supabase.from('atlas_assets').select('id,title,series_id,visibility,deidentified_status,copyright_status,review_status').order('updated_at',{ascending:false}).limit(50),
    supabase.from('atlas_references').select('id,series_id,citation_text,source_type').order('created_at',{ascending:false}).limit(50),
  ]);
  const cats = cat.data || [];
  const topics = topic.data || [];
  const listSeries = series.data || [];
  const listAssets = assets.data || [];
  const listRefs = refs.data || [];

  $('topicCategory').innerHTML = cats.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $('seriesTopic').innerHTML = topics.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('');
  $('assetSeries').innerHTML = listSeries.map(x=>`<option value="${x.id}">${esc(x.title)}</option>`).join('');
  $('quickSeriesId').innerHTML = listSeries.map(x=>`<option value="${x.id}">${esc(x.title)}</option>`).join('');
  $('refSeries').innerHTML = listSeries.map(x=>`<option value="${x.id}">${esc(x.title)}</option>`).join('');

  $('catList').innerHTML = cats.map(c=>`<div class="card" style="padding:8px;"><b>${esc(c.name)}</b> · ${esc(c.slug)} · ${esc(c.status)}</div>`).join('') || '<div class="note">暂无分类</div>';
  $('topicList').innerHTML = topics.map(t=>`<div class="card" style="padding:8px;"><b>${esc(t.name)}</b> · ${esc(t.slug)} · ${esc(t.status)}</div>`).join('') || '<div class="note">暂无专题</div>';
  $('seriesList').innerHTML = listSeries.map(s=>`<div class="card" style="padding:8px;"><b>${esc(s.title)}</b> · ${esc(s.slug)} · ${esc(s.visibility)} / ${esc(s.status)} <button class="btn tiny" data-publish-series="${s.id}">发布</button></div>`).join('') || '<div class="note">暂无系列</div>';
  $('assetList').innerHTML = listAssets.map(a=>`<div class="card" style="padding:8px;"><b>${esc(a.title||'未命名')}</b> · ${esc(a.visibility)} · 版权:${esc(a.copyright_status)} · 去标识:${esc(a.deidentified_status)} · 审核:${esc(a.review_status)}</div>`).join('') || '<div class="note">暂无图谱卡</div>';
  $('refList').innerHTML = listRefs.map(r=>`<div class="card" style="padding:8px;">${esc(r.citation_text)} <span class="badge">${esc(r.source_type||'paper')}</span></div>`).join('') || '<div class="note">暂无参考文献</div>'; 

  document.querySelectorAll('[data-publish-series]').forEach(btn=>{
    btn.onclick = async ()=>{
      const id = Number(btn.getAttribute('data-publish-series'));
      const { error } = await supabase.from('atlas_series').update({ status: 'published', published_at: new Date().toISOString() }).eq('id', id);
      if(error) alert('发布失败：'+ (error.message||'unknown'));
      await refreshAll();
    };
  });
}

init();
