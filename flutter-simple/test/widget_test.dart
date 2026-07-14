import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_simple/main.dart';

void main() {
  setUp(() {
    kEnablePerfDemoSideEffects = false;
  });

  tearDown(() {
    kEnablePerfDemoSideEffects = true;
  });

  testWidgets('Home page smoke test', (WidgetTester tester) async {
    await tester.pumpWidget(const PerfTestApp());
    expect(find.text('Perf Test Home'), findsOneWidget);
    expect(find.text('拉取 Feed'), findsOneWidget);
  });
}
