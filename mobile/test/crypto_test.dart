import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:lantransfer_mobile/src/crypto.dart';
import 'package:lantransfer_mobile/src/protocol.dart';

void main() {
  group('base64url', () {
    test('round-trips arbitrary bytes and is url-safe', () {
      final bytes = Uint8List.fromList([0, 1, 2, 250, 251, 255, 62, 63, 64]);
      final s = toBase64Url(bytes);
      expect(s.contains('+'), isFalse);
      expect(s.contains('/'), isFalse);
      expect(s.contains('='), isFalse);
      expect(fromBase64Url(s), equals(bytes));
    });
  });

  group('sha256Hex', () {
    test('matches the known empty-input vector', () {
      expect(
        sha256Hex(Uint8List(0)),
        equals('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'),
      );
    });

    test('matches the known "abc" vector', () {
      expect(
        sha256Hex(Uint8List.fromList(utf8.encode('abc'))),
        equals('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'),
      );
    });

    test('hashes a multi-block message correctly', () {
      // Two-block message exercises the padding/length code.
      final msg = utf8.encode('a' * 200);
      // Reference value computed with a standard SHA-256 implementation.
      expect(
        sha256Hex(Uint8List.fromList(msg)),
        equals('c2a908d98f5df987ade41b5fce213067efbcc21ef2240212a41e54b5e7c28ae5'),
      );
    });
  });

  group('protocol', () {
    test('pairing codes have the adjective-noun-number shape', () {
      final code = generatePairingCode();
      expect(RegExp(r'^[a-z]+-[a-z]+-\d{1,2}$').hasMatch(code), isTrue);
    });

    test('transfer ids are 32 hex chars', () {
      final id = newTransferId();
      expect(RegExp(r'^[0-9a-f]{32}$').hasMatch(id), isTrue);
    });

    test('ChannelMessage round-trips through JSON', () {
      final msg = ChannelMessage.chunk('abc', 3, true, 'ZGF0YQ');
      final decoded = ChannelMessage.fromJson(msg.toJson());
      expect(decoded.type, equals('chunk'));
      expect(decoded.fields['seq'], equals(3));
      expect(decoded.fields['last'], isTrue);
      expect(decoded.fields['data'], equals('ZGF0YQ'));
    });
  });
}
