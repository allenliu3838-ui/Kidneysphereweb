function toast(msg){
  let root = document.querySelector(".toast");
  if (!root){
    root = document.createElement("div");
    root.className = "toast";
    document.body.appendChild(root);
  }
  const t = document.createElement("div");
  t.className = "t";
  t.textContent = msg;
  root.appendChild(t);
  setTimeout(()=>t.remove(), 3200);
}

function qsa(sel, el=document){ return Array.from(el.querySelectorAll(sel)); }
function qs(sel, el=document){ return el.querySelector(sel); }

function initCopy(){
  qsa(".copybtn").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const text = btn.getAttribute("data-copy") || "";
      try{
        await navigator.clipboard.writeText(text.replace(/&#10;/g,"\n"));
        toast("已复制");
      }catch{
        toast("复制失败，请手动选择复制");
      }
    });
  });
}

function initRoles(){
  const buttons = qsa(".rolebtn");
  const sections = qsa(".role-section");
  const key = "ks_role";
  let current = localStorage.getItem(key) || "all";

  function apply(role){
    current = role;
    localStorage.setItem(key, role);
    buttons.forEach(b=>b.classList.toggle("active", b.getAttribute("data-role")===role));
    sections.forEach(sec=>{
      const roles = (sec.getAttribute("data-role")||"").split(/\s+/).filter(Boolean);
      sec.hidden = !(roles.includes(role) || roles.includes("all"));
    });
  }

  buttons.forEach(b=>{
    b.addEventListener("click", ()=>apply(b.getAttribute("data-role")));
  });

  apply(current);
}

function initStepper(){
  const stepper = qs("#stepper");
  if (!stepper) return;

  const navItems = qsa(".step-item", stepper);
  const panels = qsa(".step-panel", stepper);

  function setActive(step){
    navItems.forEach(b=>b.classList.toggle("active", b.getAttribute("data-step")===String(step)));
  }

  navItems.forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const step = btn.getAttribute("data-step");
      const panel = qs(`[data-step-panel="${step}"]`, stepper);
      if (panel){
        panel.scrollIntoView({behavior:"smooth", block:"start"});
        setActive(step);
      }
    });
  });

  // done checkboxes
  qsa("[data-done-step]", stepper).forEach(chk=>{
    const s = chk.getAttribute("data-done-step");
    const k = `ks_done_step_${s}`;
    chk.checked = localStorage.getItem(k) === "1";
    const btn = qs(`.step-item[data-step="${s}"]`, stepper);
    if (btn) btn.classList.toggle("done", chk.checked);

    chk.addEventListener("change", ()=>{
      localStorage.setItem(k, chk.checked ? "1":"0");
      if (btn) btn.classList.toggle("done", chk.checked);
    });
  });

  // observe panels to highlight
  const io = new IntersectionObserver((entries)=>{
    const visible = entries.filter(e=>e.isIntersecting).sort((a,b)=>b.intersectionRatio-a.intersectionRatio)[0];
    if (visible){
      const step = visible.target.getAttribute("data-step-panel");
      setActive(step);
    }
  }, { root: null, threshold: [0.15, 0.25, 0.35, 0.5] });

  panels.forEach(p=>io.observe(p));
}

function initFaq(){
  const search = qs("#faqSearch");
  const openAll = qs("#faqOpenAll");
  const closeAll = qs("#faqCloseAll");
  const items = qsa("[data-faq]");

  if (openAll) openAll.addEventListener("click", ()=>items.forEach(d=>d.open=true));
  if (closeAll) closeAll.addEventListener("click", ()=>items.forEach(d=>d.open=false));

  if (search){
    search.addEventListener("input", ()=>{
      const q = search.value.trim().toLowerCase();
      items.forEach(d=>{
        const txt = d.textContent.toLowerCase();
        const hit = !q || txt.includes(q);
        d.style.display = hit ? "" : "none";
      });
    });
  }
}

initCopy();
initRoles();
initStepper();
initFaq();
