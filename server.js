var express = require('express');
var http = require('http');
var WebSocket = require('ws');
var multer = require('multer');
var path = require('path');
var fs = require('fs');

var app = express();
var server = http.createServer(app);
var wss = new WebSocket.Server({ server });

var PORT = process.env.PORT || 3000;
var ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '5788';

var TRACKS_DIR = path.join(__dirname, 'public', 'tracks');
if (!fs.existsSync(TRACKS_DIR)) fs.mkdirSync(TRACKS_DIR, { recursive: true });

var DATA_FILE = path.join(__dirname, 'gamedata.json');
var gameData = { trackNames: {}, playlists: [] };
if (fs.existsSync(DATA_FILE)) {
  try { gameData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(e) {}
}
function saveData() { fs.writeFileSync(DATA_FILE, JSON.stringify(gameData, null, 2)); }

var storage = multer.diskStorage({
  destination: function(req, file, cb) { cb(null, TRACKS_DIR); },
  filename: function(req, file, cb) {
    var safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, Date.now() + '_' + safe);
  }
});
var upload = multer({ storage: storage, limits: { fileSize: 200 * 1024 * 1024 } });

var PHASES = { WAITING: 'waiting', ROLES: 'roles', PLAYING: 'playing', ENDED: 'ended' };

var gameState = {
  phase: PHASES.WAITING,
  timerStart: null,
  timerDuration: 3600,
  timerPaused: false,
  timerElapsed: 0,
  timerEnded: false,
  announcements: [],
  pois: [],
  music: {
    status: 'stopped', trackUrl: '', trackName: '',
    currentTime: 0, volume: 0.8, startedAt: null, loop: false,
    playlist: [], playlistIndex: 0
  }
};

var players = new Map();
var idCounter = 0;
function genId() { return 'p' + (++idCounter); }

function getPlayersList() {
  // Liste complete (admin) : uniquement les joueurs ayant choisi un pseudo, avec leur position
  var list = [];
  players.forEach(function(p) {
    if (!p.pseudo) return;
    list.push({ id: p.id, pseudo: p.pseudo, role: p.role, alive: p.alive, location: p.location, lastSeen: p.lastSeen });
  });
  return list;
}
function getPublicPlayersList() {
  // Liste publique (joueurs) : pas de position des autres joueurs, pour la confidentialite
  var list = [];
  players.forEach(function(p) {
    if (!p.pseudo) return;
    list.push({ id: p.id, pseudo: p.pseudo, alive: p.alive, lastSeen: p.lastSeen });
  });
  return list;
}

function send(ws, msg) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
function broadcastAll(msg) {
  var data = JSON.stringify(msg);
  wss.clients.forEach(function(c) { if (c.readyState === WebSocket.OPEN) c.send(data); });
}
function broadcast(msg) {
  var data = JSON.stringify(msg);
  players.forEach(function(p, ws) { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
}
function broadcastToRoles(roles, msg) {
  var data = JSON.stringify(msg);
  players.forEach(function(p, ws) {
    if (roles.indexOf(p.role) !== -1 && ws.readyState === WebSocket.OPEN) ws.send(data);
  });
}

function getCurrentMusicTime() {
  var m = gameState.music;
  if (m.status === 'playing' && m.startedAt)
    return m.currentTime + (Date.now() - m.startedAt) / 1000;
  return m.currentTime;
}

function sendInitialState(ws, p) {
  var isAdm = p && p.isAdmin;
  send(ws, {
    type: 'game_state',
    phase: gameState.phase,
    timerStart: gameState.timerStart,
    timerDuration: gameState.timerDuration,
    timerPaused: gameState.timerPaused,
    timerElapsed: gameState.timerElapsed,
    timerEnded: gameState.timerEnded,
    announcements: gameState.announcements.slice(-20)
  });
  send(ws, { type: 'music_sync', music: Object.assign({}, gameState.music, { currentTime: getCurrentMusicTime() }) });
  if (isAdm) {
    send(ws, { type: 'players_update', players: getPlayersList(), admin: true });
  } else {
    send(ws, { type: 'players_update', players: getPublicPlayersList() });
    if (p && p.role) send(ws, { type: 'your_role', role: p.role, alive: p.alive });
  }
  // POIs: admin voit tout, joueurs voient seulement si partie en cours
  var myRole = p ? p.role : null;
  var canSeePois = isAdm || gameState.phase === PHASES.PLAYING || gameState.phase === PHASES.ENDED;
  var visiblePois = !canSeePois ? [] : (isAdm ? gameState.pois : gameState.pois.filter(function(poi) {
    return poi.visibleTo[0] === 'all' || poi.visibleTo.indexOf(myRole) !== -1;
  }));
  send(ws, { type: 'pois_update', pois: visiblePois });
}

// Track list
var trackList = [];
function refreshTracks() {
  if (!fs.existsSync(TRACKS_DIR)) return;
  trackList = fs.readdirSync(TRACKS_DIR)
    .filter(function(f) { return /\.(mp3|ogg|wav|m4a|flac)$/i.test(f); })
    .map(function(f) {
      var raw = f.replace(/^\d+_/, '').replace(/\.[^.]+$/, '');
      return { filename: f, url: '/tracks/' + f, name: (gameData.trackNames && gameData.trackNames[f]) || raw, size: fs.statSync(path.join(TRACKS_DIR, f)).size };
    })
    .sort(function(a, b) { return b.filename.localeCompare(a.filename); });
}
refreshTracks();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

function adminOnly(req, res, next) {
  if ((req.headers['x-admin-password'] || req.body.password) !== ADMIN_PASSWORD)
    return res.status(403).json({ error: 'Non autorise' });
  next();
}

app.get('/api/tracks', function(req, res) { refreshTracks(); res.json(trackList); });
app.get('/api/playlists', function(req, res) { res.json(gameData.playlists || []); });
app.get('/api/status', function(req, res) { res.json({ clients: wss.clients.size, phase: gameState.phase }); });

app.post('/api/upload', adminOnly, function(req, res) {
  upload.single('track')(req, res, function(err) {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Pas de fichier' });
    refreshTracks();
    res.json({ ok: true, track: { filename: req.file.filename, name: req.file.originalname.replace(/\.[^.]+$/, ''), url: '/tracks/' + req.file.filename, size: req.file.size } });
  });
});

app.post('/api/tracks/:f/rename', adminOnly, function(req, res) {
  if (!gameData.trackNames) gameData.trackNames = {};
  gameData.trackNames[req.params.f] = req.body.name;
  saveData(); refreshTracks();
  // Mettre a jour dans les playlists sauvegardees
  (gameData.playlists || []).forEach(function(pl) {
    (pl.tracks || []).forEach(function(t) { if (t.filename === req.params.f) t.name = req.body.name; });
  });
  saveData();
  res.json({ ok: true });
});

app.delete('/api/tracks/:f', adminOnly, function(req, res) {
  var fp = path.join(TRACKS_DIR, path.basename(req.params.f));
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  if (gameData.trackNames) delete gameData.trackNames[req.params.f];
  saveData(); refreshTracks(); res.json({ ok: true });
});

app.post('/api/playlists', adminOnly, function(req, res) {
  if (!gameData.playlists) gameData.playlists = [];
  var idx = -1;
  gameData.playlists.forEach(function(p, i) { if (p.name === req.body.name) idx = i; });
  var pl = { name: req.body.name, tracks: req.body.tracks || [] };
  if (idx >= 0) gameData.playlists[idx] = pl; else gameData.playlists.push(pl);
  saveData(); res.json({ ok: true });
});

app.post('/api/playlists/rename', adminOnly, function(req, res) {
  (gameData.playlists || []).forEach(function(p) { if (p.name === req.body.oldName) p.name = req.body.newName; });
  saveData(); res.json({ ok: true });
});

app.delete('/api/playlists/:name', adminOnly, function(req, res) {
  gameData.playlists = (gameData.playlists || []).filter(function(p) { return p.name !== req.params.name; });
  saveData(); res.json({ ok: true });
});

wss.on('connection', function(ws) {
  var id = genId();
  var info = { id: id, pseudo: '', role: null, alive: true, location: null, lastSeen: null, isAdmin: false };
  players.set(ws, info);
  send(ws, { type: 'welcome', id: id });
  sendInitialState(ws, info);

  ws.on('message', function(raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }
    var p = players.get(ws);
    if (!p) return;

    // Messages joueur sans mdp
    if (msg.type === 'set_pseudo') {
      var rawPseudo = (msg.pseudo || '').toString().substring(0, 24).trim();
      if (!rawPseudo || rawPseudo === ADMIN_PASSWORD) { send(ws, { type: 'error', message: 'Pseudo invalide' }); return; }
      p.pseudo = rawPseudo;
      broadcastAll({ type: 'players_update', players: getPublicPlayersList() });
      broadcastAll({ type: 'system_notice', text: p.pseudo + ' a rejoint la partie' });
      return;
    }
    if (msg.type === 'location_update') {
      if (msg.lat && msg.lng) {
        p.location = { lat: msg.lat, lng: msg.lng, acc: msg.acc || 0 };
        p.lastSeen = Date.now();
        // Confidentialite : seul l'admin voit la position des autres joueurs
        players.forEach(function(pp, pws) {
          if (pp.isAdmin) send(pws, { type: 'player_location', id: p.id, pseudo: p.pseudo, lat: msg.lat, lng: msg.lng, alive: p.alive });
        });
      }
      return;
    }
    if (msg.type === 'private_msg') {
      var txt2 = (msg.text || '').toString().substring(0, 300).trim();
      if (!txt2) return;
      var targetWs = null;
      players.forEach(function(pp, pws) { if (pp.id === msg.to) targetWs = pws; });
      if (targetWs) {
        send(targetWs, { type: 'private_msg', from: p.pseudo, fromId: p.id, text: txt2 });
        send(ws, { type: 'private_msg_sent', toPseudo: players.get(targetWs).pseudo, text: txt2 });
      }
      return;
    }

    // Commandes admin
    if (msg.password !== ADMIN_PASSWORD) { send(ws, { type: 'error', message: 'Mot de passe incorrect' }); return; }
    p.isAdmin = true;

    function doMusicPlay(url, name, time) {
      gameState.music.trackUrl = url; gameState.music.trackName = name;
      gameState.music.currentTime = time || 0; gameState.music.startedAt = Date.now(); gameState.music.status = 'playing';
      broadcast({ type: 'music_track_changed', trackUrl: url, trackName: name });
      broadcast({ type: 'music_play', currentTime: gameState.music.currentTime, serverTime: gameState.music.startedAt });
    }

    switch (msg.type) {
      case 'set_phase':
        gameState.phase = msg.phase;
        if (msg.phase === PHASES.PLAYING) {
          gameState.timerStart = Date.now();
          gameState.timerElapsed = 0;
          gameState.timerPaused = false;
          gameState.timerEnded = false;
        }
        if (msg.phase === PHASES.ENDED) {
          // Arreter le timer
          if (gameState.timerStart) gameState.timerElapsed += Date.now() - gameState.timerStart;
          gameState.timerStart = null;
          gameState.timerPaused = true;
          gameState.timerEnded = true;
        }
        broadcastAll({ type: 'game_state', phase: gameState.phase, timerStart: gameState.timerStart, timerDuration: gameState.timerDuration, timerPaused: gameState.timerPaused, timerElapsed: gameState.timerElapsed, timerEnded: gameState.timerEnded });
        // Syncer les POIs selon la nouvelle phase
        players.forEach(function(pp, pws) {
          var canSee = pp.isAdmin || gameState.phase === PHASES.PLAYING || gameState.phase === PHASES.ENDED;
          var vis = !canSee ? [] : (pp.isAdmin ? gameState.pois : gameState.pois.filter(function(poi) {
            return poi.visibleTo[0] === 'all' || poi.visibleTo.indexOf(pp.role) !== -1;
          }));
          send(pws, { type: 'pois_update', pois: vis });
        });
        break;

      case 'set_timer':
        gameState.timerDuration = msg.duration || 3600;
        broadcastAll({ type: 'game_state', phase: gameState.phase, timerStart: gameState.timerStart, timerDuration: gameState.timerDuration, timerPaused: gameState.timerPaused, timerElapsed: gameState.timerElapsed, timerEnded: gameState.timerEnded });
        break;

      case 'pause_timer':
        if (!gameState.timerPaused && gameState.timerStart) {
          gameState.timerElapsed += Date.now() - gameState.timerStart;
          gameState.timerStart = null; gameState.timerPaused = true;
        }
        broadcastAll({ type: 'timer_update', paused: true, elapsed: gameState.timerElapsed, duration: gameState.timerDuration, timerEnded: gameState.timerEnded });
        break;

      case 'resume_timer':
        if (gameState.timerPaused && !gameState.timerEnded) {
          gameState.timerStart = Date.now(); gameState.timerPaused = false;
        }
        broadcastAll({ type: 'timer_update', paused: false, timerStart: gameState.timerStart, elapsed: gameState.timerElapsed, duration: gameState.timerDuration, timerEnded: gameState.timerEnded });
        break;

      case 'assign_role':
        players.forEach(function(pp, pws) {
          if (pp.id === msg.playerId) { pp.role = msg.role; send(pws, { type: 'your_role', role: msg.role, alive: pp.alive }); }
        });
        send(ws, { type: 'players_update', players: getPlayersList(), admin: true });
        break;

      case 'auto_assign_roles':
        var allP = []; players.forEach(function(pp) { if (!pp.isAdmin && pp.pseudo) allP.push(pp); });
        var rolePool = msg.roles || [];
        for (var i = rolePool.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var tmp = rolePool[i]; rolePool[i] = rolePool[j]; rolePool[j] = tmp; }
        allP.forEach(function(pp, idx) {
          if (idx < rolePool.length) {
            pp.role = rolePool[idx];
            players.forEach(function(pp2, pws) { if (pp2.id === pp.id) send(pws, { type: 'your_role', role: pp.role, alive: pp.alive }); });
          }
        });
        send(ws, { type: 'players_update', players: getPlayersList(), admin: true });
        break;

      case 'eliminate':
        players.forEach(function(pp, pws) {
          if (pp.id === msg.playerId) {
            pp.alive = msg.alive !== undefined ? msg.alive : false;
            send(pws, { type: 'your_role', role: pp.role, alive: pp.alive });
            broadcastAll({ type: 'player_eliminated', id: pp.id, pseudo: pp.pseudo, alive: pp.alive });
          }
        });
        send(ws, { type: 'players_update', players: getPlayersList(), admin: true });
        break;

      case 'announce':
        var ann = { id: Date.now(), text: msg.text, targetRoles: msg.targetRoles || ['all'], ts: Date.now() };
        gameState.announcements.push(ann);
        if (gameState.announcements.length > 50) gameState.announcements.shift();
        if (ann.targetRoles[0] === 'all') {
          broadcastAll({ type: 'announcement', announcement: ann });
        } else {
          broadcastToRoles(ann.targetRoles, { type: 'announcement', announcement: ann });
          send(ws, { type: 'announcement', announcement: ann });
        }
        break;

      case 'add_poi':
        var poi = { id: Date.now(), lat: msg.lat, lng: msg.lng, label: msg.label || 'Point', color: msg.color || '#7F77DD', visibleTo: msg.visibleTo || ['all'] };
        gameState.pois.push(poi);
        players.forEach(function(pp, pws) {
          if (pp.isAdmin) { send(pws, { type: 'poi_added', poi: poi }); return; }
          if (gameState.phase !== PHASES.PLAYING && gameState.phase !== PHASES.ENDED) return;
          if (poi.visibleTo[0] === 'all' || poi.visibleTo.indexOf(pp.role) !== -1) send(pws, { type: 'poi_added', poi: poi });
        });
        break;

      case 'remove_poi':
        gameState.pois = gameState.pois.filter(function(poi) { return poi.id !== msg.poiId; });
        broadcastAll({ type: 'poi_removed', poiId: msg.poiId });
        break;

      case 'music_play':
        gameState.music.currentTime = msg.currentTime != null ? msg.currentTime : gameState.music.currentTime;
        gameState.music.startedAt = Date.now(); gameState.music.status = 'playing';
        broadcast({ type: 'music_play', currentTime: gameState.music.currentTime, serverTime: gameState.music.startedAt });
        break;
      case 'music_pause':
        gameState.music.currentTime = getCurrentMusicTime();
        gameState.music.startedAt = null; gameState.music.status = 'paused';
        broadcast({ type: 'music_pause', currentTime: gameState.music.currentTime });
        break;
      case 'music_stop':
        gameState.music.currentTime = 0; gameState.music.startedAt = null; gameState.music.status = 'stopped';
        broadcast({ type: 'music_stop' });
        break;
      case 'music_seek':
        gameState.music.currentTime = msg.currentTime;
        if (gameState.music.status === 'playing') gameState.music.startedAt = Date.now();
        broadcast({ type: 'music_seek', currentTime: msg.currentTime, serverTime: Date.now(), status: gameState.music.status });
        break;
      case 'music_volume':
        gameState.music.volume = msg.volume;
        broadcast({ type: 'music_volume', volume: msg.volume });
        break;
      case 'music_set_track':
        gameState.music.trackUrl = msg.trackUrl; gameState.music.trackName = msg.trackName || '';
        gameState.music.status = 'stopped'; gameState.music.currentTime = 0; gameState.music.startedAt = null;
        broadcast({ type: 'music_track_changed', trackUrl: msg.trackUrl, trackName: msg.trackName });
        break;
      case 'music_loop':
        gameState.music.loop = !!msg.loop;
        broadcast({ type: 'music_loop', loop: gameState.music.loop });
        break;
      case 'music_set_playlist':
        gameState.music.playlist = msg.playlist || []; gameState.music.playlistIndex = msg.index || 0;
        broadcast({ type: 'music_playlist', playlist: gameState.music.playlist, index: gameState.music.playlistIndex });
        break;
      case 'music_next':
        if (gameState.music.playlist.length > 0) {
          gameState.music.playlistIndex = (gameState.music.playlistIndex + 1) % gameState.music.playlist.length;
          var nt = gameState.music.playlist[gameState.music.playlistIndex];
          doMusicPlay(nt.url, nt.name, 0);
        }
        break;
      case 'music_prev':
        if (gameState.music.playlist.length > 0) {
          gameState.music.playlistIndex = (gameState.music.playlistIndex - 1 + gameState.music.playlist.length) % gameState.music.playlist.length;
          var pt = gameState.music.playlist[gameState.music.playlistIndex];
          doMusicPlay(pt.url, pt.name, 0);
        }
        break;
      case 'music_goto':
        if (gameState.music.playlist.length > msg.index) {
          gameState.music.playlistIndex = msg.index;
          var gt = gameState.music.playlist[msg.index];
          doMusicPlay(gt.url, gt.name, 0);
        }
        break;

      case 'reset_game':
        gameState.phase = PHASES.WAITING;
        gameState.timerStart = null; gameState.timerElapsed = 0; gameState.timerPaused = false; gameState.timerEnded = false;
        gameState.announcements = []; gameState.pois = [];
        players.forEach(function(pp) { pp.role = null; pp.alive = true; });
        broadcastAll({ type: 'game_reset' });
        break;
    }
  });

  ws.on('close', function() {
    var p = players.get(ws);
    if (p && p.pseudo) {
      broadcastAll({ type: 'system_notice', text: p.pseudo + ' a quitte la partie' });
      broadcastAll({ type: 'player_left', id: p.id });
      broadcastAll({ type: 'players_update', players: getPublicPlayersList() });
    }
    players.delete(ws);
  });
});

server.listen(PORT, function() {
  console.log('Serveur JDR sur port ' + PORT);
  console.log('Mot de passe admin: ' + ADMIN_PASSWORD);
});
