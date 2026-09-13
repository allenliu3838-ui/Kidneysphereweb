// Independent of authentication/data loading: these utilities must work even if
// the external data source is unavailable. End is exclusive (Beijing midnight).
export function conferenceState(start, end, now = Date.now()) {
  const startAt = Date.parse(start);
  const endAt = Date.parse(end);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt || !Number.isFinite(now)) {
    return { kind: 'unknown', label: '查看会议日程' };
  }
  if (now >= endAt) return { kind: 'ended', label: '往期会议 · 已结束' };
  if (now >= startAt) return { kind: 'live', label: '会议进行中' };
  const days = Math.ceil((startAt - now) / 86400000);
  return { kind: 'upcoming', label: days <= 1 ? '即将开幕' : `${days} 天后开幕` };
}

export function updateConferenceStatuses(root, now = Date.now()) {
  root.querySelectorAll('[data-conference-status]').forEach(el => {
    const state = conferenceState(el.dataset.start, el.dataset.end, now);
    el.textContent = state.label;
    el.dataset.state = state.kind;
  });
}

export function initContactCopy(root, clipboard) {
  const button = root.querySelector('[data-copy-contact]');
  const status = root.querySelector('[data-contact-status]');
  if (!button || !status || !clipboard?.writeText) return;
  button.hidden = false;
  button.addEventListener('click', async () => {
    try {
      await clipboard.writeText('china@kidneysphere.com');
      status.textContent = '邮箱已复制，可粘贴到您的邮件应用。';
    } catch (_) {
      status.textContent = '未能自动复制，请手动复制：china@kidneysphere.com';
    }
  });
}

if (typeof document !== 'undefined') {
  updateConferenceStatuses(document);
  // Update long-lived tabs, including after a device resumes from sleep.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) updateConferenceStatuses(document);
  });
  setInterval(() => updateConferenceStatuses(document), 60000);
  initContactCopy(document, navigator.clipboard);
}
