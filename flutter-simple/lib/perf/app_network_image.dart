import 'dart:async';
import 'dart:developer' as developer;
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

/// 业务侧「一处侵入」样板：统一网络图入口，供 flutter-devtools-mcp 采集
/// `imageDecode` 时带上 url / 尺寸 / 字节数。
///
/// ## 接入步骤
/// 1. 复制本文件到业务工程（如 `lib/widgets/app_network_image.dart`）
/// 2. 全站网络图改用 [AppNetworkImage]，禁止业务直接 `Image.network`
/// 3. 大图预加载/强制解码走 [AppImageLoader.loadAndDecode]
///
/// ## Timeline 约定（MCP 已识别）
/// - 事件名：`app.imageDecode`
/// - arguments：`url`（必填）、`ms`（必填，Stopwatch 耗时）、`width`/`height`/`bytes`（可选）
///
/// 复制到业务后可按需换成 Dio / cached_network_image，只要保留 Timeline 字段即可。
class AppImageLoader {
  AppImageLoader._();

  static const String timelineEvent = 'app.imageDecode';

  /// 下载并解码；耗时与元数据写入 Timeline，便于性能报告点名 URL。
  ///
  /// 注意：跨 await 时 Timeline B/E 时常采不到时长，因此用 Stopwatch
  /// 在结束 instant 里写入 `ms`，供 MCP 解析。
  static Future<ui.Image> loadAndDecode(
    String url, {
    int? cacheWidth,
    int? cacheHeight,
  }) async {
    final sw = Stopwatch()..start();
    try {
      final bytes = await _downloadBytes(url);
      final codec = await ui.instantiateImageCodec(
        bytes,
        targetWidth: cacheWidth,
        targetHeight: cacheHeight,
      );
      final frame = await codec.getNextFrame();
      return frame.image;
    } finally {
      sw.stop();
      developer.Timeline.instantSync(
        timelineEvent,
        arguments: <Object, Object>{
          'url': url,
          'ms': sw.elapsedMilliseconds,
          if (cacheWidth != null) 'width': cacheWidth,
          if (cacheHeight != null) 'height': cacheHeight,
        },
      );
    }
  }

  static Future<Uint8List> _downloadBytes(String url) async {
    final client = HttpClient();
    try {
      final req = await client.getUrl(Uri.parse(url));
      final res = await req.close();
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw HttpException('HTTP ${res.statusCode}', uri: Uri.parse(url));
      }
      final builder = BytesBuilder(copy: false);
      await for (final chunk in res) {
        builder.add(chunk);
      }
      return builder.takeBytes();
    } finally {
      client.close(force: true);
    }
  }
}

/// 带 Timeline 埋点的 [ImageProvider]，供 [AppNetworkImage] 使用。
class AppNetworkImageProvider extends ImageProvider<AppNetworkImageProvider> {
  const AppNetworkImageProvider(
    this.url, {
    this.cacheWidth,
    this.cacheHeight,
    this.scale = 1.0,
  });

  final String url;
  final int? cacheWidth;
  final int? cacheHeight;
  final double scale;

  @override
  Future<AppNetworkImageProvider> obtainKey(ImageConfiguration configuration) {
    return SynchronousFuture<AppNetworkImageProvider>(this);
  }

  @override
  ImageStreamCompleter loadImage(
    AppNetworkImageProvider key,
    ImageDecoderCallback decode,
  ) {
    final chunkEvents = StreamController<ImageChunkEvent>();
    return MultiFrameImageStreamCompleter(
      codec: _loadAsync(key, chunkEvents, decode),
      scale: key.scale,
      chunkEvents: chunkEvents.stream,
      informationCollector: () => <DiagnosticsNode>[
        DiagnosticsProperty<ImageProvider>('Image provider', this),
        DiagnosticsProperty<String>('URL', url),
      ],
    );
  }

  Future<ui.Codec> _loadAsync(
    AppNetworkImageProvider key,
    StreamController<ImageChunkEvent> chunkEvents,
    ImageDecoderCallback decode,
  ) async {
    final sw = Stopwatch()..start();
    try {
      final bytes = await AppImageLoader._downloadBytes(key.url);
      chunkEvents.add(
        ImageChunkEvent(
          cumulativeBytesLoaded: bytes.length,
          expectedTotalBytes: bytes.length,
        ),
      );
      final buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
      return decode(
        buffer,
        getTargetSize: (intrinsicWidth, intrinsicHeight) {
          return ui.TargetImageSize(
            width: key.cacheWidth,
            height: key.cacheHeight,
          );
        },
      );
    } catch (e, st) {
      scheduleMicrotask(() {
        chunkEvents.addError(e, st);
      });
      rethrow;
    } finally {
      sw.stop();
      developer.Timeline.instantSync(
        AppImageLoader.timelineEvent,
        arguments: <Object, Object>{
          'url': key.url,
          'ms': sw.elapsedMilliseconds,
          if (key.cacheWidth != null) 'width': key.cacheWidth!,
          if (key.cacheHeight != null) 'height': key.cacheHeight!,
        },
      );
      await chunkEvents.close();
    }
  }

  @override
  bool operator ==(Object other) {
    if (other.runtimeType != runtimeType) return false;
    return other is AppNetworkImageProvider &&
        other.url == url &&
        other.cacheWidth == cacheWidth &&
        other.cacheHeight == cacheHeight &&
        other.scale == scale;
  }

  @override
  int get hashCode => Object.hash(url, cacheWidth, cacheHeight, scale);

  @override
  String toString() =>
      '${objectRuntimeType(this, 'AppNetworkImageProvider')}("$url")';
}

/// 业务推荐使用的网络图组件（替代裸 [Image.network]）。
class AppNetworkImage extends StatelessWidget {
  const AppNetworkImage({
    super.key,
    required this.url,
    this.width,
    this.height,
    this.fit = BoxFit.cover,
    this.cacheWidth,
    this.cacheHeight,
    this.errorBuilder,
    this.placeholder,
  });

  final String url;
  final double? width;
  final double? height;
  final BoxFit fit;

  /// 解码目标宽高（逻辑像素×devicePixelRatio 由调用方换算，或直接传展示像素）
  final int? cacheWidth;
  final int? cacheHeight;

  final ImageErrorWidgetBuilder? errorBuilder;
  final Widget? placeholder;

  @override
  Widget build(BuildContext context) {
    final dpr = MediaQuery.devicePixelRatioOf(context);
    final tw = cacheWidth ??
        (width != null ? (width! * dpr).round() : null);
    final th = cacheHeight ??
        (height != null ? (height! * dpr).round() : null);

    return Image(
      image: AppNetworkImageProvider(url, cacheWidth: tw, cacheHeight: th),
      width: width,
      height: height,
      fit: fit,
      gaplessPlayback: true,
      errorBuilder: errorBuilder ??
          (context, error, stackTrace) => SizedBox(
            width: width,
            height: height,
            child: placeholder ??
                const Center(child: Icon(Icons.broken_image, size: 20)),
          ),
      frameBuilder: (context, child, frame, wasSynchronouslyLoaded) {
        if (wasSynchronouslyLoaded || frame != null) return child;
        return SizedBox(
          width: width,
          height: height,
          child: placeholder ??
              const Center(
                child: SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ),
        );
      },
    );
  }
}
