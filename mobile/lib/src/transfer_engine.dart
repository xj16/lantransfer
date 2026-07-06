/// The transfer state machine, shared by the send and receive paths.
///
/// This is the platform-independent core: given a [SessionCipher] and a sink to
/// push encrypted [ChannelMessage]s onto the data channel, it drives chunked
/// file transfers with backpressure-free sequencing and a SHA-256 integrity
/// check on completion — the same algorithm as PeerSession in the desktop app.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'crypto.dart';
import 'protocol.dart';

typedef SendSealed = void Function(String sealed);
typedef TransferUpdate = void Function(TransferInfo info);
typedef IncomingPrompt = Future<bool> Function(TransferInfo info);
typedef FileComplete = void Function(String name, Uint8List bytes);

class _Outgoing {
  _Outgoing(this.info, this.bytes);
  final TransferInfo info;
  final Uint8List bytes;
}

class _Incoming {
  _Incoming(this.info);
  final TransferInfo info;
  final List<Uint8List> chunks = [];
  int received = 0;
}

class TransferEngine {
  TransferEngine({
    required this.cipher,
    required this.send,
    required this.onUpdate,
    required this.onIncoming,
    required this.onComplete,
    required this.peerId,
    required this.peerName,
  });

  final SessionCipher cipher;
  final SendSealed send;
  final TransferUpdate onUpdate;
  final IncomingPrompt onIncoming;
  final FileComplete onComplete;
  final String peerId;
  final String peerName;

  final Map<String, _Outgoing> _outgoing = {};
  final Map<String, _Incoming> _incoming = {};

  /// Queue a file for sending. Chunks flow once the peer accepts.
  Future<String> sendFile(String name, String mime, Uint8List bytes) async {
    final id = newTransferId();
    final info = TransferInfo(
      transferId: id,
      name: name,
      size: bytes.length,
      mime: mime,
      direction: TransferDirection.send,
      peerId: peerId,
      peerName: peerName,
    );
    _outgoing[id] = _Outgoing(info, bytes);
    onUpdate(info);
    await _emit(ChannelMessage.offerFile(id, name, bytes.length, mime));
    return id;
  }

  /// Feed a raw (still-sealed) frame received from the data channel.
  Future<void> onChannelData(String sealed) async {
    late ChannelMessage msg;
    try {
      final plaintext = await cipher.open(sealed);
      msg = ChannelMessage.fromJson(jsonDecode(plaintext) as Map<String, dynamic>);
    } catch (_) {
      return; // undecryptable / tampered frame
    }
    await _dispatch(msg);
  }

  Future<void> _emit(ChannelMessage msg) async {
    final sealed = await cipher.seal(jsonEncode(msg.toJson()));
    send(sealed);
  }

  Future<void> _dispatch(ChannelMessage msg) async {
    final id = msg.fields['transferId'] as String? ?? '';
    switch (msg.type) {
      case 'offer-file':
        await _onOfferFile(msg);
        break;
      case 'accept-file':
        await _onAccept(id);
        break;
      case 'reject-file':
        _mark(id, TransferState.rejected);
        _outgoing.remove(id);
        break;
      case 'chunk':
        _onChunk(msg);
        break;
      case 'complete':
        _onComplete(msg);
        break;
      case 'cancel':
        _mark(id, TransferState.cancelled);
        _outgoing.remove(id);
        _incoming.remove(id);
        break;
    }
  }

  Future<void> _onOfferFile(ChannelMessage msg) async {
    final id = msg.fields['transferId'] as String;
    final info = TransferInfo(
      transferId: id,
      name: msg.fields['name'] as String,
      size: msg.fields['size'] as int,
      mime: msg.fields['mime'] as String? ?? 'application/octet-stream',
      direction: TransferDirection.receive,
      peerId: peerId,
      peerName: peerName,
    );
    _incoming[id] = _Incoming(info);
    onUpdate(info);

    final accepted = await onIncoming(info);
    if (accepted) {
      info.state = TransferState.active;
      onUpdate(info);
      await _emit(ChannelMessage.acceptFile(id));
    } else {
      _incoming.remove(id);
      info.state = TransferState.rejected;
      onUpdate(info);
      await _emit(ChannelMessage.rejectFile(id));
    }
  }

  Future<void> _onAccept(String id) async {
    final out = _outgoing[id];
    if (out == null) return;
    out.info.state = TransferState.active;
    onUpdate(out.info);

    var offset = 0;
    var seq = 0;
    while (offset < out.bytes.length) {
      final end = (offset + chunkSize).clamp(0, out.bytes.length);
      final slice = Uint8List.sublistView(out.bytes, offset, end);
      final last = end >= out.bytes.length;
      await _emit(ChannelMessage.chunk(id, seq, last, toBase64Url(slice)));
      offset = end;
      seq++;
      out.info.transferred = offset;
      onUpdate(out.info);
    }
    await _emit(ChannelMessage.complete(id, sha256Hex(out.bytes)));
    out.info.state = TransferState.completed;
    onUpdate(out.info);
    _outgoing.remove(id);
  }

  void _onChunk(ChannelMessage msg) {
    final id = msg.fields['transferId'] as String;
    final inc = _incoming[id];
    if (inc == null) return;
    final bytes = fromBase64Url(msg.fields['data'] as String);
    inc.chunks.add(bytes);
    inc.received += bytes.length;
    inc.info.transferred = inc.received;
    onUpdate(inc.info);
  }

  void _onComplete(ChannelMessage msg) {
    final id = msg.fields['transferId'] as String;
    final inc = _incoming[id];
    if (inc == null) return;
    final total = inc.chunks.fold<int>(0, (n, c) => n + c.length);
    final merged = Uint8List(total);
    var off = 0;
    for (final c in inc.chunks) {
      merged.setRange(off, off + c.length, c);
      off += c.length;
    }
    final expected = msg.fields['sha256'] as String;
    if (sha256Hex(merged) != expected) {
      inc.info
        ..state = TransferState.failed
        ..error = 'checksum mismatch';
      onUpdate(inc.info);
      _incoming.remove(id);
      return;
    }
    inc.info
      ..state = TransferState.completed
      ..transferred = total;
    onUpdate(inc.info);
    onComplete(inc.info.name, merged);
    _incoming.remove(id);
  }

  void _mark(String id, TransferState state) {
    final out = _outgoing[id];
    if (out != null) {
      out.info.state = state;
      onUpdate(out.info);
    }
    final inc = _incoming[id];
    if (inc != null) {
      inc.info.state = state;
      onUpdate(inc.info);
    }
  }
}
