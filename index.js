const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const chalk = require('chalk');
const { login } = require('ws3-fca');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'bot_data.json');

// ============================================================
// 💾 DATA STORAGE — LAHAT NAKASAVE, WALANG BUBURAHIN
// ============================================================
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const defaultData = {
      adminId: "",
      session: "",
      hamolReplies: [
        "uy andyan ka pa ba", "sumagot ka naman wag kang duwag",
        "bakit tahimik ka dyan", "wag kang magtago alam kong nandyan ka",
        "hindi ako aalis hanggat di ka sumasagot", "andito lang ako hinihintay ka"
      ],
      trollReplies: [
        "akala ko kung sino natakot lang pala", "buti naman sumagot ka",
        "hindi ka makakatakas sakin", "wag ka na magtago ha",
        "andito lang ako naghihintay sayo"
      ],
      suffixes: ["", " noh", " ha", " naman", " 💀", " 🤭", " 🩸"],
      delayMin: 4000,
      delayMax: 8000
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(defaultData, null, 2));
    return defaultData;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let botData = loadData();
let api = null;
let userID = null;
let isLoggingIn = false;
let reconnectCount = 0;
let lockedTarget = null;
let activeThreads = new Set();
let startTime = Date.now();
let botStatus = { online: false, lastError: "" };

// ============================================================
// 🔧 HELPERS
// ============================================================
function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomDelay() {
  return Math.floor(Math.random() * (botData.delayMax - botData.delayMin + 1)) + botData.delayMin;
}
function getUptime() {
  const s = Math.floor((Date.now() - startTime) / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}
function isFatalErr(err) {
  if (!err) return false;
  const m = String(err).toLowerCase();
  return m.includes("checkpoint") || m.includes("confirm") || m.includes("blocked") || m.includes("verify");
}

// ============================================================
// 🔒 LOCK SYSTEM
// ============================================================
function lockTargetFn(threadID, targetID) {
  lockedTarget = { threadID, targetID, tries: 0 };
  const msg = rand(botData.hamolReplies) + rand(botData.suffixes);
  api.sendMessage(msg, threadID);
  lockedTarget.tries = 1;
  console.log(chalk.red.bold(`🔒 LOCKED → ${targetID}`));
  repeatHamolFn();
}

function repeatHamolFn() {
  if (!lockedTarget || !api) return;
  setTimeout(() => {
    if (!lockedTarget) return;
    const msg = rand(botData.hamolReplies) + rand(botData.suffixes);
    api.sendMessage(msg, lockedTarget.threadID);
    lockedTarget.tries++;
    repeatHamolFn();
  }, randomDelay());
}

function onTargetMsg(msgBody) {
  if (!lockedTarget) return;
  setTimeout(() => {
    const reply = rand(botData.trollReplies) + rand(botData.suffixes);
    api.sendMessage(reply, lockedTarget.threadID);
    console.log(chalk.green(`✅ SAGOT: ${reply.slice(0,35)}...`));
  }, randomDelay());
}

function stopLockFn() {
  lockedTarget = null;
  console.log(chalk.yellow(`🛑 LOCK RELEASED`));
}

// ============================================================
// 🚀 BOT CONNECT
// ============================================================
function connectBot() {
  if (!botData.session || !botData.adminId) {
    botStatus.lastError = "Missing session or Admin ID";
    return;
  }
  if (isLoggingIn) return;
  isLoggingIn = true;

  const agents = [
    "Mozilla/5.0 (Linux; Android 14; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
  ];

  login({
    appState: JSON.parse(botData.session),
    userAgent: rand(agents),
    forceLogin: false,
    logLevel: "silent"
  }, async (err, apiObj) => {
    if (err) {
      reconnectCount++;
      botStatus.lastError = err.message.slice(0, 60);
      console.log(chalk.red(`🔴 Login failed (${reconnectCount}x)`));
      
      if (isFatalErr(err)) {
        isLoggingIn = false;
        setTimeout(connectBot, 45000);
        return;
      }
      isLoggingIn = false;
      setTimeout(connectBot, 10000 + reconnectCount * 5000);
      return;
    }

    api = apiObj;
    userID = await api.getCurrentUserID();
    reconnectCount = 0;
    isLoggingIn = false;
    botStatus.online = true;
    botStatus.lastError = "";
    startTime = Date.now();
    console.log(chalk.green(`✅ ONLINE — Dashboard Controlled! ID: ${userID}`));

    api.setOptions({
      listenEvents: true, selfListen: false, online: true,
      autoMarkRead: false, autoMarkDelivery: false
    });

    api.listenMqtt((listenErr, event) => {
      if (listenErr) {
        botStatus.online = false;
        console.log(chalk.red("🔴 Reconnecting..."));
        setTimeout(connectBot, 10000);
        return;
      }
      if (!event || event.senderID === userID) return;

      const tid = event.threadID;
      const sid = event.senderID;
      const msg = event.body ? event.body.trim() : "";
      const mid = event.messageID;

      // COMMANDS — ADMIN LANG
      if (msg === "." && sid === botData.adminId) {
        stopLockFn();
        activeThreads.add(tid);
        api.setMessageReaction("🩸", mid, () => {}, true);
        console.log(chalk.green(`✅ AUTO-REPLY ON — GC: ${tid}`));
        return;
      }

      if (msg.startsWith(".. @") && sid === botData.adminId) {
        const targetID = msg.slice(4).trim();
        if (!targetID) return;
        activeThreads.delete(tid);
        stopLockFn();
        lockTargetFn(tid, targetID);
        api.setMessageReaction("🩸", mid, () => {}, true);
        api.sendMessage(`🔒 LOCKED ON\n📍 Target: ${targetID}`, tid);
        return;
      }

      if (msg === ".stop" && sid === botData.adminId) {
        stopLockFn();
        activeThreads.delete(tid);
        api.setMessageReaction("🩸", mid, () => {}, true);
        api.sendMessage("🛑 TIGIL 🩸", tid);
        return;
      }

      // LOCKED — SIYA BA?
      if (lockedTarget && lockedTarget.threadID === tid && lockedTarget.targetID === sid) {
        onTargetMsg(msg);
        return;
      }

      // AUTO-REPLY — WALANG LOCK
      if (!lockedTarget && activeThreads.has(tid) && sid !== botData.adminId) {
        const reply = rand(botData.trollReplies) + rand(botData.suffixes);
        api.sendMessage(reply, tid);
      }
    });
  });
}

// ============================================================
// 🖥️ DASHBOARD WEB SERVER
// ============================================================
const app = express();
app.use(cors());
app.use(express.json());

// API — KUNIN DATA
app.get('/api/status', (req, res) => {
  res.json({
    online: botStatus.online,
    uptime: botStatus.online ? getUptime() : null,
    adminId: botData.adminId,
    hasSession: !!botData.session,
    lastError: botStatus.lastError,
    lockedTarget: lockedTarget?.targetID || null,
    tries: lockedTarget?.tries || 0
  });
});

app.get('/api/settings', (req, res) => {
  res.json({
    adminId: botData.adminId,
    hamolReplies: botData.hamolReplies,
    trollReplies: botData.trollReplies,
    suffixes: botData.suffixes,
    delayMin: botData.delayMin,
    delayMax: botData.delayMax
  });
});

// API — SAVE SETTINGS
app.post('/api/settings', (req, res) => {
  const { adminId, hamolReplies, trollReplies, suffixes, delayMin, delayMax } = req.body;
  if (adminId !== undefined) botData.adminId = adminId;
  if (hamolReplies) botData.hamolReplies = hamolReplies;
  if (trollReplies) botData.trollReplies = trollReplies;
  if (suffixes) botData.suffixes = suffixes;
  if (delayMin) botData.delayMin = delayMin;
  if (delayMax) botData.delayMax = delayMax;
  saveData(botData);
  res.json({ success: true, message: "✅ Settings saved!" });
});

// API — SAVE C3C SESSION
app.post('/api/session', (req, res) => {
  const { session } = req.body;
  try {
    JSON.parse(session); // validate
    botData.session = session;
    saveData(botData);
    res.json({ success: true, message: "✅ Session saved! Bot will connect..." });
    setTimeout(connectBot, 2000);
  } catch (e) {
    res.status(400).json({ success: false, message: "❌ Invalid JSON session!" });
  }
});

// API — RESTART BOT
app.post('/api/restart', (req, res) => {
  botStatus.online = false;
  lockedTarget = null;
  activeThreads.clear();
  setTimeout(connectBot, 1500);
  res.json({ success: true, message: "🔄 Restarting..." });
});

// 🖥️ DASHBOARD UI
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>SAIZEN DASHBOARD — C3C-FCA BOT</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    *{margin:0;padding:0;box-sizing:border-box;font-family:system-ui,-apple-system,sans-serif}
    body{background:#0a0a0a;color:#fff;padding:20px;max-width:900px;margin:0 auto}
    h1{color:#ef4444;margin-bottom:5px;font-size:24px}
    .stat{background:#121212;padding:15px;border-radius:10px;margin:10px 0;border-left:4px solid #ef4444}
    .on{color:#22c55e;font-weight:bold}
    .off{color:#ef4444;font-weight:bold}
    .card{background:#121212;padding:20px;border-radius:12px;margin:15px 0;border:1px solid #222}
    label{display:block;margin:15px 0 5px;font-weight:600;color:#ddd}
    input,textarea{width:100%;background:#1e1e1e;border:1px solid #333;padding:12px;border-radius:8px;color:#fff;font-size:14px}
    textarea{min-height:100px;resize:vertical}
    button{background:#ef4444;border:none;padding:12px 24px;border-radius:8px;color:#fff;font-weight:bold;cursor:pointer;font-size:15px;margin:5px 5px 5px 0}
    button:hover{background:#dc2626}
    button.sec{background:#333}
    button.sec:hover{background:#444}
    .msg{padding:10px;border-radius:6px;margin:10px 0;display:none}
    .ok{background:#1a3322;color:#86efac;display:block}
    .err{background:#331a1a;color:#fca5a5;display:block}
    .cmd{background:#1e1e1e;padding:10px;border-radius:6px;font-family:monospace;color:#facc15;margin:5px 0}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  </style>
</head>
<body>
  <h1>🔥 SAIZEN DASHBOARD — C3C-FCA BOT</h1>
  <p style="color:#888;margin-bottom:20px">All settings here — no file editing needed!</p>

  <!-- STATUS -->
  <div class="stat">
    <strong>STATUS: </strong>
    <span id="status">Checking...</span>
    <div style="margin-top:8px;font-size:13px;color:#888">
      Uptime: <span id="uptime">-</span> | 
      Locked: <span id="locked">-</span>
    </div>
  </div>

  <!-- C3C SESSION -->
  <div class="card">
    <h3>🔑 C3C / AppState Session</h3>
    <p style="color:#888;font-size:13px;margin:5px 0">Paste your C3C session JSON here</p>
    <label>Session JSON</label>
    <textarea id="sessionInput" placeholder='{"appstate":...}'></textarea>
    <button onclick="saveSession()">💾 SAVE SESSION</button>
    <div id="sessionMsg" class="msg"></div>
  </div>

  <!-- ADMIN ID -->
  <div class="card">
    <h3>👑 ADMIN SETTINGS</h3>
    <label>Your Facebook User ID</label>
    <input type="text" id="adminInput" placeholder="615xxxxxxxxx">
    <button onclick="saveAdmin()">💾 SAVE ADMIN ID</button>
    <div id="adminMsg" class="msg"></div>
  </div>

  <!-- REPLIES -->
  <div class="card">
    <h3>💀 REPLIES</h3>
    <label>Hamol / Challenge Messages (one per line)</label>
    <textarea id="hamolInput" placeholder="uy andyan ka pa ba&#10;sumagot ka naman"></textarea>
    
    <label>Troll Replies (one per line)</label>
    <textarea id="trollInput" placeholder="buti naman sumagot ka&#10;hindi ka makakatakas"></textarea>
    
    <label>Suffixes (one per line)</label>
    <textarea id="suffixInput" placeholder="&#10; noh&#10; ha&#10; 💀"></textarea>
    
    <div class="grid">
      <div>
        <label>Min Delay (ms)</label>
        <input type="number" id="delayMin" value="4000">
      </div>
      <div>
        <label>Max Delay (ms)</label>
        <input type="number" id="delayMax" value="8000">
      </div>
    </div>
    
    <button onclick="saveAllReplies()">💾 SAVE ALL REPLIES</button>
    <div id="replyMsg" class="msg"></div>
  </div>

  <!-- COMMANDS GUIDE -->
  <div class="card">
    <h3>📝 GC COMMANDS — Type in Group Chat</h3>
    <div class="cmd">.</div>
    <p>→ Turn ON Auto-Reply in this GC</p>
    
    <div class="cmd">.. @userID</div>
    <p>→ LOCK & TARGET that person — non-stop hamol until reply</p>
    
    <div class="cmd">.stop</div>
    <p>→ STOP everything</p>
    
    <button class="sec" onclick="restartBot()">🔄 RESTART BOT</button>
  </div>

<script>
async function loadSettings() {
  try {
    const [stRes, setRes] = await Promise.all([
      fetch('/api/status'),
      fetch('/api/settings')
    ]);
    const st = await stRes.json();
    const set = await setRes.json();
    
    document.getElementById('status').innerHTML = st.online 
      ? '<span class="on">✅ ONLINE</span>' 
      : '<span class="off">❌ OFFLINE</span>';
    document.getElementById('uptime').textContent = st.uptime || '-';
    document.getElementById('locked').textContent = st.lockedTarget || '-';
    
    document.getElementById('adminInput').value = set.adminId || '';
    document.getElementById('hamolInput').value = set.hamolReplies.join('\\n');
    document.getElementById('trollInput').value = set.trollReplies.join('\\n');
    document.getElementById('suffixInput').value = set.suffixes.join('\\n');
    document.getElementById('delayMin').value = set.delayMin;
    document.getElementById('delayMax').value = set.delayMax;
  } catch(e){}
}

async function saveSession() {
  const val = document.getElementById('sessionInput').value.trim();
  const msgEl = document.getElementById('sessionMsg');
  try {
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({session: val})
    });
    const d = await res.json();
    msgEl.className = 'msg ' + (d.success ? 'ok' : 'err');
    msgEl.textContent = d.message;
  } catch(e){}
}

async function saveAdmin() {
  const adminId = document.getElementById('adminInput').value.trim();
  const msgEl = document.getElementById('adminMsg');
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({adminId})
  });
  const d = await res.json();
  msgEl.className = 'msg ' + (d.success ? 'ok' : 'err');
  msgEl.textContent = d.message;
}

async function saveAllReplies() {
  const hamol = document.getElementById('hamolInput').value.split('\\n').filter(x=>x.trim());
  const troll = document.getElementById('trollInput').value.split('\\n').filter(x=>x.trim());
  const suffix = document.getElementById('suffixInput').value.split('\\n');
  const dMin = parseInt(document.getElementById('delayMin').value);
  const dMax = parseInt(document.getElementById('delayMax').value);
  
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      hamolReplies: hamol,
      trollReplies: troll,
      suffixes: suffix,
      delayMin: dMin,
      delayMax: dMax
    })
  });
  const d = await res.json();
  document.getElementById('replyMsg').className = 'msg ' + (d.success ? 'ok' : 'err');
  document.getElementById('replyMsg').textContent = d.message;
}

async function restartBot() {
  await fetch('/api/restart', {method:'POST'});
  setTimeout(loadSettings, 2000);
}

loadSettings();
setInterval(loadSettings, 5000);
</script>
</body>
</html>
  `);
});

// ============================================================
// ▶️ START
// ============================================================
app.listen(PORT, () => {
  console.log(chalk.green(`\n🚀 DASHBOARD RUNNING → http://localhost:${PORT}`));
  console.log(chalk.yellow(`Open the URL to configure your bot!\n`));
  if (botData.session && botData.adminId) {
    connectBot();
  } else {
    console.log(chalk.cyan(`⚠️ Go to Dashboard → Enter Admin ID + C3C Session`));
  }
});
