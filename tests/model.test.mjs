import test from "node:test";
import assert from "node:assert/strict";

import {
  assignRanks,
  buildView,
  formatAge,
  formatRate,
  formatValue,
  nextColor,
  orderVisible,
  parseMarkdown,
  paletteColor,
  rateOf,
  roundedPath,
  sampleAt,
  shade,
} from "../viewer/model.mjs";

const SAMPLE = `# Demo

\`\`\`md
### fake · 代码块示例
\`\`\`

### sensing · 传感
概要：采集信号。
详细：生成数据。

### sensing/signal · 目标生成
概要：生成目标值。

### control · 控制
概要：控制闭环。

### control/config · 配置
概要：参数。

### control/regulation · 平滑与调节
概要：PID。

## 数据流
- sensing/signal -> missing : broken | 坏 | 曲线 | 实时 | 未声明端点
- sensing/signal -> sensing/signal : self | 自环 | 曲线 | 实时 | 自环
- control/config -> sensing/signal : params | 参数 | 数值 | 配置 | 配置流
- sensing/signal -> control/regulation : target | 目标 | 数值 | 实时 | 目标值
- sensing/signal -> control/regulation : target | 同名 | 数值 | 实时 | 重复名
- 这一行不是合法的数据流
- a -> b : 缺少字段
`;

test("parseMarkdown skips code fences and reports diagnostics", () => {
  const model = parseMarkdown(SAMPLE);
  assert.equal(model.title, "Demo");
  assert.deepEqual([...model.modules.keys()], [
    "sensing",
    "sensing/signal",
    "control",
    "control/config",
    "control/regulation",
  ]);
  assert.equal(model.flows.length, 3);
  assert.equal(model.realtimeFlows.length, 2);
  assert.equal(model.hiddenFlows.length, 1);
  assert.equal(model.invalidFlows.length, 2);
  assert.equal(model.configOnly.has("control/config"), true);
  assert.equal(model.configOnly.has("sensing/signal"), false);
  assert.equal(model.byName.get("target").realtime, true);
  assert.ok(model.warnings.some((warning) => warning.message.includes("未声明模块")));
  assert.ok(model.warnings.some((warning) => warning.message.includes("自环")));
  assert.ok(model.warnings.some((warning) => warning.message.includes("无法解析")));
  const malformed = model.warnings.find((warning) => warning.message.includes("无法解析"));
  assert.equal(typeof malformed.line, "number");
});

test("parseMarkdown prefers realtime flow for a shared name", () => {
  const text = `# X
### a · A
### b · B
## 数据流
- a -> b : same | 配置 | 数值 | 配置 | first
- a -> b : same | 实时 | 数值 | 实时 | second
`;
  const model = parseMarkdown(text);
  assert.equal(model.byName.get("same").realtime, true);
  assert.equal(model.byName.get("same").label, "实时");
});

test("buildView folds external endpoints and excludes non-realtime flows", () => {
  const model = parseMarkdown(SAMPLE);
  const view = buildView(model, "sensing");
  assert.equal(view.framed, true);
  assert.deepEqual([...view.nodes.keys()], ["sensing/signal"]);
  assert.equal(view.pairs.length, 1);
  assert.equal(view.pairs[0].source, "sensing/signal");
  assert.equal(view.pairs[0].target, "@out");
  assert.equal(view.extOut.has("control"), true);
  assert.equal(view.pairs[0].flows.every((flow) => flow.realtime), true);
});

test("buildView maps the top level", () => {
  const model = parseMarkdown(SAMPLE);
  const view = buildView(model, "");
  assert.deepEqual([...view.nodes.keys()], ["sensing", "control"]);
  assert.equal(view.pairs.some((pair) => pair.source === "sensing" && pair.target === "control"), true);
});

test("assignRanks keeps independent modules in column zero", () => {
  const pairs = [
    { source: "A", target: "B", flows: [{ name: "x" }] },
  ];
  const order = orderVisible(["A", "B", "C"], pairs);
  const ranks = assignRanks(order, ["A", "B", "C"], pairs);
  assert.equal(ranks.get("A"), 0);
  assert.equal(ranks.get("B"), 1);
  assert.equal(ranks.get("C"), 0);
});

test("palette never hangs and produces many distinct colors", () => {
  for (const theme of ["light", "dark"]) {
    const used = new Set();
    for (let index = 0; index < 300; index++) {
      const color = nextColor(used, theme);
      assert.equal(used.has(color), false);
      used.add(color);
      assert.match(color, /^#[0-9a-f]{6}$/i);
    }
    assert.equal(used.size, 300);
    assert.notEqual(paletteColor(0, theme), paletteColor(1, theme));
  }
});

test("shade distinguishes channels", () => {
  const theme = { ink: "#171b21", surface: "#ffffff" };
  const colors = new Set();
  for (let index = 0; index < 16; index++) colors.add(shade("#3d6b96", index, theme));
  assert.equal(colors.size, 16);
});

test("formatValue is adaptive and human readable", () => {
  assert.equal(formatValue(0), "0");
  assert.equal(formatValue(0.607), "0.607");
  assert.equal(formatValue(0.9996), "0.9996");
  assert.equal(formatValue(100.04), "100.04");
  assert.equal(formatValue(1e-7), "1.000e-7");
  assert.equal(formatValue(-0.0004), "−4.000e-4");
  assert.equal(formatValue([1, 2.5]), "[1, 2.5]");
  assert.equal(formatValue(null), "null");
});

test("rateOf and sampleAt work on sorted points", () => {
  const now = 100;
  const points = [];
  for (let index = 0; index < 100; index++) points.push([now - 2 + index * 0.02, index]);
  assert.ok(Math.abs(rateOf(points, now, 2) - 50) < 0.1);
  assert.deepEqual(sampleAt(points, 99.5)[1], 75);
  assert.equal(sampleAt(points, 1), null);
});

test("formatAge and formatRate", () => {
  assert.equal(formatAge(0.24), "0.2s");
  assert.equal(formatAge(12), "12s");
  assert.equal(formatAge(65), "1m5s");
  assert.equal(formatRate(0), "—");
  assert.equal(formatRate(50), "50.0/s");
  assert.equal(formatRate(120), "120/s");
});

test("roundedPath keeps a valid path", () => {
  const path = roundedPath([[0, 0], [10, 0], [10, 10], [20, 10]], 4, true);
  assert.match(path, /^M 0 0 L .* Q .* L .*$/);
});
