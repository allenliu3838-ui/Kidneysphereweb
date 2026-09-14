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
  canAccessNephroPro,
} from './supabaseClient.js?v=20260401_fix';
import { classifyTrainingProduct } from './training-commerce.js?v=20260914_pricing1';

// ── 工具函数 ──────────────────────────────────────────────────
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function fmtPrice(p){ return p != null ? `¥${Number(p).toLocaleString('zh-CN',{minimumFractionDigits:0})}` : null; }

function cohortStatusLabel(s){
  const MAP = {
    planning:'筹备中', draft:'筹备中',
    enrollment:'招生中', recruiting:'招生中',
    live:'进行中', in_progress:'进行中',
    concluded:'已结束', ended:'已结束',
    closed:'报名已截止',
  };
  return MAP[s] || s || '筹备中';
}
function cohortStatusClass(s){
  const MAP = {
    planning:'planning', draft:'planning',
    enrollment:'enrollment', recruiting:'enrollment',
    live:'live', in_progress:'live',
    concluded:'concluded', ended:'concluded',
    closed:'planning',
  };
  return MAP[s] || 'planning';
}

function groupTrainingProducts(products){
  const bySpec = {};
  for(const p of products){
    if(p.is_active !== true) continue;
    const kind = classifyTrainingProduct(p);
    if(kind !== 'registration' && kind !== 'bundle') continue;
    const spec = String(p.product_code).split('-')[0].toLowerCase();
    if(!bySpec[spec]) bySpec[spec] = {};
    bySpec[spec][kind === 'registration' ? 'full' : 'bundle'] = p;
  }
  return bySpec;
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

  // 商品类型由明确的 SKU / product_type 决定；推荐标记不决定购买范围。
  const bySpec = groupTrainingProducts(products);
  const productsReady = productsRes.status === 'fulfilled';

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

  // 按专科渲染
  ['glom','icu','tx','patho','da'].forEach(spec => {
    const ps = bySpec[spec] || {};
    renderPricingCards(spec, ps, purchasedIds, productsReady);
    renderBundle(spec, ps.bundle, purchasedIds, productsReady);
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
    .select('id,product_code,title,subtitle,price_cny,list_price_cny,product_type,is_active,project_id,specialty_id,membership_period')
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
    .in('status', ['live','recruiting','draft','planning']);
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
    ctaEl.innerHTML = '<span class="badge" style="border-color:rgba(34,197,94,.5);background:rgba(34,197,94,.1);color:#4ade80;padding:8px 16px;font-size:14px">已开通会员</span> <a class="btn" href="videos.html?source=glomcon">进入 GlomCon 视频</a> <a class="btn" href="nephro-pro.html">进入肾域 Pro</a>';
    return;
  }

  if(yearly){
    if(priceEl) priceEl.textContent = fmtPrice(yearly.price_cny) + '/年';
    if(origEl) origEl.hidden = true;
    const buyYearly = document.getElementById('membershipBuyYearly');
    if(buyYearly){
      buyYearly.href = `checkout.html?product_id=${encodeURIComponent(yearly.id)}`;
      buyYearly.textContent = `开通教育会员 ${fmtPrice(yearly.price_cny)}/年`;
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

function renderPricingCards(spec, ps, purchasedIds, productsReady = true){
  const container = document.getElementById(`proj-pricing-${spec}`);
  if(!container) return;

  const p = ps.full;
  if(!p){
    const message = productsReady ? '暂未开放报名' : '报名信息暂未加载，请稍后重试';
    container.innerHTML = `<div class="price-option"><div class="p-label">培训报名</div><div class="p-includes">${message}</div><div class="p-btn"><a class="btn" href="my-learning.html">已购学员进入学习</a></div></div>`;
    return;
  }
  const bought = purchasedIds.has(p.id);
  const cur = fmtPrice(p.price_cny);
  const btnHref = bought ? 'my-learning.html' : `checkout.html?product=${encodeURIComponent(p.product_code)}`;
  container.innerHTML = `
    <div class="price-option recommended">
      <div class="p-label">培训报名（完整版）</div>
      <div><span class="p-price">${esc(cur||'—')}</span></div>
      <div class="p-includes">含直播互动 + 学习群 + 全程回放</div>
      <div class="p-btn"><a class="btn primary" href="${esc(btnHref)}">${bought ? '✅ 已购买 → 我的学习' : '立即报名'}</a></div>
    </div>`;
}

function renderBundle(spec, p, purchasedIds, productsReady = true){
  const banner = document.getElementById(`bundle-${spec}`);
  if(!banner) return;

  const bought = p && purchasedIds.has(p.id);
  const cur = p ? fmtPrice(p.price_cny) : (productsReady ? '暂未开放销售' : '价格暂未加载');
  const btnHref = !p || bought ? 'my-learning.html' : `checkout.html?product=${encodeURIComponent(p.product_code)}`;
  const btnLabel = !p ? '已购学员进入学习' : bought ? '✅ 已购买 → 我的学习' : '购买整套课';

  // Update price
  const priceEl = banner.querySelector('.bb-price');
  const origEl  = banner.querySelector('.bb-orig');
  if(priceEl && cur) priceEl.textContent = cur;
  origEl?.remove();

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

  // Also update the tab label
  const tabBtn = document.querySelector(`[data-spec-tab="${spec}"]`);
  if(tabBtn){
    const statusColors = { live:'#4ade80', enrollment:'#4ade80', recruiting:'#4ade80', planning:'inherit', concluded:'#9ca3af' };
    const existingSpan = tabBtn.querySelector('span');
    const label = cohortStatusLabel(projStatus);
    const color = statusColors[projStatus] || 'inherit';
    if(existingSpan){
      existingSpan.textContent = label;
      existingSpan.style.color = color;
      existingSpan.style.opacity = projStatus === 'planning' ? '.6' : '1';
    } else if(projStatus !== 'planning') {
      tabBtn.insertAdjacentHTML('beforeend', ` <span style="font-size:10px;color:${color};margin-left:3px">${label}</span>`);
    }
  }

  // Hide/show planning banner
  const planningBanner = document.getElementById(`planning-banner-${spec}`);
  if(planningBanner) planningBanner.style.display = (projStatus === 'planning') ? 'flex' : 'none';

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
      dateEl.textContent = '开班时间待定，以项目通知为准';
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
  // 肾域 Pro 是教育会员/付费会员/项目学员的核心权益, 多角色叠加时单独显示一个标签
  if(canAccessNephroPro(active)){
    labels.push('肾域 Pro');
  }
  text.textContent = `已开通权益：${labels.join(' · ')}`;
  bar.hidden = false;
}

// ── 启动 ──────────────────────────────────────────────────
init().catch(err => console.warn('[academy.js]', err));
