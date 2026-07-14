# flutter-devtools-mcp

Connect AI agents to running Flutter apps for runtime inspection, profiling, and debugging through the Dart VM Service Protocol.

```
┌─────────────────┐     stdio      ┌──────────────────────┐   WebSocket    ┌─────────────────┐
│  AI Agent       │◄──────────────►│  flutter-devtools-mcp │◄─────────────►│  Flutter App     │
│ (Cursor/Claude) │                │      (MCP Server)     │   VM Service  │ (debug/profile)  │
└─────────────────┘                └──────────────────────┘                └─────────────────┘
```

[中文文档](./README.zh-CN.md)

## 1) Capabilities

- Auto-discover and connect to running Flutter apps
- Inspect widget tree and locate rebuild hotspots with source references
- Run session-based performance collection (frames, jank@16.67ms, rebuilds, hot functions Self>20ms, GC Top5, scroll FPS, image decode, isolate, network, memory)
- Generate rule-engine `.ai.md` reports (runtime summary → findings → P0/P1/P2)
- Save and compare memory snapshots
- Execute debug actions (hot reload/restart, evaluate expression, screenshot)

## 2) Quick Start

### Prerequisites

- Node.js >= 18
- A Flutter app running in `debug` or `profile` mode (recommended: `profile` for metrics; use `debug` when you need rebuild tracking)

### Install via npm (recommended)

No local clone required:

```bash
npx -y flutter-devtools-mcp
```

### MCP config (npx)

#### Cursor (`.cursor/mcp.json` or Settings → MCP)

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

### Local build (optional)

```bash
git clone https://github.com/treexi/flutter-devtools-ext.git
cd flutter-devtools-ext/flutter-devtools-mcp
npm install
npm run build
```

Then point MCP at the built entry:

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

## 3) Recommended Flow: 30s Session Collection

Start your app:

```bash
flutter run --profile
# or: flutter run --debug   # needed for rebuild tracking
```

Then ask your AI assistant:

```text
Connect Flutter app, collect performance data for 30s (scenario: home feed scroll), and provide optimization suggestions based on code.
```

The AI calls `collect_performance_session` (blocking for ~30s), then reads `filesToInspect` and returns P0/P1/P2 suggestions.

Design docs:

- Metrics guide: [`docs/performance-metrics-guide.md`](docs/performance-metrics-guide.md)
- Session design: [`docs/performance-session-simple-design.md`](docs/performance-session-simple-design.md)
- Doc index: [`docs/README.md`](docs/README.md)
- Image URL sample: [`examples/app_network_image_README.md`](examples/app_network_image_README.md)

## 4) Tool List (22)

### Performance Session
| Tool | Description |
|------|-------------|
| `collect_performance_session` | Block for N seconds (default 30), return JSON + `.ai.md`: frames/jank, rebuilds (debug), hot functions (Self>20ms), GC Top5, scroll FPS, image decode, isolate, memory, network |

### Discovery & Connection
| Tool | Description |
|------|-------------|
| `discover_apps` | Auto-discover and connect to running Flutter apps |
| `connect` | Connect by VM Service URI |
| `disconnect` | Disconnect from current app |
| `get_app_info` | VM / isolate / platform / extension capability info |

### Widget Inspection
| Tool | Description |
|------|-------------|
| `get_widget_tree` | Widget hierarchy with source locations and project filtering |
| `inspect_widget` | Deep inspect widget properties/constraints/render info |

### Rebuild Tracking
| Tool | Description |
|------|-------------|
| `start_tracking_rebuilds` | Start rebuild tracking |
| `stop_tracking_rebuilds` | Rebuild report with counts, source locations, and suggestions |

### Performance Profiling
| Tool | Description |
|------|-------------|
| `start_profiling` | Start timeline profiling |
| `stop_profiling` | Frame/jank/hotspot/build-layout-paint analysis |

### Memory Analysis
| Tool | Description |
|------|-------------|
| `get_memory_snapshot` | Heap snapshot with class distribution and suspicious allocations |
| `save_snapshot` | Save named snapshot |
| `compare_snapshots` | Compare two snapshots |
| `list_snapshots` | List saved snapshots |

### Network
| Tool | Description |
|------|-------------|
| `start_network_capture` | Start HTTP traffic capture |
| `stop_network_capture` | URL/status/time/size/error report |

### Debug Actions
| Tool | Description |
|------|-------------|
| `hot_reload` | Trigger hot reload |
| `hot_restart` | Trigger hot restart |
| `take_screenshot` | Capture screenshot |
| `toggle_debug_paint` | Toggle debug paint |
| `evaluate_expression` | Evaluate Dart expression |

## 5) Recommendations and Limitations

- Prefer `profile` mode for accurate performance metrics: `flutter run --profile`
- `debug` mode adds overhead; use it for trend checks and **rebuild tracking**
- Rebuild tracking extension is unavailable in `profile` mode (auto-degraded)
- Network capture depends on `dart:io` `HttpClient` timeline events (and HttpProfile when available)
- Hot functions (`projectTopFunctions`) track app `lib/` methods; on Android profile hit rate can be low — use 30~60s and keep interacting
- Jank budget is fixed at **16.67ms** (60 FPS)
- To attribute image decode to a **URL + ms**, use the shared loader sample: [`examples/app_network_image.dart`](./examples/app_network_image.dart) (writes `args.ms`)

## 6) Publish (GitHub Actions → npm)

1. Repo Settings → Secrets → Actions: create **`NPM_TOKEN`**
   - [npm Access Tokens](https://www.npmjs.com/settings/~/tokens) → **Granular Access Token**
   - Packages: Read and write
   - Enable **Bypass two-factor authentication** (required for CI)
   - Prefer enabling 2FA on the npm account first
2. Bump & tag:

```bash
cd flutter-devtools-mcp
npm version patch
git push origin main --tags
```

3. GitHub → Releases → publish the tag (e.g. `v0.3.1`), or run workflow **Publish npm** manually.  
   Workflow: [`.github/workflows/publish-npm.yml`](../.github/workflows/publish-npm.yml)

Tag version (without `v`) must match `package.json` `version`.

## 7) Roadmap

- [x] Auto-discover running Flutter apps
- [x] Widget rebuild tracking with source locations
- [x] Network traffic inspection
- [x] Before/after snapshot comparison
- [x] Session-based performance collection (`collect_performance_session`)
- [x] npm publish for `npx flutter-devtools-mcp`
- [ ] Continuous monitoring mode
- [ ] Integration test runner with performance baselines
- [ ] Shader compilation jank detection

## 8) License

MIT

Flutter and Dart are trademarks of Google LLC. This project is an independent, unofficial tool that talks to apps over the Dart VM Service; it is not affiliated with, endorsed by, or part of Google or the official Flutter DevTools.
