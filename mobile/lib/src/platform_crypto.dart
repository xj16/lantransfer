/// Concrete ECDH (P-256) + HKDF-SHA-256 + AES-256-GCM implementation backed by
/// the pure-Dart `cryptography` package. Produces the exact nonce||ciphertext
/// base64url format used by the desktop client, so the two interoperate.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

import 'crypto.dart';

/// AES-256-GCM session cipher keyed by a 32-byte secret.
class AesGcmCipher implements SessionCipher {
  AesGcmCipher(this._secretKey);

  static final _aead = AesGcm.with256bits();
  final SecretKey _secretKey;

  @override
  Future<String> seal(String plaintext) async {
    final box = await _aead.encrypt(
      utf8.encode(plaintext),
      secretKey: _secretKey,
    );
    // Layout on the wire: nonce(12) || ciphertext || tag(16).
    final out = BytesBuilder()
      ..add(box.nonce)
      ..add(box.cipherText)
      ..add(box.mac.bytes);
    return toBase64Url(out.toBytes());
  }

  @override
  Future<String> open(String sealed) async {
    return utf8.decode(await openBytes(fromBase64Url(sealed)));
  }

  @override
  Future<Uint8List> sealBytes(Uint8List plaintext) async {
    final box = await _aead.encrypt(plaintext, secretKey: _secretKey);
    // Layout on the wire: nonce(12) || ciphertext || tag(16).
    final out = BytesBuilder()
      ..add(box.nonce)
      ..add(box.cipherText)
      ..add(box.mac.bytes);
    return out.toBytes();
  }

  @override
  Future<Uint8List> openBytes(Uint8List bytes) async {
    if (bytes.length < 12 + 16) {
      throw ArgumentError('ciphertext too short');
    }
    final nonce = bytes.sublist(0, 12);
    final tag = bytes.sublist(bytes.length - 16);
    final cipherText = bytes.sublist(12, bytes.length - 16);
    final box = SecretBox(cipherText, nonce: nonce, mac: Mac(tag));
    final clear = await _aead.decrypt(box, secretKey: _secretKey);
    return Uint8List.fromList(clear);
  }
}

/// ECDH P-256 key agreement. Both peers derive the same AES-256-GCM key via
/// HKDF-SHA-256 with a protocol-bound info string.
class EcdhKeyAgreement implements KeyAgreement {
  EcdhKeyAgreement._(this._keyPair, this._publicKeyB64);

  static final _algorithm = Ecdh.p256(length: 32);
  static final _hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: 32);
  static final _info = utf8.encode('lantransfer/v1/session-key');

  final EcKeyPair _keyPair;
  final String _publicKeyB64;

  @override
  String get publicKeyB64 => _publicKeyB64;

  /// Generate a fresh ephemeral key pair for a pairing session.
  static Future<EcdhKeyAgreement> generate() async {
    final keyPair = await _algorithm.newKeyPair();
    final pub = await keyPair.extractPublicKey();
    final encoded = _encodePublic(pub);
    return EcdhKeyAgreement._(keyPair, toBase64Url(encoded));
  }

  /// Reconstruct a key agreement from pinned P-256 scalar coordinates (the JWK
  /// `d`, `x`, `y` values). Used by the cross-platform interop test to load the
  /// exact key material the desktop reference generated, so both platforms
  /// derive an identical session key. `d`, `x`, `y` are big-endian 32-byte
  /// scalars.
  static Future<EcdhKeyAgreement> fromKeyPairData(
    List<int> d,
    List<int> x,
    List<int> y,
  ) async {
    final keyPair = EcKeyPairData(
      d: d,
      x: x,
      y: y,
      type: KeyPairType.p256,
    );
    final pub = EcPublicKey(x: x, y: y, type: KeyPairType.p256);
    final encoded = _encodePublic(pub);
    return EcdhKeyAgreement._(keyPair, toBase64Url(encoded));
  }

  @override
  Future<SessionCipher> deriveCipher(String peerPublicKeyB64) async {
    final peerPublic = _decodePublic(fromBase64Url(peerPublicKeyB64));
    final shared = await _algorithm.sharedSecretKey(
      keyPair: _keyPair,
      remotePublicKey: peerPublic,
    );
    final sessionKey = await _hkdf.deriveKey(
      secretKey: shared,
      info: _info,
      nonce: const <int>[], // empty salt, matching the desktop HKDF
    );
    return AesGcmCipher(sessionKey);
  }

  /// Encode a P-256 public key as uncompressed X9.62 (0x04 || X || Y) wrapped
  /// in the same SPKI/DER header the desktop WebCrypto `exportKey('spki')`
  /// emits, so both platforms exchange byte-identical public keys.
  static Uint8List _encodePublic(EcPublicKey pub) {
    // `cryptography` exposes the affine coordinates X and Y separately (each a
    // big-endian 32-byte scalar for P-256). Assemble the 65-byte uncompressed
    // point (0x04 || X || Y) and prepend the fixed 26-byte SPKI prefix for
    // id-ecPublicKey over prime256v1.
    final out = BytesBuilder()
      ..add(_spkiP256Prefix)
      ..addByte(0x04)
      ..add(_fixedLen(pub.x, 32))
      ..add(_fixedLen(pub.y, 32));
    return out.toBytes();
  }

  static EcPublicKey _decodePublic(Uint8List spki) {
    // Strip the SPKI prefix and the 0x04 uncompressed-point marker, then split
    // the remaining 64 bytes back into the X and Y coordinates.
    final prefixLen = _spkiP256Prefix.length;
    final point = spki.length > prefixLen ? spki.sublist(prefixLen) : spki;
    // Drop the leading 0x04 uncompressed marker if present.
    final xy = (point.isNotEmpty && point[0] == 0x04)
        ? point.sublist(1)
        : point;
    if (xy.length != 64) {
      throw ArgumentError('unexpected P-256 public key length: ${xy.length}');
    }
    return EcPublicKey(
      x: Uint8List.sublistView(xy, 0, 32),
      y: Uint8List.sublistView(xy, 32, 64),
      type: KeyPairType.p256,
    );
  }

  /// Left-pad (or trim) a big-endian scalar to exactly [len] bytes so the wire
  /// encoding is stable regardless of leading-zero stripping.
  static Uint8List _fixedLen(List<int> bytes, int len) {
    if (bytes.length == len) return Uint8List.fromList(bytes);
    final out = Uint8List(len);
    if (bytes.length < len) {
      out.setRange(len - bytes.length, len, bytes);
    } else {
      // Trim leading bytes (should only ever be leading zeros).
      out.setRange(0, len, bytes.sublist(bytes.length - len));
    }
    return out;
  }

  /// The constant 26-byte DER prefix WebCrypto uses for an SPKI-wrapped,
  /// uncompressed P-256 (prime256v1) public key.
  static final Uint8List _spkiP256Prefix = Uint8List.fromList(const [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02,
    0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03,
    0x42, 0x00,
  ]);
}

/// Convenience factory used by PeerSession.
Future<KeyAgreement> createKeyAgreement() => EcdhKeyAgreement.generate();
