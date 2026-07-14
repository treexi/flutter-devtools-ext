# flutter-devtools-ext

Flutter 性能 / 调试相关工具集：

| 目录 | 说明 |
|------|------|
| [`flutter-devtools-mcp`](./flutter-devtools-mcp) | MCP Server：连接 AI ↔ 运行中 Flutter App，采集性能并生成优化报告。已发布：[`npmjs.com/package/flutter-devtools-mcp`](https://www.npmjs.com/package/flutter-devtools-mcp) |
| [`flutter-simple`](./flutter-simple) | Demo App（故意含重建 / 热点 / 图片解码 / 后台 isolate 等问题） |

## 快速开始

```bash
# 1) Cursor / Claude MCP（推荐）
# 见 flutter-devtools-mcp/README.zh-CN.md §2.3
# command: npx , args: ["-y", "flutter-devtools-mcp"]

# 2) 启动 Demo
cd flutter-simple && flutter run --debug
```

详细文档：[`flutter-devtools-mcp/README.zh-CN.md`](./flutter-devtools-mcp/README.zh-CN.md)
