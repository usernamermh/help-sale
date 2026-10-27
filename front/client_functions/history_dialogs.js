// 历史会话:列表、新建、选择、导出、删除、清理

async function clearThreads() {
  if (!window.confirm("确认清空全部历史会话吗?此操作不可恢复。")) return;
  try {
    await api("/api/v1/agent/threads", { method: "DELETE" });
    currentThreadId = null;
    clearChat();
    loadThreads();
    hideTrPanel();
  } catch (e) { alert("清理失败:" + e.message); }
}
// 导出单个历史会话:JSON 文件,保存每一轮对话的完整输入与输出(原始 content,含工具调用与结果)
async function exportThread(id, title) {
  try {
    const r = await api("/api/v1/agent/threads/" + id + "/export");
    let summary = null;
    try { const s = await api("/api/v1/agent/threads/" + id + "/summary"); summary = s.summary || null; } catch { }
    const payload = {
      exportedAt: new Date().toISOString(),
      app: "sales-copilot",
      thread: r.thread,
      summary: summary,
      messages: r.messages || [],
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "会话-" + String(id).slice(0, 8) + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (e) { alert("导出失败:" + e.message); }
}
// 删除单个历史会话
async function removeThread(id) {
  if (!window.confirm("确认删除该历史会话?此操作不可恢复。")) return;
  try {
    await api("/api/v1/agent/threads/" + id, { method: "DELETE" });
    if (currentThreadId === id) { currentThreadId = null; clearChat(); hideTrPanel(); }
    loadThreads();
  } catch (e) { alert("删除失败:" + e.message); }
}
async function loadThreads() {
  const box = $("threadList");
  try {
    const r = await api("/api/v1/agent/threads");
    const threads = r.threads || [];
    if (!threads.length) { box.innerHTML = "<div class=\"thread-item\" style=\"color:var(--muted)\">暂无会话</div>"; return; }
    box.innerHTML = "";
    for (const t of threads) {
      const d = document.createElement("div");
      d.className = "thread-item" + (t.id === currentThreadId ? " selected" : "");
      d.innerHTML = "<div>" + escapeHtml(t.title || "未命名会话") + "</div><div class=\"t\">" + escapeHtml(new Date(t.updatedAt).toLocaleString()) + "</div>" +
        '<div class="thread-actions"><button class="thread-act" title="导出完整对话历史">导出</button><button class="thread-act del" title="删除该历史会话">删除</button></div>';
      d.addEventListener("click", () => selectThread(t.id));
      d.querySelector(".thread-actions button:first-child").addEventListener("click", (e) => { e.stopPropagation(); exportThread(t.id, t.title); });
      d.querySelector(".thread-act.del").addEventListener("click", (e) => { e.stopPropagation(); removeThread(t.id); });
      box.appendChild(d);
    }
  } catch (e) { box.innerHTML = "加载失败:" + escapeHtml(e.message); }
}
async function newThread() { const t = await api("/api/v1/agent/threads", { method: "POST" }); currentThreadId = t.id; clearChat(); loadThreads(); }
async function selectThread(id) {
  currentThreadId = id; loadThreads(); if ($("kanbanPanel").style.display !== "none") loadKanban();
  const chat = $("chat"); chat.innerHTML = "<div class=\"cap-item\">加载中…</div>";
  try {
    const r = await api("/api/v1/agent/threads/" + id);
    chat.innerHTML = "";
    for (const m of r.messages || []) { if (m.role === "user" || m.role === "assistant") appendAgentMsg(m.role, extractAgentText(m.content)); }
    if (!(r.messages || []).length) renderWelcome();
  } catch (e) { chat.innerHTML = "加载失败:" + escapeHtml(e.message); }
}
$("goal").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
$("newBtn").addEventListener("click", newThread);

