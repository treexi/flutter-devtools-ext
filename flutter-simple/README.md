# flutter_simple

供 `flutter-devtools-mcp` 回归测试用的简易 App，**故意包含**典型性能问题：

- 每 50ms `setState` → `OrderCard` 过度重建
- `HttpClient` 请求 jsonplaceholder（`dart:io`，可被 MCP 网络采集）
- `build` 内轻量循环计算

## 运行

```bash
flutter run --profile -d macos
```

## 回归测试

```bash
# 终端 1：启动 App
flutter run --profile -d macos

# 终端 2：跑 MCP 回归（默认采集 8s）
cd ../flutter-devtools-mcp
node scripts/regression-performance-session.mjs

# 或自动拉起 App（较慢）
node scripts/regression-performance-session.mjs --spawn
```

通过标准：返回 JSON 含帧数据、topRebuilds、hints，且 OrderCard 重建次数 > 10。
