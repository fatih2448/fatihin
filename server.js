const express  = require("express");
const http     = require("http");
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
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────
//  HOST BİLGİLERİ
// ─────────────────────────────────────────────
const HOST_USERNAME = "admin";
const HOST_PASSWORD = bcrypt.hashSync("4321adam", 10);
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
// position ve updatedAt her zaman doğru tutulur.
// Birisi katıldığında computedPosition() ile anlık pozisyonu hesaplarız.
let room = {
  type:      "none",    // "none" | "youtube" | "local"
  videoId:   null,
  videoUrl:  null,
  videoName: null,
  isPlaying: false,
  position:  0,         // isPlaying=false ise sabit pozisyon
  updatedAt: Date.now(),// isPlaying=true ise bu andan itibaren geçen süre eklenir
};

// Anlık pozisyonu hesapla
function currentPos() {
  if (!room.isPlaying) return room.position;
  return room.position + (Date.now() - room.updatedAt) / 1000;
}

// Durum snapshot'ı — her zaman gerçek pozisyonu içerir
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

  // Katıl — anlık pozisyonu gönder
  socket.on("join", ({ role }) => {
    connectedUsers[socket.id] = { role };
    // Yeni katılana o anki gerçek durumu gönder
    socket.emit("sync", snapshot());
    broadcastViewers();
  });

  // ── Host komutları ──────────────────────────
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
    // Pozisyonu kaydet, oynatmayı başlat
    room = { ...room, isPlaying:true, position: position ?? currentPos(), updatedAt:Date.now() };
    io.emit("sync", snapshot());
  }));

  socket.on("pause", hostOnly(({ position }) => {
    // Duraklat — pozisyonu kaydet
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
  console.log(`\n🎬 Watch Party → http://localhost:${PORT}`);
  console.log(`👑 Host: ${HOST_USERNAME} / 1234\n`);
});
