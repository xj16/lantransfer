/// Glue between the relay, peer sessions, and the Flutter UI.
///
/// A [ChangeNotifier] that owns the connection lifecycle: it connects to the
/// relay, tracks discovered peers, spins up a [PeerSession] per peer, and
/// exposes the current transfer list to the widget tree.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'peer_session.dart';
import 'platform_crypto.dart';
import 'protocol.dart';
import 'relay_client.dart';

class DiscoveredPeer {
  DiscoveredPeer(this.peerId, this.name, this.platform);
  final String peerId;
  final String name;
  final Platform platform;
}

class IncomingRequest {
  IncomingRequest(this.info, this.respond);
  final TransferInfo info;
  final void Function(bool accept) respond;
}

class AppController extends ChangeNotifier {
  AppController({
    required this.relayUrl,
    required this.displayName,
    required this.room,
  }) : selfId = '${generatePairingCode()}-${newTransferId().substring(0, 4)}';

  final String relayUrl;
  final String displayName;
  final String room;
  final String selfId;

  RelayClient? _relay;
  final Map<String, PeerSession> _sessions = {};

  final List<DiscoveredPeer> peers = [];
  final List<TransferInfo> transfers = [];
  IncomingRequest? incoming;
  bool connected = false;

  void start() {
    final relay = RelayClient(
      url: relayUrl,
      peerId: selfId,
      name: displayName,
      room: room,
    );
    _relay = relay;
    relay.messages.listen(_onSignal);
    relay.connect();
    connected = true;
    notifyListeners();
  }

  void _onSignal(SignalMessage msg) {
    switch (msg.type) {
      case 'peer-joined':
        final id = msg.fields['peerId'] as String;
        if (peers.every((p) => p.peerId != id)) {
          peers.add(DiscoveredPeer(
            id,
            msg.fields['name'] as String? ?? id,
            _parsePlatform(msg.fields['platform'] as String?),
          ));
          notifyListeners();
        }
        break;
      case 'peer-left':
        final id = msg.fields['peerId'] as String;
        peers.removeWhere((p) => p.peerId == id);
        _sessions.remove(id)?.close();
        notifyListeners();
        break;
      case 'offer':
      case 'answer':
      case 'ice':
        final from = msg.fields['from'] as String;
        final session = _sessionFor(
          DiscoveredPeer(from, from, Platform.desktop),
          initiate: false,
        );
        session.handleSignal(msg);
        break;
    }
  }

  PeerSession _sessionFor(DiscoveredPeer peer, {required bool initiate}) {
    return _sessions.putIfAbsent(peer.peerId, () {
      final session = PeerSession(
        selfId: selfId,
        peerId: peer.peerId,
        peerName: peer.name,
        sendSignal: (m) => _relay?.send(m),
        keyAgreementFactory: createKeyAgreement,
        onUpdate: _upsertTransfer,
        onIncoming: _promptIncoming,
        onComplete: _saveFile,
      );
      if (initiate) session.connect();
      return session;
    });
  }

  Future<void> sendFileTo(
    DiscoveredPeer peer,
    String name,
    String mime,
    Uint8List bytes,
  ) async {
    final session = _sessionFor(peer, initiate: true);
    await session.onReady;
    await session.sendFile(name, mime, bytes);
  }

  Future<bool> _promptIncoming(TransferInfo info) {
    final completer = Completer<bool>();
    incoming = IncomingRequest(info, (accept) {
      incoming = null;
      notifyListeners();
      completer.complete(accept);
    });
    notifyListeners();
    return completer.future;
  }

  void _upsertTransfer(TransferInfo info) {
    final idx = transfers.indexWhere((t) => t.transferId == info.transferId);
    if (idx >= 0) {
      transfers[idx] = info;
    } else {
      transfers.insert(0, info);
    }
    notifyListeners();
  }

  /// Hook for the platform layer to persist a received file. The default
  /// implementation is set by the app; kept as a field for testability.
  void Function(String name, Uint8List bytes)? onSaveFile;

  void _saveFile(String name, Uint8List bytes) {
    onSaveFile?.call(name, bytes);
  }

  Platform _parsePlatform(String? s) {
    switch (s) {
      case 'desktop':
        return Platform.desktop;
      case 'mobile':
        return Platform.mobile;
      case 'web':
        return Platform.web;
      case 'relay':
        return Platform.relay;
      default:
        return Platform.desktop;
    }
  }

  @override
  void dispose() {
    for (final s in _sessions.values) {
      s.close();
    }
    _relay?.close();
    super.dispose();
  }
}
