# 可视化编程模块

用一份手写的 `module.md` 描述程序的模块划分与数据流，再用一个本地网页把它画成可交互的模块图和实时曲线。

项目本身不依赖任何第三方库，只需要 Python 3.10+。

## 目录

```
probe/            打点库：把运行中的数值通过 UDP 发给观察端
viewer/           本地查看器：接收打点 + 提供网页（server.py / index.html）
examples/demo/    示例工程：传感器 → 控制器 → 电机 的闭环仿真
```

## 组成

- **probe**：`probe.probe(name, value)` 发送 `{"name", "t", "value"}` 的 JSON 包到本机 UDP 8766。序列化或发送失败时静默忽略，不影响被测程序。
- **viewer/server.py**：同时开两个端口
  - UDP 8766：接收打点，数据在内存中保留最近 30 秒；
  - HTTP 8765：提供网页、`module.md` 以及 `/names`、`/data` 两个数据接口。
- **viewer/index.html**：单页应用，解析 `module.md`，画出模块层级、模块间的数据流，并把打点数据显示在每个模块的卡片上。

## 快速开始

```bash
# 1. 启动查看器，指定要观察的项目目录（需要包含 module.md）
python3 viewer/server.py --project examples/demo

# 2. 另开终端，运行示例工程（需要 uv）
cd examples/demo && ./run.sh

# 3. 浏览器打开
open http://127.0.0.1:8765/
```

页面会显示模块图与实时曲线；`examples/demo/logs/` 下还会生成控制器逐周期的 CSV 记录。

打点目标地址可以用环境变量覆盖：

```bash
PROBE_HOST=127.0.0.1 PROBE_PORT=8766 python3 your_program.py
```

## module.md 格式

```markdown
# 项目名

## 模块

### sensing · 传感
概要：一句话说明。
详细：展开说明。

### sensing/signal · 目标生成
概要：...
详细：...

## 数据流
- sensing/signal -> sensing/measurement : target_value | 目标值 | 曲线 | 实时 | 详细说明
```

- 模块 id 用 `/` 表示层级，如 `sensing/signal` 是 `sensing` 的子模块；
- 数据流格式为：`源 -> 目标 : 名称 | 标签 | 显示方式 | 类型 | 说明`；
- 数据流名与 `probe` 打点使用的 `name` 一致时，曲线会自动挂到对应的边上；
- 修改 `module.md` 后页面约 3 秒内自动刷新，无需重启。

## HTTP 接口

| 路径 | 说明 |
| --- | --- |
| `/` | 查看器页面 |
| `/module.md` | 当前项目的模块说明 |
| `/names` | 各数据名最近一次收到打点的时间戳 |
| `/data?names=a,b&since=ts` | 指定数据名在 `since` 之后的采样点 |

## 参数

```bash
python3 viewer/server.py --project <目录> [--port 8765] [--udp-port 8766]
```
