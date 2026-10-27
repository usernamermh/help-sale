// 定时任务:内置/自定义任务管理、执行记录、欢迎区结果

let welcomeResults = null;
function welcomeAll() { return (welcomeResults || []).filter((x) => x.kind === "builtin" || x.kind === "custom"); }
function welcomeButtonsHtml() {
  const all = welcomeAll();
  if (!all.length) return '<div class="welcome-sub">暂无定时任务</div>';
  return '<div class="welcome-btns">' + all.map((res, i) => {
    const state = res.status ? (res.status === "success" ? " · 已生成" : " · " + escapeHtml(String(res.status))) : "";
    return '<button class="welcome-btn" data-idx="' + i + '"><div class="wb-name">' + escapeHtml(res.name) + '</div><div class="wb-time">' + escapeHtml(res.schedule || "") + state + "</div></button>";
  }).join("") + "</div>";
}
function bindWelcomeClicks(wrap) {
  wrap.addEventListener("click", (e) => {
    const b = e.target && e.target.closest ? e.target.closest(".welcome-btn") : null;
    if (!b) return;
    const all = welcomeAll();
    const res = all[Number(b.dataset.idx)];
    if (res) showJobResult(res);
  });
}
function welcomeHead() {
  return '<div class="welcome-title">📊 定时任务结果</div><div class="welcome-sub">点击按钮查看最近一次的结构化执行结果</div>';
}
async function renderWelcome() {
  const chat = $("chat");
  if (!chat || chat.children.length || $("welcome")) return;
  try { const r = await api("/api/v1/automations/results"); welcomeResults = r.results || []; } catch { welcomeResults = welcomeResults || []; }
  if (!chat || chat.children.length || $("welcome")) return;
  const wrap = document.createElement("div"); wrap.className = "welcome"; wrap.id = "welcome";
  wrap.innerHTML = welcomeHead() + welcomeButtonsHtml();
  bindWelcomeClicks(wrap);
  chat.appendChild(wrap); chat.scrollTop = chat.scrollHeight;
}
function refreshWelcomeButtons() {
  const wrap = $("welcome"); if (!wrap) return;
  wrap.innerHTML = welcomeHead() + welcomeButtonsHtml();
  bindWelcomeClicks(wrap);
}
async function showJobResult(res) {
  const wrap = $("welcome"); if (!wrap || !res) return;
  let runs = [];
  try {
    const r = await api("/api/v1/automations/results?jobType=" + encodeURIComponent(res.jobType) + "&limit=50");
    runs = r.results || [];
  } catch { runs = []; }
  if (!runs.length) {
    wrap.innerHTML = '<button class="welcome-back" onclick="refreshWelcomeButtons()">‹ 返回任务列表</button><div class="welcome-result md">' + renderMarkdown(renderJobResultMarkdown(res)) + "</div>";
    return;
  }
  wrap.innerHTML = '<button class="welcome-back" onclick="refreshWelcomeButtons()">‹ 返回任务列表</button>' +
    '<div class="welcome-pick"><label style="font-size:13px;color:var(--muted);margin-right:8px">选择日期/时间</label><select id="welcomePick" class="welcome-select">' +
    runs.map((x, i) => '<option value="' + i + '">' + escapeHtml(jobResultLabel(x)) + "</option>").join("") +
    '</select></div><div class="welcome-result md" id="welcomeResult">' + renderMarkdown(renderJobResultMarkdown(runs[0])) + "</div>";
  $("welcomePick").addEventListener("change", () => {
    const idx = Number($("welcomePick").value) || 0;
    $("welcomeResult").innerHTML = renderMarkdown(renderJobResultMarkdown(runs[idx] || runs[0]));
  });
}
function jobResultLabel(x) {
  let label = String(x.runDate || "—");
  if (x.createdAt) {
    const t = new Date(x.createdAt);
    if (!isNaN(t.getTime())) label += " " + t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (x.status) label += " · " + (x.status === "success" ? "已生成" : x.status);
  return label;
}
function statsTable(stats) {
  const kv = [["date", "日期"], ["pendingTasks", "进行中任务"], ["overdueTasks", "已到期"], ["analyses24h", "近24h分析"], ["vehiclePlans7d", "近7天方案"], ["customers", "客户总数"], ["analyses", "会话分析"], ["deals", "成交"], ["dealAmount", "成交额(元)"], ["taskRate", "任务完成率"], ["newCustomers", "新增客户"]];
  const rows = [];
  for (const [k, label] of kv) {
    const v = stats[k];
    if (v == null) continue;
    if (k === "dealAmount") rows.push([label, "¥" + Number(v).toLocaleString()]);
    else if (k === "taskRate") rows.push([label, Math.round(Number(v) * 100) + "%"]);
    else rows.push([label, String(v)]);
  }
  if (!rows.length) return "";
  return "| 指标 | 数值 |\n| --- | --- |\n" + rows.map((r) => "| " + r[0] + " | " + r[1] + " |").join("\n");
}
function renderJobResultMarkdown(res) {
  const d = res.detail || {};
  let md = "## " + res.name + (res.runDate ? " · " + String(res.runDate) : "");
  if (!res.status) return md + "\n\n暂无执行记录,可到顶部「定时任务」中点击「立即运行」生成。";
  if (res.status !== "success") return md + "\n\n执行状态:**" + escapeHtml(String(res.status)) + "**" + (res.summary ? "\n\n" + res.summary : "");
  if (d.stats) { const t = statsTable(d.stats); if (t) md += "\n\n" + t; }
  if (d.content) md += "\n\n" + d.content;
  if (d.answer) md += "\n\n" + d.answer;
  if (Array.isArray(d.suggestions) && d.suggestions.length) {
    md += "\n\n**改进建议**\n" + d.suggestions.map((s) => "- " + (s.topic || "规则") + "(" + (s.count || 1) + " 次):" + (s.suggestion || "")).join("\n");
  }
  if (typeof d.created === "number") md += "\n\n- 沉默客户总数:" + d.total + "\n- 新建唤醒任务:" + d.created + " 条\n- 已有待办跳过:" + d.skipped + " 条";
  if (res.summary) md += "\n\n> " + res.summary;
  return md;
}
const JOB_WEEK = ["", "一", "二", "三", "四", "五", "六", "日"];
const JOB_DEFS = [
  { type: "morning_digest", name: "每日晨报", time: "每天 08:00", desc: "自动生成团队晨报:待办/到期任务、近24小时分析量、优先跟进客户,并推送通知日志。" },
  { type: "weekly_report", name: "每周周报", time: "每周一 09:00", desc: "汇总近 7 天经营数据:分析量、成交量额、任务完成率、热门意图、车型分布与销售漏斗。" },
  { type: "silent_wakeup", name: "沉默客户唤醒", time: "每天 08:30", desc: "为近 7 天未跟进(无会话/任务/试驾)的客户自动创建「唤醒回访」任务,已有待办自动跳过。" },
  { type: "reflection", name: "反思改进", time: "每周一 09:30", desc: "聚合近 7 天反思案例(评估低分/运行失败),把改进建议写入系统记忆「规则改进」,影响后续 Agent 行为。" },
];

function describeJobSchedule(j) {
  if (!j) return "";
  if (j.scheduleType === "once") return "一次性 " + (j.onceDate || "") + " " + (j.scheduleTime || "");
  if (j.scheduleType === "interval") return (j.intervalUnit === "hour" ? "每 " + (j.intervalDays || 1) + " 小时 " : "每 " + (j.intervalDays || 1) + " 天 ") + (j.scheduleTime || "");
  if (j.scheduleType === "weekly") return "每周" + (JOB_WEEK[j.weekday || 1] || "一") + " " + (j.scheduleTime || "");
  return "每天 " + (j.scheduleTime || "");
}
let jobsState = { selected: null, customs: [], runs: [], editing: null, builtin: {} };
function openJobsModal() { $("jobsModal").style.display = "flex"; loadJobsData(); }
function closeJobsModal() { $("jobsModal").style.display = "none"; jobsState.editing = null; }
async function loadJobsData() {
  let runs = []; let customs = []; let builtin = {};
  let failed = 0;
  try { const r = await api("/api/v1/automations?limit=100"); runs = r.runs || []; } catch { failed++; }
  try { const r = await api("/api/v1/automations/jobs"); customs = r.jobs || []; } catch { failed++; }
  try { const r = await api("/api/v1/automations/builtin"); builtin = r.settings || {}; } catch { failed++; }
  jobsState.runs = runs; jobsState.customs = customs; jobsState.builtin = builtin;
  if (failed === 3) { $("jobsList").innerHTML = '<div class="job-error">定时任务加载失败,请刷新页面重试</div>'; return; }
  try { renderJobsList(); } catch (e) { $("jobsList").innerHTML = '<div class="job-error">加载出错:' + escapeHtml(e.message) + "</div>"; return; }
  if (jobsState.selected) renderJobDetail();
  else $("jobsDetail").innerHTML = "请选择左侧任务,或点击上方「＋ 新增任务」创建一个定时任务";
}
function renderJobsList() {
  const box = $("jobsList"); box.innerHTML = "";
  const add = document.createElement("div"); add.className = "job-add"; add.textContent = "＋ 新增任务";
  add.onclick = () => { jobsState.editing = {}; renderJobForm(null); };
  box.appendChild(add);
  for (const def of JOB_DEFS) {
    box.appendChild(jobItem({ name: def.name, time: def.time, tag: "内置", active: jobsState.selected && jobsState.selected.kind === "builtin" && jobsState.selected.id === def.type, onClick: () => { jobsState.selected = { kind: "builtin", id: def.type }; jobsState.editing = null; renderJobsList(); renderJobDetail(); } }));
  }
  for (const c of jobsState.customs) {
    box.appendChild(jobItem({ name: c.name, time: describeJobSchedule(c), tag: "自定义", active: jobsState.selected && jobsState.selected.kind === "custom" && jobsState.selected.id === c.id, onClick: () => { jobsState.selected = { kind: "custom", id: c.id }; jobsState.editing = null; renderJobsList(); renderJobDetail(); } }));
  }
}
function jobItem(o) {
  const d = document.createElement("div"); d.className = "jobs-item" + (o.active ? " active" : "");
  d.innerHTML = '<div class="ji-name">' + escapeHtml(o.name) + '<span class="ji-tag">' + escapeHtml(o.tag) + "</span></div><div class=\"ji-time\">" + escapeHtml(o.time) + "</div>";
  d.onclick = o.onClick; return d;
}
function renderJobDetail() {
  const sel = jobsState.selected; const box = $("jobsDetail");
  if (!sel) return;
  if (jobsState.editing) { renderJobForm(jobsState.editing); return; }
  if (sel.kind === "builtin") {
    const def = JOB_DEFS.find((d) => d.type === sel.id);
    if (!def) return;
    const ben = jobsState.builtin[def.type] !== false;
    const runs = jobsState.runs.filter((r) => r.jobType === def.type).slice(0, 10);
    box.innerHTML = '<div class="jd-name">' + escapeHtml(def.name) + ' <span style="font-size:12px;color:' + (ben ? "#16a34a" : "#64748b") + '">' + (ben ? "启用中" : "已停用") + ' · 内置任务</span></div><div class="jd-time">⏰ ' + escapeHtml(def.time) + "</div><div class=\"jd-desc\">" + escapeHtml(def.desc) + '</div><div class="jd-actions"><button class="primary" onclick="runBuiltinJob(\'' + def.type + '\')">立即运行</button><button onclick="toggleBuiltinJob(\'' + def.type + '\',' + (ben ? "false" : "true") + ')">' + (ben ? "停用" : "启用") + '</button></div><div class="jd-runs"><b>最近执行记录</b>' + renderRuns(runs) + "</div>";
  } else {
    const c = jobsState.customs.find((x) => x.id === sel.id);
    if (!c) return;
    const action = JSON.parse(c.actionJson || "{}");
    const runs = jobsState.runs.filter((r) => r.jobType === "custom:" + c.id).slice(0, 10);
    box.innerHTML = '<div class="jd-name">' + escapeHtml(c.name) + ' <span style="font-size:12px;color:' + (c.enabled ? "#16a34a" : "#64748b") + '">' + (c.enabled ? "启用中" : "已停用") + '</span></div><div class="jd-time">⏰ ' + escapeHtml(describeJobSchedule(c)) + "</div><div class=\"jd-desc\">" + escapeHtml(c.description || "通知任务") + '<br>通知标题:' + escapeHtml(action.title || "") + '</div><div class="jd-actions"><button class="primary" onclick="runCustomJobNow(\'' + c.id + '\')">立即运行</button><button onclick="toggleCustomJob(\'' + c.id + '\',' + (c.enabled ? "false" : "true") + ')">' + (c.enabled ? "停用" : "启用") + '</button><button onclick="editCustomJob(\'' + c.id + '\')">编辑</button><button class="danger" onclick="deleteCustomJob(\'' + c.id + '\')">删除</button></div><div class="jd-runs"><b>最近执行记录</b>' + renderRuns(runs) + "</div>";
  }
}
function renderRuns(runs) {
  if (!runs.length) return '<div style="margin-top:6px">暂无执行记录</div>';
  return runs.map((r) => '<div class="run-line ' + (r.status === "success" ? "ok" : r.status === "error" ? "err" : "") + '">' + escapeHtml(String(r.runDate)) + " · " + (r.status === "success" ? "成功" : r.status === "error" ? "失败" : "跳过") + (r.summary ? " · " + escapeHtml(String(r.summary)) : "") + "</div>").join("");
}
async function toggleBuiltinJob(key, enabled) { try { await api("/api/v1/automations/builtin/" + key, { method: "PUT", body: JSON.stringify({ enabled: enabled }) }); } catch (e) { alert("操作失败:" + e.message); } loadJobsData(); } async function runBuiltinJob(type) { try { const r = await api("/api/v1/automations/run", { method: "POST", body: JSON.stringify({ job: type }) }); alert(r.summary || "已执行"); } catch (e) { alert("执行失败:" + e.message); } loadJobsData(); }
async function runCustomJobNow(id) { try { const r = await api("/api/v1/automations/jobs/" + id + "/run", { method: "POST" }); alert(r.summary || "已执行"); } catch (e) { alert("执行失败:" + e.message); } loadJobsData(); }
async function toggleCustomJob(id, enabled) { try { await api("/api/v1/automations/jobs/" + id, { method: "PUT", body: JSON.stringify({ enabled: enabled }) }); } catch (e) { alert("操作失败:" + e.message); } loadJobsData(); }
function editCustomJob(id) { const c = jobsState.customs.find((x) => x.id === id); if (c) { jobsState.editing = c; renderJobForm(c); } }
async function deleteCustomJob(id) { if (!window.confirm("确认删除该定时任务?")) return; try { await api("/api/v1/automations/jobs/" + id, { method: "DELETE" }); if (jobsState.selected && jobsState.selected.id === id) jobsState.selected = null; } catch (e) { alert("删除失败:" + e.message); } jobsState.editing = null; loadJobsData(); }
function renderJobForm(job) {
  const box = $("jobsDetail"); const isEdit = job && job.id;
  const j = job || {};
  const action = (job && job.actionJson) ? JSON.parse(job.actionJson) : {};
  const actKind = action.kind === "agent_goal" ? "agent_goal" : "notify";
  const isHour = j.scheduleType === "interval" && j.intervalUnit === "hour";
  const isOnce = j.scheduleType === "once";
  box.innerHTML = '<div class="jd-name">' + (isEdit ? "编辑任务" : "新增任务") + '</div><div class="job-form">' +
    '<label>任务名称</label><input id="jfName" value="' + escapeHtml(j.name || "") + '">' +
    '<div class="row2"><div><label>类型</label><select id="jfType"><option value="interval"' + ((j.scheduleType === "interval" && !isHour) || !j.scheduleType ? " selected" : "") + '>每 N 天</option><option value="interval_hour"' + (isHour ? " selected" : "") + '>每 N 小时</option><option value="once"' + (isOnce ? " selected" : "") + '>指定日期(一次性)</option></select></div>' +
    '<div><label>时间(HH:MM)</label><input id="jfTime" value="' + escapeHtml(j.scheduleTime || "09:00") + '"></div></div>' +
    '<div id="jfOnceRow" style="' + (isOnce ? "" : "display:none") + '"><label>执行日期</label><input id="jfDate" type="date" value="' + escapeHtml(j.onceDate || "") + '"></div>' +
    '<div id="jfIntervalRow" style="' + (isOnce ? "display:none" : "") + '"><label id="jfIntervalLabel">' + (isHour ? "间隔小时数(每 N 小时执行一次)" : "间隔天数(每 N 天执行一次)") + '</label><input id="jfIntervalDays" type="number" min="1" max="365" value="' + (j.intervalDays || 3) + '"></div>' +
    '<label>任务说明</label><textarea id="jfDesc" rows="2">' + escapeHtml(j.description || "") + '</textarea>' +
    '<div class="row2"><div><label>动作类型</label><select id="jfAction"><option value="notify"' + (actKind === "notify" ? " selected" : "") + '>通知</option><option value="agent_goal"' + (actKind === "agent_goal" ? " selected" : "") + '>Agent 自主执行</option></select></div></div>' +
    '<div id="jfNotifyBlock"><label>通知标题</label><input id="jfTitle" value="' + escapeHtml(action.title || "") + '"><label>通知内容</label><textarea id="jfContent" rows="2">' + escapeHtml(action.content || "") + '</textarea></div>' +
    '<div id="jfGoalBlock" style="display:none"><label>Agent 目标(到点由 Agent 自主执行,例如:生成近3天经营报告)</label><textarea id="jfGoal" rows="3">' + escapeHtml(action.goal || "") + '</textarea></div>' +
    '<div style="margin-top:10px;display:flex;gap:8px"><button class="primary" onclick="saveJob()">保存</button><button onclick="cancelJobForm()">取消</button></div></div>';
  const syncForm = () => {
    const t = $("jfType").value;
    $("jfIntervalRow").style.display = (t === "interval" || t === "interval_hour") ? "" : "none";
    $("jfIntervalLabel").textContent = t === "interval_hour" ? "间隔小时数(每 N 小时执行一次)" : "间隔天数(每 N 天执行一次)";
    $("jfOnceRow").style.display = t === "once" ? "" : "none";
    const a = $("jfAction").value;
    $("jfNotifyBlock").style.display = a === "agent_goal" ? "none" : "";
    $("jfGoalBlock").style.display = a === "agent_goal" ? "" : "none";
  };
  $("jfType").onchange = syncForm;
  $("jfAction").onchange = syncForm;
  syncForm();
}
function cancelJobForm() { jobsState.editing = null; renderJobDetail(); }
async function saveJob() {
  const name = $("jfName").value.trim(); const time = $("jfTime").value.trim(); const type = $("jfType").value;
  if (!name || !/^\d{2}:\d{2}$/.test(time)) { alert("名称与时间(HH:MM)必填"); return; }
  const actKind = $("jfAction").value;
  let action;
  if (actKind === "agent_goal") {
    const goal = $("jfGoal").value.trim();
    if (!goal) { alert("请填写 Agent 目标"); return; }
    action = { kind: "agent_goal", goal: goal };
  } else {
    action = { kind: "notify", title: $("jfTitle").value.trim(), content: $("jfContent").value.trim() };
  }
  const editing = jobsState.editing || {};
  const description = $("jfDesc").value.trim();
  let body;
  if (type === "once") {
    const onceDate = $("jfDate").value.trim();
    if (!onceDate) { alert("请选择执行日期"); return; }
    body = { name: name, scheduleType: "once", scheduleTime: time, onceDate: onceDate, intervalDays: null, intervalUnit: "day", weekday: null, description: description, action: action, enabled: true };
  } else {
    body = { name: name, scheduleType: "interval", scheduleTime: time, intervalDays: Number($("jfIntervalDays").value) || 1, intervalUnit: type === "interval_hour" ? "hour" : "day", weekday: null, description: description, action: action, enabled: true };
  }
  try {
    if (editing.id) { await api("/api/v1/automations/jobs/" + editing.id, { method: "PUT", body: JSON.stringify(body) }); jobsState.selected = { kind: "custom", id: editing.id }; }
    else { const r = await api("/api/v1/automations/jobs", { method: "POST", body: JSON.stringify(body) }); jobsState.selected = { kind: "custom", id: r.job.id }; }
    jobsState.editing = null; loadJobsData();
  } catch (e) { alert("保存失败:" + e.message); }
}
