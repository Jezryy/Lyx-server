const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let pairingCodes = {};
let devices = [];

app.post('/api/generate-pairing', (req, res) => {
  const { code } = req.body;
  if (!code) return res.json({ success: false });
  pairingCodes[code] = { used: false, createdAt: Date.now() };
  console.log('📌 Pairing code dibuat:', code);
  res.json({ success: true, code });
});

app.post('/api/register-device', (req, res) => {
  const { code, name, model, os, type } = req.body;
  if (!pairingCodes[code]) return res.json({ success: false, message: 'Code pairing tidak valid' });
  if (pairingCodes[code].used) return res.json({ success: false, message: 'Code sudah dipakai' });

  const device = {
    id: 'dev_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
    name: name || 'Unknown Device',
    model: model || 'Unknown',
    os: os || 'Unknown',
    type: type || 'android',
    pairedAt: Date.now(),
    commands: []
  };

  devices.push(device);
  pairingCodes[code].used = true;
  console.log('✅ Device terhubung:', device.name, device.id);
  res.json({ success: true, deviceId: device.id });
});

app.get('/api/devices', (req, res) => {
  res.json(devices.map(d => ({ id: d.id, name: d.name, model: d.model, os: d.os, type: d.type })));
});

app.post('/api/lock', (req, res) => {
  const { deviceId, html, action } = req.body;
  const device = devices.find(d => d.id === deviceId);
  if (!device) return res.json({ success: false });
  if (action === 'unlock') device.commands.push({ type: 'unlock', id: Date.now() });
  else device.commands.push({ type: 'lock', html: html || '', id: Date.now() });
  console.log('🔒 Lock dikirim ke', device.name);
  res.json({ success: true });
});

app.post('/api/block-app', (req, res) => {
  const { deviceId, appName, message } = req.body;
  const device = devices.find(d => d.id === deviceId);
  if (!device) return res.json({ success: false });
  device.commands.push({ type: 'block-app', appName, message: message || 'Aplikasi diblokir.', id: Date.now() });
  console.log('🚫 Blokir app', appName, 'ke', device.name);
  res.json({ success: true });
});

app.post('/api/unblock-app', (req, res) => {
  const { deviceId, appName } = req.body;
  const device = devices.find(d => d.id === deviceId);
  if (!device) return res.json({ success: false });
  device.commands.push({ type: 'unblock-app', appName, id: Date.now() });
  res.json({ success: true });
});

app.get('/api/agent/commands/:deviceId', (req, res) => {
  const device = devices.find(d => d.id === req.params.deviceId);
  if (!device) return res.json({ commands: [] });
  const cmds = [...device.commands];
  device.commands = [];
  res.json({ commands: cmds });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🔥 LYX SERVER JALAN DI PORT ' + PORT));