// 对话流:发送任务、流式接收、事件处理、本轮任务面板、表格翻页

function resetRunPanel() { $("runList").innerHTML = ""; $("runMeta").textContent = ""; $("runPanel").style.display = "flex"; $("headerRunBtn").classList.add("active"); syncRightCol(); }
function addRunTask(label, status, detail, toolName) {
  // tool call 结果返回后不再新增记录:同名工具已存在时只更新状态
  const items = $("runList").children;
  for (const it of items) {
    if (toolName && it.getAttribute("data-tool") === toolName) {
      it.className = "run-item run-" + status;
      return it;
    }
  }
  const d = document.createElement("div"); d.className = "run-item run-" + status;
  if (toolName) d.setAttribute("data-tool", toolName);
  d.innerHTML = '<div class="run-head"><span>' + escapeHtml(label) + '</span><span class="run-time">' + new Date().toLocaleTimeString() + '</span></div>' + (detail ? '<div class="run-detail">' + escapeHtml(detail) + '</div>' : "");
  $("runList").appendChild(d); $("runList").scrollTop = $("runList").scrollHeight;
  $("runPanel").style.display = "flex";
}
function toggleRunPanel() { if ($("runPanel").style.display === "none") showRunPanel(); else hideRunPanel(); }
function hideRunPanel() { $("runPanel").style.display = "none"; $("headerRunBtn").classList.remove("active"); syncRightCol(); }
function showRunPanel() { $("runPanel").style.display = "flex"; $("headerRunBtn").classList.add("active"); $("runList").scrollTop = $("runList").scrollHeight; syncRightCol(); }
function runTaskCount() { return $("runList").querySelectorAll(".run-item").length; }
let running = false; let currentThreadId = null; let deltaBuf = ""; let abortCtrl = null; let kanbanTimer = null; let multiState = null;
const PAGE_TOOLS = ["customer_query", "conversation_query", "vehicle_query", "excel", "table_generate", "playbook_check"];
function appendAgentMsg(role, text) {
  const chat = $("chat");
  const wel = $("welcome"); if (wel) wel.remove();
  const div = document.createElement("div");
  div.className = "agent-msg " + (role === "user" ? "agent-user" : "agent-assist");
  const body = document.createElement("div"); body.className = "agent-body"; if (role === "assistant") { renderAssistantContent(text, body); } else { body.textContent = text; }
  div.appendChild(body);
  const step = document.createElement("div"); step.style.display = "none";
  const meta = document.createElement("div"); meta.className = "agent-meta";
  div.appendChild(step); div.appendChild(meta);
  chat.appendChild(div); chat.scrollTop = chat.scrollHeight;
  return { div, body, step, meta };
}
function extractAgentText(content) { if (!Array.isArray(content)) return ""; return content.map((c) => (c && c.type === "text" ? c.text : "")).join(""); }
function clearChat() { $("chat").innerHTML = ""; renderWelcome(); }
async function send() {
  const goal = $("goal").value.trim();
  if (!goal || running) return;
  running = true;
  abortCtrl = new AbortController();
  if (kanbanTimer) clearInterval(kanbanTimer);
  kanbanTimer = setInterval(() => { if ($("kanbanPanel").style.display !== "none") loadKanban(); }, 2500);
  $("sendBtn").disabled = true;
  $("stopBtn").style.display = "inline-block";
  $("goal").value = "";
  appendAgentMsg("user", goal);
  const wait = appendAgentMsg("assist", "正在开始任务…");
  wait.pageArgs = null; wait.pager = null;
  const steps = [];
  try {
    if (!currentThreadId) { const t = await api("/api/v1/agent/threads", { method: "POST" }); currentThreadId = t.id; }
    await streamRun(goal, wait, steps, abortCtrl.signal);
    loadThreads(); loadCapabilities();
  } catch (e) {
    if (e && e.name === "AbortError") {
      wait.body.textContent = "已停止本轮任务。";
    } else {
      wait.body.textContent = "出错了：" + e.message;
    }
  } finally {
    running = false;
    if (kanbanTimer) { clearInterval(kanbanTimer); kanbanTimer = null; }
    abortCtrl = null;
    $("stopBtn").style.display = "none";
    $("sendBtn").disabled = false;
    $("goal").focus();
  }
}
async function streamRun(goal, wait, steps, signal) {
  deltaBuf = "";
  resetRunPanel();
  const res = await fetch("/api/v1/agent/threads/" + currentThreadId + "/run-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tenant-id": "t_demo" },
    body: JSON.stringify({ goal }),
    signal,
  });
  if (!res.ok) { let msg = "HTTP " + res.status; try { msg = (await res.json()).message || msg; } catch { } throw new Error(msg); }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      handleStreamEvent(evt, wait, steps);
    }
  }
  // 多代理模式:流已结束(仅提交),轮询看板直到子任务全部完成,再调用汇总生成最终答复
  if (multiState) {
    const deadline = Date.now() + 900000;
    let stoppedByUser = false;
    while (true) {
      if (signal.aborted) {
        stoppedByUser = true;
        try { await api("/api/v1/agent/threads/" + currentThreadId + "/stop", { method: "POST" }); } catch { }
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
      const k = await api("/api/v1/kanban?threadId=" + encodeURIComponent(currentThreadId));
      const cards = k.cards || [];
      const done = cards.length > 0 && cards.every((c) => c.status === "done" || c.status === "error");
      if (done || Date.now() > deadline) break;
    if (stoppedByUser) {
      wait.body.textContent = "已停止本轮任务。";
      multiState = null;
      return;
    }
    }
    const sumCtrl = new AbortController();
    const sumTimer = setTimeout(() => sumCtrl.abort(new Error("汇总超时(180s)")), 180000);
    let r;
    try {
      const res2 = await fetch("/api/v1/agent/threads/" + currentThreadId + "/multi-summary", { method: "POST", headers: { "Content-Type": "application/json", "x-tenant-id": "t_demo" }, body: JSON.stringify({ runId: multiState.runId }), signal: sumCtrl.signal });
      r = await res2.json();
    } finally { clearTimeout(sumTimer); }
    const k2 = await api("/api/v1/kanban?threadId=" + encodeURIComponent(currentThreadId));
    const unfinished = (k2.cards || []).filter((c) => c.status === "pending" || c.status === "inprogress");
    const answer = r.final && r.final.answer ? r.final.answer : (unfinished.length ? "部分子任务仍在执行中,可打开协作看板查看进度;完成后会保留在看板。" : "（未生成答复）");
    renderAssistantContent(answer, wait.body);
    if (r.final && r.final.nextSteps && r.final.nextSteps.length) wait.meta.textContent = "下一步：" + r.final.nextSteps.join(" · ");
    multiState = null;
  }
}
// ── 执行计划展示 ──
function attachPlanCard(wait, plan) {
  if (!wait || !plan) return;
  const isMulti = plan.mode === "multi";
  if (!isMulti && (!Array.isArray(plan.steps) || !plan.steps.length)) return;
  let card = wait.div.querySelector(".plan-card");
  if (!card) {
    card = document.createElement("div"); card.className = "plan-card";
    wait.div.insertBefore(card, wait.body);
  }
  const head = isMulti
    ? '<div class="plan-head">🤖 多代理并行' + (plan.summary ? " · " + escapeHtml(String(plan.summary)) : "") + '</div>'
    : '<div class="plan-head">📋 执行计划' + (plan.summary ? " · " + escapeHtml(String(plan.summary)) : "") + '</div>';
  const body = isMulti
    ? '<ol class="plan-steps">' + (plan.subtasks || []).map((s, i) => "<li><b>子任务" + (i + 1) + ": " + escapeHtml(String(s.title)) + "</b>" + (s.tools && s.tools.length ? ' <span class="plan-tool">' + escapeHtml(s.tools.join(",")) + "</span>" : "") + '<div class="plan-purpose">' + escapeHtml(String(s.goal || "")) + "</div></li>").join("") + "</ol>"
    : '<ol class="plan-steps">' + plan.steps.map((s, i) => "<li><b>" + escapeHtml(String(s.step)) + "</b>" + (s.tool ? ' <span class="plan-tool">' + escapeHtml(String(s.tool)) + "</span>" : "") + '<div class="plan-purpose">' + escapeHtml(String(s.purpose || "")) + "</div></li>").join("") + "</ol>";
  card.innerHTML = head + body;
}
function handleStreamEvent(evt, wait, steps) {
  if (evt.type === "plan") {
    attachPlanCard(wait, evt.payload);
    if (evt.payload && evt.payload.mode === "multi") {
      multiState = { runId: evt.payload.runId || null };
      wait.body.textContent = "子任务已提交,正在后台并行执行…";
    }
  } else if (evt.type === "tool_start") {
    const name = evt.label || evt.toolName || "工具";
    steps.push({ eventType: "tool_start", toolName: evt.toolName, label: name });
    if (PAGE_TOOLS.indexOf(evt.toolName) >= 0 && evt.payload && typeof evt.payload === "object") wait.pageArgs = evt.payload;
    addRunTask(name, "start", "", evt.toolName);
    if (evt.toolName !== "emit_final") wait.body.textContent = "正在调用 " + name + "…";
  } else if (evt.type === "tool_end") {
    if (evt.toolName === "dialog_extract" && evt.payload && evt.payload.details && evt.payload.details.conversationId) {
      const d = evt.payload.details;
      trHighlights[d.conversationId] = new Set((d.hitIndexes || []).map(Number));
      (async () => {
        try {
          const res = await api("/api/v1/agent/tools/conversation_query/page", { method: "POST", body: JSON.stringify({ params: { view: "load", conversationId: d.conversationId, page: 1 } }) });
          const det = res.details || {};
          renderTrPanel("会话 " + String(d.conversationId || "").slice(0, 10) + "…", det.messages || [], { conversationId: d.conversationId, page: 1, pageSize: Number(det.pageSize) || 10, totalPages: Number(det.totalPages) || 1, totalMessages: Number(det.totalMessages) || (det.messages || []).length }, d.conversationId);
        } catch (e) { /* 拉全文失败,不阻塞 */ }
      })();
    }
    const name = evt.label || evt.toolName || "工具";
    steps.push({ eventType: "tool_end", toolName: evt.toolName, label: name });
    addRunTask(name, "done", "", evt.toolName);
    if (evt.toolName !== "emit_final") wait.body.textContent = name + " 完成，模型生成答复中…";
    const det = evt.payload && evt.payload.details;
    if (det && Array.isArray(det.messages) && det.messages.length) {
      renderTrPanel("会话 " + String(det.conversationId || "").slice(0, 10) + "…", det.messages, { conversationId: det.conversationId, page: Number(det.page) || 1, pageSize: Number(det.pageSize) || 10, totalPages: Number(det.totalPages) || 1, totalMessages: Number(det.totalMessages) || det.messages.length });
    }
    if (det && PAGE_TOOLS.indexOf(evt.toolName) >= 0 && Number(det.totalPages) > 1) {
      wait.pager = { toolName: evt.toolName, baseArgs: wait.pageArgs || {}, page: Number(det.page) || 1, totalPages: Number(det.totalPages) || 1, totalRows: Number(det.totalRows) || 0 };
    }
  } else if (evt.type === "tool_update") {
    wait.body.textContent = (evt.label || evt.toolName || "工具") + " 处理中…";
  } else if (evt.type === "text_delta") {
    deltaBuf += (evt.payload && evt.payload.text) || "";
    wait.body.innerHTML = '<div class="md">' + renderMarkdown(stripMdTables(deltaBuf)) + '</div>';
    if (window.mermaid) renderMermaidBlocks(wait.body);
  } else if (evt.type === "delta") {
    deltaBuf += evt.text || "";
    wait.body.innerHTML = '<div class="md">' + renderMarkdown(stripMdTables(deltaBuf)) + '</div>';
    if (window.mermaid) renderMermaidBlocks(wait.body);
  } else if (evt.type === "final") {
    if (multiState && evt.runId) multiState.runId = evt.runId;
    deltaBuf = "";
    const answer = evt.final && evt.final.answer ? evt.final.answer : "";
    if (multiState && !answer) {
      // 多代理:子任务刚提交,最终答复由看板轮询汇总生成;这里不渲染空结果,避免误显示'未生成答复/已完成'
      wait.body.textContent = "子任务已提交,正在后台并行执行…";
      wait.meta.textContent = "";
      $("runMeta").textContent = "子任务执行中 · " + runTaskCount() + " 项";
    } else {
      renderAssistantContent(answer || "（未生成答复）", wait.body);
      wait.meta.textContent = (evt.final && evt.final.nextSteps && evt.final.nextSteps.length) ? ("下一步：" + evt.final.nextSteps.join(" · ")) : "";
      if (wait.pager) attachPager(wait);
      $("runMeta").textContent = "本轮任务完成 · " + runTaskCount() + " 项";
    }
  } else if (evt.type === "error") {
    wait.body.textContent = "出错了：" + (evt.error || "未知错误");
    $("runMeta").textContent = "本轮出错:" + (evt.error || "未知错误");
  }
}
function prettyPayload(p) {
  if (p == null) return "";
  try {
    if (p && Array.isArray(p.content)) {
      const txt = p.content.map((c) => (c && c.type === "text" ? c.text : "")).join(" ").trim();
      if (txt) return txt;
    }
  } catch { }
  try { return typeof p === "string" ? p : JSON.stringify(p); } catch { return String(p); }
}

// ── 定时任务管理弹窗 ──
function attachPager(wait) {
  const body = wait.body;
  if (!body || !wait.pager) return;
  const tables = body.querySelectorAll("table");
  if (!tables.length) return;
  const table = tables[tables.length - 1];
  let bar = body.querySelector(".pager-bar");
  if (!bar) { bar = document.createElement("div"); bar.className = "pager-bar"; table.after(bar); }
  const st = wait.pager;
  bar.innerHTML =
    '<button class="pager-btn" data-dir="-1"' + (st.page <= 1 ? " disabled" : "") + '>上一页</button>' +
    '<span class="pager-info">第 ' + st.page + '/' + st.totalPages + ' 页 · 共 ' + st.totalRows + ' 条</span>' +
    '<button class="pager-btn" data-dir="1"' + (st.page >= st.totalPages ? " disabled" : "") + '>下一页</button>';
  Array.from(bar.querySelectorAll("button")).forEach((b) => { b.onclick = () => flipPager(wait, Number(b.dataset.dir)); });
}
async function flipPager(wait, dir) {
  const st = wait.pager;
  if (!st) return;
  const target = st.page + dir;
  if (target < 1 || target > st.totalPages) return;
  const bar = wait.body && wait.body.querySelector(".pager-bar");
  if (bar) { bar.style.opacity = "0.55"; bar.style.pointerEvents = "none"; }
  try {
    const res = await api("/api/v1/agent/tools/" + encodeURIComponent(st.toolName) + "/page", {
      method: "POST",
      body: JSON.stringify({ params: Object.assign({}, st.baseArgs, { page: target }) }),
    });
    const det = res.details || {};
    const md = (typeof det.rawTable === "string" && det.rawTable) ? det.rawTable : (typeof det.table === "string" ? det.table : "");
    const tables = wait.body.querySelectorAll("table");
    if (tables.length) {
      const table = tables[tables.length - 1];
      if (md) {
        const wrap = document.createElement("div"); wrap.className = "md"; wrap.innerHTML = renderMarkdown(md);
        table.replaceWith(wrap);
      } else {
        const txt = (res.content || []).map((c) => (c && c.text ? c.text : "")).join("\n");
        const pre = document.createElement("pre"); pre.className = "pager-pre"; pre.textContent = txt;
        table.replaceWith(pre);
      }
    }
    st.page = target;
    if (Number.isFinite(Number(det.totalPages)) && Number(det.totalPages) > 0) st.totalPages = Number(det.totalPages);
    if (Number.isFinite(Number(det.totalRows))) st.totalRows = Number(det.totalRows);
    attachPager(wait);
  } catch (e) {
    alert("翻页失败:" + e.message);
  } finally {
    if (bar) { bar.style.opacity = ""; bar.style.pointerEvents = ""; }
  }
}
