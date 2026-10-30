// 外部渠道(微信)写入的消息实时同步到网页:订阅服务端会话事件流,当前打开的就是直接追加
let threadStream = null;
function initThreadLiveUpdates() {
  if (!window.EventSource) return;
  try {
    threadStream = new EventSource("/api/v1/agent/threads/stream");
    threadStream.onmessage = (ev) => {
      let e = null;
      try { e = JSON.parse(ev.data); } catch { return; }
      if (!e || !e.threadId) return;
      if (e.type === "message") {
        if (e.threadId === currentThreadId && (e.role === "user" || e.role === "assistant")) {
          appendAgentMsg(e.role, e.text || "");
        }
        loadThreads();
      } else if (e.type === "title") {
        loadThreads();
      }
    };
    // 断线由浏览器自动重连,这里不额外处理
    threadStream.onerror = () => { };
  } catch (e) { /* 不支持 SSE 时静默降级:列表仍可手动刷新 */ }
}
initThreadLiveUpdates();