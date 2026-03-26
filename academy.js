/**
 * academy.js — 培训与定价页动态数据加载
 *
 * 功能：
 * 1. 从 products + specialties 加载价格，覆盖 HTML 静态骨架
 * 2. 从 learning_projects + cohorts 加载班期信息
 * 3. 检查登录用户的 entitlements，展示"已开通"状态
 */
import {
  supabase,
  ensureSupabase,
  isConfigured,
  getSession,
} from './supabaseClient.js?v=20260128_030';

// ── 工具函数 ──────────────────────────────────────────────────
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function fmtPrice(p){ return p != null ? `¥${Number(p).toLocaleString('zh-CN',{minimumFractionDigits:0})}` : null; }

function cohortStatusLabel(s){
  const MAP = { planning:'筹备中', enrollment:'招募中', live:'进行中', concluded:'已结束' };
  return MAP[s] || s || '筹备中';
}
function cohortStatusClass(s){
  const MAP = { enrollment:'enrollment', live:'live', planning:'planning', concluded:'concluded' };
  return MAP[s] || 'planning';
}

// ── 主流程 ──────────────────────────────────────────────────
async function init(){
  if(!isConfigured()) return;         // 未配置 Supabase，静态骨架保持原样

  await ensureSupabase();

  // 并行拉取数据
  const [productsRes, projectsRes, sessionRes] = await Promise.allSettled([
    fetchProducts(),
    fetchProjects(),
    getSession(),
  ]);

  const products  = productsRes.status  === 'fulfilled' ? (productsRes.value  || []) : [];
  const projects  = projectsRes.status  === 'fulfilled' ? (projectsRes.value  || []) : [];
  const session   = sessionRes.status   === 'fulfilled' ? sessionRes.value : null;

  // 按 product_code 前缀归类
  const bySpec = {};
  for(const p of products){
    const code = (p.product_code || '').toUpperCase();
    const spec = code.startsWith('ICU') ? 'icu'
               : code.startsWith('TX')  ? 'tx'
               : code.startsWith('PATHO') ? 'patho'
               : code.startsWith('GLOM-BUNDLE') || code.startsWith('GLOM-REG') ? 'glom'
               : null;
    if(!spec) continue;
    if(!bySpec[spec]) bySpec[spec] = {};
    if(/full|完整|reg.*full/i.test(code)) bySpec[spec].full = p;
    else if(/video|视频|回放/i.test(code)) bySpec[spec].video = p;
    else if(/bundle|整套/i.test(code)) bySpec[spec].bundle = p;
  }

  // 用户权益（已购的 product_id set）
  let purchasedIds = new Set();
  if(session?.user){
    try{
      const { data: ents } = await supabase
        .rpc('get_my_entitlements');
      if(ents?.length){
        ents.forEach(e => { if(e.source_product_id) purchasedIds.add(e.source_product_id); });
        renderStatusBar(ents);
      }
    }catch(_e){}
  }

  // ── 渲染会员产品 ──
  const memberYearly = products.find(p => p.product_code === 'MEMBERSHIP-YEARLY');
  const memberMonthly = products.find(p => p.product_code === 'MEMBERSHIP-MONTHLY');
  renderMembership(memberYearly, memberMonthly, purchasedIds);

  // 按专科渲染（DA 产品未上线，跳过价格覆盖，保留静态骨架）
  ['glom','icu','tx','patho'].forEach(spec => {
    const ps = bySpec[spec];
    if(!ps) return;
    renderPricingCards(spec, ps, purchasedIds);
    renderBundle(spec, ps.bundle, purchasedIds);
  });

  // 班期信息
  for(const proj of projects){
    const code = (proj.project_code || '').toUpperCase();
    const spec = code.startsWith('GLOM')  ? 'glom'
               : code.startsWith('ICU')   ? 'icu'
               : code.startsWith('TX')    ? 'tx'
               : code.startsWith('PATHO') ? 'patho'
               : code.startsWith('DA')    ? 'da'
               : null;
    if(!spec) continue;
    renderProjectMeta(spec, proj);
  }
}

// ── 数据请求 ──────────────────────────────────────────────────
async function fetchProducts(){
  const { data, error } = await supabase
    .from('products')
    .select('id,product_code,title,subtitle,price_cny,list_price_cny,product_type,recommended,is_active,project_id,specialty_id,early_bird_deadline,membership_period')
    .eq('is_active', true)
    .in('product_type', ['project_registration','specialty_bundle','membership_plan'])
    .order('sort_order');
  if(error) throw error;
  return data || [];
}

async function fetchProjects(){
  const { data, error } = await supabase
    .from('learning_projects')
    .select('id,project_code,title,intro,status,cohorts(id,title,start_date,enrollment_deadline,status)')
    .eq('status','live');
  if(error){
    // table may not exist yet in some deployments
    if(/relation|does not exist/i.test(String(error.message||''))) return [];
    throw error;
  }
  return data || [];
}

// ── DOM 渲染 ──────────────────────────────────────────────────

function renderMembership(yearly, monthly, purchasedIds){
  const priceEl = document.getElementById('membershipYearlyPrice');
  const origEl = document.getElementById('membershipYearlyOrig');
  const monthlyEl = document.getElementById('membershipMonthlyPrice');
  const ctaEl = document.getElementById('membershipCta');

  // Check if user already has membership
  const hasMembership = purchasedIds.has(yearly?.id) || purchasedIds.has(monthly?.id);

  if(hasMembership && ctaEl){
    ctaEl.innerHTML = '<span class="badge" style="border-color:rgba(34,197,94,.5);background:rgba(34,197,94,.1);color:#4ade80;padding:8px 16px;font-size:14px">已开通会员</span> <a class="btn" href="videos.html?cat=glomcon">进入 GlomCon 视频</a>';
    const promoEl = document.getElementById('membershipPromo');
    if(promoEl) promoEl.hidden = true;
    return;
  }

  if(yearly){
    if(priceEl) priceEl.textContent = fmtPrice(yearly.price_cny) + '/年';
    if(origEl && yearly.list_price_cny > yearly.price_cny){
      origEl.textContent = fmtPrice(yearly.list_price_cny) + '/年';
    }else if(origEl){
      origEl.hidden = true;
    }
    const buyYearly = document.getElementById('membershipBuyYearly');
    if(buyYearly){
      buyYearly.href = `checkout.html?product_id=${encodeURIComponent(yearly.id)}`;
      buyYearly.textContent = `年费 ${fmtPrice(yearly.price_cny)}`;
    }
  }
  if(monthly){
    if(monthlyEl) monthlyEl.textContent = fmtPrice(monthly.price_cny) + '/月';
    const buyMonthly = document.getElementById('membershipBuyMonthly');
    if(buyMonthly){
      buyMonthly.href = `checkout.html?product_id=${encodeURIComponent(monthly.id)}`;
      buyMonthly.textContent = `月费 ${fmtPrice(monthly.price_cny)}`;
    }
  }
}

function earlyBirdTag(p){
  if(!p?.early_bird_deadline) return '';
  const deadline = new Date(p.early_bird_deadline);
  const now = new Date();
  if(deadline <= now) return '';   // expired — don't show
  const days = Math.ceil((deadline - now) / 864e5);
  const label = days <= 7
    ? `🐦 早鸟价 · 还剩 ${days} 天`
    : `🐦 早鸟价 · 截止 ${deadline.toLocaleDateString('zh-CN',{month:'long',day:'numeric'})}`;
  return `<div style="font-size:11px;font-weight:700;color:#fbbf24;margin-bottom:4px">${label}</div>`;
}

function renderPricingCards(spec, ps, purchasedIds){
  const container = document.getElementById(`proj-pricing-${spec}`);
  if(!container) return;

  const fullP  = ps.full;
  const videoP = ps.video;

  function cardHtml(p, isRec){
    if(!p) return '';
    const bought = purchasedIds.has(p.id);
    const cur  = fmtPrice(p.price_cny);
    const orig = p.list_price_cny ? fmtPrice(p.list_price_cny) : null;
    const label = isRec ? '报名版（完整版）' : '视频版（回放版）';
    const includes = isRec
      ? '含直播互动 + 学习群 + 全程回放'
      : '仅含视频回放，不含直播与学习群';
    const btnLabel = bought ? '已购买' : (isRec ? '立即报名' : '购买视频版');
    const btnClass = isRec ? 'btn primary' : 'btn';
    const btnHref  = bought ? 'my-learning.html' : `checkout.html?product=${encodeURIComponent(p.product_code)}`;
    return `
      <div class="price-option${isRec ? ' recommended' : ''}">
        ${isRec ? '<div class="rec-tag">★ 推荐</div>' : ''}
        ${earlyBirdTag(p)}
        <div class="p-label">${esc(label)}</div>
        <div>
          <span class="p-price">${esc(cur||'—')}</span>
          ${orig ? `<span class="p-orig">${esc(orig)}</span>` : ''}
        </div>
        <div class="p-includes">${esc(includes)}</div>
        <div class="p-btn">
          <a class="${btnClass}" href="${esc(btnHref)}">${bought ? '✅ 已购买 → 我的学习' : esc(btnLabel)}</a>
        </div>
      </div>`;
  }

  container.innerHTML = cardHtml(fullP, true) + cardHtml(videoP, false);
}

function renderBundle(spec, p, purchasedIds){
  if(!p) return;
  const banner = document.getElementById(`bundle-${spec}`);
  if(!banner) return;

  const bought = purchasedIds.has(p.id);
  const cur  = fmtPrice(p.price_cny);
  const orig = p.list_price_cny ? fmtPrice(p.list_price_cny) : null;
  const btnHref = bought ? 'my-learning.html' : `checkout.html?product=${encodeURIComponent(p.product_code)}`;
  const btnLabel = bought ? '✅ 已购买 → 我的学习' : '购买整套课';

  // Update price
  const priceEl = banner.querySelector('.bb-price');
  const origEl  = banner.querySelector('.bb-orig');
  if(priceEl && cur) priceEl.textContent = cur;
  if(origEl && orig) origEl.textContent = orig; else if(origEl) origEl.remove();

  // Update button
  const btn = banner.querySelector('.btn');
  if(btn){ btn.href = btnHref; btn.textContent = btnLabel; }
}

function renderProjectMeta(spec, proj){
  // Status badge
  const statusEl = document.getElementById(`proj-status-${spec}`);
  const cohorts = (proj.cohorts || []).filter(c => c.status !== 'concluded');
  const nextCohort = cohorts.sort((a,b) => new Date(a.start_date||0) - new Date(b.start_date||0))[0];
  const projStatus = nextCohort ? nextCohort.status : (proj.status || 'planning');

  if(statusEl){
    statusEl.textContent = cohortStatusLabel(projStatus);
    statusEl.className = `proj-status ${cohortStatusClass(projStatus)}`;
  }

  // Start date
  const dateEl = document.getElementById(`proj-date-${spec}`);
  if(dateEl){
    if(nextCohort?.start_date){
      const d = new Date(nextCohort.start_date);
      dateEl.textContent = d.toLocaleDateString('zh-CN',{year:'numeric',month:'long',day:'numeric'}) + ' 开班';
    } else if(nextCohort?.enrollment_deadline){
      const d = new Date(nextCohort.enrollment_deadline);
      dateEl.textContent = `报名截止：${d.toLocaleDateString('zh-CN',{month:'long',day:'numeric'})}`;
    } else {
      dateEl.textContent = '开班时间待定，可先报名锁定早鸟价';
    }
  }
}

function renderStatusBar(ents){
  const bar  = document.getElementById('acStatusBar');
  const text = document.getElementById('acStatusText');
  if(!bar || !text) return;

  const active = ents.filter(e => e.status === 'active');
  if(!active.length){ bar.hidden = true; return; }

  const typeLabels = {
    project_access: '项目学员',
    specialty_bundle: '专科整套课',
    membership: '付费会员',
    single_video: '单视频',
  };
  const labels = [...new Set(active.map(e => typeLabels[e.entitlement_type] || e.entitlement_type))];
  text.textContent = `已开通权益：${labels.join(' · ')}`;
  bar.hidden = false;
}

// ── 启动 ──────────────────────────────────────────────────
init().catch(err => console.warn('[academy.js]', err));
