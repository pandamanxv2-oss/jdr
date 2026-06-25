const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
 
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
 
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
 
const TRACKS_DIR = path.join(__dirname, 'public', 'tracks');
if (!fs.existsSync(TRACKS_DIR)) fs.mkdirSync(TRACKS_DIR, { recursive: true });
 
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TRACKS_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, Date.now() + '_' + safe);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 150 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /audio\/(mpeg|ogg|wav|mp4|aac|flac|webm)/.test(file.mimetype)
             || /\.(mp3|ogg|wav|m4a|aac|flac|webm)$/i.test(file.originalname);
    cb(null, ok);
  }
});
 
let musicState = {
  status: 'stopped',
  trackUrl: '',
  trackName: '',
  currentTime: 0,
  volume: 0.8,
  startedAt: null,
};
 
let trackList = [];
function refreshTrackList() {
  trackList = fs.readdirSync(TRACKS_DIR)
    .filter(f => /\.(mp3|ogg|wav|m4a|aac|flac|webm)$/i.test(f))
    .map(f => ({
      filename: f,
      name: f.replace(/^\d+_/, '').replace(/\.[^.]+$/, ''),
      url: '/tracks/' + f,
      size: fs.statSync(path.join(TRACKS_DIR, f)).size,
    }))
    .sort((a, b) => b.filename.localeCompare(a.filename));
}
refreshTrackList();
 
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
 
app.get('/api/status', (req, res) => {
  res.json({ clients: wss.clients.size, state: musicState });
});
 
app.get('/api/tracks', (req, res) => {
  refreshTrackList();
  res.json(trackList);
});
 
app.post('/api/upload', (req, res) => {
  const pass = req.headers['x-admin-password'];
  if (pass !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Mot de passe incorrect' });
  upload.single('track')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier recu' });
    refreshTrackList();
    const track = {
      filename: req.file.filename,
      name: req.file.originalname.replace(/\.[^.]+$/, ''),
      url: '/tracks/' + req.file.filename,
      size: req.file.size,
    };
    res.json({ ok: true, track });
  });
});
 
app.delete('/api/tracks/:filename', (req, res) => {
  const pass = req.headers['x-admin-password'];
  if (pass !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Non autorise' });
  const file = path.join(TRACKS_DIR, path.basename(req.params.filename));
  if (fs.existsSync(file)) fs.unlinkSync(file);
  refreshTrackList();
  res.json({ ok: true });
});
 
function broadcast(msg, exceptWs) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(function(c) {
    if (c.readyState === WebSocket.OPEN && c !== exceptWs) c.send(data);
  });
}
 
function getCurrentTime() {
  if (musicState.status === 'playing' && musicState.startedAt)
    return musicState.currentTime + (Date.now() - musicState.startedAt) / 1000;
  return musicState.currentTime;
}
 
wss.on('connection', function(ws) {
  console.log('Client connecte - total: ' + wss.clients.size);
  ws.send(JSON.stringify({ type: 'sync', state: Object.assign({}, musicState, { currentTime: getCurrentTime() }) }));
 
  ws.on('message', function(raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }
    if (msg.password !== ADMIN_PASSWORD) {
      ws.send(JSON.stringify({ type: 'error', message: 'Mot de passe incorrect' }));
      return;
    }
    switch (msg.type) {
      case 'play':
        musicState.currentTime = msg.currentTime != null ? msg.currentTime : musicState.currentTime;
        musicState.startedAt = Date.now();
        musicState.status = 'playing';
        broadcast({ type: 'play', currentTime: musicState.currentTime, serverTime: musicState.startedAt });
        break;
      case 'pause':
        musicState.currentTime = getCurrentTime();
        musicState.startedAt = null;
        musicState.status = 'paused';
        broadcast({ type: 'pause', currentTime: musicState.currentTime });
        break;
      case 'stop':
        musicState.currentTime = 0;
        musicState.startedAt = null;
        musicState.status = 'stopped';
        broadcast({ type: 'stop' });
        break;
      case 'seek':
        musicState.currentTime = msg.currentTime;
        if (musicState.status === 'playing') musicState.startedAt = Date.now();
        broadcast({ type: 'seek', currentTime: msg.currentTime, serverTime: Date.now(), status: musicState.status });
        break;
      case 'volume':
        musicState.volume = msg.volume;
        broadcast({ type: 'volume', volume: msg.volume });
        break;
      case 'set_track':
        musicState.trackUrl = msg.trackUrl;
        musicState.trackName = msg.trackName || 'Piste sans nom';
        musicState.status = 'stopped';
        musicState.currentTime = 0;
        musicState.startedAt = null;
        broadcast({ type: 'track_changed', trackUrl: msg.trackUrl, trackName: musicState.trackName });
        break;
    }
  });
 
  ws.on('close', function() { console.log('Client deconnecte - restants: ' + wss.clients.size); });
});
 
server.listen(PORT, function() {
  console.log('Serveur LARP Music sur port ' + PORT);
  console.log('Mot de passe: ' + ADMIN_PASSWORD);
});
