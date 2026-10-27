// 子agent协作看板:卡片加载、展开/收起、结果展示

function toggleKanbanPanel() { if ($("kanbanPanel").style.display === "none") showKanbanPanel(); else hideKanbanPanel(); }
function hideKanbanPanel() { $("kanbanPanel").style.display = "none"; $("headerKanbanBtn").classList.remove("active"); syncRightCol(); }
function showKanbanPanel() { $("kanbanPanel").style.display = "flex"; $("headerKanbanBtn").classList.add("active"); loadKanban(); syncRightCol(); }
async function loadKanban() {
  const box = $("kanbanList");
  // 未打开任何会话:看板为空(按会话隔离,不展示其他会话的历史卡片)
  if (!currentThreadId) {
    $("kanbanMeta").textContent = "共 0 张卡片";
    box.innerHTML = "<div class=\"mini\">请先选择或创建一个会话</div>";
    return;
  }
  try {
    const r = await api("/api/v1/kanban?threadId=" + encodeURIComponent(currentThreadId));
    const cards = r.cards || [];
    $("kanbanMeta").textContent = "共 " + cards.length + " 张卡片";
    if (!cards.length) { box.innerHTML = "<div class=\"mini\">看板为空</div>"; return; }
    const statusOrder = ["pending", "inprogress", "done", "error"];
    const groups = {};
    for (const s of statusOrder) groups[s] = cards.filter((c) => c.status === s);
    const labels = { pending: "待执行", inprogress: "执行中", done: "已完成", error: "出错" };
    box.innerHTML = "";
    for (const s of statusOrder) {
      if (!groups[s].length) continue;
      const g = document.createElement("div");
      g.className = "kb-group";
      g.innerHTML = '<div class="kb-group-head">' + labels[s] + ' (' + groups[s].length + ')' + '</div>';
      for (const card of groups[s]) {
        const d = document.createElement("div"); d.className = "kb-card kb-" + card.status;
        d.innerHTML = '<div class="kb-card-head"><b>' + escapeHtml(card.id) + " " + escapeHtml(card.title || "") + '</b><span class="badge">' + (labels[card.status] || card.status) + '</span></div>'
          + (card.goal ? '<div class="kb-goal">' + escapeHtml(card.goal) + '</div>' : "")
          + (card.tools && card.tools.length ? '<div class="kb-tools">工具: ' + escapeHtml(card.tools.join(", ")) + '</div>' : "")
          + (card.result ? renderKanbanResult(card.result, card.id, !!kanbanExpanded[card.id]) : "")
          + (card.error ? '<div class="kb-error">错误: ' + escapeHtml(card.error) + '</div>' : "");
        g.appendChild(d);
      }
      box.appendChild(g);
    }
  } catch (e) { box.innerHTML = "加载失败:" + escapeHtml(e.message); }
}

// 看板长结果折叠:超过 200 字只显示前 200 字,可展开/收起(状态记忆,轮询刷新后保持)
function toggleKanbanResult(btn, id, expanded) {
  const span = btn.previousElementSibling;
  if (!span) return;
  const full = btn.getAttribute("data-full") || "";
  if (expanded) {
    kanbanExpanded[id] = true;
    span.textContent = full;
    btn.textContent = "收起";
    btn.setAttribute("onclick", "toggleKanbanResult(this, '" + id + "', false)");
  } else {
    kanbanExpanded[id] = false;
    span.textContent = full.length > 200 ? full.slice(0, 200) + "…" : full;
    btn.textContent = "展开";
    btn.setAttribute("onclick", "toggleKanbanResult(this, '" + id + "', true)");
  }
}

// 渲染看板结果
function renderKanbanResult(text, id, expanded) {
  const MAX = 200;
  const full = String(text || "");
  if (full.length <= MAX) return '<div class="kb-result">结果: ' + escapeHtml(full) + '</div>';
  const data = "data-full=\"" + escapeHtml(full).replace(/"/g, "&quot;") + "\"";
  if (expanded) {
    return '<div class="kb-result"><span class="kb-collapse">' + escapeHtml(full) + '</span> <button class="kb-toggle" onclick="toggleKanbanResult(this, \'' + id + '\', false)" ' + data + '>收起</button></div>';
  }
  const preview = escapeHtml(full.slice(0, MAX)) + "…";
  return '<div class="kb-result"><span class="kb-collapse">' + preview + '</span> <button class="kb-toggle" onclick="toggleKanbanResult(this, \'' + id + '\', true)" ' + data + '>展开</button></div>';
}
let kanbanExpanded = {}; // cardId -> 是否展开(刷新后保持)
