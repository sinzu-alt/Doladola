const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const chalk = require('chalk');
const { login } = require('ws3-fca');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'bot_data.json');

// ============================================================
// 💾 DATA STORAGE — PERMANENT STORAGE
// ============================================================
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const defaultData = {
      adminId: "",
      session: "",
      autoReplies: [
        "Noted! Nabasang maigi.",
        "Sige boss, copy that.",
        "Hello! Received your message.",
        "Copy! Sandali lang po.",
        "On it! Wait lang nang kaunti."
      ],
      suffixes: ["", " ~ LGC Bot", " 🩸"],
      delayMin: 3000,
      delayMax: 5000
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
let activeThreads = new Set();
let userCooldowns = new Map(); // Anti-spam tracking (UserId_ThreadId -> Timestamp)
let startTime = Date.now();
let botStatus = { online: false, lastError: "" };

// ============================================================
// 🔧 HELPERS
// ============================================================
function rand(arr) { 
  if (!arr || arr.length === 0) return "";
  return arr[Math.floor(Math.random() * arr.length)]; 
}

function randomDelay() {
  const min = parseInt(botData.delayMin) || 3000;
  const max = parseInt(botData.delayMax) || 5000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
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
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1"
  ];

  login({
    appState: JSON.parse(botData.session),
    userAgent: rand(agents),
    forceLogin: false,
    logLevel: "silent"
  }, async (err, apiObj) => {
    if (err) {
      reconnectCount++;
      botStatus.lastError = err.message ? err.message.slice(0, 60) : "Login Error";
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
    console.log(chalk.green(`✅ ONLINE — Auto-Reply Bot Active! ID: ${userID}`));

    api.setOptions({
      listenEvents: true,
      selfListen: false,
      online: true,
      autoMarkRead: false,
      autoMarkDelivery: false
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
        activeThreads.add(tid);
        api.setMessageReaction("🩸", mid, () => {}, true);
        api.sendMessage("✅ AUTO-REPLY ON", tid);
        console.log(chalk.green(`✅ AUTO-REPLY ON — GC: ${tid}`));
        return;
      }

      if (msg === ".stop" && sid === botData.adminId) {
        activeThreads.delete(tid);
        api.setMessageReaction("🩸", mid, () => {}, true);
        api.sendMessage("🛑 AUTO-REPLY OFF 🩸", tid);
        console.log(chalk.yellow(`🛑 AUTO-REPLY OFF — GC: ${tid}`));
        return;
      }

      // NORMAL AUTO-REPLY LOGIC (WALANG SPAM LOOP)
      if (activeThreads.has(tid) && sid !== botData.adminId) {
        // Anti-Spam Cooldown Check (1 Reply per Hour per User)
        const cooldownKey = `${sid}_${tid}`;
        const now = Date.now();
        const ONE_HOUR = 60 * 60 * 1000;

        if (userCooldowns.has(cooldownKey)) {
          const lastReplied = userCooldowns.get(cooldownKey);
          if (now - lastReplied < ONE_HOUR) return;
        }

        userCooldowns.set(cooldownKey, now);

        // Fixed / Random Delay Control Bago Sumagot
        setTimeout(() => {
          if (!activeThreads.has(tid)) return;
          const reply = rand(botData.autoReplies) + rand(botData.suffixes);
          api.sendMessage(reply, tid, mid);
          console.log(chalk.green(`✅ REPLIED to ${sid} in ${tid}: ${reply}`));
        }, randomDelay());
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

app.get('/api/status', (req, res) => {
  res.json({
    online: botStatus.online,
    uptime: botStatus.online ? getUptime() : null,
    adminId: botData.adminId,
    activeGcCount: activeThreads.size,
    lastError: botStatus.lastError
  });
});

app.get('/api/settings', (req, res) => {
  res.json({
    adminId: botData.adminId,
    autoReplies: botData.autoReplies,
    suffixes: botData.suffixes,
    delayMin: botData.delayMin,
    delayMax: botData.delayMax
  });
});

app.post('/api/settings', (req, res) => {
  const { adminId, autoReplies, suffixes, delayMin, delayMax } = req.body;
  if (adminId !== undefined) botData.adminId = adminId;
  if (autoReplies) botData.autoReplies = autoReplies;
  if (suffixes) botData.suffixes = suffixes;
  if (delayMin) botData.delayMin = delayMin;
  if (delayMax) botData.delayMax = delayMax;
  saveData(botData);
  res.json({ success: true, message: "✅ Settings saved!" });
});

app.post('/api/session', (req, res) => {
  const { session } = req.body;
  try {
    JSON.parse(session);
    botData.session = session;
    saveData(botData);
    res.json({ success: true, message: "✅ Session saved! Connecting..." });
    setTimeout(connectBot, 2000);
  } catch (e) {
    res.status(400).json({ success: false, message: "❌ Invalid JSON session!" });
  }
});

app.post('/api/restart', (req, res) => {
  botStatus.online = false;
  activeThreads.clear();
  setTimeout(connectBot, 1500);
  res.json({ success: true, message: "🔄 Restarting..." });
});

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>AUTO-REPLY BOT DASHBOARD</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    *{margin:0;padding:0;box-sizing:border-box;font-family:system-ui,-apple-system,sans-serif}
    body{background:#0a0a0a;color:#fff;padding:20px;max-width:900px;margin:0 auto}
    h1{color:#3b82f6;margin-bottom:5px;font-size:24px}
    .stat{background:#121212;padding:15px;border-radius:10px;margin:10px 0;border-left:4px solid #3b82f6}
    .on{color:#22c55e;font-weight:bold}
    .off{color:#ef4444;font-weight:bold}
    .card{background:#121212;padding:20px;border-radius:12px;margin:15px 0;border:1px solid #222}
    label{display:block;margin:15px 0 5px;font-weight:600;color:#ddd}
    input,textarea{width:100%;background:#1e1e1e;border:1px solid #333;padding:12px;border-radius:8px;color:#fff;font-size:14px}
    textarea{min-height:100px;resize:vertical}
    button{background:#2563eb;border:none;padding:12px 24px;border-radius:8px;color:#fff;font-weight:bold;cursor:pointer;font-size:15px;margin:5px 5px 5px 0}
    button:hover{background:#1d4ed8}
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
  <h1>🤖 AUTO-REPLY BOT DASHBOARD</h1>
  <p style="color:#888;margin-bottom:20px">Configure your non-spam auto-reply bot settings here.</p>

  <div class="stat">
    <strong>STATUS: </strong>
    <span id="status">Checking...</span>
    <div style="margin-top:8px;font-size:13px;color:#888">
      Uptime: <span id="uptime">-</span> | 
      Active GCs: <span id="activeGc">-</span>
    </div>
  </div>

  <div class="card">
    <h3>🔑 C3C / AppState Session</h3>
    <textarea id="sessionInput" placeholder='Paste AppState JSON here...'></textarea>
    <button onclick="saveSession()">💾 SAVE SESSION</button>
    <div id="sessionMsg" class="msg"></div>
  </div>

  <div class="card">
    <h3>👑 ADMIN SETTINGS</h3>
    <label>Your Facebook User ID</label>
    <input type="text" id="adminInput" placeholder="1000xxxxxxxxx">
    <button onclick="saveAdmin()">💾 SAVE ADMIN ID</button>
    <div id="adminMsg" class="msg"></div>
  </div>

  <div class="card">
    <h3>💬 REPLIES & SUFFIXES</h3>
    <label>Auto-Replies (one per line)</label>
    <textarea id="replyInput" placeholder="Noted po!\nCopy that."></textarea>
    
    <label>Suffixes (one per line)</label>
    <textarea id="suffixInput" placeholder="\n ~ LGC Bot\n 🩸"></textarea>
    
    <div class="grid">
      <div>
        <label>Min Delay (ms)</label>
        <input type="number" id="delayMin" value="3000">
      </div>
      <div>
        <label>Max Delay (ms)</label>
        <input type="number" id="delayMax" value="5000">
      </div>
    </div>
    
    <button onclick="saveAllReplies()">💾 SAVE ALL REPLIES</button>
    <div id="replyMsg" class="msg"></div>
  </div>

  <div class="card">
    <h3>📝 GC COMMANDS (Admin Only)</h3>
    <div class="cmd">.</div>
    <p>→ Turn ON Auto-Reply in the current GC</p>
    
    <div class="cmd">.stop</div>
    <p>→ STOP Auto-Reply in the current GC</p>
    
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
    document.getElementById('activeGc').textContent = st.activeGcCount || '0';
    
    document.getElementById('adminInput').value = set.adminId || '';
    document.getElementById('replyInput').value = (set.autoReplies || []).join('\n');
    document.getElementById('suffixInput').value = (set.suffixes || []).join('\n');
    document.getElementById('delayMin').value = set.delayMin || 3000;
    document.getElementById('delayMax').value = set.delayMax || 5000;
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
  const replies = document.getElementById('replyInput').value.split('\n').filter(x=>x.trim());
  const suffixes = document.getElementById('suffixInput').value.split('\n');
  const dMin = parseInt(document.getElementById('delayMin').value);
  const dMax = parseInt(document.getElementById('delayMax').value);
  
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      autoReplies: replies,
      suffixes: suffixes,
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

app.listen(PORT, () => {
  console.log(chalk.green(`\n🚀 DASHBOARD RUNNING → http://localhost:${PORT}`));
  if (botData.session && botData.adminId) {
    connectBot();
  } else {
    console.log(chalk.cyan(`⚠️ Go to Dashboard → Enter Admin ID + Session`));
  }
});
