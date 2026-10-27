// 图表渲染:漏斗/柱状/折线/饼图/雷达/散点(SVG)与 ECharts 图表、图表内容渲染

function renderFunnelSVG(wrap, opt) {
  wrap.className = "echarts-render funnel";
  const series = ((opt.series || []).find((s) => s && s.type === "funnel")) || (opt.series || [])[0] || {};
  const items = (Array.isArray(series.data) ? series.data : []).map((d) => ({ name: d && d.name != null ? String(d.name) : "", value: Number((d && d.value) || 0) }));
  if (!items.length) return false;
  const title = opt.title && opt.title.text ? String(opt.title.text) : "";
  const max = Math.max(1, ...items.map((i) => i.value));
  const palette = Array.isArray(opt.color) && opt.color.length ? opt.color : null;
  const W = 760;
  const stageH = 72;
  const H = 34 + items.length * stageH;
  const cx = W / 2;
  const topW = W - 170;
  const widths = items.map((i) => Math.max(10, (i.value / max) * topW));
  let svg = "";
  if (title) svg += '<text x="' + cx + '" y="18" text-anchor="middle" font-size="15" font-weight="600" fill="#1e293b">' + escapeHtml(title) + "</text>";
  for (let i = 0; i < items.length; i++) {
    const yTop = 34 + i * stageH;
    const yBot = 34 + (i + 1) * stageH;
    const wTop = widths[i];
    const wBot = i < items.length - 1 ? widths[i + 1] : widths[i];
    const pct = Math.round((items[i].value / max) * 100);
    const hue = 220 - i * 26;
    const fill = palette ? palette[i % palette.length] : "hsl(" + hue + ",70%," + (62 - i * 4) + "%)";
    svg += '<polygon points="' + (cx - wTop / 2) + ',' + yTop + ' ' + (cx + wTop / 2) + ',' + yTop + ' ' + (cx + wBot / 2) + ',' + yBot + ' ' + (cx - wBot / 2) + ',' + yBot + '" fill="' + fill + '" stroke="#ffffff" stroke-width="2"/>';
    svg += '<text x="' + (cx - wTop / 2 - 10) + '" y="' + (yTop + stageH / 2 + 5) + '" text-anchor="end" font-size="13" fill="#334155">' + escapeHtml(items[i].name) + "</text>";
    svg += '<text x="' + (cx + wTop / 2 + 10) + '" y="' + (yTop + stageH / 2 + 5) + '" text-anchor="start" font-size="13" fill="#334155">' + items[i].value + " · " + pct + "%</text>";
  }
  wrap.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-width:640px;height:auto;display:block;margin:0 auto" role="img">' + svg + "</svg>";
  return true;
}

function chartPalette(opt) {
  const def = ["#2563eb", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"];
  return Array.isArray(opt.color) && opt.color.length ? opt.color : def;
}
function svgWrap(wrap, W, H, inner) {
  wrap.className = "echarts-render";
  wrap.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-width:720px;height:auto;display:block;margin:0 auto" role="img">' + inner + "</svg>";
}
function renderBarSVG(wrap, opt) {
  const series = (Array.isArray(opt.series) ? opt.series : []).filter((s) => s && Array.isArray(s.data));
  if (!series.length) return false;
  const cats = (opt.xAxis && Array.isArray(opt.xAxis.data)) ? opt.xAxis.data.map(String) : series[0].data.map((_, i) => "项" + (i + 1));
  const palette = chartPalette(opt);
  const allVals = [];
  for (const s of series) for (const v of s.data) allVals.push(Number(v || 0));
  const max = Math.max(1, ...allVals);
  const W = 760, padL = 64, padR = 20, padT = 34, padB = 36;
  const plotW = W - padL - padR, plotH = 300;
  const H = padT + plotH + padB;
  const groupW = plotW / Math.max(cats.length, 1);
  const barW = Math.min(56, (groupW * 0.72) / Math.max(series.length, 1));
  const title = opt.title && opt.title.text ? String(opt.title.text) : "";
  let out = title ? '<text x="' + W / 2 + '" y="18" text-anchor="middle" font-size="15" font-weight="600" fill="#1e293b">' + escapeHtml(title) + "</text>" : "";
  for (let g = 0; g <= 4; g++) {
    const y = padT + plotH - (plotH * g) / 4;
    out += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#e2e8f0" stroke-width="1"/>';
    out += '<text x="' + (padL - 8) + '" y="' + (y + 4) + '" text-anchor="end" font-size="11" fill="#94a3b8">' + Math.round((max * g) / 4) + "</text>";
  }
  cats.forEach((cat, ci) => {
    const gx = padL + groupW * ci;
    series.forEach((s, si) => {
      const v = Number(s.data[ci] || 0);
      const bh = (v / max) * plotH;
      const x = gx + groupW / 2 - (barW * series.length) / 2 + si * barW;
      const y = padT + plotH - bh;
      out += '<rect x="' + x + '" y="' + y + '" width="' + barW + '" height="' + Math.max(bh, 1) + '" rx="3" fill="' + palette[si % palette.length] + '"/>';
      out += '<text x="' + (x + barW / 2) + '" y="' + (y - 4) + '" text-anchor="middle" font-size="11" fill="#334155">' + v + "</text>";
    });
    out += '<text x="' + (gx + groupW / 2) + '" y="' + (H - 14) + '" text-anchor="middle" font-size="12" fill="#334155">' + escapeHtml(cat) + "</text>";
  });
  if (series.length > 1) {
    const lx = W - padR - 70;
    series.forEach((s, si) => {
      const ly = padT + 14 + si * 18;
      out += '<rect x="' + lx + '" y="' + (ly - 10) + '" width="12" height="12" rx="2" fill="' + palette[si % palette.length] + '"/>';
      out += '<text x="' + (lx + 16) + '" y="' + ly + '" font-size="12" fill="#334155">' + escapeHtml(String(s.name || "")) + "</text>";
    });
  }
  svgWrap(wrap, W, H, out);
  return true;
}
function renderLineSVG(wrap, opt) {
  const series = (Array.isArray(opt.series) ? opt.series : []).filter((s) => s && Array.isArray(s.data));
  if (!series.length) return false;
  const cats = (opt.xAxis && Array.isArray(opt.xAxis.data)) ? opt.xAxis.data.map(String) : series[0].data.map((_, i) => "项" + (i + 1));
  const palette = chartPalette(opt);
  const allVals = [];
  for (const s of series) for (const v of s.data) allVals.push(Number(v || 0));
  const max = Math.max(1, ...allVals);
  const W = 760, padL = 64, padR = 20, padT = 34, padB = 36;
  const plotW = W - padL - padR, plotH = 300;
  const H = padT + plotH + padB;
  const title = opt.title && opt.title.text ? String(opt.title.text) : "";
  let out = title ? '<text x="' + W / 2 + '" y="18" text-anchor="middle" font-size="15" font-weight="600" fill="#1e293b">' + escapeHtml(title) + "</text>" : "";
  for (let g = 0; g <= 4; g++) {
    const y = padT + plotH - (plotH * g) / 4;
    out += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#e2e8f0" stroke-width="1"/>';
    out += '<text x="' + (padL - 8) + '" y="' + (y + 4) + '" text-anchor="end" font-size="11" fill="#94a3b8">' + Math.round((max * g) / 4) + "</text>";
  }
  const px = (i) => padL + (cats.length > 1 ? (plotW * i) / (cats.length - 1) : plotW / 2);
  const py = (v) => padT + plotH - (Number(v || 0) / max) * plotH;
  series.forEach((s, si) => {
    const pts = s.data.map((v, i) => px(i) + "," + py(v)).join(" ");
    out += '<polyline points="' + pts + '" fill="none" stroke="' + palette[si % palette.length] + '" stroke-width="2.5"/>';
    s.data.forEach((v, i) => {
      out += '<circle cx="' + px(i) + '" cy="' + py(v) + '" r="4" fill="#ffffff" stroke="' + palette[si % palette.length] + '" stroke-width="2"/>';
    });
  });
  cats.forEach((cat, i) => {
    out += '<text x="' + px(i) + '" y="' + (H - 14) + '" text-anchor="middle" font-size="12" fill="#334155">' + escapeHtml(cat) + "</text>";
  });
  svgWrap(wrap, W, H, out);
  return true;
}
function renderPieSVG(wrap, opt) {
  const series = (Array.isArray(opt.series) ? opt.series : []).filter((s) => s && Array.isArray(s.data));
  const items = (series[0] ? series[0].data : []).map((d, i) => {
    const obj = d && typeof d === "object" ? d : { name: "项" + (i + 1), value: d };
    return { name: obj.name != null ? String(obj.name) : "项" + (i + 1), value: Number(obj.value || 0) };
  });
  if (!items.length || items.reduce((s, x) => s + x.value, 0) <= 0) return false;
  const palette = chartPalette(opt);
  const total = items.reduce((s, x) => s + x.value, 0);
  const cx = 260, cy = 210, R = 150;
  const W = 760, H = 420;
  const title = opt.title && opt.title.text ? String(opt.title.text) : "";
  let out = title ? '<text x="' + W / 2 + '" y="18" text-anchor="middle" font-size="15" font-weight="600" fill="#1e293b">' + escapeHtml(title) + "</text>" : "";
  let ang = -90;
  const pt = (a, r) => (cx + r * Math.cos((a * Math.PI) / 180)).toFixed(1) + "," + (cy + r * Math.sin((a * Math.PI) / 180)).toFixed(1);
  items.forEach((it, i) => {
    const sweep = (it.value / total) * 360;
    const a1 = ang, a2 = ang + sweep;
    const large = sweep > 180 ? 1 : 0;
    const p1 = pt(a1, R), p2 = pt(a2, R);
    const mid = ((a1 + a2) / 2) * (Math.PI / 180);
    const lx = cx + (R + 26) * Math.cos(mid), ly = cy + (R + 26) * Math.sin(mid);
    out += '<path d="M' + cx + "," + cy + " L" + p1 + " A" + R + "," + R + " 0 " + large + " 1 " + p2 + ' Z" fill="' + palette[i % palette.length] + '"/>';
    out += '<text x="' + lx.toFixed(1) + '" y="' + (ly + 4).toFixed(1) + '" text-anchor="middle" font-size="12" fill="#334155">' + Math.round((it.value / total) * 100) + "%</text>";
    ang = a2;
  });
  const lx0 = 480, ly0 = 80;
  items.forEach((it, i) => {
    const ly = ly0 + i * 26;
    out += '<rect x="' + lx0 + '" y="' + (ly - 10) + '" width="12" height="12" rx="2" fill="' + palette[i % palette.length] + '"/>';
    out += '<text x="' + (lx0 + 18) + '" y="' + ly + '" font-size="13" fill="#334155">' + escapeHtml(it.name) + " · " + it.value + "</text>";
  });
  svgWrap(wrap, W, H, out);
  return true;
}
function renderRadarSVG(wrap, opt) {
  const radar = opt && opt.radar;
  const indicators = radar && Array.isArray(radar.indicator) ? radar.indicator : [];
  const series = (Array.isArray(opt.series) ? opt.series : []).filter((s) => s && s.data && s.data[0] && Array.isArray(s.data[0].value));
  if (!indicators.length || !series.length) return false;
  const palette = chartPalette(opt);
  const cx = 300, cy = 250, R = 160;
  const W = 760, H = 500;
  const k = indicators.length;
  const angle = (i) => -90 + (360 * i) / k;
  const pp = (i, r) => (cx + r * Math.cos((angle(i) * Math.PI) / 180)).toFixed(1) + "," + (cy + r * Math.sin((angle(i) * Math.PI) / 180)).toFixed(1);
  const title = opt.title && opt.title.text ? String(opt.title.text) : "";
  let out = title ? '<text x="' + W / 2 + '" y="18" text-anchor="middle" font-size="15" font-weight="600" fill="#1e293b">' + escapeHtml(title) + "</text>" : "";
  for (let ring = 1; ring <= 4; ring++) {
    const pts = [];
    for (let i = 0; i < k; i++) pts.push(pp(i, (R * ring) / 4));
    out += '<polygon points="' + pts.join(" ") + '" fill="none" stroke="#e2e8f0" stroke-width="1"/>';
  }
  for (let i = 0; i < k; i++) {
    const ep = pp(i, R).split(",");
    out += '<line x1="' + cx + '" y1="' + cy + '" x2="' + ep[0] + '" y2="' + ep[1] + '" stroke="#e2e8f0" stroke-width="1"/>';
    const lab = indicators[i];
    const maxV = Number(lab.max || 1);
    const lx = cx + (R + 24) * Math.cos((angle(i) * Math.PI) / 180);
    const ly = cy + (R + 24) * Math.sin((angle(i) * Math.PI) / 180);
    out += '<text x="' + lx.toFixed(1) + '" y="' + (ly + 4).toFixed(1) + '" text-anchor="middle" font-size="12" fill="#334155">' + escapeHtml(String(lab.name || "")) + "</text>";
    const sv = Number((series[0].data[0].value || [])[i] || 0);
    const vp = pp(i, (sv / Math.max(maxV, 1)) * R).split(",");
    out += '<circle cx="' + vp[0] + '" cy="' + vp[1] + '" r="3.5" fill="' + palette[0] + '"/>';
  }
  const pts = [];
  indicators.forEach((lab, i) => {
    const maxV = Number(lab.max || 1);
    const sv = Number((series[0].data[0].value || [])[i] || 0);
    pts.push(pp(i, (sv / Math.max(maxV, 1)) * R));
  });
  out += '<polygon points="' + pts.join(" ") + '" fill="' + palette[0] + '" fill-opacity="0.25" stroke="' + palette[0] + '" stroke-width="2"/>';
  svgWrap(wrap, W, H, out);
  return true;
}
function renderScatterSVG(wrap, opt) {
  const series = (Array.isArray(opt.series) ? opt.series : []).filter((s) => s && Array.isArray(s.data));
  if (!series.length || !series[0].data.length) return false;
  const palette = chartPalette(opt);
  const pts = series[0].data.map((d) => (Array.isArray(d) ? { x: Number(d[0] || 0), y: Number(d[1] || 0) } : { x: null, y: Number(d || 0) }));
  const xs = pts.map((p) => p.x).filter((v) => v != null);
  const ys = pts.map((p) => p.y);
  const maxX = Math.max(1, ...xs);
  const maxY = Math.max(1, ...ys);
  const W = 760, padL = 64, padR = 20, padT = 34, padB = 36;
  const plotW = W - padL - padR, plotH = 300;
  const H = padT + plotH + padB;
  const title = opt.title && opt.title.text ? String(opt.title.text) : "";
  let out = title ? '<text x="' + W / 2 + '" y="18" text-anchor="middle" font-size="15" font-weight="600" fill="#1e293b">' + escapeHtml(title) + "</text>" : "";
  for (let g = 0; g <= 4; g++) {
    const y = padT + plotH - (plotH * g) / 4;
    out += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#e2e8f0" stroke-width="1"/>';
  }
  pts.forEach((p, i) => {
    const x = padL + (p.x != null ? (p.x / maxX) * plotW : plotW / 2);
    const y = padT + plotH - (p.y / maxY) * plotH;
    out += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="5" fill="' + palette[i % palette.length] + '" opacity="0.85"/>';
  });
  svgWrap(wrap, W, H, out);
  return true;
}
function renderChartDirect(wrap, opt) {
  const series0 = Array.isArray(opt.series) ? opt.series[0] : null;
  const type = series0 && series0.type ? String(series0.type) : "bar";
  if (type === "funnel" && renderFunnelSVG(wrap, opt)) return;
  if (type === "pie" && renderPieSVG(wrap, opt)) return;
  if (type === "line" && renderLineSVG(wrap, opt)) return;
  if (type === "radar" && renderRadarSVG(wrap, opt)) return;
  if (type === "scatter" && renderScatterSVG(wrap, opt)) return;
  if (renderBarSVG(wrap, opt)) return;
  renderFallbackChart(wrap, opt);
}
function ensureECharts() {
  if (window.echarts) return Promise.resolve();
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "/vendor/echarts.min.js";
    s.onload = () => resolve();
    s.onerror = () => {
      const s2 = document.createElement("script");
      s2.src = "https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js";
      s2.onload = () => resolve();
      s2.onerror = () => resolve();
      document.head.appendChild(s2);
    };
    document.head.appendChild(s);
  });
}
async function renderChartInto(wrap, json) {
  let opt = null;
  try { opt = JSON.parse(json); } catch { }
  if (!opt || typeof opt !== "object") {
    wrap.innerHTML = '<pre style="margin:0;font-size:12px;color:#64748b;white-space:pre-wrap;word-break:break-all">' + escapeHtml(json) + "</pre>";
    return;
  }
  const series0 = Array.isArray(opt.series) ? opt.series[0] : null;
  if (series0 && series0.type === "funnel" && renderFunnelSVG(wrap, opt)) return;
  await ensureECharts();
  if (window.echarts) {
    try {
      wrap.style.height = "340px";
      wrap.style.width = "100%";
      const chart = window.echarts.init(wrap);
      chart.setOption(opt);
      return;
    } catch { }
  }
  renderChartDirect(wrap, opt);
}
async function renderAssistantContent(text, body) {
  body.innerHTML = "";
  const segments = String(text || "").split(/(```echarts\s*\n?[\s\S]*?```)/g);
  for (const seg of segments) {
    if (!seg) continue;
    const m = seg.match(/^```echarts\s*\n?([\s\S]*?)```$/);
    if (m) {
      const wrap = document.createElement("div"); wrap.className = "echarts-render";
      body.appendChild(wrap);
      await renderChartInto(wrap, m[1]);
    } else {
      const md = document.createElement("div"); md.className = "md";
      md.innerHTML = renderMarkdown(seg);
      body.appendChild(md);
    }
  }
  renderMermaidBlocks(body);
}
function renderFallbackChart(wrap, opt) {
  const series = (opt.series || [])[0] || {};
  const items = Array.isArray(series.data) ? series.data : [];
  let cats = [];
  let data = [];
  if (items.length && typeof items[0] === "object" && items[0] && "name" in items[0]) {
    cats = items.map((d) => String(d.name != null ? d.name : ""));
    data = items.map((d) => Number((d && d.value) || 0));
  } else {
    cats = (opt.xAxis && Array.isArray(opt.xAxis.data)) ? opt.xAxis.data.map(String) : items.map((_, i) => "项" + (i + 1));
    data = items.map((v) => Number(v || 0));
  }
  const title = opt.title && opt.title.text ? String(opt.title.text) : "";
  const max = Math.max(1, ...data);
  const rows = cats.map((cat, i) => {
    const v = data[i] || 0;
    const pct = Math.round((v / max) * 100);
    return '<div style="display:flex;align-items:center;gap:8px;margin:4px 0"><div style="width:96px;text-align:right;font-size:12px;color:#334155;flex-shrink:0">' + escapeHtml(String(cat)) + '</div><div style="background:#2563eb;height:18px;border-radius:4px;width:' + pct + '%"></div><div style="font-size:12px;color:#64748b;flex-shrink:0">' + v + '</div></div>';
  }).join("");
  wrap.innerHTML = '<div style="font-size:13px;font-weight:600;color:#1e293b;margin-bottom:6px">' + escapeHtml(title) + '</div><div>' + rows + '</div>';
}

async function renderEChartsBlocks(root) {
  const codes = Array.from(root.querySelectorAll("code.language-echarts"));
  if (!codes.length) return;
  for (const code of codes) {
try {
  const opt = JSON.parse(code.textContent || "{}");
  if (!opt || typeof opt !== "object") continue;
  const wrap = document.createElement("div"); wrap.className = "echarts-render";
  const pre = code.closest("pre");
  if (pre) pre.replaceWith(wrap); else code.replaceWith(wrap);
  await renderChartInto(wrap, JSON.stringify(opt));
} catch {}
  }
}
