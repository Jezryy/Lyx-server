const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const app = express();

app.use(cors());
app.use(express.json());

/* Serve static dari BEBERAPA lokasi (antisipasi file di root atau di public) */
app.use(express.static('public'));
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

let pairingCodes = {};
let devices = [];

app.post('/api/generate-pairing', (req, res) => {
  const code = req.body.code;
  if (!code) return res.json({ success: false });
  pairingCodes[code] = { used: false };
  res.json({ success: true, code: code });
});

app.post('/api/register-device', (req, res) => {
  const code = req.body.code;
  if (!pairingCodes[code]) return res.json({ success: false, message: 'Code invalid' });
  if (pairingCodes[code].used) return res.json({ success: false, message: 'Code used' });

  const device = {
    id: 'dev_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    name: req.body.name || 'Unknown',
    model: req.body.model || 'Unknown',
    os: req.body.os || 'Unknown',
    type: req.body.type || 'android',
    commands: []
  };
  devices.push(device);
  pairingCodes[code].used = true;
  res.json({ success: true, deviceId: device.id });
});

app.get('/api/devices', (req, res) => {
  res.json(devices.map(d => ({ id: d.id, name: d.name, model: d.model, os: d.os, type: d.type })));
});

app.post('/api/command', (req, res) => {
  const deviceId = req.body.deviceId;
  const type = req.body.type;
  const device = devices.find(d => d.id === deviceId);
  if (!device) return res.json({ success: false });

  const cmd = { type: type, id: Date.now() };
  for (let k in req.body) {
    if (k !== 'deviceId' && k !== 'type') cmd[k] = req.body[k];
  }
  device.commands.push(cmd);
  res.json({ success: true });
});

app.get('/api/agent/commands/:deviceId', (req, res) => {
  const device = devices.find(d => d.id === req.params.deviceId);
  if (!device) return res.json({ commands: [] });
  const cmds = device.commands.slice();
  device.commands = [];
  res.json({ commands: cmds });
});

/* ROOT → index.html */
app.get('/', (req, res) => {
  const paths = [
    path.join(__dirname, 'public', 'index.html'),
    path.join(__dirname, 'index.html')
  ];
  for (let p of paths) {
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  res.send('Lyx Server OK - tapi index.html gak ditemukan');
});

/* /agent.html → cek di public/ atau root */
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, function() {
  console.log('LYX SERVER RUNNING ON PORT ' + PORT);
});
