/* 纯逻辑工具：解析 module.md、构建视图、颜色与数字格式化。
 * 不依赖 DOM，可在浏览器和 node --test 中共用。
 */

export const DEFAULT_TITLE = "模块与数据流";

const MODULE_RE = /^###\s+([^\s·•]+)\s*[·•]\s*(.+)$/;
const FLOW_RE = /^-\s+(\S+)\s*->\s*(\S+)\s*:\s*([^|]+)\|([^|]*)\|([^|]*)\|([^|]*)\|(.*)$/;

export const PALETTE_LIGHT = [
  "#3d6b96",
  "#a95a1c",
  "#3b7a3f",
  "#8a4b84",
  "#ad3e3e",
  "#2d7975",
  "#82650f",
  "#654a99",
];

export const PALETTE_DARK = [
  "#81aad3",
  "#e09a5e",
  "#7fc482",
  "#c990c0",
  "#e48787",
  "#5fc5be",
  "#d8b85d",
  "#ae90d8",
];

export function unique(items) {
  return [...new Set(items)];
}

export function parentId(id) {
  const slash = id.lastIndexOf("/");
  return slash < 0 ? "" : id.slice(0, slash);
}

export function childToward(base, target) {
  const rest = base ? target.slice(base.length + 1) : target;
  return (base ? base + "/" : "") + rest.split("/")[0];
}

function warning(warnings, message, line) {
  warnings.push({ level: "warning", message, line });
}

function info(warnings, message, line) {
  warnings.push({ level: "info", message, line });
}

/**
 * 解析手写的 module.md。
 *
 * 返回 modules/children/flows（所有合法 flow）、byName、realtimeFlows、
 * hiddenFlows、configOnly 以及 warnings。代码块中的示例不会被误解析。
 */
export function parseMarkdown(text) {
  const modules = new Map();
  const children = new Map();
  const flows = [];
  const warnings = [];
  let title = DEFAULT_TITLE;
  let current = null;
  let fence = null;

  const lines = String(text).split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    const lineNumber = index + 1;

    const fenceMatch = line.match(/^(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      if (!fence) {
        fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      } else if (
        fenceMatch[1][0] === fence.marker &&
        fenceMatch[1].length >= fence.length
      ) {
        fence = null;
      }
      return;
    }
    if (fence) return;

    const projectMatch = line.match(/^#\s+(.+)$/);
    if (projectMatch && title === DEFAULT_TITLE) {
      title = projectMatch[1].trim();
      current = null;
      return;
    }

    const moduleMatch = line.match(MODULE_RE);
    if (moduleMatch) {
      const id = moduleMatch[1];
      const name = moduleMatch[2].trim();
      if (modules.has(id)) {
        warning(warnings, `重复的模块 id：${id}`, lineNumber);
        current = null;
        return;
      }
      current = {
        id,
        name,
        summary: "",
        detail: "",
        order: modules.size,
      };
      modules.set(id, current);
      return;
    }

    const flowMatch = line.match(FLOW_RE);
    if (flowMatch) {
      const [, source, target, name, label, display, type, detail] = flowMatch;
      const flow = {
        source,
        target,
        name: name.trim(),
        label: label.trim(),
        display: display.trim(),
        type: type.trim(),
        detail: detail.trim(),
        line: lineNumber,
      };
      if (!flow.name) {
        warning(warnings, "数据流缺少名称，已忽略", lineNumber);
        return;
      }
      flows.push(flow);
      return;
    }

    if (/^-\s+/.test(line) && line.includes("->")) {
      warning(warnings, "数据流格式无法解析，已忽略", lineNumber);
      return;
    }

    if (/^#{1,6}\s/.test(line)) {
      current = null;
      return;
    }
    if (!current) return;
    if (/^概要[：:]/.test(line)) {
      current.summary = line.replace(/^概要[：:]\s*/, "");
      return;
    }
    if (/^详细[：:]/.test(line)) {
      current.detail = line.replace(/^详细[：:]\s*/, "");
    }
  });

  if (fence) warning(warnings, "代码块没有闭合");

  // 建立层级；父模块未声明时给出提示。
  for (const module of modules.values()) {
    const parent = parentId(module.id);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(module.id);
    if (parent && !modules.has(parent)) {
      warning(warnings, `模块 ${module.id} 的父模块 ${parent} 未声明，可能无法显示`);
    }
  }

  // 校验 flow 端点、自环与类型。
  const validFlows = [];
  const invalidFlows = [];
  const hiddenFlows = [];
  const realtimeModules = new Set();
  const configModules = new Set();
  const byName = new Map();

  for (const flow of flows) {
    if (!modules.has(flow.source) || !modules.has(flow.target)) {
      const missing = [flow.source, flow.target].filter((id) => !modules.has(id));
      warning(warnings, `数据流 ${flow.source} -> ${flow.target} 引用了未声明模块：${missing.join("、")}`, flow.line);
      invalidFlows.push(flow);
      continue;
    }
    if (flow.source === flow.target) {
      warning(warnings, `数据流 ${flow.name} 自环，监测图中不会显示`, flow.line);
      invalidFlows.push(flow);
      continue;
    }
    const realtime = flow.type === "实时";
    flow.realtime = realtime;
    if (!realtime) {
      hiddenFlows.push(flow);
      configModules.add(flow.source);
      configModules.add(flow.target);
    } else {
      realtimeModules.add(flow.source);
      realtimeModules.add(flow.target);
    }
    if (!flow.display) {
      warning(warnings, `数据流 ${flow.name} 缺少显示方式，按文本处理`, flow.line);
    }
    if (!flow.type) {
      warning(warnings, `数据流 ${flow.name} 缺少类型，按非实时处理`, flow.line);
    }
    validFlows.push(flow);
    const existing = byName.get(flow.name);
    if (!existing || (!existing.realtime && flow.realtime)) byName.set(flow.name, flow);
  }

  const configOnly = new Set(
    [...configModules].filter((id) => !realtimeModules.has(id) && modules.has(id))
  );

  if (!modules.size) {
    info(warnings, "module.md 中没有找到 ### 模块定义");
  }
  if (hiddenFlows.length) {
    info(warnings, `有 ${hiddenFlows.length} 条非实时数据流未绘制（配置/文件类）`);
  }

  return {
    title,
    modules,
    children,
    flows: validFlows,
    realtimeFlows: validFlows.filter((flow) => flow.realtime),
    hiddenFlows,
    invalidFlows,
    byName,
    configOnly,
    warnings,
    stats: {
      moduleCount: modules.size,
      flowCount: validFlows.length,
      realtimeCount: validFlows.filter((flow) => flow.realtime).length,
      hiddenCount: hiddenFlows.length,
      invalidCount: invalidFlows.length,
    },
  };
}

/**
 * 按当前层级把真实的实时数据流折叠成“模块对 + 外部入口/出口”。
 * 只依赖 model 和 level，方便单测。
 */
export function buildView(model, level) {
  const framed = !!level;
  const visibleIds = model.children.get(level) || [];
  const visible = new Set(visibleIds);
  const nodes = new Map();
  for (const id of visibleIds) {
    const module = model.modules.get(id);
    if (module) nodes.set(id, { id, module });
  }

  function mapEndpoint(id) {
    if (!model.modules.has(id)) return null;
    if (!level) {
      const top = id.split("/")[0];
      return visible.has(top) ? { id: top, external: false } : null;
    }
    const prefix = level + "/";
    if (id.startsWith(prefix)) {
      const child = prefix + id.slice(prefix.length).split("/")[0];
      return visible.has(child) ? { id: child, external: false } : null;
    }
    // 外部端点折叠到与当前路径分叉处的祖先，避免把整棵外部子树画进来。
    const outside = id.split("/");
    const inside = level.split("/");
    let common = 0;
    while (common < outside.length && common < inside.length && outside[common] === inside[common]) {
      common++;
    }
    let representative = outside.slice(0, Math.min(common + 1, outside.length)).join("/");
    while (representative && !model.modules.has(representative)) representative = parentId(representative);
    return representative ? { id: representative, external: true } : null;
  }

  const pairs = new Map();
  const extIn = new Map();
  const extOut = new Map();
  for (const flow of model.realtimeFlows) {
    const source = mapEndpoint(flow.source);
    const target = mapEndpoint(flow.target);
    if (!source || !target || source.id === target.id) continue;
    if (source.external && target.external) continue;
    let sourceId = source.id;
    let targetId = target.id;
    if (source.external) {
      if (!extIn.has(source.id)) extIn.set(source.id, []);
      extIn.get(source.id).push(flow);
      sourceId = "@in";
    }
    if (target.external) {
      if (!extOut.has(target.id)) extOut.set(target.id, []);
      extOut.get(target.id).push(flow);
      targetId = "@out";
    }
    const key = JSON.stringify([sourceId, targetId]);
    if (!pairs.has(key)) {
      pairs.set(key, {
        key,
        source: sourceId,
        target: targetId,
        flows: [],
        externals: new Set(),
      });
    }
    const pair = pairs.get(key);
    pair.flows.push(flow);
    if (source.external) pair.externals.add(source.id);
    if (target.external) pair.externals.add(target.id);
  }

  return { framed, level, nodes, visibleIds, pairs: [...pairs.values()], extIn, extOut };
}

/** 拓扑排序；环内优先保留向外流量更大的方向。 */
export function orderVisible(ids, pairs) {
  const internal = pairs.filter((pair) => pair.source !== "@in" && pair.target !== "@out");
  const remaining = new Set(ids);
  const order = [];
  while (remaining.size) {
    let chosen = null;
    let bestScore = -Infinity;
    for (const id of ids) {
      if (!remaining.has(id)) continue;
      let incoming = 0;
      let outgoing = 0;
      for (const pair of internal) {
        if (pair.target === id && remaining.has(pair.source)) incoming += pair.flows.length;
        if (pair.source === id && remaining.has(pair.target)) outgoing += pair.flows.length;
      }
      if (incoming === 0) {
        chosen = id;
        break;
      }
      const score = outgoing - incoming;
      if (score > bestScore) {
        bestScore = score;
        chosen = id;
      }
    }
    if (chosen === null) break;
    order.push(chosen);
    remaining.delete(chosen);
  }
  return order;
}

/** 最长路径分层；独立模块应留在第 0 列。 */
export function assignRanks(order, ids, pairs) {
  const internal = pairs.filter((pair) => pair.source !== "@in" && pair.target !== "@out");
  const ranks = new Map();
  for (const id of order) {
    let rank = 0;
    for (const pair of internal) {
      if (pair.target === id && ranks.has(pair.source)) {
        rank = Math.max(rank, ranks.get(pair.source) + 1);
      }
    }
    ranks.set(id, rank);
  }
  for (const id of ids) {
    if (!ranks.has(id)) ranks.set(id, 0);
  }
  return ranks;
}

export function pipeWidth(count) {
  return Math.min(22, 4 + 3 * count);
}

/** radius 可按拐角逐个指定；fullEnds 时首尾两段可整段用于圆角。 */
export function roundedPath(points, radius = 10, fullEnds = false) {
  const clean = points.filter(
    (point, i) => !i || point[0] !== points[i - 1][0] || point[1] !== points[i - 1][1]
  );
  let path = `M ${clean[0][0]} ${clean[0][1]}`;
  for (let i = 1; i < clean.length - 1; i++) {
    const a = clean[i - 1];
    const b = clean[i];
    const c = clean[i + 1];
    const before = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const after = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const wanted = Array.isArray(radius) ? radius[i - 1] ?? 10 : radius;
    const r = Math.min(wanted, fullEnds && i === 1 ? before : before / 2, fullEnds && i === clean.length - 2 ? after : after / 2);
    const start = [b[0] + ((a[0] - b[0]) * r) / before, b[1] + ((a[1] - b[1]) * r) / before];
    const end = [b[0] + ((c[0] - b[0]) * r) / after, b[1] + ((c[1] - b[1]) * r) / after];
    path += ` L ${start[0]} ${start[1]} Q ${b[0]} ${b[1]} ${end[0]} ${end[1]}`;
  }
  const last = clean[clean.length - 1];
  return path + ` L ${last[0]} ${last[1]}`;
}

/* ---------- 颜色 ---------- */

export function hexToRgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function mix(a, b, amount) {
  const from = hexToRgb(a);
  const to = hexToRgb(b);
  return (
    "#" +
    from
      .map((channel, i) =>
        Math.round(channel + (to[i] - channel) * amount)
          .toString(16)
          .padStart(2, "0")
      )
      .join("")
  );
}

function hslToHex(h, s, l) {
  const saturation = s / 100;
  const lightness = l / 100;
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lightness - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return (
    "#" +
    [r, g, b]
      .map((channel) =>
        Math.round((channel + m) * 255)
          .toString(16)
          .padStart(2, "0")
      )
      .join("")
  );
}

export function paletteColor(index, themeName = "light") {
  const palette = themeName === "dark" ? PALETTE_DARK : PALETTE_LIGHT;
  const base = palette[index % palette.length];
  if (index < palette.length) return base;
  // 超过基础色板后使用黄金角色相，保证颜色数量不封顶。
  const hue = (index * 137.508 + 17) % 360;
  const lightness = themeName === "dark" ? 64 + (index % 3) * 4 : 39 + (index % 3) * 5;
  const saturation = 52 + (index % 2) * 10;
  return hslToHex(hue, saturation, lightness);
}

export function nextColor(used, themeName = "light") {
  for (let index = 0; index < 512; index++) {
    const color = paletteColor(index, themeName);
    if (!used.has(color)) return color;
  }
  return themeName === "dark" ? "#8c99a8" : "#69717c";
}

const SHADE_STEPS = [
  0, -0.26, 0.28, -0.4, 0.44, -0.54, 0.58, -0.64, 0.68, -0.2, 0.18, -0.34,
  0.34, -0.48, 0.48, -0.58,
];

/** 数组中的各元素用同一色相的深浅区分；依靠主题的 ink/surface 取色。 */
export function shade(color, index, theme) {
  if (!index) return color;
  const amount =
    index < SHADE_STEPS.length
      ? SHADE_STEPS[index]
      : (index % 2 ? -1 : 1) * Math.min(0.72, 0.2 + (index % 7) * 0.06);
  const target = amount < 0 ? theme.ink : theme.surface;
  return mix(color, target, Math.abs(amount));
}

/* ---------- 展示 ---------- */

export function displayKind(display) {
  return display === "曲线" || display === "波形" ? "curve" : display === "数值" ? "number" : "text";
}

export function signed(text) {
  return text.replace(/^-/, "−");
}

export function formatValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const absolute = Math.abs(value);
    if (absolute !== 0 && (absolute < 1e-3 || absolute >= 1e6)) {
      return signed(value.toExponential(3));
    }
    if (absolute === 0) return "0";
    const digits = absolute >= 1000 ? 1 : absolute >= 100 ? 2 : absolute >= 10 ? 3 : 4;
    return signed(
      value
        .toFixed(digits)
        .replace(/(\.\d*?)0+$/, "$1")
        .replace(/\.$/, "")
    );
  }
  if (Array.isArray(value)) return "[" + value.map(formatValue).join(", ") + "]";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function compactValue(value) {
  return Array.isArray(value) ? value.map(formatValue).join(" ") : formatValue(value);
}

export function clockTime(timestamp, precise = false) {
  const date = new Date(timestamp * 1000);
  if (!Number.isFinite(date.getTime())) return "—";
  const clock = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
  return precise ? clock + "." + Math.floor(date.getMilliseconds() / 100) : clock;
}

export function formatAge(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 1) return seconds.toFixed(1) + "s";
  if (seconds < 60) return Math.round(seconds) + "s";
  return Math.floor(seconds / 60) + "m" + Math.round(seconds % 60) + "s";
}

export function formatRate(rate) {
  if (!Number.isFinite(rate) || rate <= 0) return "—";
  return rate >= 100 ? Math.round(rate) + "/s" : rate.toFixed(1) + "/s";
}

export function rateOf(points, now, windowSeconds = 2) {
  const start = now - windowSeconds;
  let newest = null;
  let oldest = null;
  let count = 0;
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i];
    if (point[0] > now) continue;
    if (point[0] < start) break;
    if (newest === null) newest = point[0];
    oldest = point[0];
    count++;
  }
  if (count < 2 || newest === null || oldest === null) return 0;
  const span = newest - oldest;
  return span > 0 ? (count - 1) / span : 0;
}

export function sampleAt(points, time) {
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (points[middle][0] < time) low = middle + 1;
    else high = middle;
  }
  const candidates = [points[low], points[low - 1]].filter(Boolean);
  if (!candidates.length) return null;
  const nearest = candidates.reduce((best, point) =>
    Math.abs(point[0] - time) < Math.abs(best[0] - time) ? point : best
  );
  return nearest && Math.abs(nearest[0] - time) <= 1 ? nearest : null;
}
