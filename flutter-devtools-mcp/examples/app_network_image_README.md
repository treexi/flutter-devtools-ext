# AppNetworkImage — 业务接入样板

复制 `flutter-simple/lib/perf/app_network_image.dart` 到业务工程，用于让性能采集能拿到 **图片 URL / 尺寸 / 字节数**。

## 为什么要这一处侵入

| 方式 | 有无 URL | 说明 |
|------|----------|------|
| 纯 Timeline 引擎事件 | 通常无 | 只能告警「有慢解码」 |
| **统一 `AppNetworkImage`** | 有 | 报告可点名具体图 |

## 接入

1. 复制文件到例如 `lib/widgets/app_network_image.dart`
2. 列表/头像/封面改为：

```dart
AppNetworkImage(
  url: item.coverUrl,
  width: 56,
  height: 56,
  fit: BoxFit.cover,
)
```

3. 预加载 / 强制解码：

```dart
final image = await AppImageLoader.loadAndDecode(
  url,
  cacheWidth: 800,
  cacheHeight: 600,
);
```

4. （可选）lint / Code Review：禁止业务直接 `Image.network`

## Timeline 约定

- 事件名：`app.imageDecode`
- arguments：`url`（必填），`ms`（必填，Stopwatch 耗时），`width` / `height` / `bytes`（可选）

跨 `await` 时 Timeline 的 B/E 时常采不到时长，样板用 **Stopwatch + instantSync 写入 `ms`**，MCP 优先读该字段。

`flutter-devtools-mcp` 的 `imageDecode` 指标会解析这些字段，并在报告「慢解码」中展示链接。

指标解读见：[../docs/performance-metrics-guide.md](../docs/performance-metrics-guide.md) §5。

## 与 cached_network_image

可在现有缓存库外包一层，在真正 decode 结束后用 Stopwatch 打同样的 `Timeline.instantSync(app.imageDecode, arguments: {url, ms, ...})` 即可，不必换掉缓存策略。
