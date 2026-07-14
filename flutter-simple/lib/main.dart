import 'dart:async';
import 'dart:convert';
import 'dart:developer' as developer;
import 'dart:io';
import 'dart:isolate';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_simple/perf/app_network_image.dart';

/// 测试时可设为 false，避免 Timer / 网络解码干扰 widget 测试。
bool kEnablePerfDemoSideEffects = true;

/// 故意包含典型性能问题，供 flutter-devtools-mcp 回归测试：
/// - 高频 setState → 列表项过度重建
/// - HttpClient 网络请求（dart:io）
/// - build 内轻量计算
/// - 网络大图解码（AppNetworkImage / AppImageLoader 样板）
/// - 后台 Isolate 重计算（供 isolateCpu 主/后台对比）
void main() {
  runApp(const PerfTestApp());
}

class PerfTestApp extends StatelessWidget {
  const PerfTestApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Flutter Simple Perf Test',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.deepPurple),
        useMaterial3: true,
      ),
      home: const HomePage(),
    );
  }
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  int _tick = 0;
  String _networkStatus = '未请求';
  String _imageStatus = '未解码';
  String _isolateStatus = '未启动';
  final List<FeedItem> _items = List.generate(
    40,
    (i) => FeedItem(id: i, title: 'Order #$i'),
  );
  final List<ui.Image> _decodedImages = [];
  final List<Timer> _timers = [];
  Isolate? _bgIsolate;
  ReceivePort? _bgReadyPort;

  @override
  void initState() {
    super.initState();
    if (!kEnablePerfDemoSideEffects) return;

    _timers.add(Timer.periodic(const Duration(milliseconds: 50), (_) {
      if (mounted) setState(() => _tick++);
    }));
    _timers.add(Timer.periodic(const Duration(seconds: 4), (_) {
      if (mounted) _fetchFeed();
    }));
    _timers.add(Timer.periodic(const Duration(seconds: 5), (_) {
      if (mounted) _decodeHeavyImages();
    }));
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _decodeHeavyImages();
      // 延后启动，避免与首帧/安装抢资源导致进程被杀
      Future<void>.delayed(const Duration(seconds: 2), () {
        if (mounted) _startBgIsolate();
      });
    });
  }

  @override
  void dispose() {
    for (final t in _timers) {
      t.cancel();
    }
    _timers.clear();
    _stopBgIsolate();
    for (final img in _decodedImages) {
      img.dispose();
    }
    _decodedImages.clear();
    super.dispose();
  }

  /// 拉起长驻后台 isolate，持续做纯计算，供 MCP isolateCpu 采样对比。
  Future<void> _startBgIsolate() async {
    if (_bgIsolate != null) return;
    setState(() => _isolateStatus = '启动中…');
    try {
      _bgReadyPort = ReceivePort();
      _bgIsolate = await Isolate.spawn(
        bgIsolateHotLoop,
        _bgReadyPort!.sendPort,
        debugName: 'perfBgWorker',
      );
      // 等 worker 回传 ready，确认已跑起来
      await _bgReadyPort!.first.timeout(const Duration(seconds: 3));
      if (mounted) setState(() => _isolateStatus = '后台 isolate 运行中');
    } catch (e) {
      _stopBgIsolate();
      if (mounted) setState(() => _isolateStatus = '启动失败: $e');
    }
  }

  void _stopBgIsolate() {
    _bgIsolate?.kill(priority: Isolate.immediate);
    _bgIsolate = null;
    _bgReadyPort?.close();
    _bgReadyPort = null;
  }

  Future<void> _fetchFeed() async {
    setState(() => _networkStatus = '请求中…');
    try {
      final client = HttpClient();
      final request = await client.getUrl(
        Uri.parse('https://jsonplaceholder.typicode.com/posts?_limit=20'),
      );
      final response = await request.close();
      final body = await response.transform(utf8.decoder).join();
      jsonDecode(body);
      if (mounted) {
        setState(() => _networkStatus = '完成 ${response.statusCode}');
      }
      client.close();
    } catch (e) {
      if (mounted) setState(() => _networkStatus = '失败: $e');
    }
  }

  /// 使用可复制样板 [AppImageLoader]，事件名 app.imageDecode + url 元数据
  Future<void> _decodeHeavyImages() async {
    setState(() => _imageStatus = '解码中…');
    var ok = 0;
    try {
      for (var i = 0; i < 6; i++) {
        final url =
            'https://picsum.photos/seed/flutter_simple_decode_$i/800/600';
        final image = await AppImageLoader.loadAndDecode(
          url,
          cacheWidth: 800,
          cacheHeight: 600,
        );
        _decodedImages.add(image);
        ok++;
      }
      if (mounted) setState(() => _imageStatus = '解码完成 $ok 张');
    } catch (e) {
      if (mounted) setState(() => _imageStatus = '解码失败: $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Perf Test Home'),
        actions: [
          Text('tick: $_tick', style: const TextStyle(fontSize: 12)),
          const SizedBox(width: 8),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    FilledButton(
                      onPressed: _fetchFeed,
                      child: const Text('拉取 Feed'),
                    ),
                    const SizedBox(width: 8),
                    FilledButton.tonal(
                      onPressed: _decodeHeavyImages,
                      child: const Text('强制图片解码'),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Text('网络: $_networkStatus'),
                Text('图片: $_imageStatus'),
                Text('Isolate: $_isolateStatus'),
              ],
            ),
          ),
          Expanded(
            child: ListView.builder(
              itemCount: _items.length,
              itemBuilder: (context, index) {
                return OrderCard(item: _items[index], tick: _tick);
              },
            ),
          ),
        ],
      ),
    );
  }
}

class FeedItem {
  final int id;
  final String title;

  FeedItem({required this.id, required this.title});
}

@pragma('vm:never-inline')
int businessHotMethod(int tick, int id) {
  return developer.Timeline.timeSync(
    'businessHotMethod',
    () {
      var acc = tick ^ (id * 31);
      for (var i = 0; i < 6000; i++) {
        acc = ((acc << 3) ^ (acc >> 2) ^ i) & 0x7fffffff;
      }
      return acc % 1000;
    },
  );
}

/// 后台 isolate 入口：周期重计算，让 isolateCpu 能采到非主 isolate。
@pragma('vm:entry-point')
void bgIsolateHotLoop(SendPort ready) {
  // ReceivePort 保持 isolate 存活并驱动事件循环
  final keepAlive = ReceivePort();
  ready.send(true);
  keepAlive.listen((_) {});

  var acc = 1;
  Future<void> loop() async {
    while (true) {
      developer.Timeline.timeSync('bgIsolateHotMethod', () {
        for (var i = 0; i < 80000; i++) {
          acc = ((acc << 3) ^ (acc >> 2) ^ i) & 0x7fffffff;
        }
      });
      await Future<void>.delayed(const Duration(milliseconds: 120));
    }
  }

  loop();
}

class OrderCard extends StatelessWidget {
  const OrderCard({super.key, required this.item, required this.tick});

  final FeedItem item;
  final int tick;

  String get _imageUrl =>
      'https://picsum.photos/seed/flutter_simple_${item.id}/400/240';

  @override
  Widget build(BuildContext context) {
    final checksum = businessHotMethod(tick, item.id);

    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: ListTile(
        leading: ClipRRect(
          borderRadius: BorderRadius.circular(6),
          child: kEnablePerfDemoSideEffects
              ? AppNetworkImage(
                  url: _imageUrl,
                  width: 56,
                  height: 56,
                  fit: BoxFit.cover,
                )
              : const SizedBox(
                  width: 56,
                  height: 56,
                  child: Icon(Icons.image),
                ),
        ),
        title: Text(item.title),
        subtitle: Text('checksum=$checksum | tick=$tick'),
        trailing: const Icon(Icons.chevron_right),
      ),
    );
  }
}
