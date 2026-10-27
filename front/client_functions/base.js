// 通用工具:DOM 选择($)、HTML 转义、markdown 渲染、API 请求、脚本加载、mermaid 渲染

const $ = (id) => document.getElementById(id);

function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function renderMarkdown(text) {
  try {
if (typeof marked !== "undefined" && marked.parse) {
  const html = marked.parse(text);
  if (typeof DOMPurify !== "undefined") return DOMPurify.sanitize(html);
  return html;
}
  } catch { }
  return escapeHtml(text);
}
function loadScript(srcs, onLoaded) {
  if (!srcs.length) { if (onLoaded) onLoaded(); return; }
  const s = document.createElement("script");
  s.src = srcs[0];
  s.onload = () => { if (onLoaded) onLoaded(); };
  s.onerror = () => loadScript(srcs.slice(1), onLoaded);
  document.head.appendChild(s);
}
function ensureMermaid() {
  if (window.mermaid) return Promise.resolve();
  return new Promise((resolve) => {
loadScript(["/vendor/mermaid.min.js", "https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"], () => {
  try { if (window.mermaid) window.mermaid.initialize({ startOnLoad: false, theme: "base", securityLevel: "strict" }); } catch { }
  resolve();
});
  });
}
async function renderMermaidBlocks(root) {
  const codes = Array.from(root.querySelectorAll("code.language-mermaid"));
  if (!codes.length) return;
  await ensureMermaid();
  if (!window.mermaid) return;
  for (const code of codes) {
try {
  const src = code.textContent || "";
  const id = "mmd" + Math.random().toString(36).slice(2, 8);
  const out = await window.mermaid.render(id, src);
  const wrap = document.createElement("div");
  wrap.className = "mermaid-render";
  wrap.innerHTML = out.svg;
  const pre = code.closest("pre");
  if (pre) pre.replaceWith(wrap); else code.replaceWith(wrap);
} catch { }
  }
}

/* 图表直渲染器见下方 renderChartDirect 系列 */
async function api(path, opt) {
  const o = opt || {};
  const headers = { "x-tenant-id": "t_demo" };
  if (o.body != null) headers["Content-Type"] = "application/json";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("请求超时(20s),请重试")), 20000);
  try {
const res = await fetch(path, Object.assign({}, o, { headers: Object.assign(headers, o.headers || {}), signal: ctrl.signal }));
if (!res.ok) { let msg = "HTTP " + res.status; try { msg = (await res.json()).message || msg; } catch { } throw new Error(msg); }
return res.json();
  } finally {
clearTimeout(timer);
  }
}
function stripMdTables(t) {
  const lines = String(t == null ? "" : t).split("\n");
  const out = [];
  let inFence = false;
  for (const line of lines) {
if (/^\s*```/.test(line)) { inFence = !inFence; out.push(line); continue; }
if (!inFence && line.trim().startsWith("|")) continue;
out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
