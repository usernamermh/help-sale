// 关键词管理:分类目录树、筛选、关键词增删改查

function openKeywordsModal() { $("keywordsModal").style.display = "flex"; loadKwCats(); loadKeywords(); }
function closeKeywordsModal() { $("keywordsModal").style.display = "none"; }
let kwState = { page: 1, pageSize: 10, total: 0, totalPages: 1, catTree: [], catFlat: [], filterPaths: new Set(), editingCat: null };
function fillSelect(sel, items, placeholder) {
  const cur = sel.value;
  sel.innerHTML = "<option value=\"\" disabled>" + placeholder + "</option>" + items.map((v) => "<option value=\"" + escapeHtml(v) + "\"" + (v === cur ? " selected" : "") + ">" + escapeHtml(v) + "</option>").join("");
}

// 递归得到扁平化 nodes
function flattenTree(nodes, out) {
  out = out || [];
  for (const n of nodes || []) { out.push(n); flattenTree(n.children || [], out); }
  return out;
}
function catPathText(parts) { return parts.join("/"); }

// 加载当前关键词分类目录
async function loadKwCats() {
  try {
    const r = await api("/api/v1/keyword-categories/tree");
    kwState.catTree = r.tree || [];
    kwState.catFlat = flattenTree(kwState.catTree);
    renderCatTree();
  } catch (e) { $("kwCatTree").innerHTML = "分类加载失败:" + escapeHtml(e.message); }
}
function renderCatTree() {
  const box = $("kwCatTree"); box.innerHTML = "";
  if (!kwState.catTree || !kwState.catTree.length) { box.innerHTML = "<div class=\"mini\">暂无分类,点击「＋ 新建分类」创建</div>"; return; }
  const renderNode = (node, depth, pathArr) => {
    const path = catPathText(pathArr);
    const d = document.createElement("div");
    d.style.cssText = "padding:3px 0;display:flex;align-items:center;gap:5px;padding-left:" + (depth * 16) + "px";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = kwState.filterPaths.has(path);
    cb.addEventListener("change", () => toggleKwFilter(path, cb.checked));
    d.appendChild(cb);
    const label = document.createElement("span");
    label.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer";
    label.textContent = (depth ? "└ " : "") + node.name;
    label.title = "筛选路径: " + path;
    label.addEventListener("click", () => { cb.checked = !cb.checked; toggleKwFilter(path, cb.checked); });
    d.appendChild(label);
    const ops = document.createElement("span");
    ops.style.cssText = "display:flex;gap:4px;flex-shrink:0";
    ops.innerHTML = "<button class=\"secondary\" title=\"在此分类下新建子分类\" onclick=\"openCategoryForm('" + node.id + "')\">＋</button>"
      + "<button class=\"secondary\" title=\"编辑名称/移动\" onclick=\"openCategoryForm('" + node.id + "',true)\">✎</button>"
      + "<button class=\"secondary\" style=\"color:#dc2626\" title=\"删除分类(含子级)\" onclick=\"removeCategory('" + node.id + "')\">×</button>";
    d.appendChild(ops);
    box.appendChild(d);
    for (const ch of node.children || []) renderNode(ch, depth + 1, pathArr.concat(ch.name));
  };
  for (const n of kwState.catTree) renderNode(n, 0, [n.name]);
  updateKwFilterInfo();
}
function updateKwFilterInfo() {
  const n = kwState.filterPaths.size;
  $("kwFilterInfo").textContent = n ? "已选 " + n + " 个分类" : "未筛选";
}
function toggleKwFilter(path, checked) {
  if (checked) kwState.filterPaths.add(path); else kwState.filterPaths.delete(path);
  kwState.page = 1;
  updateKwFilterInfo();
  loadKeywords();
}
function clearKwFilter() {
  if (!kwState.filterPaths.size) return;
  kwState.filterPaths.clear();
  kwState.page = 1;
  renderCatTree();
  loadKeywords();
}

function openCategoryForm(catId, isEdit) {
  const editing = isEdit ? (kwState.catFlat.find((c) => c.id === catId) || null) : null;
  kwState.editingCat = editing;
  $("kwCatForm").style.display = "flex";
  $("kwCatName").value = editing ? editing.name : "";
  const sel = $("kwCatParent");
  const excludeIds = new Set();
  if (editing) {
    const collect = (id) => { excludeIds.add(id); const n = kwState.catFlat.find((c) => c.id === id); for (const ch of n?.children || []) collect(ch.id); };
    collect(editing.id);
  }
  const pathOf = (id) => {
    const parts = [];
    let cur = kwState.catFlat.find((c) => c.id === id);
    while (cur) { parts.unshift(cur.name); cur = cur.parentId ? kwState.catFlat.find((c) => c.id === cur.parentId) : null; }
    return parts.join(" / ");
  };
  sel.innerHTML = "<option value=\"\">无(作为一级分类)</option>";
  for (const n of kwState.catFlat) {
    if (excludeIds.has(n.id) || n.level >= 3) continue;
    const opt = document.createElement("option");
    opt.value = n.id;
    opt.textContent = "　".repeat(Math.max(0, n.level - 1)) + "└ " + pathOf(n.id);
    sel.appendChild(opt);
  }
  if (editing) sel.value = editing.parentId || "";
  else if (catId && !isEdit) sel.value = catId;
  $("kwCatName").focus();
}
function cancelCategoryForm() { kwState.editingCat = null; $("kwCatForm").style.display = "none"; }
async function saveCategoryForm() {
  const name = $("kwCatName").value.trim();
  if (!name) { alert("请输入分类名称"); return; }
  const parentId = $("kwCatParent").value || null;
  try {
    if (kwState.editingCat) {
      await api("/api/v1/keyword-categories/" + kwState.editingCat.id, { method: "PUT", body: JSON.stringify({ name, parentId }), headers: { "Content-Type": "application/json" } });
    } else {
      await api("/api/v1/keyword-categories", { method: "POST", body: JSON.stringify({ name, parentId }), headers: { "Content-Type": "application/json" } });
    }
  } catch (e) { alert("保存失败:" + e.message); return; }
  cancelCategoryForm();
  loadKwCats(); loadKeywords();
}
async function removeCategory(id) {
  const node = kwState.catFlat.find((c) => c.id === id);
  if (!confirm("确认删除分类「" + (node ? node.name : "") + "」及其全部子级?相关关键词将失去该分类标记")) return;
  await api("/api/v1/keyword-categories/" + id, { method: "DELETE" });
  loadKwCats(); loadKeywords();
}
function kwPage(dir) {
  const target = kwState.page + dir;
  if (target < 1 || target > kwState.totalPages) return;
  kwState.page = target;
  loadKeywords();
}
async function loadKeywords() {
  const box = $("keywordsList");
  try {
    const q = new URLSearchParams();
    q.set("page", String(kwState.page)); q.set("pageSize", String(kwState.pageSize));
    for (const p of kwState.filterPaths) q.append("categoryPaths", p);
    const r = await api("/api/v1/keywords?" + q.toString());
    kwState.total = r.total || 0; kwState.totalPages = r.totalPages || 1;
    $("kwPageInfo").textContent = "第 " + kwState.page + "/" + kwState.totalPages + " 页 · 共 " + kwState.total + " 条";
    const list = r.keywords || [];
    box.innerHTML = list.length ? "" : "<div class=\"mini\">暂无关键词,添加一个吧</div>";
    for (const k of list) renderKeywordRow(box, k);
  } catch (e) { box.innerHTML = "加载失败:" + escapeHtml(e.message); }
}
function renderKeywordRow(box, k) {
  const d = document.createElement("div"); d.className = "kw-item";
  d.dataset.id = k.id;
  d.style.cssText = "display:flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:8px;padding:5px 8px;flex-wrap:wrap";
  const kwInput = document.createElement("input");
  kwInput.className = "kw-name-input";
  kwInput.value = k.keyword;
  kwInput.title = "关键词文本(可编辑)";
  kwInput.style.cssText = "width:110px;min-width:90px;padding:4px 6px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px";
  d.appendChild(kwInput);
  const cnt = document.createElement("span");
  cnt.className = "badge";
  cnt.textContent = "命中 " + k.hitCount + " 次";
  cnt.style.cssText = "flex-shrink:0;background:#eff6ff;color:#2563eb;cursor:pointer";
  cnt.title = "查看命中明细(去重后:每个会话计 1 次)";
  cnt.addEventListener("click", () => showKeywordHits(k.id));
  d.appendChild(cnt);
  const s1 = document.createElement("select");
  s1.className = "kw-sel1";
  s1.style.cssText = "width:96px;padding:4px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px";
  s1.addEventListener("change", () => refreshRowSelects(d, s1.value, s2.value));
  d.appendChild(s1);
  const s2 = document.createElement("select");
  s2.className = "kw-sel2";
  s2.style.cssText = "width:96px;padding:4px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px";
  s2.addEventListener("change", () => refreshRowSelects(d, s1.value, s2.value));
  d.appendChild(s2);
  const s3 = document.createElement("select");
  s3.className = "kw-sel3";
  s3.style.cssText = "width:96px;padding:4px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px";
  d.appendChild(s3);
  const save = document.createElement("button");
  save.className = "secondary";
  save.textContent = "保存";
  save.addEventListener("click", () => saveKeyword(k.id, s1.value, s2.value, s3.value));
  d.appendChild(save);
  const del = document.createElement("button");
  del.className = "secondary"; del.style.color = "#dc2626"; del.textContent = "删除";
  del.addEventListener("click", () => deleteKeyword(k.id));
  d.appendChild(del);
  box.appendChild(d);
  refreshRowSelects(d, k.categoryL1 || "", k.categoryL2 || "");
  if (k.categoryL1) s1.value = k.categoryL1;
  if (k.categoryL2) s2.value = k.categoryL2;
  if (k.categoryL3) s3.value = k.categoryL3;
}
function refreshRowSelects(row, l1, l2) {
  const s1 = row.querySelector(".kw-sel1"), s2 = row.querySelector(".kw-sel2"), s3 = row.querySelector(".kw-sel3");
  const tree = kwState.catTree || [];
  fillSelect(s1, tree.map((n) => n.name), "一级");
  const node1 = tree.find((n) => n.name === l1);
  fillSelect(s2, node1 ? (node1.children || []).map((n) => n.name) : [], "二级");
  const node2 = node1 && (node1.children || []).find((n) => n.name === l2);
  fillSelect(s3, node2 ? (node2.children || []).map((n) => n.name) : [], "三级");
}
async function addKeyword() {
  const kw = $("kwInput").value.trim(); if (!kw) return;
  const body = { keyword: kw };
  const paths = [...kwState.filterPaths];
  if (paths.length) {
    const parts = paths[paths.length - 1].split("/").filter(Boolean);
    if (parts.length >= 1) body.categoryL1 = parts[0];
    if (parts.length >= 2) body.categoryL2 = parts[1];
    if (parts.length >= 3) body.categoryL3 = parts[2];
  }
  try {
    await api("/api/v1/keywords", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  } catch (e) { alert("添加失败:" + e.message); return; }
  $("kwInput").value = ""; loadKwCats(); loadKeywords();
}
async function saveKeyword(id, l1, l2, l3) {
  const row = [...document.querySelectorAll(".kw-item")].find((x) => x.dataset.id === id);
  const kwInput = row ? row.querySelector(".kw-name-input") : null;
  const kw = kwInput ? kwInput.value.trim() : "";
  if (!kw) { alert("关键词不能为空"); return; }
  try {
    await api("/api/v1/keywords/" + id, { method: "PUT", body: JSON.stringify({ keyword: kw, categoryL1: l1 || null, categoryL2: l2 || null, categoryL3: l3 || null }), headers: { "Content-Type": "application/json" } });
  } catch (e) { alert("保存失败:" + e.message); return; }
  loadKwCats(); loadKeywords();
}
// 查看关键词命中明细:拉取 keyword_hits(每个会话去重后)并展示在列表顶部
async function showKeywordHits(id) {
  const list = $("keywordsList");
  const detail = document.createElement("div");
  detail.className = "kw-hits-detail";
  detail.style.cssText = "border:1px solid #bfdbfe;background:#eff6ff;border-radius:8px;padding:8px;margin-bottom:8px;font-size:12px";
  detail.innerHTML = "加载命中明细…";
  list.insertBefore(detail, list.firstChild);
  try {
    const r = await api("/api/v1/keywords/" + id + "/hits");
    const hits = r.hits || [];
    detail.innerHTML = '<div style="display:flex;align-items:center;gap:8px"><b>命中明细</b><span class="mini">每个会话计 1 次</span><button class="secondary" style="margin-left:auto" onclick="this.parentElement.parentElement.remove()">关闭</button></div>'
      + (hits.length ? hits.map((h) => '<div style="margin-top:6px;border-bottom:1px dashed #bfdbfe;padding:4px 0">'
        + '<b>' + escapeHtml(h.customerName || "未知客户") + '</b> × ' + escapeHtml(h.salesName || "—")
        + ' <span class="mini">' + escapeHtml(h.conversationId || "") + '</span>'
        + (h.conversationDate ? ' <span class="mini">' + escapeHtml(h.conversationDate) + "</span>" : "")
        + "</div>").join("") : '<div class="mini">暂无命中明细</div>');
  } catch (e) {
    detail.innerHTML = "加载失败:" + escapeHtml(e.message);
  }
}

async function deleteKeyword(id) {
  if (!confirm("确认删除该关键词?")) return;
  await api("/api/v1/keywords/" + id, { method: "DELETE" });
  loadKwCats(); loadKeywords();
}
