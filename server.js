"use strict";
/*
 * Le Salon — serveur temps réel.
 * Sert la page (public/index.html) et relaie l'état de chacun par WebSocket.
 * Tout est en mémoire : quand tout le monde part, la salle est vide.
 *
 * Variables d'environnement (toutes facultatives) :
 *   PORT         port d'écoute (défaut 3000)
 *   ROOM_CODE    code à saisir pour entrer (recommandé si le lien est public)
 *   MAX_CLIENTS  nombre maximum de connexions simultanées (défaut 100)
 *   WEATHER_CITY nom affiché pour la météo des fenêtres (défaut « Paris »)
 *   WEATHER_LAT  latitude du lieu (défaut 48.8566)
 *   WEATHER_LON  longitude du lieu (défaut 2.3522)
 *
 * La météo vient d'Open-Meteo (gratuit, sans clé) et est mise à jour toutes les 10 minutes.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const ROOM_CODE = (process.env.ROOM_CODE || "").trim();
const MAX_CLIENTS = Number(process.env.MAX_CLIENTS) || 100;
const INDEX = path.join(__dirname, "index.html");

const W_CITY = (process.env.WEATHER_CITY || "Paris").slice(0, 30);
const W_LAT = process.env.WEATHER_LAT !== undefined && process.env.WEATHER_LAT !== "" ? Number(process.env.WEATHER_LAT) : 48.8566;
const W_LON = process.env.WEATHER_LON !== undefined && process.env.WEATHER_LON !== "" ? Number(process.env.WEATHER_LON) : 2.3522;
const W_API = process.env.WEATHER_API || "https://api.open-meteo.com/v1/forecast";

const ACCS = ["aucun", "chat", "bonnet", "lunettes"];
const ACTS = ["lire", "jouer", "travailler", "pause"];
const NB_COULEURS = 6;

/* ---------- HTTP ---------- */
const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/" || url === "/index.html") {
    fs.readFile(INDEX, (err, buf) => {
      if (err) { res.writeHead(500); res.end("Erreur serveur"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(buf);
    });
  } else if (url === "/config") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ needCode: !!ROOM_CODE }));
  } else if (url === "/healthz") {
    res.writeHead(200); res.end("ok");
  } else {
    res.writeHead(404); res.end("Introuvable");
  }
});

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });

server.on("upgrade", (req, socket, head) => {
  const url = (req.url || "").split("?")[0];
  let sameOrigin = true;
  if (req.headers.origin) {
    try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch { sameOrigin = false; }
  }
  if (url !== "/ws" || !sameOrigin) { socket.destroy(); return; }
  if (wss.clients.size >= MAX_CLIENTS) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

function cleanStr(v, max) {
  if (typeof v !== "string") return "";
  const t = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "").trim();
  return Array.from(t).slice(0, max).join("");
}
function sanitize(s) {
  if (!s || typeof s !== "object") return null;
  const name = cleanStr(s.name, 16);
  if (!name) return null; // pas de nom, pas de personnage
  return {
    name,
    ci: Number.isInteger(s.ci) && s.ci >= 0 && s.ci < NB_COULEURS ? s.ci : 0,
    acc: ACCS.includes(s.acc) ? s.acc : "aucun",
    act: ACTS.includes(s.act) ? s.act : null,
    note: cleanStr(s.note, 40),
  };
}
function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function allow(ws) { // ~10 messages/s, rafales de 20
  const now = Date.now();
  ws.tokens = Math.min(20, ws.tokens + (now - ws.last) / 100);
  ws.last = now;
  if (ws.tokens < 1) return false;
  ws.tokens -= 1;
  return true;
}
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

/* ---------- Météo (Open-Meteo) ---------- */
let weather = null;
async function fetchWeather() {
  try {
    if (!Number.isFinite(W_LAT) || !Number.isFinite(W_LON)) throw new Error("coordonnées invalides");
    const url = `${W_API}?latitude=${W_LAT}&longitude=${W_LON}&current=temperature_2m,weather_code,is_day,wind_speed_10m&timezone=auto`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const c = (await r.json()).current;
    const code = Number(c && c.weather_code), temp = Number(c && c.temperature_2m);
    if (!Number.isFinite(code) || !Number.isFinite(temp)) throw new Error("réponse inattendue");
    const w = { code, day: c.is_day === 0 ? 0 : 1, temp: Math.round(temp), city: W_CITY };
    if (!weather || JSON.stringify(weather) !== JSON.stringify(w)) {
      weather = w;
      wss.clients.forEach((cl) => { if (cl.authed) send(cl, { t: "weather", w }); });
    }
  } catch (e) {
    console.log("Météo indisponible pour le moment :", e.message);
  }
}

let pending = false;
function broadcastSoon() {
  if (pending) return;
  pending = true;
  setTimeout(() => { pending = false; broadcast(); }, 50);
}
function broadcast() {
  const peers = [];
  wss.clients.forEach((c) => { if (c.authed && c.state) peers.push({ id: c.id, ...c.state }); });
  const msg = JSON.stringify({ t: "peers", peers });
  wss.clients.forEach((c) => { if (c.authed && c.readyState === 1) c.send(msg); });
}

wss.on("connection", (ws) => {
  ws.id = crypto.randomBytes(5).toString("hex");
  ws.authed = !ROOM_CODE;
  ws.state = null;
  ws.alive = true;
  ws.tokens = 20;
  ws.last = Date.now();
  ws.denials = 0;

  send(ws, { t: "welcome", id: ws.id });
  if (ws.authed) { if (weather) send(ws, { t: "weather", w: weather }); broadcastSoon(); }

  ws.on("pong", () => { ws.alive = true; });
  ws.on("error", () => {});
  ws.on("close", () => { if (ws.state) broadcastSoon(); });

  ws.on("message", (data) => {
    if (!allow(ws)) return;
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (!m || typeof m !== "object") return;

    if (m.t === "hello") {
      if (!ROOM_CODE) return;
      if (typeof m.code === "string" && safeEqual(m.code, ROOM_CODE)) {
        ws.authed = true;
        if (weather) send(ws, { t: "weather", w: weather });
        broadcastSoon();
      } else {
        ws.authed = false; ws.state = null;
        send(ws, { t: "denied" });
        if (++ws.denials > 5) ws.close();
        broadcastSoon();
      }
    } else if (m.t === "set") {
      if (!ws.authed) return;
      const clean = sanitize(m.s);
      if (!clean) return;
      const prev = ws.state;
      // l'heure d'installation est fixée par le serveur : ordre des sièges identique pour tous
      clean.since = prev && prev.act === clean.act ? prev.since : Date.now();
      ws.state = clean;
      broadcastSoon();
    }
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.alive) { ws.terminate(); return; }
    ws.alive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

fetchWeather();
setInterval(fetchWeather, 10 * 60 * 1000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Le Salon est ouvert sur http://localhost:${PORT}` + (ROOM_CODE ? " (code requis)" : " (ouvert à tous ceux qui ont le lien)"));
});
