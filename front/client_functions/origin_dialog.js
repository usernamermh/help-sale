// 对话原文面板:读取对话原文、翻页、抽取命中加粗

let trPager = null;
let trHighlights = {}; // conversationId -> Set<seq> 抽取命中加粗
function renderTrPanel(meta, list, pager, highlightKey) {
  $("trMeta").textContent = meta || "";
  const box = $("trList"); box.innerHTML = "";
  if (!list || !list.length) { box.innerHTML = "<div class=\"t\">暂无原文</div>"; }
  for (const m of list) {
    const d = document.createElement("div"); d.className = "tr-line";
    const role = m.speakerRole === "customer" ? "客户" : m.speakerRole === "sales" ? "销售" : "其他";
    const name = m.speakerName ? "·" + escapeHtml(m.speakerName) : "";
    const seqNum = Number(m.seq || m.index || 0);
    const hl = highlightKey && trHighlights[highlightKey] && trHighlights[highlightKey].has(seqNum);
    d.innerHTML = '<div><span class="tr-time">' + (m.spokenAt ? escapeHtml(new Date(m.spokenAt).toLocaleString()) : "—") + '</span><span class="tr-role ' + escapeHtml(m.speakerRole || "") + '">' + role + name + '</span></div><div class="tr-text' + (hl ? " tr-highlight" : "") + '">' + escapeHtml(m.content) + '</div>';
    box.appendChild(d);
  }
  trPager = pager || null;
  if (trPager && trPager.totalPages > 1) {
    const bar = document.createElement("div"); bar.className = "pager-bar";
    bar.innerHTML =
      '<button class="pager-btn" data-dir="-1"' + (trPager.page <= 1 ? " disabled" : "") + '>上一页</button>' +
      '<span class="pager-info">第 ' + trPager.page + '/' + trPager.totalPages + ' 页 · 共 ' + trPager.totalMessages + ' 条</span>' +
      '<button class="pager-btn" data-dir="1"' + (trPager.page >= trPager.totalPages ? " disabled" : "") + '>下一页</button>';
    Array.from(bar.querySelectorAll("button")).forEach((b) => { b.onclick = () => flipTrPage(Number(b.dataset.dir)); });
    box.appendChild(bar);
  }
  $("trPanel").style.display = "flex";
  $("headerTrBtn").classList.add("active");
  syncRightCol();
}
async function flipTrPage(dir) {
  if (!trPager) return;
  const target = trPager.page + dir;
  if (target < 1 || target > trPager.totalPages) return;
  try {
    const res = await api("/api/v1/agent/tools/conversation_query/page", {
      method: "POST",
      body: JSON.stringify({ params: { view: "load", conversationId: trPager.conversationId, page: target } }),
    });
    const det = res.details || {};
    trPager.page = target;
    if (Number.isFinite(Number(det.totalPages)) && Number(det.totalPages) > 0) trPager.totalPages = Number(det.totalPages);
    if (Number.isFinite(Number(det.totalMessages))) trPager.totalMessages = Number(det.totalMessages);
    renderTrPanel("会话 " + String(trPager.conversationId || "").slice(0, 10) + "…", det.messages || [], trPager, trPager.conversationId);
  } catch (e) {
    alert("翻页失败:" + e.message);
  }
}
function toggleTrPanel() { if ($("trPanel").style.display === "none") showTrPanel(); else hideTrPanel(); }
function hideTrPanel() { $("trPanel").style.display = "none"; $("headerTrBtn").classList.remove("active"); syncRightCol(); }
function showTrPanel() { $("trPanel").style.display = "flex"; $("headerTrBtn").classList.add("active"); syncRightCol(); }
