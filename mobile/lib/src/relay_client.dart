/// Reconnecting WebSocket client for the LanTransfer signaling relay.
///
/// Mirrors desktop/src/shared/relayClient.ts. Emits decoded [SignalMessage]s on
/// a broadcast stream and transparently reconnects with exponential backoff.
library;

import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

import 'protocol.dart';

typedef ChannelFactory = WebSocketChannel Function(Uri uri);

class RelayClient {
  RelayClient({
    required this.url,
    required this.peerId,
    required this.name,
    required this.room,
    this.platform = Platform.mobile,
    ChannelFactory? channelFactory,
  }) : _channelFactory = channelFactory ?? WebSocketChannel.connect;

  final String url;
  final String peerId;
  final String name;
  final String room;
  final Platform platform;
  final ChannelFactory _channelFactory;

  final _controller = StreamController<SignalMessage>.broadcast();
  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _sub;
  Duration _backoff = const Duration(milliseconds: 500);
  bool _closed = false;

  /// Inbound signaling messages from the relay.
  Stream<SignalMessage> get messages => _controller.stream;

  void connect() {
    _closed = false;
    _open();
  }

  void _open() {
    final channel = _channelFactory(Uri.parse(url));
    _channel = channel;

    _sub = channel.stream.listen(
      (event) {
        try {
          final map = jsonDecode(event as String) as Map<String, dynamic>;
          _controller.add(SignalMessage.fromJson(map));
        } catch (_) {
          // Ignore malformed frames.
        }
      },
      onDone: _scheduleReconnect,
      onError: (_) => _scheduleReconnect(),
      cancelOnError: true,
    );

    // Greet the relay and join our room.
    send(SignalMessage.hello(peerId, name, platform));
    send(SignalMessage.join(room));
    _backoff = const Duration(milliseconds: 500);
  }

  void send(SignalMessage msg) {
    _channel?.sink.add(jsonEncode(msg.toJson()));
  }

  void _scheduleReconnect() {
    if (_closed) return;
    final delay = _backoff;
    _backoff = Duration(
      milliseconds: (_backoff.inMilliseconds * 2).clamp(500, 8000),
    );
    Timer(delay, () {
      if (!_closed) _open();
    });
  }

  Future<void> close() async {
    _closed = true;
    await _sub?.cancel();
    await _channel?.sink.close();
    await _controller.close();
  }
}
