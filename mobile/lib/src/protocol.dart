/// LanTransfer wire protocol (Dart mirror of desktop/src/shared/protocol.ts).
///
/// The mobile client speaks the exact same JSON envelope to the relay and the
/// same encrypted [ChannelMessage] format inside the WebRTC data channel, so a
/// phone and a laptop can transfer files directly between each other.
library;

import 'dart:math';

/// Protocol version. Peers refuse to pair across a major-version mismatch.
///
/// v2 introduces binary data-channel chunk frames (see [encodeChunkFrame] in
/// crypto.dart) that replace the v1 double-base64 JSON `chunk` message on the
/// throughput hot path. Control messages remain JSON.
const int protocolVersion = 2;

/// Preferred plaintext chunk size (bytes) before encryption.
const int chunkSize = 64 * 1024;

enum Platform { desktop, mobile, web, relay }

String platformName(Platform p) => p.name;

/// Signaling message exchanged with the relay.
class SignalMessage {
  SignalMessage(this.type, this.fields);

  final String type;
  final Map<String, dynamic> fields;

  Map<String, dynamic> toJson() => {'t': type, ...fields};

  static SignalMessage fromJson(Map<String, dynamic> json) {
    final type = json['t'] as String? ?? '';
    final fields = Map<String, dynamic>.from(json)..remove('t');
    return SignalMessage(type, fields);
  }

  factory SignalMessage.hello(String peerId, String name, Platform platform) =>
      SignalMessage('hello', {
        'v': protocolVersion,
        'peerId': peerId,
        'name': name,
        'platform': platformName(platform),
      });

  factory SignalMessage.join(String room) => SignalMessage('join', {'room': room});

  factory SignalMessage.offer(String to, String from, String sdp) =>
      SignalMessage('offer', {'to': to, 'from': from, 'sdp': sdp});

  factory SignalMessage.answer(String to, String from, String sdp) =>
      SignalMessage('answer', {'to': to, 'from': from, 'sdp': sdp});

  factory SignalMessage.ice(String to, String from, Map<String, dynamic> candidate) =>
      SignalMessage('ice', {'to': to, 'from': from, 'candidate': candidate});
}

/// Application-level message sent inside the encrypted WebRTC data channel.
class ChannelMessage {
  ChannelMessage(this.type, this.fields);

  final String type;
  final Map<String, dynamic> fields;

  Map<String, dynamic> toJson() => {'t': type, ...fields};

  static ChannelMessage fromJson(Map<String, dynamic> json) {
    final type = json['t'] as String? ?? '';
    final fields = Map<String, dynamic>.from(json)..remove('t');
    return ChannelMessage(type, fields);
  }

  factory ChannelMessage.offerFile(String id, String name, int size, String mime) =>
      ChannelMessage('offer-file', {'transferId': id, 'name': name, 'size': size, 'mime': mime});

  factory ChannelMessage.acceptFile(String id) =>
      ChannelMessage('accept-file', {'transferId': id});

  factory ChannelMessage.rejectFile(String id) =>
      ChannelMessage('reject-file', {'transferId': id});

  factory ChannelMessage.chunk(String id, int seq, bool last, String data) =>
      ChannelMessage('chunk', {'transferId': id, 'seq': seq, 'last': last, 'data': data});

  factory ChannelMessage.complete(String id, String sha256) =>
      ChannelMessage('complete', {'transferId': id, 'sha256': sha256});

  factory ChannelMessage.cancel(String id, String reason) =>
      ChannelMessage('cancel', {'transferId': id, 'reason': reason});
}

enum TransferDirection { send, receive }

enum TransferState { pending, active, completed, rejected, cancelled, failed }

/// Metadata describing a transfer, tracked on both ends.
class TransferInfo {
  TransferInfo({
    required this.transferId,
    required this.name,
    required this.size,
    required this.mime,
    required this.direction,
    required this.peerId,
    required this.peerName,
    this.state = TransferState.pending,
    this.transferred = 0,
    this.error,
  });

  final String transferId;
  final String name;
  final int size;
  final String mime;
  final TransferDirection direction;
  final String peerId;
  final String peerName;
  TransferState state;
  int transferred;
  String? error;

  double get progress {
    if (size <= 0) return 0.0;
    final ratio = transferred / size;
    return ratio.clamp(0.0, 1.0).toDouble();
  }
}

const _adjectives = [
  'amber', 'brave', 'calm', 'dawn', 'eager', 'frost', 'gold', 'holly',
  'ivory', 'jade', 'keen', 'lunar', 'mint', 'noble', 'onyx', 'plum',
];
const _nouns = [
  'otter', 'falcon', 'maple', 'harbor', 'comet', 'willow', 'ember', 'quartz',
  'raven', 'sparrow', 'thistle', 'walrus', 'yak', 'zephyr', 'badger', 'crane',
];

final _rng = Random.secure();

/// Build a friendly three-part pairing code like "amber-otter-42".
String generatePairingCode() {
  final adj = _adjectives[_rng.nextInt(_adjectives.length)];
  final noun = _nouns[_rng.nextInt(_nouns.length)];
  final num = _rng.nextInt(100);
  return '$adj-$noun-$num';
}

/// Generate a random 128-bit transfer id as hex.
String newTransferId() {
  final bytes = List<int>.generate(16, (_) => _rng.nextInt(256));
  return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}
