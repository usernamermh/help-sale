// 业务逻辑功能侧栏与布局:能力列表、左右面板自适应

async function loadCapabilities() {
  const box = $("capList");
  try {
    const r = await api("/api/v1/agent/capabilities");
    const list = (r.capabilities || []).filter((c) => c.enabled && c.root === "tools");
    if (!list.length) { box.innerHTML = "<div class=\"cap-item\">暂无启用能力</div>"; return; }
    const cats = {};
    for (const c of list) { (cats[c.category] = cats[c.category] || []).push(c); }
    box.innerHTML = "";
    for (const cat of Object.keys(cats)) {
      const t = document.createElement("div"); t.className = "cap-cat"; t.textContent = cat; box.appendChild(t);
      for (const c of cats[cat]) {
        const d = document.createElement("div"); d.className = "cap-item"; d.title = c.description;
        d.innerHTML = "<b>" + escapeHtml(c.label) + "</b><div class=\"d\">" + escapeHtml(c.description) + "</div>";
        box.appendChild(d);
      }
    }
  } catch (e) { box.innerHTML = "加载失败:" + escapeHtml(e.message); }
}
// ── 本轮任务栏 ──
function syncRightCol() {
  const visible = $("runPanel").style.display !== "none" || $("trPanel").style.display !== "none" || $("kanbanPanel").style.display !== "none";
  $("rightCol").style.display = visible ? "flex" : "none";
  $("rightResizer").style.display = visible ? "block" : "none";
}
function syncSide() {
  const capsHidden = $("capsBlock").style.display === "none";
  const threadsHidden = $("threadsBlock").style.display === "none";
  $("side").classList.toggle("collapsed", capsHidden && threadsHidden);
}
// ── 历史会话一键清理 ──
function toggleLeftBlock(blockId, btn) {
  const el = $(blockId);
  const hidden = el.style.display === "none";
  el.style.display = hidden ? "flex" : "none";
  btn.classList.toggle("active", hidden);
  syncSide();
}
