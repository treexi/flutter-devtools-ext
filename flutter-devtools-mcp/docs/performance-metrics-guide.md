# Flutter 性能采集 — 指标与使用指南

> 面向开发者：如何读报告、各指标能发现什么问题、profile/debug 怎么选。  
> 产品交互与工具参数见 [`performance-session-simple-design.md`](./performance-session-simple-design.md)。  
> 图片 URL 埋点样板见 [`../examples/app_network_image_README.md`](../examples/app_network_image_README.md)。

---

## 1. 推荐用法（两分钟）

```bash
# 1) 性能主采（帧 / 耗时函数 / GC / 图片解码更准）
flutter run --profile

# 2) AI 对话
连接 Flutter App，开始采集性能数据 30s，场景：首页列表滚动，结合代码给优化方案
```

| 目的 | 模式 | 说明 |
|------|------|------|
| 卡顿体感、业务慢函数、GC、图片解码 | **profile** | 接近真实性能 |
| Widget 谁重建太多 | **debug 再采一轮** | profile **没有**重建追踪扩展 |

报告优先看 **「运行时摘要」**（带 🟢/🟡/🔴），再看「开发者结论」与 P0/P1/P2 详单。

---

## 2. 报告结构（当前）

```text
## 运行时摘要               ← 每行：状态 + 数字 + → 下一步
## 开发者结论（先看这里）   ← P0/P1 + 改法
## P0 / P1 / P2             ← 详单（数据依据 / 原因 / 改法）
## 分析线索 / 耗时函数 Top10 / GC / 图片解码 / Isolate …
```

状态含义：

| 标记 | 含义 |
|------|------|
| 🟢正常 | 当前窗口未达告警阈值 |
| 🟡注意 | 有风险，建议结合业务热点处理 |
| 🔴异常 | 建议优先处理 |
| ⚪无数据 | 本模式采不到或 Timeline 不足（不是「没问题」） |

---

## 3. 核心指标一览

### 3.1 体感：有没有卡

| 指标 | 来源 | 经验阈值（60Hz） | 能发现什么 |
|------|------|------------------|------------|
| **掉帧率 jank%** | Timeline 帧；单帧 **>16.67ms**（固定 60FPS 预算） | >5% 要查，>15% 明显卡 | UI 线程整体过载 |
| **P99 帧时** | 同上 | >32ms 易抖一下 | 最差帧尖刺 |
| **滚动段 FPS / 段 jank** | 2s 窗口分段 | 滑动 <50FPS 或段 jank 高 | 列表滑动卡顿 |
| **Build / Layout / Paint max** | Timeline 阶段 | 单阶段经常 >8～16ms | 卡在 build / 布局 / 绘制哪一段 |

**限制**：Android profile 下 Timeline 帧事件偶发偏少 → 摘要可能 ⚪无数据，此时以 **耗时函数 / 图片解码** 为准。

### 3.2 归因：卡在哪

| 指标 | 来源 | 能发现什么 | 注意 |
|------|------|------------|------|
| **耗时函数 Top（lib/）** | VM `getCpuSamples` + 路径过滤；**Self >20ms → 🔴异常** | 哪个业务方法占时间 | 比框架 `drawFrame` 有用；框架热点不进开发者结论 |
| **Widget 重建 Top** | inspector 扩展 | 哪个组件重建过多、文件:行号 | **仅 debug**；profile 固定 ⚪无数据 |
| **filesToInspect** | 重建 + 耗时函数 文件 | 该打开哪些源码 | AI/人工优先读这些文件 |

### 3.3 尖刺：偶发卡一下

| 指标 | 来源 | 能发现什么 | 注意 |
|------|------|------------|------|
| **GC 次数 / 最长停顿 / Top5** | Timeline `GC` 流 | 停顿尖刺；次数高暗示分配偏勤；Top5 看最长几次事件名 | 见 §4 |
| **图片解码** | Timeline + 可选业务埋点 | 大图解码拖垮帧；带 URL 可点名 | 见 §5 |
| **Isolate CPU** | 多 isolate 采样 | 重活是否仍在主 isolate | 不把 `drawFrame` 当业务根因 |

### 3.4 其它

| 指标 | 能发现什么 |
|------|------------|
| **网络 total / errors / slow** | 失败重试、慢接口；图片请求多属正常 |
| **内存 heap / 利用率** | 堆压力；泄漏需看趋势，单次会话只能提示 |

### 3.5 明确不作为主结论的

- 框架链路：`drawFrame` / `_handlePersistentFrameCallback` 等（只说明在刷帧）
- 内存里的 VM 内部类（`Code` / `Field` / `InstructionsSection` 等）

---

## 4. GC 指标怎么读

示例：`GC [🔴异常]: 473 次, 最长停顿 28.1ms Top5[CollectNewGeneration 28.1ms, …] → 减少每帧临时对象分配`

| 字段 | 含义 |
|------|------|
| 次数 | 窗口内 GC 发生次数 |
| 最长停顿 | 单次卡住多久；相对 ~16ms 帧预算 |
| Top5 | 最长 5 次停顿（事件名 + ms），便于区分 Young/Old/MarkSweep |
| >8ms 次数 | 可能顶掉一帧的停顿次数（规则引擎内部） |

**能发现：**

1. **卡顿尖刺来自 GC**：最长经常 >16～32ms，或 >8ms 很多次  
2. **分配偏勤（间接）**：次数极高 → 短命对象多（临时 List、字符串、闭包、解码缓冲）；需结合耗时函数/重建  
3. **交叉验证**：与 setState / 热循环 / 大图同时出现时，GC 高往往是副作用  

**发现不了：**

- 具体哪行在分配（要看业务热点 / 分配采样）  
- 单纯用「次数多」定罪卡顿（最长 7ms 时体感可能仍顺）  
- 内存泄漏（要看堆是否持续涨、GC 后降不下来）

**判定倾向（实现侧）：**

- 最长 ≤8ms 且长停顿不多 → 🟢（停顿不是主因）  
- 长停顿偏多 / 最长 >8ms → 🟡  
- 最长 >32ms 或长停顿很多 → 🔴 / P1  

处理方向：减每帧临时对象、缩小重建、大图与重计算下沉；**不要去「调 GC 参数」**。

---

## 5. 图片解码与 URL

| 能力 | 是否要业务改代码 | 结果 |
|------|------------------|------|
| 发现「有慢解码」 | 否（旁路 Timeline） | 常 **无 URL** |
| 点名「哪张图、多大、多久」 | **是（一处侵入）** | 有 url / width / height / bytes |

**推荐**：全站网络图走统一入口 [`AppNetworkImage`](../examples/app_network_image.dart)：

- Timeline 事件名：`app.imageDecode`
- arguments：`url`（必填），**`ms`（必填，Stopwatch 耗时）**，`width` / `height` / `bytes`（可选）
- 跨 `await` 时 B/E 常丢时长，样板用 instant + `args.ms`；MCP 优先读该字段

报告示例：

```text
慢解码: app.imageDecode 1788ms | https://cdn.xxx/cover.jpg | 800x600 | 118KB
→ 针对该 URL：ResizeImage / 预缓存 / 避免 UI 路径同步大图解码
```

零侵入只能告警；要链接必须轻量埋点（统一加载器即可，不必每个页面手写）。

---

## 6. 重建为什么 profile 无数据

重建依赖：

`ext.flutter.inspector.trackRebuildDirtyWidgets`

| 模式 | 重建追踪 | 帧/CPU |
|------|----------|--------|
| debug | ✅ | 偏慢、易夸大 jank |
| profile | ❌（扩展不可用） | 更接近真实 |
| release | ❌ | 无此类 VM 调试能力 |

因此摘要写「profile 下常无数据 → 需要时用 debug 补采」是 **Flutter 平台限制**，不是采集失败。

**实战**：profile 定「有多卡、哪个业务函数」；debug 定「哪个 Widget 重建爆了」。

---

## 7. 耗时函数为什么曾为空 / 怎么读

- 过滤规则：业务 `lib/` / `package:<app>/`，排除 Flutter SDK、`dart:ui` 等误归一路径  
- Android profile 下 Self 时间常落在框架叶子；业务方法靠采样 + 路径/符号命中  
- Demo 可用 `Timeline` / `@pragma('vm:never-inline')` 提高命中率  
- **Self >20ms → 报告标 🔴异常**  
- **看 `projectTopFunctions`，不要看框架 `topFunctions` 当根因**

---

## 8. 排查优先级（建议）

```text
1. 开发者结论里的 P0
2. 🔴 行：图片解码（带 URL）/ 高 jank / 滚动最差段
3. 耗时函数 Top → 打开 filesToInspect
4. 🟡 GC / 内存 → 当旁证，回到分配与重建
5. debug 补采重建（若怀疑 setState 风暴）
```

---

## 9. 相关文档索引

| 文档 | 内容 |
|------|------|
| [performance-session-simple-design.md](./performance-session-simple-design.md) | 产品形态、工具参数、数据结构、AI 话术 |
| [performance-audit-requirements.md](./performance-audit-requirements.md) | 重型 MD/HTML 审计（P2 规划，非当前主路径） |
| [../examples/app_network_image_README.md](../examples/app_network_image_README.md) | 图片统一入口接入 |
| [../README.zh-CN.md](../README.zh-CN.md) | 安装、MCP 配置（npx）、工具清单、发版 |

报告默认落在 Flutter 工程下：`performance-sessions/*.json` + `*.ai.md`。
