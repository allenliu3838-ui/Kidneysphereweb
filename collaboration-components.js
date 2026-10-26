(function(){
  var CONTACT_EMAIL = 'china@kidneysphere.com';

  function escapeHtml(str=''){
    return str
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }

  function showToast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;right:16px;bottom:20px;background:#0b1220;color:#fff;padding:9px 16px;border-radius:12px;font-size:13px;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.35);transition:opacity .3s';
    document.body.appendChild(t);
    setTimeout(function(){ t.style.opacity = '0'; setTimeout(function(){ t.remove(); }, 350); }, 2000);
  }

  function copyEmail(email) {
    function done(){ showToast('已复制：' + email); }
    function fallback(){
      var ta = document.createElement('textarea');
      ta.value = email;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      try { document.execCommand('copy'); done(); }
      catch(e){ prompt('请复制邮箱地址：', email); }
      ta.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(email).then(done).catch(fallback);
    } else {
      fallback();
    }
  }
  window._copyEmail = copyEmail;

  function CollaborationPathCard(item, compact){
    return `
      <article class="${compact ? 'compact-card' : 'price-card'}" id="path-${escapeHtml(item.id)}">
        <div class="price-title">${escapeHtml(item.title)}</div>
        <div class="small">${escapeHtml(item.who)}</div>
        <div class="small" style="margin-top:6px">${escapeHtml(item.cycle)}</div>
        <div class="small" style="margin-top:6px">${escapeHtml(item.scenario)}</div>
        <div class="btnbar" style="margin-top:10px">
          <a class="btn small" href="${escapeHtml(item.ctaHref)}">${escapeHtml(item.ctaLabel)}</a>
        </div>
      </article>`;
  }

  function listItems(arr){
    if (!arr || !arr.length) return '';
    return arr.map(function(s){ return '<li>' + escapeHtml(s) + '</li>'; }).join('');
  }

  function ProjectCard(item){
    var subject = encodeURIComponent(item.emailSubject || ('加入项目：' + item.name));
    var mailto = 'mailto:' + CONTACT_EMAIL + '?subject=' + subject;
    var statusHtml = item.status
      ? '<span class="proj-status ' + escapeHtml(item.statusClass || 'ok') + '">' + escapeHtml(item.status) + '</span>'
      : '';
    var categoryHtml = item.category
      ? '<span class="pill active" style="margin-left:6px">' + escapeHtml(item.category) + '</span>'
      : '';
    var suitableHtml = item.suitableFor && item.suitableFor.length
      ? '<div style="margin-top:8px"><div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:3px;text-transform:uppercase;letter-spacing:.5px">适合加入的中心</div><ul class="small" style="margin:0;padding-left:16px;line-height:1.7">' + listItems(item.suitableFor) + '</ul></div>'
      : '';
    var fieldsHtml = item.keyFields && item.keyFields.length
      ? '<div style="margin-top:8px"><div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:3px;text-transform:uppercase;letter-spacing:.5px">建议优先准备的关键字段</div><ul class="small" style="margin:0;padding-left:16px;line-height:1.7">' + listItems(item.keyFields) + '</ul></div>'
      : '';
    var supportHtml = item.support && item.support.length
      ? '<div style="margin-top:8px"><div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:3px;text-transform:uppercase;letter-spacing:.5px">加入后可获得的支持</div><ul class="small" style="margin:0;padding-left:16px;line-height:1.7">' + listItems(item.support) + '</ul></div>'
      : '';
    var detailsHtml = item.detailHighlights && item.detailHighlights.length
      ? '<details class="faq" style="margin-top:8px"><summary style="font-size:12px;font-weight:600">展开详细说明</summary><ul class="small" style="margin:8px 0 0;padding-left:16px;line-height:1.7">' + listItems(item.detailHighlights) + '</ul></details>'
      : '';

    return `
      <article class="price-card project-card" data-category="${escapeHtml(item.category || '')}">
        <div style="margin-bottom:4px">${statusHtml}${categoryHtml}</div>
        <div class="price-title">${escapeHtml(item.name)}</div>
        <div class="infobox" style="padding:8px 10px;font-size:12px;line-height:1.55;margin:8px 0">${escapeHtml(item.summary)}</div>
        ${suitableHtml}
        ${fieldsHtml}
        ${supportHtml}
        ${detailsHtml}
        <div class="btnbar" style="margin-top:10px">
          <a class="btn small primary" href="${mailto}">${escapeHtml(item.ctaLabel || '联系加入')}</a>
        </div>
        <button class="copy-email" onclick="window._copyEmail('${CONTACT_EMAIL}')" title="复制邮箱">
          📋 ${CONTACT_EMAIL}
        </button>
      </article>`;
  }

  function CaseCard(item){
    return `
      <article class="compact-card">
        <div class="price-title">${escapeHtml(item.title)}</div>
        <div class="small" style="margin-top:6px">${escapeHtml(item.text)}</div>
      </article>`;
  }

  window.CollabComponents = {
    renderPaths: function(el, items, compact){
      if (!el) return;
      el.innerHTML = items.map(function(i){ return CollaborationPathCard(i, compact); }).join('');
    },

    renderProjects: function(el, items){
      if (!el) return;
      el.innerHTML = items.map(ProjectCard).join('');
    },

    renderProjectsWithFilter: function(gridEl, tabsEl, items, tabs){
      if (!gridEl) return;
      var active = 'all';

      function renderTabs(){
        if (!tabsEl) return;
        tabsEl.innerHTML = tabs.map(function(t){
          return '<button class="filter-tab' + (t.id === active ? ' active' : '') + '" data-id="' + escapeHtml(t.id) + '">' + escapeHtml(t.label) + '</button>';
        }).join('');
        tabsEl.querySelectorAll('.filter-tab').forEach(function(btn){
          btn.addEventListener('click', function(){
            active = btn.dataset.id;
            renderTabs();
            renderGrid();
          });
        });
      }

      function renderGrid(){
        var visible = active === 'all'
          ? items
          : items.filter(function(p){ return p.category === active; });
        gridEl.innerHTML = visible.length
          ? visible.map(ProjectCard).join('')
          : '<div class="small muted" style="padding:12px">当前筛选无匹配项目。</div>';
      }

      renderTabs();
      renderGrid();
    },

    renderCases: function(el, items){
      if (!el) return;
      el.innerHTML = items.map(CaseCard).join('');
    },

    renderFaq: function(el, items){
      if (!el) return;
      el.innerHTML = items.map(function(f, idx){
        return '<details class="faq" ' + (idx === 0 ? 'open' : '') + '><summary>' + escapeHtml(f.q) + '</summary><div class="small">' + escapeHtml(f.a) + '</div></details>';
      }).join('');
    }
  };
})();
