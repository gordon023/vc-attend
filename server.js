import express from "express";
import http from "http";
import { Server as SocketServer } from "socket.io";
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import ExcelJS from "exceljs";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { Client, GatewayIntentBits, Events } from "discord.js";
import { startOfDay, startOfWeek } from "date-fns";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const dataFile = path.join(__dirname, "data", "attendance.json");
fs.ensureFileSync(dataFile);

let attendance = { history: [], active: {}, stats: {} };

// Load saved data
if (fs.existsSync(dataFile)) {
  try {
    const content = fs.readFileSync(dataFile, "utf8");
    attendance = content ? JSON.parse(content) : { history: [], active: {}, stats: {} };
  } catch (err) {
    console.error("Error reading attendance.json:", err.message);
    attendance = { history: [], active: {}, stats: {} };
  }
}

function saveData() {
  fs.writeFileSync(dataFile, JSON.stringify(attendance, null, 2));
}

function getSecondsDiff(startTime, endTime) {
  return Math.floor((new Date(endTime) - new Date(startTime)) / 1000);
}

function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

// ------------------ REST API ------------------
app.post("/voice-event", (req, res) => {
  const { type, user, channel } = req.body;
  const timestamp = new Date().toISOString();

  if (type === "join") {
    attendance.active[user] = { channel, joinedAt: timestamp };
  } else if (type === "leave") {
    if (attendance.active[user]) {
      const joinedAt = attendance.active[user].joinedAt;
      const duration = getSecondsDiff(joinedAt, timestamp);
      if (!attendance.stats[user]) attendance.stats[user] = 0;
      attendance.stats[user] += duration;
    }
    delete attendance.active[user];
  }

  attendance.history.unshift({ type, user, channel, time: timestamp });
  if (attendance.history.length > 100) attendance.history.pop();

  io.emit("update", attendance);
  saveData();
  res.sendStatus(200);
});

io.on("connection", (socket) => {
  socket.emit("update", attendance);
});

// ------------------ Leaderboards ------------------
function calculateVCStats(history, filterFn) {
  const stats = {};
  for (const h of history) {
    if (h.type === "leave" && (!filterFn || filterFn(h))) {
      const join = history.find(
        j => j.user === h.user && j.type === "join" && new Date(j.time) <= new Date(h.time)
      );
      if (!join) continue;
      const seconds = getSecondsDiff(join.time, h.time);
      if (!stats[h.user]) stats[h.user] = 0;
      stats[h.user] += seconds;
    }
  }
  return Object.entries(stats)
    .map(([user, time]) => ({ user, time: formatDuration(time) }))
    .sort((a, b) => b.time.localeCompare(a.time));
}

app.get("/leaderboard/daily", (req, res) => {
  const today = startOfDay(new Date());
  const list = calculateVCStats(attendance.history, h => new Date(h.time) >= today);
  res.json(list);
});

app.get("/leaderboard/weekly", (req, res) => {
  const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
  const list = calculateVCStats(attendance.history, h => new Date(h.time) >= weekStart);
  res.json(list);
});

app.get("/leaderboard/all", (req, res) => {
  const list = calculateVCStats(attendance.history);
  res.json(list);
});

// ------------------ XLSX Export ------------------
app.get("/export/xlsx/:type", async (req, res) => {
  try {
    const { type } = req.params;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Discord VC Tracker";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("Stats");
    sheet.columns = [
      { header: "User", key: "user", width: 30 },
      { header: "VC Time", key: "time", width: 20 },
    ];

    let filteredHistory = attendance.history;
    const now = new Date();

    if (type === "daily") {
      const today = startOfDay(now);
      filteredHistory = attendance.history.filter(h => new Date(h.time) >= today);
    } else if (type === "weekly") {
      const weekStart = startOfWeek(now, { weekStartsOn: 1 });
      filteredHistory = attendance.history.filter(h => new Date(h.time) >= weekStart);
    }

    const stats = {};
    for (const h of filteredHistory) {
      if (h.type === "leave") {
        const join = filteredHistory.find(
          j => j.user === h.user && j.type === "join" && new Date(j.time) <= new Date(h.time)
        );
        if (!join) continue;
        const seconds = getSecondsDiff(join.time, h.time);
        if (!stats[h.user]) stats[h.user] = 0;
        stats[h.user] += seconds;
      }
    }

    for (const [user, seconds] of Object.entries(stats)) {
      sheet.addRow({ user, time: formatDuration(seconds) });
    }

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="attendance_${type}.xlsx"`
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("XLSX export failed:", err);
    res.status(500).send("Failed to export XLSX");
  }
});

// ------------------ Discord Bot ------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

const GUILD_ID = process.env.GUILD_ID;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;
const WEB_API_URL = process.env.WEB_API_URL || "http://localhost:3000";

client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`🎧 Tracking voice channel ID: ${VOICE_CHANNEL_ID}`);
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    const user = newState.member?.user?.username;
    if (!user) return;

    const guildId = newState.guild.id;
    const joinedChannel = newState.channelId;
    const leftChannel = oldState.channelId;

    if (guildId !== GUILD_ID) return;

    if (joinedChannel === VOICE_CHANNEL_ID && leftChannel !== VOICE_CHANNEL_ID) {
      await sendEvent({ type: "join", user, channel: newState.channel?.name || "VC" });
      console.log(`📡 ${user} joined VC`);
    }

    if (leftChannel === VOICE_CHANNEL_ID && joinedChannel !== VOICE_CHANNEL_ID) {
      await sendEvent({ type: "leave", user, channel: oldState.channel?.name || "VC" });
      console.log(`📡 ${user} left VC`);
    }
  } catch (err) {
    console.error("VoiceStateUpdate error:", err);
  }
});

async function sendEvent(event) {
  try {
    const res = await fetch(`${WEB_API_URL}/voice-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!res.ok) console.error(`Failed to send event: ${res.status}`);
  } catch (err) {
    console.error("Failed to send event:", err.message);
  }
}

client.login(process.env.BOT_TOKEN);

// ------------------ Start Server ------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌐 Server + Bot running on port ${PORT}`));
