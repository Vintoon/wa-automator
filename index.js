/**
 * WhatsApp Automator v2 — index.js
 * Powered by whatsapp-web.js + Express + Claude AI
 *
 * Setup:
 *   npm install
 *   node index.js
 *   Open http://localhost:3000 in your browser
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cron = require('node-cron');
const express = require('express');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG_FILE = path.join(__dirname, 'config.json');
const PORT = process.env.PORT || 3000;

const DEFAULT_CONFIG = {
  message: "Hello {{name}} 👋\n\nThis is an automated message. Please check our latest updates.\n\nThank you!",
  targets: [
    { id: 1, name: "Family Group",  type: "group",  wid: "REPLACE_WITH_GROUP_ID@g.us", enabled: true },
    { id: 2, name: "Work Team",     type: "group",  wid: "REPLACE_WITH_GROUP_ID@g.us", enabled: false },
    { id: 3, name: "John Kamau",    type: "person", wid: "254712345678@c.us",           enabled: true }
  ],
  schedule: {
    enabled: false,
    cron: "0 9 * * 1",
    delaySeconds: 5
  },
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || ""
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
    console.log('✅  Created config.json');
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ─── STATE ───────────────────────────────────────────────────────────────────
let state = {
  connected: false,
  phone: null,
  qrDataUrl: null,
  qrExpired: false,
  sentCount: 0,
  nextSend: null,
  sending: false,
  sendProgress: { current: 0, total: 0, currentName: '' },
  cronJob: null
};

const activityLog = [];
let nextTargetId = 100;

function addLog(icon, msg) {
  const entry = {
    icon,
    msg,
    time: new Date().toTimeString().slice(0, 8),
    ts: Date.now()
  };
  activityLog.unshift(entry);
  if (activityLog.length > 200) activityLog.pop();
  console.log(`${icon}  ${msg}`);
}

// ─── WHATSAPP CLIENT ─────────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'wa-automator' }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  }
});

client.on('qr', async (qr) => {
  try {
    state.qrDataUrl = await qrcode.toDataURL(qr, { width: 280, margin: 2 });
    state.qrExpired = false;
    addLog('📱', 'QR code generated — open http://localhost:' + PORT + ' to scan');
  } catch (err) {
    console.error('QR generation error:', err);
  }
});

client.on('authenticated', () => {
  state.qrDataUrl = null;
  addLog('🔐', 'Authenticated — session saved');
});

client.on('ready', async () => {
  state.connected = true;
  state.qrDataUrl = null;
client.on('message', async (msg) => {
  try {
    if (msg.fromMe) return;

    const cfg = loadConfig();

    // Only respond to allowed targets (contacts or groups)
    const allowed = cfg.targets.some(t => t.wid === msg.from);
    if (!allowed) return;

    // Optional stop command
    if (msg.body?.toLowerCase().startsWith('!stop')) return;

    const reply = await generateWithClaude(
      `Reply to this WhatsApp message naturally: "${msg.body}"`,
      "friendly"
    );

    await msg.reply(reply);

    addLog('🤖', `Auto-replied → ${msg.from}`);
  } catch (err) {
    addLog('❌', 'Auto-reply error: ' + err.message);
  }
});
  try {
    const info = client.info;
    state.phone = info?.wid?.user ? info.wid.user + '@c.us' : 'connected';
    addLog('✅', `WhatsApp connected! (${state.phone})`);
  } catch {
    state.phone = 'connected';
    addLog('✅', 'WhatsApp connected!');
  }

  // Print group IDs to console
  try {
    const chats = await client.getChats();
    const groups = chats.filter(c => c.isGroup);
    if (groups.length) {
      console.log('\n📋  Your groups (copy IDs into config.json or dashboard):');
      groups.forEach(g => {
        console.log(`  "${g.name}" → ${g.id._serialized}`);
        addLog('👥', `Group found: "${g.name}" — ${g.id._serialized}`);
      });
      console.log('');
    }
  } catch { /* ignore */ }

  // Re-apply schedule if enabled
  const cfg = loadConfig();
  if (cfg.schedule.enabled) startSchedule(cfg);
});

client.on('auth_failure', (msg) => {
  state.connected = false;
  state.qrExpired = true;
  addLog('❌', 'Auth failed: ' + msg + ' — delete .wwebjs_auth and restart');
});

client.on('disconnected', (reason) => {
  state.connected = false;
  state.phone = null;
  addLog('⚠️', 'Disconnected: ' + reason);
});

// ─── SEND ────────────────────────────────────────────────────────────────────
async function sendMessages() {
  if (state.sending) {
    addLog('⚠️', 'Already sending — please wait');
    return { ok: false, error: 'Already sending' };
  }
  if (!state.connected) {
    addLog('❌', 'Cannot send — WhatsApp not connected');
    return { ok: false, error: 'Not connected' };
  }

  const cfg = loadConfig();
  const enabled = cfg.targets.filter(t => t.enabled);

  if (!enabled.length) {
    addLog('⚠️', 'No enabled targets in config');
    return { ok: false, error: 'No enabled targets' };
  }

  state.sending = true;
  state.sendProgress = { current: 0, total: enabled.length, currentName: '' };
  addLog('📤', `Starting send to ${enabled.length} target(s)…`);

  let successCount = 0;

  for (let i = 0; i < enabled.length; i++) {
    const target = enabled[i];
    state.sendProgress = { current: i + 1, total: enabled.length, currentName: target.name };

    try {
      const msg = cfg.message.replace(/{{name}}/g, target.name);
      await client.sendMessage(target.wid, msg);
      state.sentCount++;
      successCount++;
      addLog('💬', `Sent → ${target.name}`);
    } catch (err) {
      addLog('❌', `Failed → ${target.name}: ${err.message}`);
    }

    if (i < enabled.length - 1 && cfg.schedule.delaySeconds > 0) {
      await sleep(cfg.schedule.delaySeconds * 1000);
    }
  }

  state.sending = false;
  state.sendProgress = { current: 0, total: 0, currentName: '' };
  addLog('✅', `Done — sent to ${successCount}/${enabled.length} targets`);
  return { ok: true, successCount, total: enabled.length };
}

// ─── SCHEDULER ───────────────────────────────────────────────────────────────
function startSchedule(cfg) {
  if (state.cronJob) {
    state.cronJob.stop();
    state.cronJob = null;
  }

  const expression = cfg.schedule.cron;
  try {
    state.cronJob = cron.schedule(expression, () => {
      addLog('🕐', `Scheduled send triggered (${new Date().toLocaleString()})`);
      sendMessages();
    });
    addLog('⏰', `Scheduler active: "${expression}"`);
  } catch (err) {
    addLog('❌', 'Invalid cron expression: ' + expression);
  }
}

function stopSchedule() {
  if (state.cronJob) {
    state.cronJob.stop();
    state.cronJob = null;
    addLog('⏸', 'Scheduler paused');
  }
}

// ─── CLAUDE AI ───────────────────────────────────────────────────────────────
async function generateWithClaude(prompt, tone) {
  const cfg = loadConfig();
  const apiKey = cfg.anthropicApiKey || process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error('No Anthropic API key. Set ANTHROPIC_API_KEY in config.json or environment.');
  }

  const anthropic = new Anthropic({ apiKey });

  const system = `You write WhatsApp messages for a person to send to their contacts or groups.
Rules:
- Use {{name}} as a placeholder for the recipient's name
- Keep it friendly, warm, and concise (under 300 characters ideally)
- Use 1-2 relevant emojis naturally
- Tone: ${tone || 'friendly and professional'}
- Return ONLY the message text — no quotes, no explanation, no preamble`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    system,
    messages: [{ role: 'user', content: `Write a WhatsApp message about: ${prompt}` }]
  });

  return response.content[0].text.trim();
}

// ─── EXPRESS API ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Status
app.get('/api/status', (req, res) => {
  const cfg = loadConfig();
  res.json({
    connected: state.connected,
    phone: state.phone,
    sentCount: state.sentCount,
    scheduleEnabled: cfg.schedule.enabled,
    scheduleActive: !!state.cronJob,
    scheduleCron: cfg.schedule.cron,
    sending: state.sending,
    sendProgress: state.sendProgress
  });
});

// QR code
app.get('/api/qr', (req, res) => {
  if (state.connected) return res.json({ connected: true });
  if (!state.qrDataUrl) return res.json({ waiting: true });
  res.json({ qr: state.qrDataUrl });
});

// Targets
app.post('/api/targets', (req, res) => {
  const { name, wid, type } = req.body;
  if (!name || !wid) return res.status(400).json({ error: 'missing data' });

  const cfg = loadConfig();

  const exists = cfg.targets.find(t => t.wid === wid);
  if (exists) {
    return res.status(409).json({ error: 'already exists' });
  }

  const target = {
    id: Date.now(),
    name: name.trim(),
    type: type || 'person',
    wid: wid.trim(),
    enabled: true
  };

  cfg.targets.push(target);
  saveConfig(cfg);

  res.json(target);
});
  // ❌ prevent duplicates
 app.post('/api/targets', (req, res) => {
  const { name, wid, type } = req.body;

  if (!name || !wid) {
    return res.status(400).json({
      error: 'missing data'
    });
  }

  const cfg = loadConfig();

  // Prevent duplicate contacts/groups
  const exists = cfg.targets.find((t) => t.wid === wid);

  if (exists) {
    return res.status(409).json({
      error: 'Contact already exists'
    });
  }

  const target = {
    id: Date.now(),
    name: name.trim(),
    type: type || 'person',
    wid: wid.trim(),
    enabled: true
  };

  cfg.targets.push(target);

  saveConfig(cfg);

  addLog('➕', `Added target: ${target.name}`);

  res.json(target);
});

app.patch('/api/targets/:id', (req, res) => {
  const cfg = loadConfig();
  const id = parseInt(req.params.id);
  const idx = cfg.targets.findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });

  cfg.targets[idx] = { ...cfg.targets[idx], ...req.body, id };
  saveConfig(cfg);
  addLog('✏️', `Updated target: ${cfg.targets[idx].name}`);
  res.json(cfg.targets[idx]);
});

app.delete('/api/targets/:id', (req, res) => {
  const cfg = loadConfig();
  const id = parseInt(req.params.id);
  const target = cfg.targets.find(t => t.id === id);
  if (!target) return res.status(404).json({ error: 'not found' });

  cfg.targets = cfg.targets.filter(t => t.id !== id);
  saveConfig(cfg);
  addLog('🗑', `Removed target: ${target.name}`);
  res.json({ ok: true });
});

// Config / message / schedule
app.get('/api/config', (req, res) => {
  const cfg = loadConfig();
  res.json({ message: cfg.message, schedule: cfg.schedule });
});

app.put('/api/config', (req, res) => {
  const cfg = loadConfig();
  if (req.body.message !== undefined) cfg.message = req.body.message;
  if (req.body.schedule) Object.assign(cfg.schedule, req.body.schedule);
  if (req.body.anthropicApiKey !== undefined) cfg.anthropicApiKey = req.body.anthropicApiKey;
  saveConfig(cfg);
  addLog('💾', 'Config saved');
  res.json({ ok: true });
});

// Schedule toggle
app.post('/api/schedule/toggle', (req, res) => {
  const cfg = loadConfig();
  if (cfg.schedule.enabled && state.cronJob) {
    cfg.schedule.enabled = false;
    saveConfig(cfg);
    stopSchedule();
    res.json({ active: false });
  } else {
    cfg.schedule.enabled = true;
    saveConfig(cfg);
    if (state.connected) startSchedule(cfg);
    res.json({ active: true });
  }
});

// Send now
app.post('/api/send', async (req, res) => {
  const result = await sendMessages();
  res.json(result);
});

// Claude AI message generation
app.post('/api/generate', async (req, res) => {
  const { prompt, tone } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  addLog('🤖', `Generating AI message: "${prompt}"`);
  try {
    const message = await generateWithClaude(prompt, tone);
    addLog('✨', 'AI message generated');
    res.json({ message });
  } catch (err) {
    addLog('❌', 'AI generation failed: ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

// Activity log
app.get('/api/logs', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const entries = since ? activityLog.filter(l => l.ts > since) : activityLog.slice(0, 100);
  res.json(entries);
});

// Group list (from WhatsApp)
app.get('/api/groups', async (req, res) => {
  if (!state.connected) return res.status(503).json({ error: 'Not connected' });
  try {
    const chats = await client.getChats();
    const groups = chats
      .filter(c => c.isGroup)
      .map(g => ({ name: g.name, wid: g.id._serialized }));
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── START ───────────────────────────────────────────────────────────────────
loadConfig();

app.listen(PORT, () => {
  console.log('\n╔═══════════════════════════════════════╗');
  console.log(`║   WhatsApp Automator v2               ║`);
  console.log(`║   http://localhost:${PORT}               ║`);
  console.log('╚═══════════════════════════════════════╝\n');
  addLog('🚀', `Server started on port ${PORT}`);
});

client.initialize();
console.log('⏳  Initialising WhatsApp client…');