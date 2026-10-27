// 页面初始化:事件绑定、启动加载(能力/会话/欢迎区/布局)
let rightResizing = false;
$("rightResizer").addEventListener("mousedown", (e) => { rightResizing = true; document.body.style.userSelect = "none"; e.preventDefault(); });
document.addEventListener("mousemove", (e) => {
  if (!rightResizing) return;
  const layout = document.querySelector(".client-layout");
  if (!layout) return;
  const rect = layout.getBoundingClientRect();
  const width = Math.min(Math.max(rect.right - e.clientX - 8, 220), 560);
  $("rightCol").style.width = width + "px";
});
document.addEventListener("mouseup", () => { if (rightResizing) { rightResizing = false; document.body.style.userSelect = ""; } });
// 顶部栏按钮:切换业务逻辑功能/历史会话/右侧面板
$("headerCapsBtn").addEventListener("click", function () { toggleLeftBlock("capsBlock", this); });
$("headerThreadsBtn").addEventListener("click", function () { toggleLeftBlock("threadsBlock", this); });
$("headerRunBtn").addEventListener("click", toggleRunPanel);
$("headerTrBtn").addEventListener("click", toggleTrPanel);
$("headerKanbanBtn").addEventListener("click", toggleKanbanPanel);
// 对话发送/停止/快捷键
$("sendBtn").addEventListener("click", send);
$("stopBtn").addEventListener("click", () => { if (abortCtrl) abortCtrl.abort(); });
$("goal").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
// 历史会话操作
$("newBtn").addEventListener("click", newThread);
$("clearThreadsBtn").addEventListener("click", clearThreads);
// 顶部功能按钮(关键词/定时任务)
$("headerKeywordsBtn").addEventListener("click", openKeywordsModal);
$("headerJobsBtn").addEventListener("click", openJobsModal);
$("jobsModal").addEventListener("click", (e) => { if (e.target === $("jobsModal")) closeJobsModal(); });
// 启动加载
syncRightCol();
loadCapabilities(); loadThreads(); renderWelcome();
