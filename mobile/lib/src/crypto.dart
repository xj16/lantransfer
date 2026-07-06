/// End-to-end encryption for the LanTransfer mobile client.
///
/// This mirrors the desktop crypto (ECDH P-256 -> HKDF-SHA-256 -> AES-256-GCM).
/// On mobile we lean on the platform WebCrypto-equivalent exposed by the
/// underlying WebRTC engine for key agreement, but the message-sealing format —
/// a 12-byte nonce prepended to the GCM ciphertext, base64url-encoded — is
/// identical on the wire, so a phone and a desktop interoperate.
///
/// The heavy lifting (X25519/P-256 + AES-GCM) is delegated to a small helper
/// interface so this file has no hard dependency on a specific crypto package;
/// [DefaultCipher] wires it to the platform. Unit tests inject a fake.
library;

import 'dart:convert';
import 'dart:typed_data';

/// base64url encode (URL-safe, no padding) — matches toBase64Url in the TS code.
String toBase64Url(Uint8List bytes) =>
    base64Url.encode(bytes).replaceAll('=', '');

/// base64url decode, tolerating missing padding.
Uint8List fromBase64Url(String s) {
  final pad = (4 - s.length % 4) % 4;
  return base64Url.decode(s + '=' * pad);
}

/// A keyed session cipher. [seal]/[open] operate on UTF-8 strings, producing
/// and consuming the nonce||ciphertext base64url format shared with desktop.
abstract class SessionCipher {
  Future<String> seal(String plaintext);
  Future<String> open(String sealed);
}

/// Establishes a [SessionCipher] from an ECDH handshake. The concrete platform
/// implementation lives in the app layer; keeping this abstract makes the
/// transfer engine testable without native crypto.
abstract class KeyAgreement {
  /// Our public key, base64url-encoded, to advertise to the peer.
  String get publicKeyB64;

  /// Derive the shared session cipher from the peer's public key.
  Future<SessionCipher> deriveCipher(String peerPublicKeyB64);
}

/// SHA-256 helper used to verify a completed transfer's integrity.
/// Implemented with a pure-Dart routine so it needs no native dependency.
String sha256Hex(Uint8List data) => _Sha256().update(data).finishHex();

// ---------------------------------------------------------------------------
// Minimal, dependency-free SHA-256 (FIPS 180-4). Used only for the integrity
// check; the bulk encryption uses platform AES-GCM via [SessionCipher].
// ---------------------------------------------------------------------------

class _Sha256 {
  static const List<int> _k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  final List<int> _h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  final BytesBuilder _buf = BytesBuilder();

  _Sha256 update(Uint8List data) {
    _buf.add(data);
    return this;
  }

  static int _rotr(int x, int n) => ((x >>> n) | (x << (32 - n))) & 0xffffffff;

  String finishHex() {
    final msg = _buf.toBytes();
    final bitLen = msg.length * 8;
    final padded = BytesBuilder()
      ..add(msg)
      ..addByte(0x80);
    while (padded.length % 64 != 56) {
      padded.addByte(0);
    }
    final lenBytes = ByteData(8)..setUint64(0, bitLen);
    padded.add(lenBytes.buffer.asUint8List());
    final data = padded.toBytes();

    final w = List<int>.filled(64, 0);
    for (var i = 0; i < data.length; i += 64) {
      for (var t = 0; t < 16; t++) {
        final j = i + t * 4;
        w[t] = (data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3];
      }
      for (var t = 16; t < 64; t++) {
        final s0 = _rotr(w[t - 15], 7) ^ _rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        final s1 = _rotr(w[t - 2], 17) ^ _rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) & 0xffffffff;
      }

      var a = _h[0], b = _h[1], c = _h[2], d = _h[3];
      var e = _h[4], f = _h[5], g = _h[6], h = _h[7];

      for (var t = 0; t < 64; t++) {
        final s1 = _rotr(e, 6) ^ _rotr(e, 11) ^ _rotr(e, 25);
        final ch = (e & f) ^ (~e & g);
        final temp1 = (h + s1 + ch + _k[t] + w[t]) & 0xffffffff;
        final s0 = _rotr(a, 2) ^ _rotr(a, 13) ^ _rotr(a, 22);
        final maj = (a & b) ^ (a & c) ^ (b & c);
        final temp2 = (s0 + maj) & 0xffffffff;
        h = g;
        g = f;
        f = e;
        e = (d + temp1) & 0xffffffff;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) & 0xffffffff;
      }

      _h[0] = (_h[0] + a) & 0xffffffff;
      _h[1] = (_h[1] + b) & 0xffffffff;
      _h[2] = (_h[2] + c) & 0xffffffff;
      _h[3] = (_h[3] + d) & 0xffffffff;
      _h[4] = (_h[4] + e) & 0xffffffff;
      _h[5] = (_h[5] + f) & 0xffffffff;
      _h[6] = (_h[6] + g) & 0xffffffff;
      _h[7] = (_h[7] + h) & 0xffffffff;
    }

    return _h.map((v) => v.toRadixString(16).padLeft(8, '0')).join();
  }
}
