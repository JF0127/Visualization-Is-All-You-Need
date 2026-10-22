/* 实时监测看板。纯逻辑在 model.mjs，本文件负责 DOM、布局、绘制与数据轮询。 */

import {
  assignRanks,
  buildView,
  childToward,
  clockTime,
  displayKind,
  formatAge,
  formatRate,
  formatValue,
  nextColor,
  orderVisible,
  parentId,
  parseMarkdown,
  pipeWidth,
  rateOf,
  roundedPath,
  sampleAt,
  shade,
  unique,
} from "./model.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";
const NODE_H = 70;
const ROW_GAP = 54;
const PAD_X = 36;
const PAD_Y = 26;
const TRUNK = 26;
const SPLIT = 12;
const MERGE = 30;
const FRAME_EDGE = 56;
const FRAME_FLOW_EDGE = 240;
const OUTER_GAP = 76;
const FRAME_TITLE_H = 46;
const FRAME_PAD_BOTTOM = 24;
const PILL_H = 26;
const PILL_GAP = 9;
const NAME_SIZE = 14;
const NAME_WEIGHT = 600;
const SUMMARY_SIZE = 11.5;
const LABEL_SIZE = 11.5;
const LABEL_LINE = 15;
const LABEL_WRAP = 130;
const READOUT_W = 176;
const READOUT_H = 20;
const READOUT_SPACING = 4;
const ACTIVE_SECONDS = 2;
const FLOW_SPEED = 52;
const DOT_GAP = 16;
const CHART_LEFT = 48;
const CHART_CURVE_H = 112;
const CHART_SMALL_H = 40;
const CHANNEL_LIMIT = 16;
const DEFAULT_WINDOW = 10;
const MAX_WINDOW = 30;
// 多进程时钟可能有亚秒级偏差；since 回退一点，让稍慢的流不会被全局最大时间跳过。
const SINCE_OVERLAP_SECONDS = 0.35;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2.2;
const MAX_SCALE = 1.75;
const STORE_THEME = "p025-theme";
const STORE_WINDOW = "p025-window";
const STORE_OBSERVED = "p025-observed:";

const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const graph = $("graph");
const popover = $("popover");
const sidebar = $("sidebar");
const cardsEl = $("cards");
const pauseButton = $("pause");
const clearButton = $("clear-observed");
const toggleSidebarButton = $("toggle-sidebar");
const closeSidebarButton = $("close-sidebar");
const themeButton = $("theme");
const statusEl = $("status");
const statusText = $("status-text");
const metricRate = $("metric-rate");
const metricAge = $("metric-age");
const observeCount = $("observe-count");
const sideNote = $("side-note");
const zoomValue = $("zoom-value");
const diagnosticsButton = $("diagnostics-button");
const diagnosticsCount = $("diagnostics-count");
const diagnosticsDialog = $("diagnostics-dialog");
const diagnosticsBody = $("diagnostics-body");

const measureContext = document.createElement("canvas").getContext("2d");
const flowStyle = document.head.appendChild(document.createElement("style"));
const flowPeriods = new Set();
const cards = new Map();

const theme = {};
const state = {
  model: parseMarkdown(""),
  text: null,
  level: "",
  names: new Map(),
  view: null,
  svg: null,
  wrap: null,
  scale: 1,
  zoom: null,
  segments: [],
  nodeElements: new Map(),
  pillElements: [],
  readouts: [],
  observed: new Map(),
  popover: null,
  popoverTriggerKey: "",
  focusKey: "",
  menuFocusName: "",
  paused: false,
  frozen: null,
  hoverOffset: null,
  windowSeconds: DEFAULT_WINDOW,
  sidebarOpen: false,
  theme: "light",
  moduleError: "",
  namesError: "",
  dataError: "",
  statsError: "",
  modulePending: false,
  namesPending: false,
  statsPending: false,
  namesLoaded: false,
  stats: null,
  statsRate: 0,
  observedRate: 0,
  retryAt: 0,
  retryDelay: 0,
  lastStatsSample: null,
  dataDrops: 0,
  statusSignature: "",
  metricsSignature: "",
};

const live = {
  cache: new Map(),
  lastTs: new Map(),
  since: null,
  namesKey: "",
  controller: null,
};

let cardFrame = 0;
let fitFrame = 0;

/* ---------- 基础工具 ---------- */

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgElement(tag, attributes = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(path, size = 14) {
  const svg = svgElement("svg", { width: size, height: size, viewBox: "0 0 14 14", "aria-hidden": "true" });
  svg.append(
    svgElement("path", {
      d: path,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 1.6,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    })
  );
  return svg;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function stored(key, fallback = null) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 隐私模式忽略 */
  }
}

function moduleName(id) {
  return state.model.modules.get(id)?.name || id;
}

function hasChildren(id) {
  return (state.model.children.get(id) || []).length > 0;
}

function flowInfo(name) {
  return state.model.byName.get(name) || null;
}

function flowLabel(flow) {
  return flow.label || flow.name;
}

function themeName() {
  return state.theme === "dark" ? "dark" : "light";
}

function readTheme() {
  const style = getComputedStyle(document.documentElement);
  const get = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  theme.ink = get("--ink", "#1c2026");
  theme.ink3 = get("--ink-3", "#6b7280");
  theme.surface = get("--surface", "#ffffff");
  theme.chartGrid = get("--chart-grid", "#efefea");
  theme.chartAxis = get("--chart-axis", "#8a9099");
  theme.chartDot = get("--chart-dot", "#ffffff");
  theme.shadow = get("--shadow-color", "#1c2026");
  theme.font = get("--font", '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif');
  theme.mono = get("--mono", 'ui-monospace, "SF Mono", Menlo, Consolas, monospace');
}

function applyTheme(themeNameValue, persist = true) {
  state.theme = themeNameValue === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = state.theme;
  if (persist) remember(STORE_THEME, state.theme);
  readTheme();
  recolorObserved();
  updateThemeButton();
  render();
  scheduleCards();
}

function updateThemeButton() {
  if (!themeButton) return;
  const dark = state.theme === "dark";
  themeButton.replaceChildren(
    icon(dark ? "M 7 1.5 V 3 M 7 11 V 12.5 M 1.5 7 H 3 M 11 7 H 12.5 M 3.1 3.1 L 4.2 4.2 M 9.8 9.8 L 10.9 10.9 M 10.9 3.1 L 9.8 4.2 M 4.2 9.8 L 3.1 10.9 M 7 4.6 A 2.4 2.4 0 1 0 7 9.4 A 2.4 2.4 0 1 0 7 4.6" : "M 9.7 8.8 A 4.3 4.3 0 1 1 5.2 3.4 A 3.6 3.6 0 0 0 9.7 8.8 Z")
  );
  themeButton.title = dark ? "切换到浅色主题" : "切换到深色主题";
  themeButton.setAttribute("aria-label", themeButton.title);
}

function observedStorageKey() {
  return STORE_OBSERVED + (state.model.title || "");
}

function saveObserved() {
  try {
    if (state.observed.size) {
      localStorage.setItem(observedStorageKey(), JSON.stringify([...state.observed.keys()]));
    } else {
      localStorage.removeItem(observedStorageKey());
    }
  } catch {
    /* 隐私模式忽略 */
  }
}

function storedObserved() {
  try {
    const raw = localStorage.getItem(observedStorageKey());
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((name) => typeof name === "string") : [];
  } catch {
    return [];
  }
}

function restoreObserved(model) {
  if (state.observed.size) return;
  const realtime = new Set(model.realtimeFlows.map((flow) => flow.name));
  const used = new Set();
  for (const name of storedObserved()) {
    if (!realtime.has(name) || state.observed.has(name)) continue;
    const color = nextColor(used, state.theme);
    used.add(color);
    state.observed.set(name, color);
  }
  if (state.observed.size) state.sidebarOpen = true;
}

function pruneObserved(model) {
  const realtime = new Set(model.realtimeFlows.map((flow) => flow.name));
  let changed = false;
  for (const name of [...state.observed.keys()]) {
    if (realtime.has(name)) continue;
    state.observed.delete(name);
    live.cache.delete(name);
    live.lastTs.delete(name);
    state.frozen?.cache.delete(name);
    changed = true;
  }
  if (changed) {
    state.sidebarOpen = state.observed.size > 0 && state.sidebarOpen;
    saveObserved();
  }
}

function recolorObserved() {
  const names = [...state.observed.keys()];
  if (!names.length) return;
  const used = new Set();
  state.observed.clear();
  for (const name of names) {
    const color = nextColor(used, state.theme);
    used.add(color);
    state.observed.set(name, color);
  }
}

function setObservedMany(names, on) {
  const focusName = state.menuFocusName;
  state.menuFocusName = "";
  let changed = false;
  const used = new Set(state.observed.values());
  for (const name of names) {
    if (on && !state.observed.has(name)) {
      state.observed.set(name, nextColor(used, state.theme));
      used.add(state.observed.get(name));
      changed = true;
    } else if (!on && state.observed.has(name)) {
      state.observed.delete(name);
      live.cache.delete(name);
      live.lastTs.delete(name);
      state.frozen?.cache.delete(name);
      changed = true;
    }
  }
  if (!changed) return;
  if (state.observed.size) state.sidebarOpen = true;
  else {
    state.paused = false;
    state.frozen = null;
    state.hoverOffset = null;
    state.sidebarOpen = false;
  }
  resetLiveScan();
  noteOnline();
  saveObserved();
  render();
  pollData();
  if (state.popover?.kind === "menu") {
    requestAnimationFrame(() => focusMenuAfter(focusName));
  }
}

function toggleObserve(name) {
  const wasObserved = state.observed.has(name);
  if (state.popover?.kind === "menu") state.menuFocusName = name;
  setObservedMany([name], !wasObserved);
}

function resetLiveScan() {
  live.since = null;
  live.namesKey = "";
}

function shouldRetry() {
  return Date.now() >= state.retryAt;
}

function noteOffline() {
  const now = Date.now();
  if (now < state.retryAt) return;
  state.retryDelay = Math.min(5000, state.retryDelay ? state.retryDelay * 2 : 500);
  state.retryAt = now + state.retryDelay;
}

function noteOnline() {
  state.retryAt = 0;
  state.retryDelay = 0;
}

/* ---------- 文本测量与折行 ---------- */

function textWidth(text, size = 12, weight = 400, family = theme.font) {
  if (!measureContext) return Array.from(text).length * size;
  measureContext.font = `${weight} ${size}px ${family}`;
  return measureContext.measureText(text).width;
}

function truncate(text, width, size = 12, weight = 400, family = theme.font) {
  if (textWidth(text, size, weight, family) <= width) return text;
  const chars = Array.from(text);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (textWidth(chars.slice(0, middle).join("") + "…", size, weight, family) <= width) low = middle;
    else high = middle - 1;
  }
  return chars.slice(0, low).join("").trimEnd() + "…";
}

const WIDE = "⺀-鿿豈-﫿︰-﹏＀-￯　-〿";
const TOKEN = new RegExp(`[${WIDE}]|\\s+|[^\\s${WIDE}]+`, "g");
const CLOSING = /^[，。、；：！？）》」』】”’,.;:!?)\]]$/;

function wrapText(text, width, size = 12, weight = 400) {
  const lines = [];
  let line = "";
  const fits = (value) => textWidth(value, size, weight) <= width;
  for (const token of String(text).match(TOKEN) || []) {
    if (/^\s+$/.test(token)) {
      if (line) line += " ";
      continue;
    }
    if (fits(line + token)) {
      line += token;
      continue;
    }
    if (line && CLOSING.test(token)) {
      line += token;
      continue;
    }
    if (line.trim()) {
      lines.push(line.trimEnd());
      line = "";
    }
    if (fits(token)) {
      line = token;
      continue;
    }
    for (const char of Array.from(token)) {
      if (line && !fits(line + char)) {
        lines.push(line);
        line = "";
      }
      line += char;
    }
  }
  if (line.trim() || !lines.length) lines.push(line.trimEnd());
  return lines;
}

function summaryText(flows) {
  const labels = flows.map(flowLabel);
  return labels.length > 2 ? labels.slice(0, 2).join("、") + ` 等 ${labels.length} 条` : labels.join("、");
}

function labelBlock(pair) {
  const watched = unique(pair.flows.map((flow) => flow.name)).filter((name) => state.observed.has(name));
  const rest = pair.flows.filter((flow) => !state.observed.has(flow.name));
  const lines = rest.length ? wrapText(summaryText(rest), LABEL_WRAP, LABEL_SIZE) : [];
  const rowsHeight = watched.length ? watched.length * READOUT_H + (watched.length - 1) * READOUT_SPACING : 0;
  const textHeight = lines.length ? (watched.length ? 5 : 0) + lines.length * LABEL_LINE : 0;
  const width = Math.max(watched.length ? READOUT_W : 0, 12, ...lines.map((line) => textWidth(line, LABEL_SIZE)));
  return { watched, lines, width, height: rowsHeight + textHeight };
}

/* ---------- 视图与布局 ---------- */

function layout(view) {
  const internal = view.pairs.filter((pair) => pair.source !== "@in" && pair.target !== "@out");
  const ordered = orderVisible(view.visibleIds, view.pairs);
  const ranks = assignRanks(ordered, view.visibleIds, view.pairs);
  const columns = new Map();
  for (const id of view.visibleIds) {
    const rank = ranks.get(id) || 0;
    if (!columns.has(rank)) columns.set(rank, []);
    columns.get(rank).push(view.nodes.get(id));
  }
  const layers = [...columns.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]);
  layers.forEach((nodes, col) => nodes.forEach((node) => { node.col = col; }));
  const lastCol = layers.length - 1;
  const colOf = (id) => (id === "@in" ? -1 : id === "@out" ? lastCol + 1 : view.nodes.get(id).col);

  // 用相邻模块的纵向位置排序，减少管道交错；框的入口和出口视为居中。
  for (let pass = 0; pass < 4; pass++) {
    const sweep = pass % 2 ? [...layers].reverse() : layers;
    for (const nodes of sweep) {
      const positions = new Map([["@in", 0.5], ["@out", 0.5]]);
      layers.forEach((layer) => layer.forEach((node, i) => positions.set(node.id, (i + 0.5) / layer.length)));
      const score = (node) => {
        const neighbors = view.pairs.flatMap((pair) =>
          pair.source === node.id ? [pair.target] : pair.target === node.id ? [pair.source] : []
        );
        return neighbors.length
          ? neighbors.reduce((sum, id) => sum + positions.get(id), 0) / neighbors.length
          : positions.get(node.id);
      };
      const scores = new Map(nodes.map((node) => [node.id, score(node)]));
      nodes.sort((a, b) => scores.get(a.id) - scores.get(b.id) || a.module.order - b.module.order);
    }
  }

  const nodeList = [...view.nodes.values()];
  nodeList.forEach((node) => {
    node.children = (state.model.children.get(node.id) || []).length;
    node.configOnly = state.model.configOnly.has(node.id);
  });
  const room = (node, width) => width - 30 - (node.children ? 20 : 0);
  let nodeW = 220;
  for (let width = 168; width <= 220; width += 4) {
    if (
      nodeList.every(
        (node) =>
          textWidth(node.module.name, NAME_SIZE, NAME_WEIGHT) <= room(node, width) &&
          textWidth(node.module.summary || "", SUMMARY_SIZE) <= room(node, width)
      )
    ) {
      nodeW = width;
      break;
    }
  }
  nodeList.forEach((node) => {
    node.nameText = truncate(node.module.name, room(node, nodeW), NAME_SIZE, NAME_WEIGHT);
    const lines = wrapText(node.module.summary || "", room(node, nodeW), SUMMARY_SIZE);
    node.summaryLines = lines.slice(0, 2);
    if (lines.length > 2) {
      node.summaryLines[1] = truncate(node.summaryLines[1] + "…", room(node, nodeW), SUMMARY_SIZE);
    }
  });

  let maxSummary = 40;
  for (const pair of view.pairs) {
    pair.width = pipeWidth(pair.flows.length);
    pair.block = labelBlock(pair);
    maxSummary = Math.max(
      maxSummary,
      ...wrapText(summaryText(pair.flows), LABEL_WRAP, LABEL_SIZE).map((line) => textWidth(line, LABEL_SIZE))
    );
    const distance = colOf(pair.target) - colOf(pair.source);
    pair.route = distance <= 0 ? "feedback" : distance > 1 ? "upper" : "forward";
  }
  const gap = Math.max(READOUT_W + 2 * TRUNK + 12, maxSummary + 2 * TRUNK + 24);
  const inUsed = view.pairs.some((pair) => pair.source === "@in");
  const outUsed = view.pairs.some((pair) => pair.target === "@out");

  const leftIds = view.framed ? [...view.extIn.keys()] : [];
  const rightIds = view.framed ? [...view.extOut.keys()] : [];
  const pillWidth = (id) => textWidth(moduleName(id), 12.5, 500) + 26;
  const leftWidth = Math.max(0, ...leftIds.map(pillWidth));
  const rightWidth = Math.max(0, ...rightIds.map(pillWidth));
  let x = PAD_X;
  let frameLeft = null;
  let frameRight = null;
  const leftPillRight = leftIds.length ? x + leftWidth : null;
  if (leftIds.length) x = leftPillRight + OUTER_GAP;
  if (view.framed) {
    frameLeft = x;
    x += inUsed ? FRAME_FLOW_EDGE : FRAME_EDGE;
  }
  layers.forEach((nodes, col) => {
    if (col) x += gap;
    nodes.forEach((node) => { node.x = x; });
    x += nodeW;
  });
  if (view.framed) {
    frameRight = x + (outUsed ? FRAME_FLOW_EDGE : FRAME_EDGE);
    x = frameRight;
  }
  const rightPillLeft = rightIds.length ? x + OUTER_GAP : null;
  if (rightIds.length) x = rightPillLeft + rightWidth;

  const span = (pair) => Math.abs(colOf(pair.target) - colOf(pair.source));
  const byLane = (a, b) => span(a) - span(b) || colOf(a.source) - colOf(b.source);
  const upper = view.pairs.filter((pair) => pair.route === "upper").sort(byLane);
  const feedback = view.pairs.filter((pair) => pair.route === "feedback").sort(byLane);
  let reach = 26;
  upper.forEach((pair, k) => {
    reach += (k ? 12 : 0) + pair.width / 2;
    pair.laneDepth = reach;
    reach += pair.width / 2 + 7 + pair.block.height;
  });
  const upperBand = upper.length ? reach + 8 : 0;
  let depth = 30;
  feedback.forEach((pair, k) => {
    depth += (k ? 12 : 0) + pair.width / 2;
    pair.laneDepth = depth;
    depth += pair.width / 2 + 7 + pair.block.height;
  });
  const feedbackBand = feedback.length ? depth + 6 : 0;

  const frameTop = PAD_Y;
  const gridTop = PAD_Y + (view.framed ? FRAME_TITLE_H : 0) + upperBand;
  const rows = Math.max(1, ...layers.map((nodes) => nodes.length));
  let gridHeight = rows * NODE_H + (rows - 1) * ROW_GAP;
  for (const pair of view.pairs) {
    if (pair.route === "forward") gridHeight = Math.max(gridHeight, pair.block.height + pair.width + 30);
  }
  layers.forEach((nodes) => {
    const height = nodes.length * NODE_H + (nodes.length - 1) * ROW_GAP;
    nodes.forEach((node, row) => {
      node.y = gridTop + (gridHeight - height) / 2 + row * (NODE_H + ROW_GAP);
      node.cy = node.y + NODE_H / 2;
    });
  });
  const gridBottom = gridTop + gridHeight;
  const portY = gridTop + gridHeight / 2;
  const frameBottom = gridBottom + feedbackBand + (view.framed ? FRAME_PAD_BOTTOM : 0);

  const exitPoint = (id) =>
    id === "@in" ? [frameLeft, portY] : [view.nodes.get(id).x + nodeW, view.nodes.get(id).cy];
  const entryPoint = (id) =>
    id === "@out" ? [frameRight, portY] : [view.nodes.get(id).x, view.nodes.get(id).cy];
  const endName = (id, pair) =>
    id === "@in" || id === "@out" ? [...pair.externals].map(moduleName).join("、") : moduleName(id);
  const segments = [];
  const used = [];

  for (const pair of view.pairs) {
    const [ex, sy] = exitPoint(pair.source);
    const [ix, ty] = entryPoint(pair.target);
    const sx = ex + TRUNK;
    const tx = ix - TRUNK;
    const block = pair.block;
    const w = pair.width;
    let path;
    let flowPath;
    let labelX;
    let labelTop;
    if (pair.route === "forward") {
      const cx = (sx + tx) / 2;
      const half = Math.max(4, Math.min(block.width / 2 + 8, (tx - sx) / 2 - 16));
      const base = (sy + ty) / 2;
      const step = 22;
      const minY = gridTop + block.height + w / 2 + 9;
      const maxY = Math.max(minY, gridBottom - w / 2 - 4);
      const boxAt = (lineY) => ({ x: cx, top: lineY - w / 2 - 7 - block.height, width: block.width, height: block.height });
      let lineY = Math.max(minY, Math.min(maxY, base));
      for (const offset of [0, -1, 1, -2, 2, -3, 3, -4, 4]) {
        const candidate = Math.max(minY, Math.min(maxY, base + offset * step));
        const box = boxAt(candidate);
        if (
          !used.some(
            (other) =>
              Math.abs(other.x - box.x) < (other.width + box.width) / 2 + 10 &&
              box.top < other.top + other.height + 8 &&
              other.top < box.top + box.height + 8
          )
        ) {
          lineY = candidate;
          break;
        }
      }
      const left = cx - half;
      const right = cx + half;
      const d1 = Math.max(10, (left - sx) * 0.55);
      const d2 = Math.max(10, (tx - right) * 0.55);
      const middle = `C ${sx + d1} ${sy}, ${left - d1} ${lineY}, ${left} ${lineY} L ${right} ${lineY} C ${right + d2} ${lineY}, ${tx - d2} ${ty}, ${tx} ${ty}`;
      path = `M ${ex} ${sy} L ${sx} ${sy} ${middle} L ${ix} ${ty}`;
      flowPath = `M ${sx - SPLIT} ${sy} L ${sx} ${sy} ${middle} L ${tx + SPLIT} ${ty}`;
      const box = boxAt(lineY);
      used.push(box);
      labelX = cx;
      labelTop = box.top;
    } else {
      const below = pair.route === "feedback";
      const lineY = below ? gridBottom + pair.laneDepth : gridTop - pair.laneDepth;
      const rx = sx + MERGE;
      const lx = tx - MERGE;
      const radii = [MERGE, 14, 14, MERGE];
      path = roundedPath([[ex, sy], [rx, sy], [rx, lineY], [lx, lineY], [lx, ty], [ix, ty]], radii, true);
      flowPath = roundedPath([[sx - SPLIT, sy], [rx, sy], [rx, lineY], [lx, lineY], [lx, ty], [tx + SPLIT, ty]], radii, true);
      labelX = (sx + tx) / 2;
      labelTop = below ? lineY + w / 2 + 7 : lineY - w / 2 - 7 - block.height;
    }
    segments.push({
      key: "p:" + pair.key,
      kind: "pair",
      flows: pair.flows,
      width: w,
      path,
      flowPath,
      ends: [pair.source, pair.target],
      heading: `${endName(pair.source, pair)} → ${endName(pair.target, pair)}`,
      block: { ...block, x: labelX, top: labelTop, onFrame: view.framed },
      anchor: { x: labelX - block.width / 2, y: labelTop, width: block.width, height: block.height },
    });
  }

  for (const node of view.nodes.values()) {
    const outs = view.pairs.filter((pair) => pair.source === node.id).flatMap((pair) => pair.flows);
    const ins = view.pairs.filter((pair) => pair.target === node.id).flatMap((pair) => pair.flows);
    node.flowNames = unique([...outs, ...ins].map((flow) => flow.name));
    node.hasOut = outs.length > 0;
    node.hasIn = ins.length > 0;
    node.inWidth = ins.length ? pipeWidth(ins.length) : 0;
    node.outWidth = outs.length ? pipeWidth(outs.length) : 0;
    if (outs.length) {
      const w = pipeWidth(outs.length);
      const ex = node.x + nodeW;
      segments.push({
        key: "x:" + node.id,
        kind: "trunk",
        flows: outs,
        width: w,
        path: `M ${ex} ${node.cy} L ${ex + TRUNK} ${node.cy}`,
        flowPath: `M ${ex} ${node.cy} L ${ex + TRUNK - SPLIT} ${node.cy}`,
        ends: [node.id],
        heading: `${node.module.name} 的出口`,
        anchor: { x: ex, y: node.cy - w / 2, width: TRUNK, height: w },
      });
    }
    if (ins.length) {
      const w = pipeWidth(ins.length);
      segments.push({
        key: "e:" + node.id,
        kind: "trunk",
        flows: ins,
        width: w,
        path: `M ${node.x - TRUNK} ${node.cy} L ${node.x} ${node.cy}`,
        flowPath: `M ${node.x - TRUNK + SPLIT} ${node.cy} L ${node.x} ${node.cy}`,
        ends: [node.id],
        heading: `${node.module.name} 的入口`,
        anchor: { x: node.x - TRUNK, y: node.cy - w / 2, width: TRUNK, height: w },
      });
    }
  }

  const pills = [];
  const frameName = moduleName(state.level);
  const placeSide = (ids, flowsOf, side) => {
    const total = ids.length * PILL_H + (ids.length - 1) * PILL_GAP;
    ids.forEach((id, i) => {
      const width = pillWidth(id);
      const y = portY - total / 2 + i * (PILL_H + PILL_GAP);
      const px = side === "left" ? leftPillRight - width : rightPillLeft;
      const cy = y + PILL_H / 2;
      const flows = flowsOf.get(id);
      const w = pipeWidth(flows.length);
      pills.push({ id, x: px, y, width, side });
      if (side === "left") {
        const mx = frameLeft - TRUNK;
        const dx = (mx - leftPillRight) * 0.5;
        const curve = `M ${leftPillRight} ${cy} C ${leftPillRight + dx} ${cy}, ${mx - dx} ${portY}, ${mx} ${portY}`;
        segments.push({
          key: "oi:" + id,
          kind: "outer",
          flows,
          width: w,
          path: `${curve} L ${frameLeft} ${portY}`,
          flowPath: `${curve} L ${frameLeft - TRUNK + SPLIT} ${portY}`,
          ends: ["@in"],
          heading: `来自 ${moduleName(id)}`,
          anchor: { x: px, y, width, height: PILL_H },
        });
      } else {
        const mx = frameRight + TRUNK;
        const dx = (rightPillLeft - mx) * 0.5;
        const curve = `C ${mx + dx} ${portY}, ${rightPillLeft - dx} ${cy}, ${rightPillLeft} ${cy}`;
        segments.push({
          key: "oo:" + id,
          kind: "outer",
          flows,
          width: w,
          path: `M ${frameRight} ${portY} L ${mx} ${portY} ${curve}`,
          flowPath: `M ${frameRight + TRUNK - SPLIT} ${portY} L ${mx} ${portY} ${curve}`,
          ends: ["@out"],
          heading: `去往 ${moduleName(id)}`,
          anchor: { x: px, y, width, height: PILL_H },
        });
      }
    });
  };
  if (view.framed) {
    placeSide(leftIds, view.extIn, "left");
    placeSide(rightIds, view.extOut, "right");
    const inFlows = [...view.extIn.values()].flat();
    const outFlows = [...view.extOut.values()].flat();
    view.frameInWidth = inFlows.length ? pipeWidth(inFlows.length) : 0;
    view.frameOutWidth = outFlows.length ? pipeWidth(outFlows.length) : 0;
    if (inFlows.length) {
      const w = pipeWidth(inFlows.length);
      segments.push({
        key: "pi",
        kind: "trunk",
        flows: inFlows,
        width: w,
        path: `M ${frameLeft - TRUNK} ${portY} L ${frameLeft + TRUNK} ${portY}`,
        flowPath: `M ${frameLeft - TRUNK + SPLIT} ${portY} L ${frameLeft + TRUNK - SPLIT} ${portY}`,
        ends: ["@in"],
        heading: `${frameName} 的入口`,
        anchor: { x: frameLeft - TRUNK, y: portY - w / 2, width: 2 * TRUNK, height: w },
      });
    }
    if (outFlows.length) {
      const w = pipeWidth(outFlows.length);
      segments.push({
        key: "po",
        kind: "trunk",
        flows: outFlows,
        width: w,
        path: `M ${frameRight - TRUNK} ${portY} L ${frameRight + TRUNK} ${portY}`,
        flowPath: `M ${frameRight - TRUNK + SPLIT} ${portY} L ${frameRight + TRUNK - SPLIT} ${portY}`,
        ends: ["@out"],
        heading: `${frameName} 的出口`,
        anchor: { x: frameRight - TRUNK, y: portY - w / 2, width: 2 * TRUNK, height: w },
      });
    }
  }

  const pillsTop = Math.min(frameTop, ...pills.map((pill) => pill.y - 18));
  const pillsBottom = Math.max(0, ...pills.map((pill) => pill.y + PILL_H));
  view.nodeW = nodeW;
  view.segments = segments;
  view.pills = pills;
  view.portY = portY;
  view.inUsed = inUsed;
  view.outUsed = outUsed;
  view.frame = view.framed
    ? { x: frameLeft, y: frameTop, width: frameRight - frameLeft, height: frameBottom - frameTop }
    : null;
  view.top = Math.min(0, pillsTop - PAD_Y);
  view.width = x + PAD_X;
  view.height = Math.max(frameBottom, pillsBottom) + PAD_Y - view.top;
}

/* ---------- 绘制 ---------- */

function activateWithKeyboard(node, callback) {
  node.addEventListener("click", callback);
  node.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      callback();
    }
  });
}

function brandMark() {
  const svg = svgElement("svg", { class: "brand", viewBox: "0 0 18 18", "aria-hidden": "true" });
  svg.append(
    svgElement("path", { class: "brand-edge", d: "M 1 9 H 17" }),
    svgElement("path", { class: "brand-fill", d: "M 1 9 H 17" }),
    svgElement("rect", { class: "brand-node", x: 2.5, y: 5, width: 5, height: 8, rx: 1.2 }),
    svgElement("rect", { class: "brand-node-outline", x: 10.5, y: 5, width: 5, height: 8, rx: 1.2 })
  );
  return svg;
}

function renderBreadcrumbs() {
  const nav = $("breadcrumbs");
  nav.replaceChildren();
  const entries = [{ id: "", name: state.model.title, root: true }];
  if (state.level) {
    const segments = state.level.split("/");
    segments.forEach((_, index) => {
      const id = segments.slice(0, index + 1).join("/");
      entries.push({ id, name: moduleName(id) });
    });
  }
  entries.forEach((entry, index) => {
    if (index) nav.append(element("span", "crumb-sep", "/"));
    const button = element("button", entry.root ? "crumb crumb-root" : "crumb");
    if (entry.root) {
      button.append(brandMark());
      button.title = entry.name + " · 返回顶层";
    } else {
      button.title = entry.name;
    }
    button.append(element("span", "crumb-text", entry.name));
    button.type = "button";
    button.disabled = entry.id === state.level;
    if (button.disabled) button.setAttribute("aria-current", "page");
    button.addEventListener("click", () => navigate(entry.id));
    nav.append(button);
  });
}

function drawFrame(view, layer) {
  const frame = view.frame;
  const module = state.model.modules.get(state.level);
  layer.append(svgElement("rect", { class: "frame-box", x: frame.x, y: frame.y, width: frame.width, height: frame.height, rx: 10 }));
  const name = truncate(module?.name || state.level, frame.width - 40, 13.5, 600);
  layer.append(svgElement("text", { class: "frame-name", x: frame.x + 18, y: frame.y + 27 }, name));
  const idX = frame.x + 18 + textWidth(name, 13.5, 600) + 10;
  if (idX + 60 < frame.x + frame.width) {
    layer.append(svgElement("text", { class: "frame-id", x: idX, y: frame.y + 27 }, state.level));
  }
}

function drawPorts(view, layer) {
  const frame = view.frame;
  layer.append(svgElement("rect", { class: "port" + (view.inUsed ? " used" : ""), x: frame.x - 4, y: view.portY - 9, width: 8, height: 18, rx: 2 }));
  layer.append(svgElement("rect", { class: "port" + (view.outUsed ? " used" : ""), x: frame.x + frame.width - 4, y: view.portY - 9, width: 8, height: 18, rx: 2 }));
  for (const side of ["left", "right"]) {
    const pills = view.pills.filter((pill) => pill.side === side);
    if (!pills.length) continue;
    const anchor = side === "left" ? Math.max(...pills.map((pill) => pill.x + pill.width)) : Math.min(...pills.map((pill) => pill.x));
    layer.append(
      svgElement(
        "text",
        { class: "side-caption", x: anchor, y: pills[0].y - 8, "text-anchor": side === "left" ? "end" : "start" },
        side === "left" ? "来自" : "去往"
      )
    );
  }
}

function drawSegment(seg, layers) {
  const attributes = { d: seg.path };
  const outline = svgElement("path", { ...attributes, class: "pipe-outline", "stroke-width": seg.width + 2 });
  const fill = svgElement("path", { ...attributes, class: "pipe-fill", "stroke-width": seg.width });
  const wires = svgElement("g");
  const dots = svgElement("g");
  layers.outline.append(outline);
  layers.fill.append(fill);
  layers.wire.append(wires);
  layers.dots.append(dots);
  const hit = svgElement("path", {
    ...attributes,
    class: "pipe-hit",
    "stroke-width": Math.max(seg.width + 10, 14),
    tabindex: 0,
    role: "button",
    "aria-label": `${seg.heading}：${summaryText(seg.flows)}；选择要看的数据`,
  });
  hit.dataset.focusKey = "seg:" + seg.key;
  hit.append(svgElement("title", {}, `${seg.heading}\n` + seg.flows.map((flow) => `${flowLabel(flow)} · ${flow.name}`).join("\n")));
  (seg.kind === "pair" ? layers.hitLow : layers.hitHigh).append(hit);
  seg.outline = outline;
  seg.fill = fill;
  seg.wires = wires;
  seg.dots = dots;
  seg.els = [outline, fill, wires, dots];
  seg.signature = null;
  bindSegment(seg, hit);
  if (seg.kind === "pair") drawLabel(seg, layers.label);
}

function bindSegment(seg, target) {
  activateWithKeyboard(target, () => activateSegment(seg));
  target.addEventListener("pointerenter", () => hoverSegment(seg, true));
  target.addEventListener("pointerleave", () => hoverSegment(seg, false));
}

function hoverSegment(seg, on) {
  seg.outline.classList.toggle("hover", on);
  seg.fill.classList.toggle("hover", on);
  seg.jointOutline?.classList.toggle("hover", on);
  seg.jointFill?.classList.toggle("hover", on);
  seg.label?.classList.toggle("hover", on);
}

function drawLabel(seg, layer) {
  const block = seg.block;
  const group = svgElement("g", { class: "label-group" });
  group.append(
    svgElement("rect", {
      class: "label-hit",
      x: block.x - block.width / 2 - 4,
      y: block.top - 3,
      width: block.width + 8,
      height: block.height + 6,
    })
  );
  let y = block.top;
  block.watched.forEach((name, i) => {
    if (i) y += READOUT_SPACING;
    drawReadout(group, block.x - READOUT_W / 2, y, name);
    y += READOUT_H;
  });
  if (block.lines.length) {
    if (block.watched.length) y += 5;
    const text = svgElement("text", { class: "pipe-label" + (block.onFrame ? " on-frame" : ""), "text-anchor": "middle" });
    block.lines.forEach((line, i) => text.append(svgElement("tspan", { x: block.x, y: y + 11.5 + i * LABEL_LINE }, line)));
    group.append(text);
  }
  layer.append(group);
  seg.label = group;
  seg.els.push(group);
  bindSegment(seg, group);
}

function drawReadout(layer, x, y, name) {
  const flow = flowInfo(name);
  const color = state.observed.get(name);
  const kind = displayKind(flow?.display);
  const label = flow ? flowLabel(flow) : name;
  const group = svgElement("g", { transform: `translate(${x}, ${y})` });
  const title = svgElement("title", {}, label + "：等待数据");
  group.append(title);
  group.append(svgElement("rect", { class: "readout-bg", width: READOUT_W, height: READOUT_H, rx: 4 }));
  group.append(svgElement("circle", { cx: 10, cy: READOUT_H / 2, r: 3.5, fill: color }));
  group.append(svgElement("text", { class: "readout-label", x: 19, y: 14 }, truncate(label, 46, 11)));
  const spark = kind === "text" ? null : svgElement("g");
  if (spark) group.append(spark);
  const value = svgElement(
    "text",
    kind === "text"
      ? { class: "readout-value text waiting", x: 68, y: 14 }
      : { class: "readout-value waiting", x: READOUT_W - 8, y: 14, "text-anchor": "end" },
    "—"
  );
  group.append(value);
  layer.append(group);
  state.readouts.push({
    name,
    kind,
    color,
    label,
    title,
    value,
    spark,
    lines: [],
    valueWidth: kind === "text" ? READOUT_W - 76 : 62,
  });
}

function drawNode(node, layer, portLayer, view) {
  const width = view.nodeW;
  const expandable = node.children > 0;
  const group = svgElement("g", {
    class: "node" + (node.configOnly ? " config-only" : ""),
    transform: `translate(${node.x}, ${node.y})`,
    tabindex: 0,
    role: "button",
    "aria-label": `${node.module.name}：${node.module.summary}${node.configOnly ? "；仅配置数据" : ""}${expandable ? "；进入查看子模块" : "；查看说明"}`,
  });
  group.dataset.focusKey = "node:" + node.id;
  group.append(
    svgElement(
      "title",
      {},
      node.module.name +
        (node.module.summary ? "\n" + node.module.summary : "") +
        (node.configOnly ? "\n仅配置数据（非实时流未绘制）" : "") +
        (expandable ? "\n点击进入" : "")
    )
  );
  if (expandable) group.append(svgElement("rect", { class: "node-stack", x: 4, y: 4, width, height: NODE_H, rx: 6 }));
  group.append(svgElement("rect", { class: "node-box", width, height: NODE_H, rx: 6 }));
  group.append(svgElement("circle", { class: "node-state", cx: width - 12, cy: 12, r: 3.2 }));
  group.append(svgElement("text", { class: "node-name", x: 16, y: 26 }, node.nameText));
  if (node.summaryLines?.length) {
    const summary = svgElement("text", { class: "node-summary", x: 16 });
    node.summaryLines.forEach((line, index) => {
      summary.append(svgElement("tspan", { x: 16, y: 44 + index * 13.5 }, line));
    });
    group.append(summary);
  }
  if (expandable) {
    group.append(
      svgElement("path", {
        class: "node-chevron",
        d: `M ${width - 19} ${NODE_H / 2 - 4} L ${width - 15} ${NODE_H / 2} L ${width - 19} ${NODE_H / 2 + 4}`,
      })
    );
  }
  activateWithKeyboard(group, () => {
    if (expandable) navigate(node.id);
    else if (state.popover?.kind === "module" && state.popover.id === node.id) closePopover();
    else openPopover({ kind: "module", id: node.id });
  });
  group.addEventListener("pointerenter", () => focusNode(node.id));
  group.addEventListener("pointerleave", () => focusNode(null));
  layer.append(group);
  state.nodeElements.set(node.id, group);
  portLayer.append(svgElement("rect", { class: "port" + (node.hasIn ? " used" : ""), x: node.x - 3, y: node.cy - 7, width: 6, height: 14, rx: 1.5 }));
  portLayer.append(svgElement("rect", { class: "port" + (node.hasOut ? " used" : ""), x: node.x + width - 3, y: node.cy - 7, width: 6, height: 14, rx: 1.5 }));
}

function drawPill(pill, layer) {
  const group = svgElement("g", {
    class: "pill",
    transform: `translate(${pill.x}, ${pill.y})`,
    tabindex: 0,
    role: "button",
    "aria-label": `跳转到${moduleName(pill.id)}`,
  });
  group.dataset.focusKey = "pill:" + pill.id;
  group.append(svgElement("title", {}, `${moduleName(pill.id)}\n点击跳转`));
  group.append(svgElement("rect", { class: "pill-box", width: pill.width, height: PILL_H, rx: PILL_H / 2 }));
  group.append(svgElement("text", { class: "pill-text", x: pill.width / 2, y: 17, "text-anchor": "middle" }, moduleName(pill.id)));
  activateWithKeyboard(group, () => jumpTo(pill.id));
  layer.append(group);
  state.pillElements.push(group);
}

function focusNode(id) {
  for (const seg of state.segments) {
    const related = !id || seg.ends.includes(id);
    seg.els.forEach((el) => el.classList.toggle("dim", !related));
  }
  state.nodeElements.forEach((group, nodeId) => {
    const linked =
      !id ||
      nodeId === id ||
      state.segments.some((seg) => seg.kind === "pair" && seg.ends.includes(id) && seg.ends.includes(nodeId));
    group.classList.toggle("dim", !linked);
  });
}

/* ---------- 主渲染 ---------- */

// 只在管道汇合/分叉的小范围内使用“模糊 + 收边”，避免圆角被过滤出小台阶。
function junctionSpots(view) {
  const spots = [];
  for (const node of view.nodes.values()) {
    if (node.hasIn) {
      spots.push({ x: node.x - TRUNK / 2, y: node.cy, r: Math.max(26, node.inWidth / 2 + 12) });
    }
    if (node.hasOut) {
      spots.push({ x: node.x + view.nodeW + TRUNK / 2, y: node.cy, r: Math.max(26, node.outWidth / 2 + 12) });
    }
  }
  if (view.frame) {
    spots.push({ x: view.frame.x, y: view.portY, r: Math.max(26, (view.frameInWidth || 0) / 2 + 12) });
    spots.push({ x: view.frame.x + view.frame.width, y: view.portY, r: Math.max(26, (view.frameOutWidth || 0) / 2 + 12) });
  }
  return spots;
}

function emptyState() {
  let title;
  let message;
  if (state.text === null) {
    if (state.moduleError) {
      title = "无法读取 module.md";
      message = state.moduleError;
    } else {
      title = "正在读取模块说明";
      message = "页面会每 3 秒自动检查一次 module.md。";
    }
  } else if (!state.model.modules.size) {
    title = "module.md 中没有模块";
    message = "请使用 ### id · 名称 定义模块，并用 - 源 -> 目标 : 名称 | 标签 | 显示方式 | 类型 | 说明 描述数据流。";
  } else if (state.level) {
    title = "当前模块没有可显示的子模块";
    message = "可以通过面包屑或“返回上层”查看其他层级。";
  } else {
    title = "模块说明中暂无可显示的模块";
    message = "请检查 module.md 的模块与数据流定义。";
  }
  const box = element("div", "empty");
  box.append(element("h2", "empty-title", title), element("p", "empty-text", message));
  if (state.level) {
    const back = element("button", "empty-action", "返回上层");
    back.type = "button";
    back.addEventListener("click", () => navigate(parentId(state.level)));
    box.append(back);
  }
  return box;
}

function render(transition = "") {
  renderBreadcrumbs();
  graph.replaceChildren();
  state.segments = [];
  state.nodeElements = new Map();
  state.pillElements = [];
  state.readouts = [];
  state.svg = null;
  state.wrap = null;

  const view = buildView(state.model, state.level);
  state.view = view;
  if (!view.nodes.size) {
    graph.append(emptyState());
    updateZoomLabel();
  } else {
    layout(view);
    const wrap = element("div", "graph-wrap");
    const svg = svgElement("svg", {
      class: "graph-svg" + (transition ? " enter-" + transition : ""),
      viewBox: `0 ${view.top} ${view.width} ${view.height}`,
      role: "group",
      "aria-label": "模块与数据管道图",
    });
    const defs = svgElement("defs");
    const shadow = svgElement("filter", { id: "node-shadow", x: "-10%", y: "-20%", width: "120%", height: "150%" });
    shadow.append(
      svgElement("feDropShadow", {
        dx: 0,
        dy: 1,
        stdDeviation: 1.4,
        "flood-color": theme.shadow,
        "flood-opacity": 0.055,
      })
    );
    const smooth = svgElement("filter", {
      id: "pipe-smooth",
      filterUnits: "userSpaceOnUse",
      x: -20,
      y: view.top - 20,
      width: view.width + 40,
      height: view.height + 40,
      "color-interpolation-filters": "sRGB",
    });
    smooth.append(
      svgElement("feGaussianBlur", { in: "SourceGraphic", stdDeviation: 2.4, result: "blur" }),
      svgElement("feColorMatrix", {
        in: "blur",
        type: "matrix",
        values: "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 14 -6",
      })
    );
    const jointFade = svgElement("radialGradient", { id: "joint-fade" });
    jointFade.append(
      svgElement("stop", { offset: "0", "stop-color": "#ffffff" }),
      svgElement("stop", { offset: "0.58", "stop-color": "#ffffff" }),
      svgElement("stop", { offset: "1", "stop-color": "#000000" })
    );
    const jointMask = svgElement("mask", {
      id: "joint-mask",
      maskUnits: "userSpaceOnUse",
      x: -20,
      y: view.top - 20,
      width: view.width + 40,
      height: view.height + 40,
    });
    for (const spot of junctionSpots(view)) {
      jointMask.append(svgElement("circle", { cx: spot.x, cy: spot.y, r: spot.r, fill: "url(#joint-fade)" }));
    }
    defs.append(shadow, smooth, jointFade, jointMask);
    svg.append(defs);
    const names = ["frame", "outline", "fill", "joint", "wire", "dots", "hitLow", "hitHigh", "label", "node", "port"];
    const layers = Object.fromEntries(names.map((name) => [name, svgElement("g")]));
    names.forEach((name) => svg.append(layers[name]));
    if (view.frame) drawFrame(view, layers.frame);
    view.segments.forEach((seg) => {
      drawSegment(seg, layers);
      state.segments.push(seg);
    });
    view.nodes.forEach((node) => drawNode(node, layers.node, layers.port, view));
    view.pills.forEach((pill) => drawPill(pill, layers.node));
    if (view.frame) drawPorts(view, layers.port);
    const jointGroup = svgElement("g", { filter: "url(#pipe-smooth)", mask: "url(#joint-mask)" });
    const jointOutline = svgElement("g");
    const jointFill = svgElement("g");
    jointGroup.append(jointOutline, jointFill);
    layers.joint.append(jointGroup);
    for (const seg of state.segments) {
      const outline = svgElement("path", { d: seg.path, class: "pipe-outline", "stroke-width": seg.width + 2 });
      const fill = svgElement("path", { d: seg.path, class: "pipe-fill", "stroke-width": seg.width });
      seg.jointOutline = outline;
      seg.jointFill = fill;
      seg.els.push(outline, fill);
      jointOutline.append(outline);
      jointFill.append(fill);
    }
    wrap.append(svg);
    graph.append(wrap);
    state.svg = svg;
    state.wrap = wrap;
    fitGraph();
  }

  updateSegments();
  updateNodeStates(viewNow());
  updateReadouts();
  updateSidebar();
  rebuildCards();
  renderCards();
  refreshPopover();
  updateDiagnostics();
  updateStatus();
  updateMetrics();
  restoreFocus();
}

function fitGraph() {
  const wrap = state.wrap;
  const view = state.view;
  if (!wrap || !view?.width) {
    updateZoomLabel();
    return;
  }
  const style = getComputedStyle(graph);
  const width = graph.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const height = graph.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  if (width <= 0 || height <= 0) return;
  const narrow = window.innerWidth <= 760;
  const natural = Math.min(width / view.width, height / view.height);
  const floor = narrow ? 0.45 : 0.8;
  const scale =
    state.zoom === null
      ? clamp(natural, floor, MAX_SCALE)
      : clamp(state.zoom, MIN_ZOOM, MAX_ZOOM);
  state.scale = scale;
  wrap.style.width = view.width * scale + "px";
  wrap.style.height = view.height * scale + "px";
  updateZoomLabel();
  positionPopover();
}

function scheduleFit() {
  if (fitFrame) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    if (state.zoom === null) fitGraph();
    else positionPopover();
  });
}

function setZoom(next) {
  if (!state.wrap) return;
  state.zoom = clamp(next, MIN_ZOOM, MAX_ZOOM);
  fitGraph();
  scheduleCards();
  positionPopover();
}

function zoomBy(factor) {
  setZoom(state.scale * factor);
}

function resetZoom() {
  state.zoom = null;
  fitGraph();
  scheduleCards();
}

function updateZoomLabel() {
  if (!zoomValue) return;
  zoomValue.textContent = state.wrap && state.scale ? Math.round(state.scale * 100) + "%" : "—";
}

function viewRect(x, y, width, height) {
  if (!state.wrap || !state.view) return null;
  const wrap = state.wrap.getBoundingClientRect();
  const base = canvas.getBoundingClientRect();
  const scale = state.scale || wrap.width / state.view.width;
  const left = wrap.left - base.left + x * scale;
  const top = wrap.top - base.top + (y - state.view.top) * scale;
  return { left, top, width: width * scale, height: height * scale, right: left + width * scale, bottom: top + height * scale };
}

function nodeRect(id) {
  const node = state.view?.nodes.get(id);
  return node && node.x !== undefined ? viewRect(node.x, node.y, state.view.nodeW, NODE_H) : null;
}

function frameRect() {
  const frame = state.view?.frame;
  return frame ? viewRect(frame.x, frame.y, frame.width, frame.height) : null;
}

/* ---------- 层级与路由 ---------- */

function hashLevel() {
  const raw = location.hash.replace(/^#\/?/, "");
  if (!raw) return "";
  try {
    return raw.split("/").map((part) => decodeURIComponent(part)).join("/");
  } catch {
    return "";
  }
}

function levelHash(level) {
  return level ? "#/" + level.split("/").map((part) => encodeURIComponent(part)).join("/") : "#/";
}

function pushRoute(level) {
  const hash = levelHash(level);
  if (location.hash !== hash) {
    try {
      history.pushState({ level }, "", hash);
    } catch {
      location.hash = hash;
    }
  }
}

function replaceRoute(level) {
  const hash = levelHash(level);
  if (location.hash !== hash) {
    try {
      history.replaceState({ level }, "", hash);
    } catch {
      /* ignore */
    }
  }
}

function navigate(target, after, options = {}) {
  const requested = target;
  if (target && !state.model.modules.has(target)) {
    let fallback = target;
    while (fallback && !state.model.modules.has(fallback)) fallback = parentId(fallback);
    target = fallback;
  }
  if (target !== requested) replaceRoute(target);
  if (target === state.level) {
    after?.();
    return;
  }
  const previous = state.level;
  const deeper = previous ? target.startsWith(previous + "/") : target !== "";
  const shallower = target ? previous.startsWith(target + "/") : previous !== "";
  const from = deeper ? nodeRect(childToward(previous, target)) : shallower ? frameRect() : null;
  closePopover(false);
  state.level = target;
  state.zoom = null;
  graph.scrollTop = 0;
  graph.scrollLeft = 0;
  if (!options.fromHistory) pushRoute(target);
  render(deeper ? "in" : shallower ? "out" : "fade");
  const to = deeper ? frameRect() : shallower ? nodeRect(childToward(target, previous)) : null;
  if (from && to) morph(from, to);
  after?.();
}

function morph(from, to) {
  if (!Element.prototype.animate || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const box = element("div", "morph");
  canvas.append(box);
  const rect = (r) => ({ left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
  const animation = box.animate(
    [
      { ...rect(from), opacity: 1 },
      { ...rect(to), opacity: 1, offset: 0.72 },
      { ...rect(to), opacity: 0 },
    ],
    { duration: 440, easing: "cubic-bezier(.2, .7, .2, 1)", fill: "forwards" }
  );
  animation.onfinish = animation.oncancel = () => box.remove();
}

function jumpTo(id) {
  if (hasChildren(id)) {
    navigate(id);
    return;
  }
  navigate(parentId(id), () => {
    if (state.view?.nodes.has(id)) openPopover({ kind: "module", id });
  });
}

/* ---------- 浮层 ---------- */

function focusMenuAfter(name) {
  if (state.popover?.kind !== "menu") return;
  if (name) {
    const input = [...popover.querySelectorAll("input[data-name]")].find((item) => item.dataset.name === name);
    if (input) {
      input.focus({ preventScroll: true });
      return;
    }
  }
  focusMenuSearch();
}

function focusMenuSearch() {
  if (state.popover?.kind !== "menu") return;
  const search = popover.querySelector(".menu-search");
  if (search) {
    search.focus({ preventScroll: true });
    return;
  }
  popover.querySelector('input[data-name]')?.focus({ preventScroll: true });
}

function openPopover(spec) {
  state.popover = spec;
  state.popoverTriggerKey = state.focusKey || document.activeElement?.dataset?.focusKey || "";
  popover.hidden = false;
  buildPopover();
  if (!state.popover) return;
  positionPopover();
  popover.style.animation = "none";
  void popover.offsetWidth;
  popover.style.animation = "";
  if (spec.kind === "menu") focusMenuSearch();
  else popover.querySelector(".pop-close")?.focus({ preventScroll: true });
}

function closePopover(restoreFocus = true) {
  if (!state.popover) return;
  const trigger = state.popoverTriggerKey;
  state.popover = null;
  popover.hidden = true;
  popover.replaceChildren();
  markOpen();
  if (restoreFocus && trigger) {
    requestAnimationFrame(() => {
      const target = [...graph.querySelectorAll("[data-focus-key]")].find((el) => el.dataset.focusKey === trigger);
      target?.focus({ preventScroll: true });
    });
  }
}

function findSegment(key) {
  return state.segments.find((seg) => seg.key === key) || null;
}

function popoverHeader(title, subtitle) {
  const head = element("div", "pop-head");
  const text = element("div", "pop-head-text");
  text.append(element("h3", "pop-name", title));
  if (subtitle) text.append(element("div", "pop-sub", subtitle));
  const close = element("button", "pop-close icon-button");
  close.type = "button";
  close.title = "关闭";
  close.setAttribute("aria-label", "关闭");
  close.append(icon("M 3.5 3.5 L 10.5 10.5 M 10.5 3.5 L 3.5 10.5", 12));
  close.addEventListener("click", () => closePopover());
  head.append(text, close);
  return head;
}

function buildPopover() {
  const spec = state.popover;
  popover.replaceChildren();
  if (!spec) return;

  if (spec.kind === "module") {
    const module = state.model.modules.get(spec.id);
    if (!module || !state.view?.nodes.has(spec.id)) {
      closePopover(false);
      return;
    }
    popover.className = "popover";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", module.name + "的说明");
    popover.append(popoverHeader(module.name, module.id));
    const flows = state.model.realtimeFlows.filter((flow) => flow.source === module.id || flow.target === module.id);
    const meta = element("div", "pop-meta");
    if (state.model.configOnly.has(module.id)) meta.append(element("span", "tag", "仅配置数据"));
    meta.append(element("span", "", `${flows.length} 条实时数据流`));
    popover.append(meta);
    popover.append(element("p", "pop-summary", module.summary || "—"));
    popover.append(element("div", "pop-label", "详细"), element("p", "pop-detail", module.detail || "—"));
    if (flows.length) {
      const list = element("div", "pop-flows");
      list.append(element("div", "pop-label", "关联数据"));
      flows.slice(0, 12).forEach((flow) => {
        const row = element("div", "pop-flow");
        row.append(
          element("span", "pop-flow-name", flowLabel(flow)),
          element("code", "", flow.name),
          element("span", "pop-flow-route", `${moduleName(flow.source)} → ${moduleName(flow.target)}`)
        );
        list.append(row);
      });
      popover.append(list);
    }
    markOpen();
    return;
  }

  if (spec.kind === "menu") {
    const seg = findSegment(spec.key);
    if (!seg) {
      closePopover(false);
      return;
    }
    const names = unique(seg.flows.map((flow) => flow.name));
    popover.className = "popover menu";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "选择要看的数据");
    popover.append(popoverHeader(seg.heading, `${names.length} 条数据`));
    if (names.length > 6) {
      const search = element("input", "menu-search");
      search.type = "search";
      search.placeholder = "筛选数据…";
      search.setAttribute("aria-label", "筛选数据");
      search.addEventListener("input", () => filterMenu(search.value));
      popover.append(search);
    }
    const actions = element("div", "menu-actions");
    const all = element("button", "menu-action", "全选");
    all.type = "button";
    all.addEventListener("click", () => setObservedMany(names, true));
    const none = element("button", "menu-action", "清空");
    none.type = "button";
    none.addEventListener("click", () => setObservedMany(names, false));
    actions.append(all, none);
    popover.append(actions);
    const list = element("div", "menu-list");
    for (const name of names) {
      const flow = seg.flows.find((item) => item.name === name);
      const row = element("label", "menu-row");
      row.dataset.search = `${flowLabel(flow)} ${name} ${moduleName(flow.source)} ${moduleName(flow.target)}`;
      const input = element("input");
      input.type = "checkbox";
      input.dataset.name = name;
      input.addEventListener("change", () => toggleObserve(name));
      const box = element("i", "menu-box");
      box.append(icon("M 3.5 7.2 L 6 9.6 L 10.5 4.6", 11));
      const text = element("span", "menu-text");
      const sub = element("span", "menu-sub");
      sub.append(
        document.createTextNode(`${moduleName(flow.source)} → ${moduleName(flow.target)} · ${flow.display || "—"} · `),
        element("code", "", name)
      );
      text.append(element("span", "menu-label", flowLabel(flow)), sub);
      row.append(input, box, text);
      list.append(row);
    }
    popover.append(list);
    const empty = element("div", "menu-empty", "没有匹配的数据");
    empty.hidden = true;
    popover.append(empty);
    updateMenuChecks();
    markOpen();
    return;
  }

  closePopover(false);
}

function filterMenu(query) {
  const text = query.trim().toLowerCase();
  let visible = 0;
  popover.querySelectorAll(".menu-row").forEach((row) => {
    const match = !text || row.dataset.search.toLowerCase().includes(text);
    row.hidden = !match;
    if (match) visible++;
  });
  const empty = popover.querySelector(".menu-empty");
  if (empty) empty.hidden = visible > 0;
}

function updateMenuChecks() {
  if (state.popover?.kind !== "menu") return;
  popover.querySelectorAll("input[data-name]").forEach((input) => {
    const color = state.observed.get(input.dataset.name);
    input.checked = !!color;
    input.closest(".menu-row").style.setProperty("--c", color || theme.ink3);
  });
}

function refreshPopover() {
  if (!state.popover) return;
  buildPopover();
  positionPopover();
}

function markOpen() {
  const spec = state.popover;
  state.nodeElements.forEach((group, id) => group.classList.toggle("open", spec?.kind === "module" && spec.id === id));
  for (const seg of state.segments) {
    const open = spec?.kind === "menu" && spec.key === seg.key;
    seg.outline.classList.toggle("open", open);
    seg.fill.classList.toggle("open", open);
    seg.jointOutline?.classList.toggle("open", open);
    seg.jointFill?.classList.toggle("open", open);
    seg.label?.classList.toggle("open", open);
  }
}

function positionPopover() {
  const spec = state.popover;
  if (!spec || popover.hidden) return;
  let anchor = null;
  if (spec.kind === "module") anchor = nodeRect(spec.id);
  else {
    const seg = findSegment(spec.key);
    if (seg) anchor = viewRect(seg.anchor.x, seg.anchor.y, seg.anchor.width, seg.anchor.height);
  }
  if (!anchor) return;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const popWidth = popover.offsetWidth;
  const popHeight = popover.offsetHeight;
  let left;
  let top;
  if (spec.kind === "module") {
    left = anchor.right + 12;
    if (left + popWidth > width - 10) left = anchor.left - 12 - popWidth;
    top = anchor.top - 4;
  } else {
    left = anchor.left + anchor.width / 2 - popWidth / 2;
    top = anchor.bottom + 10;
    if (top + popHeight > height - 10) top = anchor.top - 10 - popHeight;
  }
  popover.style.left = Math.max(10, Math.min(width - popWidth - 10, left)) + "px";
  popover.style.top = Math.max(10, Math.min(height - popHeight - 10, top)) + "px";
}

function activateSegment(seg) {
  const names = unique(seg.flows.map((flow) => flow.name));
  if (names.length === 1) {
    closePopover(false);
    toggleObserve(names[0]);
  } else if (state.popover?.kind === "menu" && state.popover.key === seg.key) {
    closePopover();
  } else {
    openPopover({ kind: "menu", key: seg.key });
  }
}

/* ---------- 侧栏与卡片 ---------- */

function shownNames() {
  return new Set(state.segments.filter((seg) => seg.kind === "pair").flatMap((seg) => seg.flows.map((flow) => flow.name)));
}

function updateSidebar() {
  const names = [...state.observed.keys()];
  const open = names.length > 0 && state.sidebarOpen;
  document.body.classList.toggle("observing", names.length > 0);
  document.body.classList.toggle("side-open", open);
  document.body.classList.toggle("paused", state.paused);
  sidebar.inert = !open;
  if (open) sidebar.removeAttribute("aria-hidden");
  else sidebar.setAttribute("aria-hidden", "true");
  toggleSidebarButton.hidden = names.length === 0;
  toggleSidebarButton.setAttribute("aria-expanded", String(open));
  toggleSidebarButton.title = open ? "收起监测栏" : "展开监测栏";
  toggleSidebarButton.setAttribute("aria-label", toggleSidebarButton.title);
  const toggleText = toggleSidebarButton.querySelector(".button-text");
  if (toggleText) toggleText.textContent = names.length ? `监测 ${names.length}` : "监测";
  pauseButton.disabled = names.length === 0;
  clearButton.disabled = names.length === 0;
  pauseButton.classList.toggle("active", state.paused);
  pauseButton.setAttribute("aria-pressed", String(state.paused));
  pauseButton.title = state.paused ? "继续（P）" : "暂停（P）";
  pauseButton.setAttribute("aria-label", pauseButton.title);
  pauseButton.replaceChildren(
    icon(state.paused ? "M 4.5 3 L 11 7 L 4.5 11 Z" : "M 5 3.5 V 10.5 M 9 3.5 V 10.5", 12),
    element("span", "button-text", state.paused ? "继续" : "暂停")
  );
  observeCount.textContent = names.length ? `${names.length} 条` : "";
  const shown = shownNames();
  const elsewhere = names.filter((name) => !shown.has(name)).length;
  if (state.paused) {
    sideNote.textContent = "已暂停于 " + clockTime(state.frozen.now) + "，后台仍在接收";
  } else if (elsewhere) {
    sideNote.textContent = `其中 ${elsewhere} 条不在当前层级`;
  } else {
    sideNote.textContent = `悬停曲线可对齐同一时刻 · 窗口 ${state.windowSeconds} 秒`;
  }
  sideNote.classList.toggle("paused", state.paused);
  document.querySelectorAll("[data-window]").forEach((button) => {
    button.setAttribute("aria-pressed", String(Number(button.dataset.window) === state.windowSeconds));
  });
  updateMetrics();
}

function createCard(name, kind) {
  const el = element("article", "card");
  el.dataset.name = name;
  const head = element("header", "card-head");
  const dot = element("i", "card-dot");
  const title = element("h3", "card-title");
  const remove = element("button", "card-remove icon-button");
  remove.type = "button";
  remove.title = "移除";
  remove.setAttribute("aria-label", "移除这条数据");
  remove.append(icon("M 3.5 3.5 L 10.5 10.5 M 10.5 3.5 L 3.5 10.5", 12));
  remove.addEventListener("click", () => {
    state.focusKey = "";
    toggleObserve(name);
    requestAnimationFrame(() => {
      if (state.observed.size) {
        document.querySelector(".card-remove")?.focus({ preventScroll: true });
      } else {
        const toggle = document.getElementById("toggle-sidebar");
        if (toggle && !toggle.hidden) toggle.focus({ preventScroll: true });
        else graph.focus({ preventScroll: true });
      }
    });
  });
  head.append(dot, title, remove);
  const meta = element("div", "card-meta");
  const metaName = element("code", "", name);
  const metaDisplay = element("span", "card-display");
  const rate = element("span", "card-rate");
  const age = element("span", "card-age");
  const away = element("span", "card-away", "不在当前层级");
  away.hidden = true;
  meta.append(metaName, metaDisplay, rate, age, away);
  const empty = element("div", "card-empty", "等待数据");
  const body = element("div", "card-body");
  body.hidden = true;
  el.append(head, meta, empty, body);
  el.addEventListener("pointerenter", () => focusFlow(name));
  el.addEventListener("pointerleave", () => focusFlow(null));

  const card = {
    name,
    kind,
    el,
    title,
    metaName,
    metaDisplay,
    rate,
    age,
    away,
    empty,
    body,
    chartWidth: 0,
  };

  if (kind === "curve" || kind === "number") {
    const readout = element("div", "readout");
    const values = element("div", "readout-values");
    const time = element("span", "readout-time");
    readout.append(values, time);
    const chart = element("canvas", kind === "curve" ? "chart" : "chart small");
    chart.setAttribute("role", "img");
    chart.setAttribute("aria-label", (flowInfo(name) ? flowLabel(flowInfo(name)) : name) + "最近数据折线图");
    bindHover(chart);
    body.append(readout, chart);
    card.readout = readout;
    card.values = values;
    card.time = time;
    card.canvas = chart;
    card.big = element("div", "big-value");
    card.channels = element("div", "channels");
    card.more = element("div", "channel-more");
    card.channels.hidden = true;
    card.more.hidden = true;
    values.append(card.big, card.channels, card.more);
    card.rows = [];
    if (typeof ResizeObserver === "function") {
      card.resizeObserver = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect?.width || 0;
        if (Math.abs(width - card.chartWidth) > 1) {
          card.chartWidth = width;
          scheduleCards();
        }
      });
      card.resizeObserver.observe(chart);
    }
    card.stats = element("div", "card-stats");
    card.stats.hidden = true;
    body.append(card.stats);
    card.statMin = element("span", "stat");
    card.statAvg = element("span", "stat");
    card.statMax = element("span", "stat");
    card.stats.append(
      card.statMin,
      card.statAvg,
      card.statMax
    );
  } else {
    const list = element("ol", "entries");
    body.append(list);
    card.list = list;
    card.entryRows = [];
    for (let i = 0; i < 5; i++) {
      const row = element("li", "entry");
      const time = element("time");
      const value = element("span", "entry-value");
      row.append(time, value);
      row.hidden = true;
      list.append(row);
      card.entryRows.push({ row, time, value });
    }
  }
  return card;
}

function rebuildCards() {
  const names = [...state.observed.keys()];
  const shown = shownNames();
  for (const [name, card] of cards) {
    if (!state.observed.has(name)) {
      card.resizeObserver?.disconnect();
      card.el.remove();
      cards.delete(name);
    }
  }
  names.forEach((name, index) => {
    const flow = flowInfo(name);
    const kind = displayKind(flow?.display);
    let card = cards.get(name);
    if (!card || card.kind !== kind) {
      card?.resizeObserver?.disconnect();
      card?.el.remove();
      card = createCard(name, kind);
      cards.set(name, card);
    }
    card.el.style.setProperty("--c", state.observed.get(name));
    card.ariaWindow = state.windowSeconds;
  card.title.replaceChildren(element("span", "", flow ? flowLabel(flow) : name));
    if (flow) card.title.append(element("span", "card-route", `（${moduleName(flow.source)} → ${moduleName(flow.target)}）`));
    card.metaName.textContent = name;
    card.metaDisplay.textContent = ` · ${flow?.display || "文本"} `;
    card.away.hidden = shown.has(name);
    if (card.canvas) {
      card.canvas.setAttribute(
        "aria-label",
        (flow ? flowLabel(flow) : name) + `最近 ${state.windowSeconds} 秒的数据折线图`
      );
    }
    if (cardsEl.children[index] !== card.el) cardsEl.insertBefore(card.el, cardsEl.children[index] || null);
  });
}

function focusFlow(name) {
  for (const seg of state.segments) {
    const related = !name || seg.flows.some((flow) => flow.name === name);
    seg.els.forEach((el) => el.classList.toggle("dim", !related));
  }
}

function bindHover(target) {
  target.addEventListener("pointermove", (event) => {
    const plot = target.plot;
    if (!plot) return;
    const ratio = (event.clientX - target.getBoundingClientRect().left - plot.left) / (plot.right - plot.left);
    setHover(ratio < 0 || ratio > 1 ? null : (ratio - 1) * state.windowSeconds);
  });
  target.addEventListener("pointerleave", () => setHover(null));
}

function setHover(offset) {
  if (state.hoverOffset === offset) return;
  state.hoverOffset = offset;
  scheduleCards();
}

function scheduleCards() {
  if (cardFrame) return;
  cardFrame = requestAnimationFrame(() => {
    cardFrame = 0;
    renderCards();
  });
}

function viewNow() {
  return state.paused && state.frozen ? state.frozen.now : Date.now() / 1000;
}

function pointsFor(name) {
  if (state.paused && state.frozen) {
    const frozen = state.frozen.cache.get(name);
    if (frozen) return frozen;
    return (live.cache.get(name) || []).filter((point) => point[0] <= state.frozen.now);
  }
  return live.cache.get(name) || [];
}

function shortText(value, limit = 240) {
  const text = formatValue(value);
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

function updateEntries(card, points) {
  const latest = points.slice(-5).reverse();
  card.entryRows.forEach((rowData, index) => {
    const point = latest[index];
    if (!point) {
      rowData.row.hidden = true;
      return;
    }
    rowData.row.hidden = false;
    rowData.time.textContent = clockTime(point[0], true);
    rowData.value.textContent = shortText(point[1]);
  });
}

function renderValues(card, value, color) {
  const isArray = Array.isArray(value);
  if (!isArray) {
    card.channels.hidden = true;
    card.more.hidden = true;
    card.big.hidden = false;
    card.big.textContent = value === null ? "—" : shortText(value, 500);
    card.big.classList.toggle("raw", value !== null && typeof value !== "number");
    return;
  }
  card.big.hidden = true;
  card.channels.hidden = false;
  const items = value.slice(0, CHANNEL_LIMIT);
  while (card.rows.length < items.length) {
    const row = element("div", "channel");
    const swatch = element("i");
    const index = element("span", "channel-index");
    const channelValue = element("span", "channel-value");
    row.append(swatch, index, channelValue);
    card.channels.append(row);
    card.rows.push({ row, swatch, index, channelValue });
  }
  card.rows.forEach((rowData, index) => {
    if (index >= items.length) {
      rowData.row.hidden = true;
      return;
    }
    rowData.row.hidden = false;
    rowData.swatch.style.background = shade(color, index, theme);
    rowData.index.textContent = `[${index}]`;
    rowData.channelValue.textContent = formatValue(items[index]);
  });
  if (value.length > CHANNEL_LIMIT) {
    card.more.hidden = false;
    card.more.textContent = `+${value.length - CHANNEL_LIMIT} 个通道未显示`;
  } else if (!value.length) {
    card.more.hidden = false;
    card.more.textContent = "空数组";
  } else {
    card.more.hidden = true;
  }
}

function updateCardStats(card, stats) {
  if (!card.stats) return;
  if (!stats || stats.count === 0) {
    card.stats.hidden = true;
    return;
  }
  card.stats.hidden = false;
  card.statMin.textContent = `最小 ${formatValue(stats.min)}`;
  card.statAvg.textContent = `平均 ${formatValue(stats.avg)}`;
  card.statMax.textContent = `最大 ${formatValue(stats.max)}`;
}

function renderCards() {
  if (!cards.size || document.hidden || !state.sidebarOpen) return;
  const now = viewNow();
  const hover = state.hoverOffset === null ? null : now + state.hoverOffset;
  let observedRate = 0;
  for (const [name, card] of cards) {
    const color = state.observed.get(name);
    const all = pointsFor(name);
    const start = now - state.windowSeconds;
    const points = all.filter((point) => point[0] >= start && point[0] <= now);
    const latest = points.length ? points[points.length - 1] : null;
    const rate = rateOf(all, now, Math.min(2, state.windowSeconds));
    observedRate += rate;
    card.rate.hidden = rate <= 0;
    card.rate.textContent = rate > 0 ? "· " + formatRate(rate) + " " : "";
    card.age.hidden = !latest;
    card.age.textContent = latest ? "· " + formatAge(now - latest[0]) + " 前" : "";
    card.empty.hidden = points.length > 0;
    card.body.hidden = points.length === 0;
    if (!points.length) {
      updateCardStats(card, null);
      continue;
    }
    if (card.kind === "text") {
      updateEntries(card, points);
      continue;
    }
    const sample = hover === null ? latest : sampleAt(points, hover);
    card.readout.classList.toggle("hovering", hover !== null);
    card.time.textContent = hover === null ? "最新 " + clockTime(latest[0], true) : clockTime(hover, true);
    renderValues(card, sample ? sample[1] : null, color);
    const numeric = points.some(([, value]) =>
      (Array.isArray(value) ? value : [value]).some((item) => typeof item === "number" && Number.isFinite(item))
    );
    card.canvas.hidden = card.kind === "number" && !numeric;
    if (card.ariaWindow !== state.windowSeconds) {
      card.ariaWindow = state.windowSeconds;
      card.canvas.setAttribute(
        "aria-label",
        (flowInfo(name) ? flowLabel(flowInfo(name)) : name) + `最近 ${state.windowSeconds} 秒的数据折线图`
      );
    }
    if (!card.canvas.hidden) {
      const width = card.chartWidth || card.canvas.clientWidth;
      if (width > 0) {
        card.chartWidth = width;
        const stats = drawChart(
          card.canvas,
          points,
          now,
          color,
          card.kind === "curve"
            ? { height: CHART_CURVE_H, axes: true, hover, width }
            : { height: CHART_SMALL_H, axes: false, hover, width }
        );
        updateCardStats(card, stats);
      }
    } else {
      updateCardStats(card, null);
    }
  }
  state.observedRate = observedRate;
}

/* ---------- 图表 ---------- */

function drawChart(target, points, now, color, { height, axes, hover, width }) {
  const context = target.getContext("2d");
  if (!context || width <= 0) return null;
  const ratio = window.devicePixelRatio || 1;
  const pixelWidth = Math.max(1, Math.round(width * ratio));
  const pixelHeight = Math.max(1, Math.round(height * ratio));
  if (target.width !== pixelWidth) target.width = pixelWidth;
  if (target.height !== pixelHeight) target.height = pixelHeight;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  let minimum = Infinity;
  let maximum = -Infinity;
  let dataMinimum = null;
  let dataMaximum = null;
  let sum = 0;
  let count = 0;
  let channels = 0;
  const samples = points.map(([timestamp, value]) => {
    const values = Array.isArray(value) ? value.slice(0, CHANNEL_LIMIT) : [value];
    channels = Math.max(channels, values.length);
    for (const number of values) {
      if (typeof number !== "number" || !Number.isFinite(number)) continue;
      minimum = Math.min(minimum, number);
      maximum = Math.max(maximum, number);
      if (dataMinimum === null || number < dataMinimum) dataMinimum = number;
      if (dataMaximum === null || number > dataMaximum) dataMaximum = number;
      sum += number;
      count++;
    }
    return { timestamp, values };
  });

  const left = axes ? CHART_LEFT : 2;
  const right = width - (axes ? 6 : 2);
  const top = axes ? 8 : 5;
  const bottom = height - (axes ? 21 : 5);
  target.plot = { left, right };
  if (minimum === Infinity) {
    if (axes) {
      context.font = `11px ${theme.font}`;
      context.fillStyle = theme.chartAxis;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText("非数值数据，无法绘制曲线", width / 2, height / 2);
    }
    return null;
  }

  if (minimum === maximum) {
    const padding = Math.max(Math.abs(minimum) * 0.05, 0.000001);
    minimum = Math.max(-Number.MAX_VALUE, minimum - padding);
    maximum = Math.min(Number.MAX_VALUE, maximum + padding);
  } else {
    const padding = maximum * 0.08 - minimum * 0.08;
    minimum = Math.max(-Number.MAX_VALUE, minimum - padding);
    maximum = Math.min(Number.MAX_VALUE, maximum + padding);
  }

  const plotWidth = Math.max(1, right - left);
  const plotHeight = bottom - top;
  if (axes) {
    const axisValue = (number) => signedValue(String(Number(number.toPrecision(3))));
    const middleValue = minimum < 0 && maximum > 0 ? 0 : minimum / 2 + maximum / 2;
    const ticks = [[top, maximum], [(top + bottom) / 2, middleValue], [bottom, minimum]];
    context.lineWidth = 1;
    context.strokeStyle = theme.chartGrid;
    context.font = `10px ${theme.mono}`;
    context.fillStyle = theme.chartAxis;
    context.textAlign = "right";
    context.textBaseline = "middle";
    for (const [y, value] of ticks) {
      const crisp = Math.round(y) + 0.5;
      context.beginPath();
      context.moveTo(left, crisp);
      context.lineTo(right, crisp);
      context.stroke();
      context.fillText(axisValue(value), left - 7, y);
    }
    context.font = `10px ${theme.font}`;
    context.textBaseline = "alphabetic";
    context.textAlign = "left";
    context.fillText(`${state.windowSeconds} 秒前`, left, height - 5);
    context.textAlign = "center";
    context.fillText(`${state.windowSeconds / 2} 秒前`, left + plotWidth / 2, height - 5);
    context.textAlign = "right";
    context.fillText("现在", right, height - 5);
  }

  const magnitude = Math.max(Math.abs(minimum), Math.abs(maximum), Number.MIN_VALUE);
  const lower = minimum / magnitude;
  const range = maximum / magnitude - lower;
  const toX = (timestamp) => left + ((timestamp - (now - state.windowSeconds)) / state.windowSeconds) * plotWidth;
  const toY = (value) => bottom - (range ? (value / magnitude - lower) / range : 0.5) * plotHeight;
  const maxPoints = Math.max(80, Math.floor(plotWidth * 2));
  const stride = Math.max(1, Math.ceil(samples.length / maxPoints));
  const drawn = samples.filter((_, index) => index % stride === 0 || index === samples.length - 1);
  const ends = [];

  context.save();
  context.beginPath();
  context.rect(left, top - 3, plotWidth, plotHeight + 6);
  context.clip();
  for (let channel = 0; channel < channels; channel++) {
    context.strokeStyle = shade(color, channel, theme);
    context.lineWidth = axes ? 1.6 : 1.4;
    context.lineJoin = "round";
    context.lineCap = "round";
    let connected = false;
    let last = null;
    context.beginPath();
    for (const sample of drawn) {
      const value = sample.values[channel];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        connected = false;
        continue;
      }
      const x = toX(sample.timestamp);
      const y = toY(value);
      if (connected) context.lineTo(x, y);
      else context.moveTo(x, y);
      connected = true;
      last = [x, y];
    }
    context.stroke();
    if (last) ends.push([last, shade(color, channel, theme)]);
  }
  context.restore();

  const dot = (x, y, fill, radius) => {
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = fill;
    context.strokeStyle = theme.chartDot;
    context.lineWidth = 1.5;
    context.fill();
    context.stroke();
  };

  if (hover !== null && hover >= now - state.windowSeconds && hover <= now) {
    const x = Math.round(toX(hover)) + 0.5;
    context.strokeStyle = theme.ink;
    context.globalAlpha = 0.28;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, top - 3);
    context.lineTo(x, bottom + 3);
    context.stroke();
    context.globalAlpha = 1;
    const sample = sampleAt(points, hover);
    const values = sample ? (Array.isArray(sample[1]) ? sample[1].slice(0, CHANNEL_LIMIT) : [sample[1]]) : [];
    values.forEach((value, channel) => {
      if (typeof value === "number" && Number.isFinite(value)) {
        dot(toX(sample[0]), toY(value), shade(color, channel, theme), axes ? 3 : 2.4);
      }
    });
  } else {
    ends.forEach(([[x, y], fill]) => dot(x, y, fill, axes ? 2.8 : 2.2));
  }

  return {
    min: dataMinimum,
    max: dataMaximum,
    avg: count ? sum / count : 0,
    count,
  };
}

function signedValue(text) {
  return text.replace(/^-/, "−");
}

/* ---------- 图上读数 ---------- */

function updateNodeStates(now) {
  for (const [id, group] of state.nodeElements) {
    const node = state.view?.nodes.get(id);
    if (!node) continue;
    const flowNames = node.flowNames || [];
    const live = flowNames.some((name) => flowIsLive(name, now));
    group.classList.toggle("live", live);
    group.classList.toggle("idle", !live && flowNames.length > 0);
    const stateCircle = group.querySelector(".node-state");
    if (stateCircle) {
      const title = stateCircle.querySelector("title") || svgElement("title");
      title.textContent = live ? "实时数据" : flowNames.length ? "暂无实时数据" : "没有实时数据流";
      if (!title.parentNode) stateCircle.append(title);
    }
  }
}

function flowIsLive(name, now) {
  const names = state.paused && state.frozen?.names ? state.frozen.names : state.names;
  const timestamp = names.get(name);
  return Number.isFinite(timestamp) && now - timestamp >= 0 && now - timestamp <= ACTIVE_SECONDS;
}

function flowAnimation(period) {
  if (!flowPeriods.has(period)) {
    flowPeriods.add(period);
    flowStyle.textContent += `@keyframes pipe-flow-${period}{to{stroke-dashoffset:-${period}px}}`;
  }
  return `pipe-flow-${period} ${(period / FLOW_SPEED).toFixed(2)}s steps(6, end) infinite`;
}

function updateSegments() {
  const now = viewNow();
  for (const seg of state.segments) {
    const names = unique(seg.flows.map((flow) => flow.name));
    const liveNames = names.filter((name) => flowIsLive(name, now));
    const watched = names.filter((name) => state.observed.has(name));
    const wiresLive = watched.some((name) => liveNames.includes(name));
    const dotsLive = liveNames.some((name) => !state.observed.has(name));
    seg.outline.classList.toggle("live", liveNames.length > 0);
    seg.jointOutline?.classList.toggle("live", liveNames.length > 0);
    seg.label?.classList.toggle("live", liveNames.length > 0);
    const signature = [watched.map((name) => state.observed.get(name)).join(), wiresLive, dotsLive, state.paused].join("|");
    if (signature === seg.signature) continue;
    seg.signature = signature;
    seg.wires.replaceChildren();
    seg.dots.replaceChildren();
    const wireWidth = Math.max(2.4, Math.min(5, seg.width * 0.4));
    const unit = wiresLive ? 14 : 12;
    const dash = wiresLive ? 10 : 12;
    const period = Math.max(1, watched.length * unit);
    watched.forEach((name, i) => {
      const path = svgElement("path", {
        class: "pipe-wire",
        d: seg.flowPath,
        stroke: state.observed.get(name),
        "stroke-width": wireWidth,
      });
      if (watched.length > 1 || wiresLive) {
        path.setAttribute("stroke-dasharray", `0 ${i * unit} ${dash} ${period - i * unit - dash}`);
      }
      if (wiresLive && !state.paused && seg.kind !== "trunk") path.style.animation = flowAnimation(period);
      seg.wires.append(path);
    });
    if (dotsLive) {
      const path = svgElement("path", {
        class: "pipe-dots",
        d: seg.flowPath,
        "stroke-width": 3,
        "stroke-dasharray": `0 ${DOT_GAP}`,
      });
      if (!state.paused && seg.kind !== "trunk") {
        path.style.animation = flowAnimation(DOT_GAP);
        path.style.animationDelay = `-${(DOT_GAP / 2 / FLOW_SPEED).toFixed(3)}s`;
      }
      seg.dots.append(path);
    }
  }
  updateNodeStates(now);
}

function drawSpark(readout, points, start) {
  const left = 68;
  const top = 4;
  const width = 30;
  const height = 12;
  const step = Math.max(1, Math.ceil(points.length / 60));
  const sampled = points.filter((_, index) => index % step === 0 || index === points.length - 1);
  let minimum = Infinity;
  let maximum = -Infinity;
  let channels = 0;
  for (const [, value] of sampled) {
    const values = Array.isArray(value) ? value.slice(0, CHANNEL_LIMIT) : [value];
    channels = Math.max(channels, values.length);
    for (const number of values) {
      if (typeof number !== "number" || !Number.isFinite(number)) continue;
      minimum = Math.min(minimum, number);
      maximum = Math.max(maximum, number);
    }
  }
  if (minimum === Infinity) channels = 0;
  const magnitude = Math.max(Math.abs(minimum), Math.abs(maximum), Number.MIN_VALUE);
  const lower = minimum === Infinity ? 0 : minimum / magnitude;
  const range = minimum === Infinity ? 0 : maximum / magnitude - lower;
  while (readout.lines.length < channels) {
    const line = svgElement("polyline", { class: "spark", stroke: shade(readout.color, readout.lines.length, theme) });
    readout.spark.append(line);
    readout.lines.push(line);
  }
  readout.lines.forEach((line, channel) => {
    if (channel >= channels) {
      line.setAttribute("points", "");
      return;
    }
    const coords = [];
    for (const [timestamp, value] of sampled) {
      const number = Array.isArray(value) ? value[channel] : value;
      if (typeof number !== "number" || !Number.isFinite(number)) continue;
      const x = left + ((timestamp - start) / state.windowSeconds) * width;
      const y = top + height - (range ? (number / magnitude - lower) / range : 0.5) * height;
      coords.push(x.toFixed(1) + "," + y.toFixed(1));
    }
    line.setAttribute("points", coords.join(" "));
  });
}

function readoutNumber(value, digitsOverride = null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return formatValue(value);
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute >= 1e5 || absolute < 1e-3)) return value.toExponential(1).replace("-", "−");
  const digits =
    digitsOverride ?? (absolute >= 1000 ? 1 : absolute >= 100 ? 2 : absolute >= 10 ? 3 : 4);
  const text = value.toFixed(digits).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") || "0";
  return text.replace(/^-/, "−");
}

function readoutText(value, kind) {
  if (kind === "text") return formatValue(value);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    const first = readoutNumber(value[0], 3);
    return value.length > 1 ? `${first} +${value.length - 1}` : first;
  }
  return readoutNumber(value);
}

function updateReadouts() {
  if (!state.readouts.length || document.hidden) return;
  const now = viewNow();
  const start = now - state.windowSeconds;
  for (const readout of state.readouts) {
    const points = pointsFor(readout.name).filter((point) => point[0] >= start && point[0] <= now);
    readout.value.classList.toggle("waiting", !points.length);
    if (!points.length) {
      readout.value.textContent = "—";
      readout.title.textContent = readout.label + "：等待数据";
      readout.lines.forEach((line) => line.setAttribute("points", ""));
      continue;
    }
    const latest = points[points.length - 1][1];
    const text = readoutText(latest, readout.kind);
    readout.value.textContent = truncate(
      text,
      readout.valueWidth,
      11,
      400,
      readout.kind === "text" ? theme.font : theme.mono
    );
    readout.title.textContent = `${readout.label}：${shortText(latest, 200)}`;
    if (readout.spark) drawSpark(readout, points, start);
  }
}

/* ---------- 数据获取 ---------- */

async function pollData() {
  if (document.hidden || !shouldRetry()) return;
  const names = [...state.observed.keys()].sort();
  if (!names.length || live.controller) return;
  const key = JSON.stringify(names);
  if (key !== live.namesKey) {
    let known = new Set();
    try {
      const parsed = live.namesKey ? JSON.parse(live.namesKey) : [];
      known = new Set(Array.isArray(parsed) ? parsed : []);
    } catch {
      known = new Set();
    }
    if (names.some((name) => !known.has(name))) live.since = null;
    live.namesKey = key;
  }
  const controller = new AbortController();
  live.controller = controller;
  const timeout = setTimeout(() => controller.abort(), 5000);
  const query = new URLSearchParams();
  names.forEach((name) => query.append("names", name));
  if (live.since !== null) query.set("since", String(live.since));
  try {
    const response = await fetch("/data?" + query.toString(), { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const now = Date.now() / 1000;
    const cutoff = now - state.windowSeconds;
    let maximum = null;
    for (const name of names) {
      if (!state.observed.has(name)) continue;
      if (!Object.prototype.hasOwnProperty.call(payload, name) || !Array.isArray(payload[name])) continue;
      const points = live.cache.get(name) || [];
      const previous = live.lastTs.has(name) ? live.lastTs.get(name) : -Infinity;
      let last = previous;
      for (const point of payload[name]) {
        if (!Array.isArray(point) || point.length !== 2) continue;
        if (typeof point[0] !== "number" || !Number.isFinite(point[0])) continue;
        // 未来时间戳只可能是时钟异常，不参与 since，避免整页停更。
        if (point[0] > now + 1.0) {
          state.dataDrops++;
          continue;
        }
        if (maximum === null || point[0] > maximum) maximum = point[0];
        if (point[0] >= cutoff && point[0] > previous) {
          points.push([point[0], point[1]]);
          last = Math.max(last, point[0]);
        }
      }
      points.sort((a, b) => a[0] - b[0]);
      live.cache.set(name, points);
      if (last > -Infinity) live.lastTs.set(name, last);
    }
    if (live.namesKey === key) {
      if (maximum !== null) live.since = Math.max(0, maximum - SINCE_OVERLAP_SECONDS);
      else if (live.since === null) live.since = Math.max(0, now - state.windowSeconds);
    }
    noteOnline();
    if (state.dataError) {
      state.dataError = "";
      updateStatus();
      updateDiagnostics();
    }
  } catch (error) {
    noteOffline();
    const message = errorMessage(error);
    if (state.dataError !== message) {
      state.dataError = message;
      updateStatus();
      updateDiagnostics();
    }
  } finally {
    clearTimeout(timeout);
    if (live.controller === controller) live.controller = null;
  }
}

function pruneCache() {
  const cutoff = Date.now() / 1000 - state.windowSeconds;
  for (const [name, points] of live.cache) {
    if (!state.observed.has(name)) {
      live.cache.delete(name);
      continue;
    }
    const recent = points.filter((point) => point[0] >= cutoff);
    if (recent.length) live.cache.set(name, recent);
    else live.cache.delete(name);
  }
}

async function request(path, asJson) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(path, { cache: "no-store", signal: controller.signal });
    if (!response.ok) {
      throw new Error(response.status === 404 ? "文件或接口不存在（404）" : "HTTP " + response.status);
    }
    return await (asJson ? response.json() : response.text());
  } finally {
    clearTimeout(timeout);
  }
}

function errorMessage(error) {
  return error.name === "AbortError" ? "请求超时，将自动重试" : error.message || "请求失败，将自动重试";
}

async function loadModules() {
  if (state.modulePending || !shouldRetry()) return;
  state.modulePending = true;
  try {
    const text = await request("/module.md", false);
    noteOnline();
    state.moduleError = "";
    if (text !== state.text) {
      const first = state.text === null;
      const model = parseMarkdown(text);
      state.model = model;
      state.text = text;
      if (first) {
        const target = hashLevel();
        if (target && model.modules.has(target)) state.level = target;
        else if (target) replaceRoute("");
        restoreObserved(model);
      } else {
        pruneObserved(model);
      }
      const hadLevel = !!state.level;
      while (state.level && !model.modules.has(state.level)) state.level = parentId(state.level);
      if (hadLevel) replaceRoute(state.level);
      document.title = model.title + " · 实时监测";
      render(first ? "fade" : "");
      updateDiagnostics();
    }
  } catch (error) {
    state.moduleError = errorMessage(error);
    if (state.text === null) render();
    updateStatus();
    updateDiagnostics();
  } finally {
    state.modulePending = false;
    updateStatus();
  }
}

async function loadNames() {
  if (state.namesPending || !shouldRetry()) return;
  state.namesPending = true;
  try {
    const names = await request("/names", true);
    noteOnline();
    if (!names || typeof names !== "object" || Array.isArray(names)) throw new Error("返回格式不正确");
    state.names = new Map(
      Object.entries(names).filter(([, timestamp]) => typeof timestamp === "number" && Number.isFinite(timestamp))
    );
    state.namesLoaded = true;
    if (state.namesError) {
      state.namesError = "";
      updateDiagnostics();
    }
    updateSegments();
    updateStatus();
    updateDiagnostics();
  } catch (error) {
    noteOffline();
    const message = errorMessage(error);
    if (state.namesError !== message) {
      state.namesError = message;
      updateDiagnostics();
    }
    updateStatus();
  } finally {
    state.namesPending = false;
  }
}

async function loadStats() {
  if (state.statsPending || !shouldRetry()) return;
  state.statsPending = true;
  try {
    const stats = await request("/stats", true);
    noteOnline();
    if (!stats || typeof stats !== "object" || Array.isArray(stats)) throw new Error("返回格式不正确");
    const now = Date.now() / 1000;
    if (state.lastStatsSample && stats.packets >= state.lastStatsSample.packets) {
      const deltaPackets = stats.packets - state.lastStatsSample.packets;
      const deltaTime = Math.max(0.001, now - state.lastStatsSample.at);
      const instant = deltaPackets / deltaTime;
      state.statsRate = state.statsRate ? state.statsRate * 0.55 + instant * 0.45 : instant;
    } else {
      state.statsRate = 0;
    }
    state.lastStatsSample = { packets: stats.packets, at: now };
    const hadError = !!state.statsError;
    state.stats = stats;
    state.statsError = "";
    updateStatus();
    updateMetrics();
    if (hadError) updateDiagnostics();
  } catch (error) {
    const message = errorMessage(error);
    if (state.statsError !== message) {
      state.statsError = message;
      updateDiagnostics();
    }
  } finally {
    state.statsPending = false;
  }
}

/* ---------- 状态与诊断 ---------- */

function clientLatest() {
  let latest = null;
  for (const name of state.observed.keys()) {
    const points = pointsFor(name);
    if (!points.length) continue;
    const timestamp = points[points.length - 1][0];
    if (latest === null || timestamp > latest) latest = timestamp;
  }
  return latest;
}

function packetAge() {
  const now = viewNow();
  const latest = clientLatest();
  if (latest !== null) return Math.max(0, now - latest);
  if (state.stats?.last_packet && !state.paused) return Math.max(0, now - state.stats.last_packet);
  return null;
}

function updateMetrics() {
  const offline = !!(state.namesError || state.dataError || state.stats?.receiver_alive === false);
  let rate = state.statsRate || 0;
  if (offline) rate = 0;
  else if (state.statsError && !state.observedRate) rate = 0;
  else rate = rate || state.observedRate || 0;
  const age = packetAge();
  const rateText = rate > 0 ? formatRate(rate) : "—";
  const ageText = age === null ? "—" : formatAge(age) + " 前";
  const signature = rateText + "|" + ageText;
  if (signature === state.metricsSignature) return;
  state.metricsSignature = signature;
  metricRate.textContent = rateText;
  metricAge.textContent = ageText;
}

function updateStatus() {
  const messages = [];
  if (state.moduleError) messages.push("模块说明：" + state.moduleError);
  if (state.namesError) messages.push("数据连接：" + state.namesError);
  if (state.dataError) messages.push("数据读取：" + state.dataError);
  if (state.stats?.receiver_alive === false) messages.push("UDP 接收：" + (state.stats.last_error || "已停止"));
  const modelWarnings = state.model.warnings.filter((warning) => warning.level === "warning").length;
  if (modelWarnings) messages.push(`module.md：${modelWarnings} 条提示`);
  const ready = state.text !== null && state.namesLoaded;
  const age = packetAge();
  let text;
  if (state.moduleError && state.text === null) text = "模块读取失败";
  else if (!ready) text = state.text === null ? "正在读取模块说明…" : "正在连接数据…";
  else if (state.paused) text = "已暂停";
  else if (state.dataError || state.namesError) text = "数据异常";
  else if (state.stats?.receiver_alive === false) text = "UDP 接收停止";
  else if (age !== null && age <= 3) text = "监测中";
  else text = "等待数据";
  const cls =
    messages.length &&
    (state.moduleError ||
      state.namesError ||
      state.dataError ||
      state.stats?.receiver_alive === false ||
      modelWarnings > 0)
      ? "warning"
      : state.paused
        ? "paused"
        : !ready
          ? "pending"
          : age !== null && age <= 3
            ? "ok"
            : "pending";
  const signature = text + "|" + cls + "|" + messages.join("|");
  if (signature === state.statusSignature) return;
  state.statusSignature = signature;
  statusEl.className = "status " + cls;
  statusText.textContent = text;
  statusEl.title = messages.length ? messages.join(" · ") : text;
}

function collectIssues() {
  const issues = [];
  if (state.moduleError) issues.push({ level: "warning", message: "module.md：" + state.moduleError });
  if (state.namesError) issues.push({ level: "warning", message: "数据连接：" + state.namesError });
  if (state.dataError) issues.push({ level: "warning", message: "数据读取：" + state.dataError });
  if (state.statsError) issues.push({ level: "warning", message: "统计接口：" + state.statsError });
  if (state.stats?.receiver_alive === false) {
    issues.push({ level: "warning", message: "UDP 接收线程已停止" + (state.stats.last_error ? "：" + state.stats.last_error : "") });
  }
  if (state.dataDrops) {
    issues.push({ level: "warning", message: `已忽略 ${state.dataDrops} 个未来时间戳采样点` });
  }
  for (const warning of state.model.warnings) {
    if (warning.level === "warning") issues.push(warning);
  }
  return issues;
}

function unmodeledNames() {
  return [...state.names.keys()].filter((name) => !state.model.byName.has(name)).sort();
}

function updateDiagnostics() {
  const issues = collectIssues();
  const hidden = state.model.hiddenFlows.length;
  const invalid = state.model.invalidFlows.length;
  const unmodeled = unmodeledNames().length;
  const total = issues.length + hidden + invalid + unmodeled;
  diagnosticsCount.textContent = total ? String(total) : "";
  diagnosticsButton.classList.toggle("warn", issues.length > 0);
  diagnosticsButton.title = total
    ? `${issues.length} 个问题 · ${hidden} 条非实时流 · ${invalid} 条无效流 · ${unmodeled} 个未声明数据名`
    : "运行状态与诊断";
}

function appendSection(parent, title) {
  const section = element("section", "diag-section");
  section.append(element("h3", "", title));
  parent.append(section);
  return section;
}

function appendKeyValues(parent, entries) {
  const list = element("dl", "diag-list");
  for (const [key, value] of entries) {
    const dt = element("dt", "", key);
    const dd = element("dd", "", value);
    list.append(dt, dd);
  }
  parent.append(list);
}

function openDiagnostics() {
  diagnosticsBody.replaceChildren();
  const issues = collectIssues();
  const server = state.stats;

  const overview = appendSection(diagnosticsBody, "运行状态");
  if (server) {
    appendKeyValues(overview, [
      ["UDP 接收", server.receiver_alive ? "正常" : "已停止"],
      ["收包速率", formatRate(state.statsRate)],
      ["累计收包", String(server.packets ?? "—")],
      ["无效包", String(server.invalid ?? "—")],
      ["时钟校正", String(server.skewed ?? "—")],
      ["缓存点 / 名称", `${server.points ?? "—"} / ${server.names ?? "—"}`],
      ["保留窗口", `${server.retention ?? "—"} 秒`],
      ["运行时长", formatAge(server.uptime)],
      ["最近收包", server.last_packet ? clockTime(server.last_packet, true) : "—"],
      ["UDP 错误", server.last_error || "无"],
    ]);
  } else {
    overview.append(element("p", "diag-muted", state.statsError || "统计接口暂不可用。"));
  }

  const client = appendSection(diagnosticsBody, "客户端");
  const unmodeled = unmodeledNames();
  appendKeyValues(client, [
    ["观测数据", `${state.observed.size} 条`],
    ["时间窗口", `${state.windowSeconds} 秒`],
    ["当前层级", state.level || "顶层"],
    ["未来时间戳丢弃", String(state.dataDrops)],
    ["模块 / 数据流", `${state.model.stats.moduleCount} / ${state.model.stats.realtimeCount}`],
    ["隐藏 / 无效流", `${state.model.stats.hiddenCount} / ${state.model.stats.invalidCount}`],
    ["未声明数据名", String(unmodeled.length)],
  ]);

  const warningSection = appendSection(diagnosticsBody, "提示");
  if (issues.length) {
    const list = element("ul", "diag-warnings");
    issues.forEach((issue) => {
      const row = element("li", "diag-warning");
      row.append(element("span", "diag-line", issue.line ? "L" + issue.line : "·"), element("span", "", issue.message));
      list.append(row);
    });
    warningSection.append(list);
  } else {
    warningSection.append(element("p", "diag-muted", "没有发现异常。"));
  }

  if (unmodeled.length) {
    const unmodeledSection = appendSection(diagnosticsBody, `未在 module.md 中声明的数据名（${unmodeled.length}）`);
    const list = element("ul", "diag-flows");
    unmodeled.slice(0, 50).forEach((name) => {
      const row = element("li", "");
      row.append(element("code", "", name), element("span", "", " 已在 /names 中出现，但没有对应数据流"));
      list.append(row);
    });
    if (unmodeled.length > 50) list.append(element("li", "diag-muted", `还有 ${unmodeled.length - 50} 个…`));
    unmodeledSection.append(list);
  }

  if (state.model.hiddenFlows.length) {
    const hiddenSection = appendSection(diagnosticsBody, `未绘制的非实时流（${state.model.hiddenFlows.length}）`);
    const list = element("ul", "diag-flows");
    state.model.hiddenFlows.forEach((flow) => {
      const row = element("li", "");
      row.append(
        element("code", "", flow.name),
        element("span", "", ` ${flowLabel(flow)} · ${flow.type || "未标注"} · ${moduleName(flow.source)} → ${moduleName(flow.target)}`)
      );
      list.append(row);
    });
    hiddenSection.append(list);
  }

  if (state.model.configOnly.size) {
    const configSection = appendSection(diagnosticsBody, "仅配置数据的模块");
    configSection.append(element("p", "diag-muted", [...state.model.configOnly].map(moduleName).join("、")));
  }

  if (typeof diagnosticsDialog.showModal === "function") {
    if (!diagnosticsDialog.open) diagnosticsDialog.showModal();
  } else {
    diagnosticsDialog.setAttribute("open", "");
  }
  diagnosticsDialog.querySelector(".dialog-close")?.focus({ preventScroll: true });
}

/* ---------- 暂停、窗口与主题 ---------- */

function togglePause() {
  if (!state.observed.size) return;
  state.paused = !state.paused;
  if (state.paused) {
    state.frozen = {
      now: Date.now() / 1000,
      cache: new Map([...live.cache].map(([name, points]) => [name, points.slice()])),
      names: new Map(state.names),
    };
  } else {
    state.frozen = null;
    state.hoverOffset = null;
  }
  updateSidebar();
  updateSegments();
  updateReadouts();
  renderCards();
  updateStatus();
  updateMetrics();
}

function clearObserved() {
  if (!state.observed.size) return;
  state.observed.clear();
  live.cache.clear();
  live.lastTs.clear();
  resetLiveScan();
  state.paused = false;
  state.frozen = null;
  state.hoverOffset = null;
  state.sidebarOpen = false;
  state.focusKey = "";
  saveObserved();
  render();
  updateMetrics();
  graph.focus({ preventScroll: true });
}

function setWindow(seconds) {
  const value = Number(seconds) === MAX_WINDOW ? MAX_WINDOW : DEFAULT_WINDOW;
  if (value === state.windowSeconds) return;
  state.windowSeconds = value;
  remember(STORE_WINDOW, String(value));
  state.paused = false;
  state.frozen = null;
  state.hoverOffset = null;
  live.cache.clear();
  live.lastTs.clear();
  resetLiveScan();
  noteOnline();
  updateSidebar();
  updateReadouts();
  renderCards();
  pollData();
  updateDiagnostics();
  updateStatus();
}

function closeSidebar() {
  if (!state.sidebarOpen) return;
  state.sidebarOpen = false;
  updateSidebar();
  toggleSidebarButton.focus({ preventScroll: true });
}

function openSidebar() {
  if (!state.observed.size) return;
  state.sidebarOpen = true;
  updateSidebar();
  renderCards();
}

function toggleSidebar() {
  if (state.sidebarOpen) closeSidebar();
  else openSidebar();
}

/* ---------- 焦点恢复 ---------- */

function restoreFocus() {
  if (!state.focusKey) return;
  if (document.activeElement !== document.body) return;
  const target = [...graph.querySelectorAll("[data-focus-key]")].find((el) => el.dataset.focusKey === state.focusKey);
  target?.focus({ preventScroll: true });
}

/* ---------- 事件绑定与启动 ---------- */

function bindEvents() {
  document.addEventListener("focusin", (event) => {
    state.focusKey = event.target.closest?.("[data-focus-key]")?.dataset.focusKey || "";
  });
  document.addEventListener("pointerdown", (event) => {
    const keyTarget = event.target.closest?.("[data-focus-key]");
    if (keyTarget) state.focusKey = keyTarget.dataset.focusKey;
    if (state.popover && !popover.contains(event.target)) {
      if (!event.target.closest?.(".node, .pipe-hit, .label-group, .pill")) closePopover();
    }
    if (diagnosticsDialog.open && event.target === diagnosticsDialog) diagnosticsDialog.close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (diagnosticsDialog.open) diagnosticsDialog.close();
      else if (state.popover) closePopover();
    }
    if (diagnosticsDialog.open) return;
    if (event.target instanceof Element && event.target.matches("input, textarea, select")) return;
    if (event.key.toLowerCase() === "p" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      togglePause();
    }
    if (event.key.toLowerCase() === "f" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      resetZoom();
    }
  });
  graph.addEventListener("scroll", positionPopover, { passive: true });
  graph.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12);
    },
    { passive: false }
  );
  window.addEventListener("resize", () => {
    scheduleFit();
    scheduleCards();
  });
  window.addEventListener("popstate", () => {
    const target = hashLevel();
    if (target !== state.level) navigate(target, null, { fromHistory: true });
  });
  window.addEventListener("hashchange", () => {
    const target = hashLevel();
    if (target !== state.level) navigate(target, null, { fromHistory: true });
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      noteOnline();
      resetLiveScan();
      pruneCache();
      pollData();
      loadNames();
      loadStats();
      updateSegments();
      updateReadouts();
      renderCards();
      updateStatus();
    }
  });
  pauseButton.addEventListener("click", togglePause);
  clearButton.addEventListener("click", clearObserved);
  toggleSidebarButton.addEventListener("click", toggleSidebar);
  closeSidebarButton.addEventListener("click", closeSidebar);
  themeButton.addEventListener("click", () => {
    applyTheme(state.theme === "dark" ? "light" : "dark");
  });
  $("zoom-in").addEventListener("click", () => zoomBy(1.12));
  $("zoom-out").addEventListener("click", () => zoomBy(1 / 1.12));
  $("zoom-fit").addEventListener("click", resetZoom);
  document.querySelectorAll("[data-window]").forEach((button) => {
    button.addEventListener("click", () => setWindow(button.dataset.window));
  });
  diagnosticsButton.addEventListener("click", openDiagnostics);
  diagnosticsDialog.querySelector(".dialog-close")?.addEventListener("click", () => diagnosticsDialog.close());
  diagnosticsDialog.addEventListener("click", (event) => {
    if (event.target === diagnosticsDialog) diagnosticsDialog.close();
  });
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => scheduleFit()).observe(graph);
    new ResizeObserver(() => scheduleCards()).observe(cardsEl);
  }
}

function init() {
  globalThis.__P025__ = {
    state,
    live,
    cards,
    theme,
    navigate,
    togglePause,
    setWindow,
    setObservedMany,
    resetZoom,
    zoomBy,
    toggleSidebar,
    openDiagnostics,
    applyTheme,
  };
  const initialTheme =
    stored(STORE_THEME) || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  state.theme = initialTheme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = state.theme;
  const savedWindow = Number(stored(STORE_WINDOW, String(DEFAULT_WINDOW)));
  state.windowSeconds = savedWindow === MAX_WINDOW ? MAX_WINDOW : DEFAULT_WINDOW;
  readTheme();
  updateThemeButton();
  graph.tabIndex = -1;
  bindEvents();
  updateSidebar();
  render();
  loadModules();
  loadNames();
  loadStats();
  setInterval(loadModules, 3000);
  setInterval(() => {
    loadNames();
    updateSegments();
    updateMetrics();
  }, 1000);
  setInterval(loadStats, 2000);
  setInterval(() => {
    if (document.hidden) return;
    pruneCache();
    pollData();
    updateReadouts();
    if (!state.paused || state.hoverOffset !== null) renderCards();
    updateMetrics();
  }, 200);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
