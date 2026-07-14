# flutter_simple

供 `flutter-devtools-mcp` 演示 / 回归用的简易 App，**故意包含**典型性能问题：

- 每 50ms `setState` → `OrderCard` / `Image` 等过度重建
- `HttpClient` 请求（可被 MCP 网络采集）
- `build` 内业务热点计算（`businessHotMethod`）
- 网络大图解码（`AppNetworkImage` / `AppImageLoader`，Timeline `app.imageDecode` + `args.ms`）
- 后台 isolate（`perfBgWorker` / `bgIsolateHotMethod`）

包名：`com.tree.devtools.flutter_simple`（Android）/ `com.tree.devtools.flutterSimple`（iOS/macOS）

## 运行

```bash
# 需要重建追踪 → debug
flutter run --debug -d <device>

# 更接近真实帧数据 → profile（无重建扩展）
flutter run --profile -d <device>
```

## 采集

配置好 MCP（`npx -y flutter-devtools-mcp`）后，对 AI 说：

```text
连接 Flutter App，开始采集性能数据 30s
```

报告默认写到：`performance-sessions/`。
