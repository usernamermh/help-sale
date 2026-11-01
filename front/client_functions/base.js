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
/* ===== 登录令牌:所有请求都带上,401 时弹出登录框 ===== */
const HS_TOKEN_KEY = "hs_auth_token";
function hsToken() { try { return window.localStorage.getItem(HS_TOKEN_KEY) || ""; } catch (e) { return ""; } }
function hsAuthHeaders() { const t = hsToken(); return t ? { Authorization: "Bearer " + t } : {}; }
function hsClearToken() { try { window.localStorage.removeItem(HS_TOKEN_KEY); } catch (e) { /* 忽略 */ } }
function hsTenantId() {
  const cfg = window.APP_CONFIG || {};
  const fromUrl = new URLSearchParams(location.search).get("tenant");
  return fromUrl || cfg.tenantId || (window.__APP_TENANT_ID__ || "t_demo");
}
function hsLogout() { hsClearToken(); location.reload(); }
function hsShowLogin(message) {
  if (document.getElementById("hs-login-mask")) return;
  const mask = document.createElement("div");
  mask.id = "hs-login-mask";
  mask.style.cssText = "position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;z-index:99999";
  const box = document.createElement("div");
  box.style.cssText = "background:#fff;border-radius:12px;padding:24px 26px;width:320px;box-shadow:0 20px 50px rgba(0,0,0,.25);font-size:14px";
  box.innerHTML = "<div style=\"font-size:16px;font-weight:600;margin-bottom:4px\">登录 助销 agent 平台</div>"
    + "<div style=\"color:#64748b;margin-bottom:14px\">租户:" + hsTenantId() + "</div>";
  const tip = document.createElement("div");
  tip.style.cssText = "color:#b91c1c;min-height:18px;margin-bottom:8px";
  tip.textContent = message || "";
  const user = document.createElement("input");
  user.placeholder = "用户名";
  user.style.cssText = "width:100%;box-sizing:border-box;padding:8px 10px;margin-bottom:8px;border:1px solid #cbd5e1;border-radius:8px";
  const pass = document.createElement("input");
  pass.type = "password";
  pass.placeholder = "密码";
  pass.style.cssText = user.style.cssText;
  const btn = document.createElement("button");
  btn.textContent = "登录";
  btn.style.cssText = "width:100%;padding:9px 0;border:0;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer";
  const submit = async () => {
    tip.textContent = "";
    btn.disabled = true;
    try {
      const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json", "x-tenant-id": hsTenantId() }),
        body: JSON.stringify({ username: user.value.trim(), password: pass.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.token) throw new Error(data.message || ("HTTP " + res.status));
      window.localStorage.setItem(HS_TOKEN_KEY, data.token);
      location.reload();
    } catch (err) {
      tip.textContent = err && err.message ? err.message : "登录失败";
      btn.disabled = false;
    }
  };
  btn.addEventListener("click", submit);
  pass.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  box.appendChild(tip); box.appendChild(user); box.appendChild(pass); box.appendChild(btn);
  mask.appendChild(box);
  document.body.appendChild(mask);
  user.focus();
}
async function hsEnsureLoggedIn() {
  const cfg = window.APP_CONFIG || {};
  if (cfg.authEnabled === false) return true;
  try {
    const res = await fetch("/api/v1/auth/me", { headers: Object.assign({}, hsAuthHeaders()) });
    if (res.ok) {
      const me = await res.json();
      if (me && me.authEnabled === false) return true;
      if (me && me.userId) { hsRenderLogout(); return true; }
    }
  } catch (e) { /* 网络问题当作未登录处理 */ }
  hsClearToken();
  hsShowLogin("请先登录");
  return false;
}
function hsRenderLogout() {
  if (document.getElementById("hs-logout")) return;
  const btn = document.createElement("button");
  btn.id = "hs-logout";
  btn.textContent = "退出登录";
  btn.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:9998;padding:6px 12px;border:1px solid #cbd5e1;border-radius:999px;background:#fff;color:#334155;cursor:pointer;font-size:12px";
  btn.addEventListener("click", hsLogout);
  document.body.appendChild(btn);
}
async function api(path, opt) {
  const o = opt || {};
  const headers = Object.assign({ "x-tenant-id": hsTenantId() }, hsAuthHeaders());
  if (o.body != null) headers["Content-Type"] = "application/json";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("请求超时(20s),请重试")), 20000);
  try {
const res = await fetch(path, Object.assign({}, o, { headers: Object.assign(headers, o.headers || {}), signal: ctrl.signal }));
if (res.status === 401) { hsClearToken(); hsShowLogin("登录已过期,请重新登录"); }
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
