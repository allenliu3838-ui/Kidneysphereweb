import { supabase, ensureAuthed, isConfigured, toast, getUserProfile, getCurrentUser, levelMeta, levelBadgeHtml } from './supabaseClient.js';

const form = document.getElementById('profileForm');
const hint = document.getElementById('profileHint');

const avatarPreview = document.getElementById('avatarPreview');
const avatarFile = document.getElementById('avatarFile');
const avatarHint = document.getElementById('avatarHint');
const avatarUploadBtn = document.getElementById('avatarUploadBtn');
const avatarClearBtn = document.getElementById('avatarClearBtn');

const verifyStatusEl = document.getElementById('verifyStatus');
const levelInfoEl = document.getElementById('levelInfo');

const MEDIA_BUCKET = 'media';

function esc(str){
  return String(str ?? '').replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
}

function renderAvatar(url, fallback='M'){
  if(!avatarPreview) return;
  avatarPreview.innerHTML = url ? `<img alt="avatar" src="${esc(url)}" style="width:100%;height:100%;object-fit:cover" />` : esc(fallback);
}

function fileExt(name){
  const n = String(name || '');
  const i = n.lastIndexOf('.');
  return i >= 0 ? n.slice(i+1).toLowerCase() : 'png';
}

async function uploadAvatar(user){
  if(!isConfigured() || !supabase){
    toast('未配置', '请先在 assets/config.js 配置 Supabase', 'err');
    return null;
  }
  const f = avatarFile?.files?.[0];
  if(!f){
    toast('请选择文件', '请选择一张图片作为头像', 'err');
    return null;
  }
  const ext = fileExt(f.name);
  const path = `avatars/${user.id}/${Date.now()}_${Math.random().toString(16).slice(2)}.${ext}`;

  avatarHint.textContent = '上传中...';
  const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(path, f, { upsert:false });
  if(error){
    avatarHint.textContent = '';
    throw error;
  }

  const { data } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(path);
  avatarHint.textContent = '';
  return data?.publicUrl || null;
}

function statusLabel(s){
  const v = String(s || '').toLowerCase();
  if(v === 'verified') return '✅ 已通过验证';
  if(v === 'pending') return '⏳ 待审核';
  if(v === 'rejected') return '❌ 未通过（可重新提交）';
  return '⚪ 未验证';
}

(async function init(){
  await ensureAuthed('login.html');

  const user = await getCurrentUser();
  if(!user){
    toast('未登录', '请先登录', 'err');
    location.href = 'login.html';
    return;
  }

  // Load profile
  let profile = null;
  try{
    profile = await getUserProfile(user);
  }catch(e){
    toast('加载失败', e.message || String(e), 'err');
  }

  const name = profile?.full_name || user.email || 'Member';
  renderAvatar(profile?.avatar_url, (name || 'M').trim().slice(0,1).toUpperCase());

  if(verifyStatusEl){
    verifyStatusEl.innerHTML = `
      <div>当前：<b>${esc(statusLabel(profile?.verification_status))}</b></div>
      <div class="small muted" style="margin-top:6px">（verification_status 字段已预留）</div>
    `;

  if(levelInfoEl){
    const posts = Number(profile?.post_count || 0);
    const m = levelMeta(posts);
    const nextText = m.nextMin != null ? `距离「${m.nextName}」还差 ${Math.max(0, m.nextMin - posts)} 篇` : '已达最高等级';
    levelInfoEl.innerHTML = `
      <div>当前：${levelBadgeHtml(posts)} <span class="small muted">（发帖 ${posts} 篇）</span></div>
      <div class="small muted" style="margin-top:6px">${esc(nextText)}</div>
    `;
  }

  }

  // Fill form
  if(form){
    const set = (key, val)=>{
      const el = form.elements.namedItem(key);
      if(el) el.value = val ?? '';
    };
    set('full_name', profile?.full_name || '');
    set('organization', profile?.organization || '');
    set('title', profile?.title || '');
    set('department', profile?.department || '');
    set('education', profile?.education || '');
    set('interests', profile?.interests || '');

    form.addEventListener('submit', async (ev)=>{
      ev.preventDefault();
      if(!isConfigured() || !supabase){
        toast('未配置', '请先在 assets/config.js 配置 Supabase', 'err');
        return;
      }
      hint.textContent = '保存中...';

      const fd = new FormData(form);
      const payload = {
        full_name: String(fd.get('full_name') || '').trim() || null,
        organization: String(fd.get('organization') || '').trim() || null,
        title: String(fd.get('title') || '').trim() || null,
        department: String(fd.get('department') || '').trim() || null,
        education: String(fd.get('education') || '').trim() || null,
        interests: String(fd.get('interests') || '').trim() || null,
        updated_at: new Date().toISOString(),
      };

      try{
        const { error } = await supabase
          .from('profiles')
          .update(payload)
          .eq('id', user.id);

        if(error) throw error;
        toast('已保存', '资料已更新', 'ok');
        hint.textContent = '已保存';
        setTimeout(()=> hint.textContent = '', 2200);

        // Update avatar fallback initial
        const nm = payload.full_name || name;
        renderAvatar(profile?.avatar_url, (nm || 'M').trim().slice(0,1).toUpperCase());
      }catch(e){
        hint.textContent = '';
        toast('保存失败', e.message || String(e), 'err');
      }
    });
  }

  // Avatar actions
  if(avatarUploadBtn){
    avatarUploadBtn.addEventListener('click', async ()=>{
      try{
        const url = await uploadAvatar(user);
        if(!url){
          toast('上传失败', '未获得头像 URL', 'err');
          return;
        }
        const { error } = await supabase
          .from('profiles')
          .update({ avatar_url: url, updated_at: new Date().toISOString() })
          .eq('id', user.id);
        if(error) throw error;

        toast('已更新', '头像已上传', 'ok');
        renderAvatar(url, (name || 'M').trim().slice(0,1).toUpperCase());
      }catch(e){
        toast('上传失败', e.message || String(e), 'err');
      }
    });
  }

  if(avatarClearBtn){
    avatarClearBtn.addEventListener('click', async ()=>{
      if(!confirm('确定清除头像吗？')) return;
      try{
        const { error } = await supabase
          .from('profiles')
          .update({ avatar_url: null, updated_at: new Date().toISOString() })
          .eq('id', user.id);
        if(error) throw error;
        toast('已清除', '头像已移除', 'ok');
        renderAvatar('', (name || 'M').trim().slice(0,1).toUpperCase());
      }catch(e){
        toast('操作失败', e.message || String(e), 'err');
      }
    });
  }
})();