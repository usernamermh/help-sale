// 工作流:自动挖掘、草稿列表、编辑微调、执行记录

function openWorkflowsModal() { $("workflowsModal").style.display = "flex"; loadWorkflows(); }
function closeWorkflowsModal() { $("workflowsModal").style.display = "none"; }
let wfState = { list: [] };

// 状态与来源的中文标签:区分「模型挖掘」与「人工预定义」,草稿单独高亮等待审批
const WF_STATUS_LABEL = { draft: "待审批草稿", enabled: "已启用", disabled: "已停用", rejected: "已驳回" };
const WF_ORIGIN_LABEL = { mined: "模型挖掘", manual: "人工预定义" };
const WF_STATUS_COLOR = { draft: "#f59e0b", enabled: "#16a34a", disabled: "#94a3b8", rejected: "#dc2626" };

async function loadWorkflows() {
  const box = $("workflowList");   // 列表容器元素，id 是 workflowList。
  try {
    const r = await api("/api/v1/workflows");
    wfState.list = r.workflows || [];
    // 草稿排在最前:挖掘产出需要人工确认后才对模型开放,避免被淹没在列表里
    wfState.list.sort((a, b) => (a.status === "draft" ? 0 : 1) - (b.status === "draft" ? 0 : 1));
    const drafts = wfState.list.filter((w) => w.status === "draft").length;
    box.innerHTML = wfState.list.length
      ? (drafts ? '<div class="mini" style="color:#b45309;margin-bottom:6px">有 ' + drafts + ' 个待审批草稿(模型挖出但未开放)</div>' : "")
      : '<div class="mini">暂无工作流，点击「🔍 自动挖掘」从历史轨迹沉淀</div>';
    for (const w of wfState.list) {
      const d = document.createElement("div");
      d.style.cssText = "padding:8px;border:1px solid var(--line);border-radius:8px;margin-bottom:6px" + (w.status === "draft" ? ";border-left:3px solid #f59e0b" : "");
      const btns = [];
      if (w.status === "draft") {
        btns.push('<button class="primary" onclick="wfApprove(\'' + w.id + '\')">晋升</button>');
        btns.push('<button class="secondary" onclick="wfReject(\'' + w.id + '\')">驳回</button>');
      } else if (w.status === "enabled") {
        btns.push('<button class="secondary" onclick="wfToggle(\'' + w.id + '\', false)">停用</button>');
      } else if (w.status === "disabled" || w.status === "rejected") {
        btns.push('<button class="secondary" onclick="wfToggle(\'' + w.id + '\', true)">启用</button>');
      }
      btns.push('<button class="secondary" onclick="wfCheck(\'' + w.id + '\')">自检</button>');
      btns.push('<button class="secondary" onclick="openWorkflowForm(\'' + w.id + '\')">编辑</button>');
      btns.push('<button class="secondary" onclick="workflowRuns(\'' + w.id + '\')">记录</button>');
      btns.push('<button class="secondary" style="color:#dc2626" onclick="workflowDel(\'' + w.id + '\')">删除</button>');
      d.innerHTML = '<b>' + escapeHtml(w.name) + '</b>'
        + ' <span class="badge" style="background:' + (WF_STATUS_COLOR[w.status] || "#64748b") + '20;color:' + (WF_STATUS_COLOR[w.status] || "#64748b") + '">' + escapeHtml(WF_STATUS_LABEL[w.status] || w.status) + '</span>'
        + ' <span class="badge">' + escapeHtml(WF_ORIGIN_LABEL[w.origin] || "人工预定义") + '</span>'
        + ' <span class="mini">v' + w.version + '</span>'
        + '<div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap">' + btns.join("") + '</div>';
      d.addEventListener("click", (e) => { if (e.target && e.target.tagName !== "BUTTON") workflowDetail(w.id); });
      box.appendChild(d);
    }
  } catch (e) { box.innerHTML = "加载失败:" + escapeHtml(e.message); }
}

// 晋升草稿为可调用工作流(用户显式确认后触发);后端会顺带返回该工作流是否真的可挂载
async function wfApprove(id) {
  if (!confirm("晋升后该工作流会开放给模型直接调用，确认？")) return;
  try {
    const r = await api("/api/v1/workflows/" + id + "/approve", { method: "POST", body: "{}" });
    if (r.mountable === false) alert("已标记启用，但存在不可执行步骤，暂不会开放给模型：\n" + (r.issues || []).map((i) => "[" + i.stepName + "] " + i.message).join("\n"));
    loadWorkflows();
  } catch (e) { alert("晋升失败:" + e.message); }
}
async function wfReject(id) {
  try {
    await api("/api/v1/workflows/" + id + "/reject", { method: "POST", body: "{}" });
    loadWorkflows();
  } catch (e) { alert("驳回失败:" + e.message); }
}
// 停用/启用:走能力清单开关(后端按 workflow_<id12> 反查工作流并改写 status),与能力面板同一套语义
async function wfToggle(id, enabled) {
  try {
    const name = wfToolNameOf((wfState.list.find((w) => w.id === id) || {}));
    if (!name) { alert("未找到该工作流"); return; }
    await api("/api/v1/console/capabilities/" + name, { method: "PUT", body: JSON.stringify({ enabled }) });
    loadWorkflows();
  } catch (e) { alert("操作失败:" + e.message); }
}
// 与后端 workflowToolName 一致:去掉连字符取前 12 位
function wfToolNameOf(w) { return w && w.id ? "workflow_" + String(w.id).replace(/-/g, "").slice(0, 12) : ""; }
async function wfCheck(id) {
  try {
    const r = await api("/api/v1/workflows/" + id + "/check", { method: "POST", body: "{}" });
    const c = r.check || {};
    $("workflowDetail").innerHTML = '<div class="md"><b>自检结果:</b>' + (c.ok ? '<div class="mini" style="color:#166534">全部步骤可执行' + ((c.paramNames || []).length ? "，需要参数:" + escapeHtml(c.paramNames.join(" / ")) : "，无需参数") + '</div>' : '<div class="mini" style="color:#991b1b">' + (c.issues || []).map((i) => "· " + escapeHtml("[" + i.stepName + "] " + i.message)).join("<br>") + "</div>") + "</div>";
  } catch (e) { $("workflowDetail").innerHTML = "自检失败:" + escapeHtml(e.message); }
}

// 挖掘工作流
async function workflowMine() {
  if (!confirm("从历史对话的工具调用轨迹中自动挖掘工作流草稿？可能耗时几十秒。")) return;
  const box = $("workflowDetail");
  box.innerHTML = '<div class="mini">正在分析历史执行轨迹，提炼可复用工作流…</div>';
  const cfg = window.APP_CONFIG || {};
  const timeoutMs = Number(cfg.workflowMineTimeoutMs) || 120000;
  const tenantId = cfg.tenantId || "t_demo";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("挖掘超时(" + Math.round(timeoutMs / 1000) + "s)")), timeoutMs);
  try {
    const res = await fetch("/api/v1/workflows/mine", { method: "POST", headers: { "Content-Type": "application/json", "x-tenant-id": tenantId }, body: JSON.stringify({}), signal: ctrl.signal });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || ("HTTP " + res.status));
    const mined = j.mined || [];
    const skipped = j.skipped || [];
    const cards = mined.map((m) => '<div style="border:1px solid var(--line);border-left:3px solid #f59e0b;border-radius:8px;padding:6px;margin-top:6px">'
      + '<b>' + escapeHtml(m.workflow.name) + '</b> <span class="badge">草稿·出现 ' + m.count + ' 次</span>'
      + '<div class="mini">' + escapeHtml(m.workflow.description || "") + '</div>'
      + '<div class="mini">来源链路:' + escapeHtml((m.minedFrom || []).join(" → ")) + '</div>'
      + '<div class="mini">晋升后才会开放给模型;可在左侧列表点「晋升」或「驳回」</div></div>').join("");
    const skipRows = skipped.length ? '<div class="mini" style="margin-top:8px">被跳过 ' + skipped.length + ' 条:</div>'
      + skipped.map((k) => '<div class="mini" style="color:#b45309">· ' + escapeHtml(k.signature) + ' —— ' + escapeHtml(k.reason) + '</div>').join("") : "";
    box.innerHTML = (mined.length || skipped.length)
      ? '<div class="md"><b>挖掘完成:候选 ' + (j.totalChains || 0) + ' 条高频串联，新产出 ' + mined.length + ' 个待审批草稿</b>' + cards + skipRows
        + (mined.length ? "" : '<div class="mini">本次没有新草稿(候选已被跳过，原因见上)</div>') + '</div>'
      : '<div class="mini">未发现可复用的高频工具串联(默认需同一序列在 ≥2 次独立运行中出现;可调 workflows.mine.minCount / days 后重试)</div>';
    loadWorkflows();
  } catch (e) { box.innerHTML = "挖掘失败:" + escapeHtml(e.message); }
  finally { clearTimeout(timer); }
}

// 根据传入的工作流 id，在弹窗里显示这条工作流的详情（名称、描述、步骤）
function workflowDetail(id) {
  const w = wfState.list.find((x) => x.id === id); if (!w) return;
  $("workflowDetail").innerHTML = '<div class="md"><b>' + escapeHtml(w.name) + '</b><div class="mini">' + escapeHtml(w.description || "") + '</div>'
    + '<pre style="white-space:pre-wrap;background:#f8fafc;padding:10px;border-radius:8px;font-size:12px">' + escapeHtml(JSON.stringify(w.steps, null, 2)) + '</pre></div>';
}

// 工作流编辑表单:打开弹窗并填充当前值(编辑微调用)
let wfFormState = { id: null };
function openWorkflowForm(id) {
  const w = wfState.list.find((x) => x.id === id) || null;
  wfFormState.id = w ? w.id : null;
  $("wfFormTitle").textContent = w ? "编辑工作流 · " + w.name : "新建工作流";
  $("wfFormName").value = w ? w.name : "";
  $("wfFormDesc").value = w ? (w.description || "") : "";
  $("wfFormSteps").value = w ? JSON.stringify(w.steps || [], null, 2) : JSON.stringify([{ name: "步骤1", tool: "playbook_check", params: { salesName: "{{param.sales}}", days: 30 }, outputVar: "hits" }], null, 2);
  $("workflowFormModal").style.display = "flex";
}
function closeWorkflowForm() { $("workflowFormModal").style.display = "none"; }

async function saveWorkflowForm() {
  const name = $("wfFormName").value.trim();
  const desc = $("wfFormDesc").value.trim();
  const stepsText = $("wfFormSteps").value.trim();
  if (!name) { alert("请输入工作流名称"); return; }
  let steps;
  try { steps = JSON.parse(stepsText); } catch (e) { alert("步骤 JSON 解析失败:" + e.message); return; }
  if (!Array.isArray(steps) || steps.length === 0) { alert("步骤必须是数组且至少一项"); return; }
  try {
    if (wfFormState.id) await api("/api/v1/workflows/" + wfFormState.id, { method: "PUT", body: JSON.stringify({ name, description: desc, steps }), headers: { "Content-Type": "application/json" } });
    else await api("/api/v1/workflows", { method: "POST", body: JSON.stringify({ name, description: desc, steps }), headers: { "Content-Type": "application/json" } });
    closeWorkflowForm();
    loadWorkflows();
  } catch (e) { alert("保存失败:" + e.message); }
}

// 执行工作流
function workflowRuns(id) {
  (async () => {
    try {
      const r = await api("/api/v1/workflows/" + id + "/runs");
      const runs = r.runs || [];
      $("workflowDetail").innerHTML = runs.length ? '<div class="md"><b>执行记录:</b>' + runs.map((x) => '<div style="border:1px solid var(--line);border-radius:8px;padding:6px;margin-top:6px">' + escapeHtml(x.status) + " · " + escapeHtml(x.createdAt) + (x.error ? " · " + escapeHtml(x.error) : "") + "</div>").join("") + "</div>" : '<div class="mini">暂无执行记录</div>';
    } catch (e) { $("workflowDetail").innerHTML = "加载记录失败:" + escapeHtml(e.message); }
  })();
}

// 删除工作流
function workflowDel(id) {
  if (!confirm("确认删除该工作流?")) return;
  (async () => {
    try { await api("/api/v1/workflows/" + id, { method: "DELETE" }); loadWorkflows(); $("workflowDetail").innerHTML = "请选择左侧工作流"; } catch (e) { alert("删除失败:" + e.message); }
  })();
}
