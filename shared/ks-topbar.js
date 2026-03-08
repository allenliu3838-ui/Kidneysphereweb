/*  KidneySphere 跨产品导航条  ks-topbar.js
 *  ─────────────────────────────────────────
 *  子站点只需在 <head> 加入：
 *    <link rel="stylesheet" href="https://kidneysphere.com/shared/ks-topbar.css">
 *    <script src="https://kidneysphere.com/shared/ks-topbar.js" defer></script>
 *
 *  会自动在 <body> 顶部插入一条跨产品导航条。
 *  根据当前域名自动高亮对应产品。
 */
(function(){
  'use strict';

  /* ── 产品列表（按顺序显示） ────────────────── */
  var products = [
    { label: '社区',      emoji: '💬', href: 'https://kidneysphere.com',              host: 'kidneysphere.com' },
    { label: 'Registry',  emoji: '🔬', href: 'https://kidneysphereregistry.cn',       host: 'kidneysphereregistry.cn' },
    { label: '随访工作台', emoji: '📋', href: 'https://kidneyspherefollowup.cn',       host: 'kidneyspherefollowup.cn' },
    { label: '医生工作台', emoji: '👨‍⚕️', href: 'https://kidneyspheredoctorapp.cn',     host: 'kidneyspheredoctorapp.cn' },
    { label: '远程协作',   emoji: '📡', href: '#',                                     host: '', disabled: true, soon: true }
  ];

  var currentHost = location.hostname.replace(/^www\./, '');

  /* ── 构建 HTML ────────────────────────────── */
  var bar = document.createElement('div');
  bar.id = 'ks-topbar';

  // 品牌区
  var brand = '<a class="ks-tb-brand" href="https://kidneysphere.com">'
    + '<img src="https://kidneysphere.com/assets/logo.png" alt="KS">'
    + '<span>肾域AI · KidneySphere</span></a>'
    + '<span class="ks-tb-sep"></span>';

  // 产品链接
  var links = products.map(function(p){
    var isActive = currentHost === p.host || currentHost.indexOf(p.host) !== -1;
    var attrs = '';
    if(isActive) attrs += ' data-active="true"';
    if(p.disabled) attrs += ' data-disabled="true"';
    var soonTag = p.soon ? ' <span class="ks-tb-soon">即将上线</span>' : '';
    var target = p.disabled ? '' : ' target="_blank" rel="noopener"';
    // 如果是当前站点，不用 target=_blank
    if(isActive) target = '';
    return '<a class="ks-tb-link" href="' + p.href + '"' + target + attrs + '>'
      + p.emoji + ' ' + p.label + soonTag + '</a>';
  }).join('');

  bar.innerHTML = brand + links;

  /* ── 插入到 body 最顶部 ───────────────────── */
  function inject(){
    if(document.body){
      document.body.insertBefore(bar, document.body.firstChild);
    }
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
