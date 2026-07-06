/// WebRTC peer session for the mobile client.
///
/// Wraps an [RTCPeerConnection] + a reliable data channel, performs the
/// SDP-carried ECDH key exchange, and hands the encrypted frames to a
/// [TransferEngine]. This is the mobile analogue of PeerSession in the desktop
/// app and speaks the identical protocol, so a phone pairs with a laptop.
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_webrtc/flutter_webrtc.dart';

import 'crypto.dart';
import 'protocol.dart';
import 'transfer_engine.dart';

/// Injected factory that produces a [KeyAgreement] for the ECDH handshake.
typedef KeyAgreementFactory = Future<KeyAgreement> Function();

class PeerSession {
  PeerSession({
    required this.selfId,
    required this.peerId,
    required this.peerName,
    required this.sendSignal,
    required this.keyAgreementFactory,
    required this.onUpdate,
    required this.onIncoming,
    required this.onComplete,
    this.iceServers = const [
      {'urls': 'stun:stun.l.google.com:19302'},
    ],
  });

  final String selfId;
  final String peerId;
  final String peerName;
  final void Function(SignalMessage) sendSignal;
  final KeyAgreementFactory keyAgreementFactory;
  final TransferUpdate onUpdate;
  final IncomingPrompt onIncoming;
  final FileComplete onComplete;
  final List<Map<String, dynamic>> iceServers;

  RTCPeerConnection? _pc;
  RTCDataChannel? _channel;
  KeyAgreement? _agreement;
  SessionCipher? _cipher;
  TransferEngine? _engine;
  String? _peerPublicKey;
  final _readyCompleter = Completer<void>();

  Future<void> get onReady => _readyCompleter.future;
  bool get isReady => _cipher != null && _channel?.state == RTCDataChannelState.RTCDataChannelOpen;

  /// Initiate the connection (offerer). Creates the data channel and sends an
  /// SDP offer with our public key embedded.
  Future<void> connect() async {
    _agreement = await keyAgreementFactory();
    _pc = await _createConnection();

    final channel = await _pc!.createDataChannel(
      'lantransfer',
      RTCDataChannelInit()..ordered = true,
    );
    _setupChannel(channel);

    final offer = await _pc!.createOffer();
    await _pc!.setLocalDescription(offer);
    sendSignal(SignalMessage.offer(
      peerId,
      selfId,
      _embedKey(offer.sdp ?? '', _agreement!.publicKeyB64),
    ));
  }

  Future<void> handleSignal(SignalMessage msg) async {
    switch (msg.type) {
      case 'offer':
        await _onOffer(msg);
        break;
      case 'answer':
        await _onAnswer(msg);
        break;
      case 'ice':
        final c = msg.fields['candidate'] as Map<String, dynamic>?;
        if (c != null && _pc != null) {
          await _pc!.addCandidate(RTCIceCandidate(
            c['candidate'] as String?,
            c['sdpMid'] as String?,
            c['sdpMLineIndex'] as int?,
          ));
        }
        break;
    }
  }

  Future<void> _onOffer(SignalMessage msg) async {
    _agreement = await keyAgreementFactory();
    _pc = await _createConnection();

    final extracted = _extractKey(msg.fields['sdp'] as String);
    _peerPublicKey = extracted.key;
    await _pc!.setRemoteDescription(RTCSessionDescription(extracted.sdp, 'offer'));

    final answer = await _pc!.createAnswer();
    await _pc!.setLocalDescription(answer);
    await _establishKey();

    sendSignal(SignalMessage.answer(
      peerId,
      selfId,
      _embedKey(answer.sdp ?? '', _agreement!.publicKeyB64),
    ));
  }

  Future<void> _onAnswer(SignalMessage msg) async {
    final extracted = _extractKey(msg.fields['sdp'] as String);
    _peerPublicKey = extracted.key;
    await _pc!.setRemoteDescription(RTCSessionDescription(extracted.sdp, 'answer'));
    await _establishKey();
  }

  Future<void> _establishKey() async {
    if (_agreement == null || _peerPublicKey == null) return;
    _cipher = await _agreement!.deriveCipher(_peerPublicKey!);
    _engine = TransferEngine(
      cipher: _cipher!,
      send: (sealed) => _channel?.send(RTCDataChannelMessage(sealed)),
      onUpdate: onUpdate,
      onIncoming: onIncoming,
      onComplete: onComplete,
      peerId: peerId,
      peerName: peerName,
    );
    _maybeReady();
  }

  Future<RTCPeerConnection> _createConnection() async {
    final pc = await createPeerConnection({'iceServers': iceServers});
    pc.onIceCandidate = (candidate) {
      sendSignal(SignalMessage.ice(peerId, selfId, {
        'candidate': candidate.candidate,
        'sdpMid': candidate.sdpMid,
        'sdpMLineIndex': candidate.sdpMLineIndex,
      }));
    };
    pc.onDataChannel = _setupChannel;
    return pc;
  }

  void _setupChannel(RTCDataChannel channel) {
    _channel = channel;
    channel.onDataChannelState = (state) {
      if (state == RTCDataChannelState.RTCDataChannelOpen) _maybeReady();
    };
    channel.onMessage = (message) {
      final engine = _engine;
      if (engine != null && message.isBinary == false) {
        engine.onChannelData(message.text);
      }
    };
  }

  void _maybeReady() {
    if (isReady && !_readyCompleter.isCompleted) {
      _readyCompleter.complete();
    }
  }

  Future<String> sendFile(String name, String mime, Uint8List bytes) {
    final engine = _engine;
    if (engine == null) {
      throw StateError('session not ready');
    }
    return engine.sendFile(name, mime, bytes);
  }

  Future<void> close() async {
    await _channel?.close();
    await _pc?.close();
  }

  // --- SDP key piggybacking (same format as desktop) -----------------------

  String _embedKey(String sdp, String pubKeyB64) =>
      '$sdp\r\na=x-lantransfer-key:$pubKeyB64\r\n';

  ({String sdp, String? key}) _extractKey(String sdp) {
    final lines = sdp.split(RegExp(r'\r?\n'));
    String? key;
    final kept = <String>[];
    for (final line in lines) {
      final m = RegExp(r'^a=x-lantransfer-key:(.+)$').firstMatch(line);
      if (m != null) {
        key = m.group(1)!.trim();
      } else {
        kept.add(line);
      }
    }
    return (sdp: kept.join('\r\n'), key: key);
  }
}
