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
- Run session-based performance collection (frames, CPU, memory, network)
- Save and compare memory snapshots
- Execute debug actions (hot reload/restart, evaluate expression, screenshot)

## 2) Quick Start

### Prerequisites

- Node.js >= 18
- A Flutter app running in `debug` or `profile` mode (recommended: `profile`)

### Install and build

```bash
git clone https://github.com/draganbajic/flutter-devtools-mcp.git
cd flutter-devtools-mcp
npm install
npm run build
```

### MCP config examples

#### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "flutter-devtools": {
      "command": "node",
      "args": ["/path/to/flutter-devtools-mcp/dist/index.js"]
    }
  }
}
```

#### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "flutter-devtools": {
      "command": "node",
      "args": ["/path/to/flutter-devtools-mcp/dist/index.js"]
    }
  }
}
```

#### VS Code / Copilot (`.vscode/mcp.json`)

```json
{
  "servers": {
    "flutter-devtools": {
      "command": "node",
      "args": ["/path/to/flutter-devtools-mcp/dist/index.js"]
    }
  }
}
```

#### CodeBuddy (`.codebuddy/mcp.json`)

```json
{
  "mcpServers": {
    "flutter-devtools": {
      "command": "node",
      "args": ["/path/to/flutter-devtools-mcp/dist/index.js"]
    }
  }
}
```

## 3) Recommended Flow: 30s Session Collection

Start your app:

```bash
flutter run --profile
```

Then ask your AI assistant:

```text
Connect Flutter app, collect performance data for 30s (scenario: home feed scroll), and provide optimization suggestions based on code.
```

The AI calls `collect_performance_session` (blocking for 30s), then reads `filesToInspect` and returns P0/P1/P2 suggestions.

Design docs:

- Metrics guide: [`docs/performance-metrics-guide.md`](docs/performance-metrics-guide.md)
- Session design: [`docs/performance-session-simple-design.md`](docs/performance-session-simple-design.md)
- Doc index: [`docs/README.md`](docs/README.md)
- Image URL sample: [`examples/app_network_image_README.md`](examples/app_network_image_README.md)

## 4) Regression Commands

```bash
# Android debug regression
npm run test:regression:android

# Android profile regression (default duration)
npm run test:regression:android:profile

# Android profile regression (30s)
npm run test:regression:android:profile:30s
```

## 5) Tool List (22)

### Performance Session
| Tool | Description |
|------|-------------|
| `collect_performance_session` | Block for N seconds (default 30), return JSON with frames/rebuilds/CPU/memory/network |

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

## 6) Recommendations and Limitations

- Prefer `profile` mode for accurate performance metrics: `flutter run --profile`
- `debug` mode adds overhead; use it for trend checks only
- Rebuild tracking extension is unavailable in `profile` mode (auto-degraded)
- Network capture depends on `dart:io` `HttpClient` timeline events
- `projectTopFunctions` tracks app `lib/` methods; hit rate can be low on Android profile. Use 30~60s collection and active interactions
- To attribute image decode to a **URL**, use the shared loader sample: [`examples/app_network_image.dart`](./examples/app_network_image.dart) (see [`examples/app_network_image_README.md`](./examples/app_network_image_README.md))

## 7) Roadmap

- [x] Auto-discover running Flutter apps
- [x] Widget rebuild tracking with source locations
- [x] Network traffic inspection
- [x] Before/after snapshot comparison
- [x] Session-based performance collection (`collect_performance_session`)
- [ ] Continuous monitoring mode (real-time jank watcher)
- [ ] Integration test runner with performance baselines
- [ ] Shader compilation jank detection
- [ ] npm publish for `npx flutter-devtools-mcp`

## 8) License

MIT

