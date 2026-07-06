import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';

import 'src/app_controller.dart';
import 'src/protocol.dart';

void main() => runApp(const LanTransferApp());

class LanTransferApp extends StatelessWidget {
  const LanTransferApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'LanTransfer',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF4F8CFF),
          brightness: Brightness.dark,
        ),
        scaffoldBackgroundColor: const Color(0xFF0D1117),
      ),
      home: const ConnectScreen(),
    );
  }
}

/// First screen: choose a display name, relay URL, and room.
class ConnectScreen extends StatefulWidget {
  const ConnectScreen({super.key});

  @override
  State<ConnectScreen> createState() => _ConnectScreenState();
}

class _ConnectScreenState extends State<ConnectScreen> {
  final _name = TextEditingController(text: 'My Phone');
  final _relay = TextEditingController(text: 'ws://192.168.1.10:8080/ws');
  final _room = TextEditingController(text: 'lan');

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('LanTransfer')),
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(
              'Encrypted P2P file sharing across any OS',
              style: TextStyle(color: Colors.white70),
            ),
            const SizedBox(height: 24),
            TextField(
              controller: _name,
              decoration: const InputDecoration(labelText: 'Display name'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _relay,
              decoration: const InputDecoration(labelText: 'Relay URL'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _room,
              decoration: const InputDecoration(labelText: 'Room'),
            ),
            const SizedBox(height: 24),
            FilledButton.icon(
              icon: const Icon(Icons.wifi_tethering),
              label: const Text('Connect'),
              onPressed: () {
                final controller = AppController(
                  relayUrl: _relay.text.trim(),
                  displayName: _name.text.trim(),
                  room: _room.text.trim(),
                );
                Navigator.of(context).push(MaterialPageRoute(
                  builder: (_) => HomeScreen(controller: controller),
                ));
              },
            ),
            const Spacer(),
            const Text(
              'Files travel directly device-to-device, end-to-end encrypted. '
              'The relay only helps devices find each other — it never sees your data.',
              style: TextStyle(color: Colors.white38, fontSize: 12),
            ),
          ],
        ),
      ),
    );
  }

  @override
  void dispose() {
    _name.dispose();
    _relay.dispose();
    _room.dispose();
    super.dispose();
  }
}

/// Main screen: nearby devices + live transfers.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.controller});
  final AppController controller;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  late final AppController _c;

  @override
  void initState() {
    super.initState();
    _c = widget.controller;
    _c.onSaveFile = _saveFile;
    _c.start();
  }

  Future<void> _saveFile(String name, List<int> bytes) async {
    final dir = await getApplicationDocumentsDirectory();
    final file = File('${dir.path}/$name');
    await file.writeAsBytes(bytes);
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Saved $name to ${file.path}')),
      );
    }
  }

  Future<void> _pickAndSend(DiscoveredPeer peer) async {
    final result = await FilePicker.platform.pickFiles(withData: true);
    if (result == null) return;
    for (final f in result.files) {
      final data = f.bytes;
      if (data == null) continue;
      await _c.sendFileTo(
        peer,
        f.name,
        'application/octet-stream',
        data,
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) {
        final incoming = _c.incoming;
        return Scaffold(
          appBar: AppBar(
            title: const Text('LanTransfer'),
            actions: [
              Padding(
                padding: const EdgeInsets.only(right: 12),
                child: Row(children: [
                  Icon(Icons.circle,
                      size: 10,
                      color: _c.connected ? Colors.greenAccent : Colors.redAccent),
                  const SizedBox(width: 6),
                  Text(_c.connected ? 'Online' : 'Offline'),
                ]),
              ),
            ],
          ),
          body: Stack(children: [
            ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Text('You are ${_c.displayName} · room ${_c.room}',
                    style: const TextStyle(color: Colors.white54)),
                const SizedBox(height: 16),
                const _SectionTitle('Nearby devices'),
                if (_c.peers.isEmpty)
                  const _EmptyCard('No devices yet. Open LanTransfer on another '
                      'device using the same relay and room.')
                else
                  ..._c.peers.map((p) => _PeerTile(
                        peer: p,
                        onSend: () => _pickAndSend(p),
                      )),
                const SizedBox(height: 24),
                const _SectionTitle('Transfers'),
                if (_c.transfers.isEmpty)
                  const _EmptyCard('No transfers yet.')
                else
                  ..._c.transfers.map((t) => _TransferTile(t)),
              ],
            ),
            if (incoming != null)
              _IncomingSheet(
                request: incoming,
              ),
          ]),
        );
      },
    );
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Text(text.toUpperCase(),
            style: const TextStyle(
                color: Colors.white38, fontSize: 12, letterSpacing: 1)),
      );
}

class _EmptyCard extends StatelessWidget {
  const _EmptyCard(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Card(
        color: const Color(0xFF161B22),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Text(text, style: const TextStyle(color: Colors.white54)),
        ),
      );
}

class _PeerTile extends StatelessWidget {
  const _PeerTile({required this.peer, required this.onSend});
  final DiscoveredPeer peer;
  final VoidCallback onSend;

  IconData get _icon => switch (peer.platform) {
        Platform.mobile => Icons.smartphone,
        Platform.desktop => Icons.desktop_windows,
        Platform.web => Icons.public,
        Platform.relay => Icons.dns,
      };

  @override
  Widget build(BuildContext context) => Card(
        color: const Color(0xFF161B22),
        child: ListTile(
          leading: Icon(_icon, color: const Color(0xFF4F8CFF)),
          title: Text(peer.name),
          subtitle: Text(platformName(peer.platform)),
          trailing: FilledButton(onPressed: onSend, child: const Text('Send')),
        ),
      );
}

class _TransferTile extends StatelessWidget {
  const _TransferTile(this.t);
  final TransferInfo t;

  @override
  Widget build(BuildContext context) {
    final arrow = t.direction == TransferDirection.send ? '↑' : '↓';
    return Card(
      color: const Color(0xFF161B22),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(children: [
              Text(arrow, style: const TextStyle(color: Color(0xFF4F8CFF))),
              const SizedBox(width: 8),
              Expanded(child: Text(t.name, overflow: TextOverflow.ellipsis)),
              Text(_state(t.state), style: const TextStyle(color: Colors.white54)),
            ]),
            const SizedBox(height: 8),
            LinearProgressIndicator(value: t.progress),
          ],
        ),
      ),
    );
  }

  String _state(TransferState s) => switch (s) {
        TransferState.pending => 'Waiting',
        TransferState.active => 'Transferring',
        TransferState.completed => 'Done',
        TransferState.rejected => 'Rejected',
        TransferState.cancelled => 'Cancelled',
        TransferState.failed => 'Failed',
      };
}

class _IncomingSheet extends StatelessWidget {
  const _IncomingSheet({required this.request});
  final IncomingRequest request;

  @override
  Widget build(BuildContext context) {
    final info = request.info;
    return Align(
      alignment: Alignment.bottomCenter,
      child: Material(
        color: const Color(0xFF1C2230),
        elevation: 12,
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('Incoming file',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              Text('${info.name} from ${info.peerName}'),
              const SizedBox(height: 16),
              Row(mainAxisAlignment: MainAxisAlignment.end, children: [
                TextButton(
                  onPressed: () => request.respond(false),
                  child: const Text('Decline'),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: () => request.respond(true),
                  child: const Text('Accept & save'),
                ),
              ]),
            ],
          ),
        ),
      ),
    );
  }
}
