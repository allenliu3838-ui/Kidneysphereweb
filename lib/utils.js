export function qs(sel, el=document){ return el.querySelector(sel); }
export function qsa(sel, el=document){ return Array.from(el.querySelectorAll(sel)); }

export function escapeCsv(v){
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g,'""') + '"';
  return s;
}

export function toCsv(rows, columns){
  const header = columns.map(c => escapeCsv(c)).join(",");
  const lines = rows.map(r => columns.map(c => escapeCsv(r[c])).join(","));
  return [header, ...lines].join("\r\n");
}

export function downloadText(filename, text, mime="text/plain;charset=utf-8"){
  const blob = new Blob([text], {type: mime});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 200);
}

export function downloadCsvUtf8Bom(filename, csvText){
  const BOM = "\ufeff";
  downloadText(filename, BOM + csvText, "text/csv;charset=utf-8");
}

let toastRoot = null;
export function toast(msg){
  if (!toastRoot){
    toastRoot = document.createElement("div");
    toastRoot.className = "toast";
    document.body.appendChild(toastRoot);
  }
  const t = document.createElement("div");
  t.className = "t";
  t.textContent = msg;
  toastRoot.appendChild(t);
  setTimeout(()=>t.remove(), 3600);
}

export function fmtDate(d){
  if (!d) return "";
  try { return new Date(d).toISOString().slice(0,10); } catch { return String(d); }
}

export function daysLeft(ts){
  if (!ts) return null;
  const diff = (new Date(ts).getTime() - Date.now())/(1000*60*60*24);
  return Math.floor(diff);
}

export function humanNumber(n){
  if (n === null || n === undefined || n === "") return "";
  const x = Number(n);
  if (Number.isNaN(x)) return String(n);
  return x.toLocaleString();
}

export function escapeHtml(s){
  return String(s||"").replace(/[&<>"']/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
