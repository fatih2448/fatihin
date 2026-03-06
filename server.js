const express  = require("express");
const http     = require("http");
const https    = require("https");
const { Server } = require("socket.io");
const bcrypt   = require("bcryptjs");
const multer   = require("multer");
const path     = require("path");
const fs       = require("fs");
const crypto   = require("crypto");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json());
// index.html neredeyse oradan sun (public/ varsa oradan, yoksa root'tan)
const publicDir = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : __dirname;
app.use(express.static(publicDir));

// ─────────────────────────────────────────────
//  HOST BİLGİLERİ
// ─────────────────────────────────────────────
const HOST_USERNAME = "admin";
const HOST_PASSWORD = bcrypt.hashSync("1234", 10);
// ─────────────────────────────────────────────

const validTokens = new Set();

const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
app.use("/uploads", express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, "video_" + Date.now() + path.extname(file.originalname)),
});
const upload = multer({
  storage,
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /mp4|webm|ogg|mkv|mov|avi/i.test(path.extname(file.originalname))),
});

// ─── Oda durumu ───────────────────────────────
let room = {
  type:      "none",
  videoId:   null,
  videoUrl:  null,
  videoName: null,
  isPlaying: false,
  position:  0,
  updatedAt: Date.now(),
};

function currentPos() {
  if (!room.isPlaying) return room.position;
  return room.position + (Date.now() - room.updatedAt) / 1000;
}

function snapshot() {
  return { ...room, position: currentPos(), updatedAt: Date.now(), isPlaying: room.isPlaying };
}

const connectedUsers = {};

// ─── Cookie ───────────────────────────────────
function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map(c => {
    const [k, ...v] = c.trim().split("=");
    return [k, decodeURIComponent(v.join("="))];
  }));
}
function isHost(req) {
  const { host_token } = parseCookies(req);
  return host_token && validTokens.has(host_token);
}

// ─────────────────────────────────────────────
//  🏓 PING ENDPOINT
//  UptimeRobot / cron-job.org bu URL'yi çağırır:
//  https://SİTEN.onrender.com/ping
// ─────────────────────────────────────────────
app.get("/ping", (req, res) => {
  res.json({
    status:  "ok",
    time:    new Date().toISOString(),
    uptime:  Math.floor(process.uptime()) + "s",
    viewers: Object.keys(connectedUsers).length,
  });
});

// ─────────────────────────────────────────────
//  🔄 SELF-PING (ikincil önlem)
//  Render, RENDER_EXTERNAL_URL'yi otomatik set eder.
//  Her 14 dakikada bir kendi /ping'ine istek atar.
// ─────────────────────────────────────────────
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  const INTERVAL = 14 * 60 * 1000; // 14 dakika
  setInterval(() => {
    const target = `${SELF_URL}/ping`;
    const mod = target.startsWith("https") ? https : http;
    const req = mod.get(target, (res) => {
      console.log(`[self-ping] ✓ ${res.statusCode} — ${new Date().toLocaleTimeString("tr-TR")}`);
    });
    req.on("error", (err) => console.warn(`[self-ping] ✗ ${err.message}`));
    req.end();
  }, INTERVAL);
  console.log(`🏓 Self-ping aktif: ${SELF_URL}/ping  (her 14 dakikada bir)`);
}

// ─── API ──────────────────────────────────────
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (username !== HOST_USERNAME || !bcrypt.compareSync(password, HOST_PASSWORD))
    return res.status(401).json({ error: "Kullanıcı adı veya şifre hatalı!" });

  const token   = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toUTCString();
  validTokens.add(token);
  res.setHeader("Set-Cookie", `host_token=${token}; Path=/; Expires=${expires}; HttpOnly; SameSite=Lax`);
  res.json({ ok: true, username: HOST_USERNAME });
});

app.get("/api/me", (req, res) => {
  res.json(isHost(req) ? { role: "host", username: HOST_USERNAME } : { role: "viewer" });
});

app.post("/api/upload", (req, res, next) => {
  if (!isHost(req)) return res.status(403).json({ error: "Yetkisiz" });
  next();
}, upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Dosya yüklenemedi." });
  res.json({ url: "/uploads/" + req.file.filename, name: req.file.originalname });
});

app.get("/api/videos", (req, res) => {
  const files = fs.readdirSync(UPLOAD_DIR).map(f => ({ url: "/uploads/" + f, name: f }));
  res.json(files);
});

app.delete("/api/videos/:name", (req, res) => {
  if (!isHost(req)) return res.status(403).json({ error: "Yetkisiz" });
  const file = path.join(UPLOAD_DIR, req.params.name);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  res.json({ ok: true });
});

// ─── Socket.io ────────────────────────────────
io.on("connection", (socket) => {

  socket.on("join", ({ role }) => {
    connectedUsers[socket.id] = { role };
    socket.emit("sync", snapshot());
    broadcastViewers();
  });

  function hostOnly(fn) {
    return (...args) => {
      if (connectedUsers[socket.id]?.role !== "host") return;
      fn(...args);
    };
  }

  socket.on("setYoutube", hostOnly(({ videoId }) => {
    room = { type:"youtube", videoId, videoUrl:null, videoName:null, isPlaying:false, position:0, updatedAt:Date.now() };
    io.emit("sync", snapshot());
  }));

  socket.on("setLocal", hostOnly(({ url, name }) => {
    room = { type:"local", videoId:null, videoUrl:url, videoName:name, isPlaying:false, position:0, updatedAt:Date.now() };
    io.emit("sync", snapshot());
  }));

  socket.on("play", hostOnly(({ position }) => {
    room = { ...room, isPlaying:true, position: position ?? currentPos(), updatedAt:Date.now() };
    io.emit("sync", snapshot());
  }));

  socket.on("pause", hostOnly(({ position }) => {
    room = { ...room, isPlaying:false, position: position ?? currentPos(), updatedAt:Date.now() };
    io.emit("sync", snapshot());
  }));

  socket.on("seek", hostOnly(({ position }) => {
    room = { ...room, position, updatedAt:Date.now() };
    io.emit("sync", snapshot());
  }));

  socket.on("disconnect", () => {
    delete connectedUsers[socket.id];
    broadcastViewers();
  });
});

function broadcastViewers() {
  io.emit("viewers", Object.keys(connectedUsers).length);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎬 Watch Party    → http://localhost:${PORT}`);
  console.log(`👑 Host           → ${HOST_USERNAME} / 1234`);
  console.log(`🏓 Ping endpoint  → http://localhost:${PORT}/ping\n`);
});
