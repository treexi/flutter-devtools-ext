# flutter-devtools-mcp

连接 AI 助手与运行中的 Flutter App（Dart VM Service），让 AI 可以直接做运行时排查、性能采集和调试分析。

```
┌─────────────────┐     stdio      ┌──────────────────────┐   WebSocket    ┌─────────────────┐
│  AI Agent       │◄──────────────►│  flutter-devtools-mcp │◄─────────────►│  Flutter App     │
│ (Cursor/Claude) │                │      (MCP Server)     │   VM Service  │ (debug/profile)  │
└─────────────────┘                └──────────────────────┘                └─────────────────┘
```

[English](./README.md)

## 1. 你能用它做什么

- 自动发现并连接 Flutter 进程（无需手抄 VM URI）
- 查看 Widget 树、定位重建热点（含源码位置）
- 采集性能会话（帧、jank@16.67ms、重建、耗时函数 Self>20ms、GC Top5、滚动 FPS、图片解码、Isolate、网络、内存）
- 生成规则引擎 `.ai.md` 报告（运行时摘要 → 问题清单 → P0/P1/P2）
- 做快照对比（内存前后变化）
- 执行调试动作（hot reload/restart、表达式求值、截图等）

## 2. 快速开始

### 2.1 前置条件

- Node.js >= 18
- Flutter App 运行在 `debug` 或 `profile` 模式（指标建议 `profile`；需要重建追踪用 `debug`）

### 2.2 用 npm 安装（推荐）

无需本地 clone / build：

```bash
npx -y flutter-devtools-mcp
```

### 2.3 MCP 配置（npx）

#### Cursor（`.cursor/mcp.json` 或 Settings → MCP）

```json
{
  "mcpServers": {
    "flutter-devtools": {
      "command": "npx",
      "args": ["-y", "flutter-devtools-mcp"]
    }
  }
}
```

#### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "flutter-devtools": {
      "command": "npx",
      "args": ["-y", "flutter-devtools-mcp"]
    }
  }
}
```

#### VS Code / Copilot (`.vscode/mcp.json`)

```json
{
  "servers": {
    "flutter-devtools": {
      "command": "npx",
      "args": ["-y", "flutter-devtools-mcp"]
    }
  }
}
```

#### CodeBuddy (`.codebuddy/mcp.json`)

```json
{
  "mcpServers": {
    "flutter-devtools": {
      "command": "npx",
      "args": ["-y", "flutter-devtools-mcp"]
    }
  }
}
```

### 2.4 本地构建（可选）

```bash
git clone https://github.com/treexi/flutter-devtools-ext.git
cd flutter-devtools-ext/flutter-devtools-mcp
npm install
npm run build
```

然后 MCP 指向：

```json
{
  "mcpServers": {
    "flutter-devtools": {
      "command": "node",
      "args": ["/absolute/path/to/flutter-devtools-mcp/dist/index.js"]
    }
  }
}
```

## 3. 推荐主流程：30s 性能会话

先启动 App：

```bash
flutter run --profile
# 或：flutter run --debug   # 需要重建追踪时
```

然后在 AI 中直接说：

```text
连接 Flutter App，开始采集性能数据 30s，场景：首页滚动，结合代码给优化方案
```

AI 会调用 `collect_performance_session`（阻塞约 30s）并返回结构化结果，随后结合 `filesToInspect` 源码给出 P0/P1/P2 优化建议。

**文档：**

- 指标怎么读：[`docs/performance-metrics-guide.md`](docs/performance-metrics-guide.md)
- 产品与数据结构：[`docs/performance-session-simple-design.md`](docs/performance-session-simple-design.md)
- 文档索引：[`docs/README.md`](docs/README.md)
- 图片 URL 埋点样板：[`examples/app_network_image_README.md`](examples/app_network_image_README.md)

## 4. Demo App

仓库内 [`../flutter-simple`](../flutter-simple) 是带故意性能问题的 Demo（高频 setState、网络图、后台 isolate）。

```bash
cd ../flutter-simple
flutter run --debug -d <device>
```

然后用 MCP `collect_performance_session` 采集即可。

## 5. 工具清单（22）

### Performance Session

| Tool | Description |
|------|-------------|
| `collect_performance_session` | 阻塞采集 N 秒（默认 30），返回 JSON + `.ai.md`：帧/jank、重建（debug）、耗时函数（Self>20ms）、GC Top5、滚动 FPS、图片解码、Isolate、内存、网络 |

### Discovery & Connection

| Tool | Description |
|------|-------------|
| `discover_apps` | 自动发现并连接运行中的 Flutter App |
| `connect` | 通过 VM Service URI 手动连接 |
| `disconnect` | 断开连接 |
| `get_app_info` | 获取 VM / isolate / 平台信息与扩展能力 |

### Widget Inspection

| Tool | Description |
|------|-------------|
| `get_widget_tree` | 获取 Widget 层级（含源码位置与项目过滤） |
| `inspect_widget` | 深度查看 widget 属性/约束/render 信息 |

### Rebuild Tracking

| Tool | Description |
|------|-------------|
| `start_tracking_rebuilds` | 开始追踪重建 |
| `stop_tracking_rebuilds` | 输出重建报告（次数、源码位置、建议） |

### Performance Profiling

| Tool | Description |
|------|-------------|
| `start_profiling` | 开始 timeline profiling |
| `stop_profiling` | 输出帧、jank、hotspot、build/layout/paint 分析 |

### Memory Analysis

| Tool | Description |
|------|-------------|
| `get_memory_snapshot` | 获取堆快照（含类分布、疑似异常） |
| `save_snapshot` | 保存命名快照 |
| `compare_snapshots` | 对比两个快照差异 |
| `list_snapshots` | 列出所有快照 |

### Network

| Tool | Description |
|------|-------------|
| `start_network_capture` | 开始抓取 HTTP 流量 |
| `stop_network_capture` | 输出 URL、状态码、耗时、体积、错误等统计 |

### Debug Actions

| Tool | Description |
|------|-------------|
| `hot_reload` | 触发 Hot Reload |
| `hot_restart` | 触发 Hot Restart |
| `take_screenshot` | 截图 |
| `toggle_debug_paint` | 切换 Debug Paint |
| `evaluate_expression` | 执行 Dart 表达式 |

## 6. 使用建议与限制

- 推荐在 `profile` 模式采集性能数据：`flutter run --profile`
- `debug` 有额外检查开销；需要 **重建追踪** 时用 debug
- `profile` 下不支持 Widget 重建追踪扩展（会自动降级）
- 网络采集基于 `dart:io` `HttpClient` / HttpProfile，部分封装可能不完整
- 耗时函数（`projectTopFunctions`）为业务 `lib/` 方法；Android profile 下命中率可能偏低，建议 30~60s 并持续操作
- 掉帧预算固定 **16.67ms**（60FPS）
- 图片解码若要带 **URL + ms**，请用统一入口样板：[`examples/app_network_image.dart`](./examples/app_network_image.dart)（写入 `args.ms`）

## 7. 路线图

- [x] 自动发现并连接运行中的 Flutter 应用
- [x] 支持带源码位置的 Widget 重建追踪
- [x] 支持网络流量检查
- [x] 支持前后快照对比
- [x] 支持会话式性能采集（`collect_performance_session`）
- [x] 发布到 npm（支持 `npx flutter-devtools-mcp`）
- [ ] 持续监控模式（实时卡顿监视）
- [ ] 集成测试运行器（含性能基线对比）
- [ ] Shader 编译卡顿检测

## 8. 发版（GitHub Actions → npm）

1. 仓库 Settings → Secrets and variables → Actions，新增 **`NPM_TOKEN`**
   - 打开 [npm Access Tokens](https://www.npmjs.com/settings/~/tokens)
   - 账号建议先开 [2FA](https://www.npmjs.com/settings/~/account/security)（Authorization and writing）
   - 创建 **Granular Access Token**：Packages **Read and write**，勾选 **Bypass two-factor authentication**（CI 必须）
   - Secret 名必须是 `NPM_TOKEN`
2. 改版本并提交：
   ```bash
   cd flutter-devtools-mcp
   npm version patch   # 例如 0.3.1 → 0.3.2
   git push origin main --tags
   ```
3. GitHub → **Releases** → 用对应 tag（如 `v0.3.2`）发布  
   → 自动跑 [`.github/workflows/publish-npm.yml`](../.github/workflows/publish-npm.yml)  
   或在 Actions 里对 **Publish npm** 手动 Run workflow

> `ENEEDAUTH`：未配置 / 空的 `NPM_TOKEN`  
> `403 … bypass 2fa`：请按上面重建 **Granular + Bypass 2FA** token  
> Tag（去掉 `v`）必须与 `package.json` 的 `version` 一致

## 9. License

MIT

Flutter / Dart 为 Google LLC 商标。本项目为独立的非官方工具，通过 Dart VM Service 连接运行中的 App，与 Google 或官方 Flutter DevTools **无隶属或背书关系**。
