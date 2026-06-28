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

// ── Dossiers ──────────────────────────────────
var TRACKS_DIR = path.join(__dirname, 'public', 'tracks');
if (!fs.existsSync(TRACKS_DIR)) fs.mkdirSync(TRACKS_DIR, { recursive: true });

var DATA_FILE = path.join(__dirname, 'gamedata.json');
var gameData = { trackNames: {}, playlists: [], customActions: [] };
if (fs.existsSync(DATA_FILE)) {
  try { gameData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(e) {}
}
function saveData() { fs.writeFileSync(DATA_FILE, JSON.stringify(gameData, null, 2)); }

// ── Multer ────────────────────────────────────
var storage = multer.diskStorage({
  destination: function(req, file, cb) { cb(null, TRACKS_DIR); },
  filename: function(req, file, cb) {
    var safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, Date.now() + '_' + safe);
  }
});
var upload = multer({ storage: storage, limits: { fileSize: 200 * 1024 * 1024 } });

// ── Etat global du jeu ────────────────────────
var PHASES = { WAITING: 'waiting', ROLES: 'roles', PLAYING: 'playing', ENDED: 'ended' };
var ROLES = ['civil', 'tueur', 'mossad'];

var gameState = {
  phase: PHASES.WAITING,
  timerStart: null,
  timerDuration: 3600, // secondes
  timerPaused: false,
  timerElapsed: 0,
  announcements: [],
  pois: [],           // points d'interet [{id, lat, lng, label, visibleTo[], color}]
  music: {
    status: 'stopped', trackUrl: '', trackName: '',
    currentTime: 0, volume: 0.8, startedAt: null, loop: false,
    playlist: [], playlistIndex: 0
  }
};

// ── Joueurs ───────────────────────────────────
var players = new Map(); // ws -> { id, pseudo, role, alive, location, lastSeen }
var idCounter = 0;
function genId() { return 'p' + (++idCounter); }

function getPlayersList() {
  var list = [];
  players.forEach(function(p) {
    list.push({
      id: p.id, pseudo: p.pseudo, role: p.role,
      alive: p.alive, location: p.location, lastSeen: p.lastSeen
    });
  });
  return list;
}

function getPublicPlayersList() {
  // Pour les joueurs: pas de role des autres, juste pseudo + position + alive
  var list = [];
  players.forEach(function(p) {
    list.push({ id: p.id, pseudo: p.pseudo, alive: p.alive, location: p.location, lastSeen: p.lastSeen });
  });
  return list;
}

// ── Diffusion ─────────────────────────────────
function send(ws, msg) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

function broadcast(msg) {
  var data = JSON.stringify(msg);
  players.forEach(function(p, ws) { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
}

function broadcastToRole(role, msg) {
  var data = JSON.stringify(msg);
  players.forEach(function(p, ws) { if (p.role === role && ws.readyState === WebSocket.OPEN) ws.send(data); });
}

function broadcastToRoles(roles, msg) {
  var data = JSON.stringify(msg);
  players.forEach(function(p, ws) {
    if (roles.indexOf(p.role) !== -1 && ws.readyState === WebSocket.OPEN) ws.send(data);
  });
}

function broadcastAdminState() {
  // Envoyer l'etat complet aux admins (tous les roles visibles)
  // On le stocke pas, on l'envoie seulement si quelqu'un a le bon mdp
  // (gere cote client)
}

function broadcastAll(msg) {
  var data = JSON.stringify(msg);
  wss.clients.forEach(function(c) { if (c.readyState === WebSocket.OPEN) c.send(data); });
}

function getCurrentMusicTime() {
  var m = gameState.music;
  if (m.status === 'playing' && m.startedAt)
    return m.currentTime + (Date.now() - m.startedAt) / 1000;
  return m.currentTime;
}

// ── Sync etat initial ─────────────────────────
function sendInitialState(ws, playerInfo) {
  var isAdmin = playerInfo && playerInfo.isAdmin;
  var p = playerInfo;

  // Etat du jeu
  send(ws, {
    type: 'game_state',
    phase: gameState.phase,
    timerStart: gameState.timerStart,
    timerDuration: gameState.timerDuration,
    timerPaused: gameState.timerPaused,
    timerElapsed: gameState.timerElapsed,
    announcements: gameState.announcements.slice(-20)
  });

  // Musique
  send(ws, {
    type: 'music_sync',
    music: Object.assign({}, gameState.music, { currentTime: getCurrentMusicTime() })
  });

  // Joueurs (admin voit tout, joueur voit positions sans roles)
  if (isAdmin) {
    send(ws, { type: 'players_update', players: getPlayersList(), admin: true });
  } else {
    send(ws, { type: 'players_update', players: getPublicPlayersList() });
    if (p && p.role) {
      send(ws, { type: 'your_role', role: p.role, alive: p.alive });
    }
  }

  // POIs visibles
  var myRole = p ? p.role : null;
  var visiblePois = isAdmin ? gameState.pois : gameState.pois.filter(function(poi) {
    return poi.visibleTo.length === 0 || poi.visibleTo.indexOf(myRole) !== -1 || poi.visibleTo.indexOf('all') !== -1;
  });
  send(ws, { type: 'pois_update', pois: visiblePois });
}

// ── Tracks ────────────────────────────────────
var trackList = [];
function refreshTracks() {
  if (!fs.existsSync(TRACKS_DIR)) return;
  trackList = fs.readdirSync(TRACKS_DIR)
    .filter(function(f) { return /\.(mp3|ogg|wav|m4a|flac)$/i.test(f); })
    .map(function(f) {
      var raw = f.replace(/^\d+_/, '').replace(/\.[^.]+$/, '');
      return {
        filename: f, url: '/tracks/' + f,
        name: (gameData.trackNames && gameData.trackNames[f]) || raw,
        size: fs.statSync(path.join(TRACKS_DIR, f)).size
      };
    })
    .sort(function(a, b) { return b.filename.localeCompare(a.filename); });
}
refreshTracks();

// ── Routes API ────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

function adminOnly(req, res, next) {
  if ((req.headers['x-admin-password'] || req.body.password) !== ADMIN_PASSWORD)
    return res.status(403).json({ error: 'Non autorise' });
  next();
}

app.get('/api/tracks', function(req, res) { refreshTracks(); res.json(trackList); });
app.get('/api/playlists', function(req, res) { res.json(gameData.playlists || []); });
app.get('/api/actions', function(req, res) { res.json(gameData.customActions || []); });
app.get('/api/status', function(req, res) {
  res.json({ clients: wss.clients.size, phase: gameState.phase });
});

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
  saveData(); refreshTracks(); res.json({ ok: true });
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

app.delete('/api/playlists/:name', adminOnly, function(req, res) {
  gameData.playlists = (gameData.playlists || []).filter(function(p) { return p.name !== req.params.name; });
  saveData(); res.json({ ok: true });
});

// Actions personnalisees
app.post('/api/actions', adminOnly, function(req, res) {
  if (!gameData.customActions) gameData.customActions = [];
  var action = { id: Date.now(), label: req.body.label, targetRole: req.body.targetRole || 'all', effect: req.body.effect || 'message', message: req.body.message || '' };
  gameData.customActions.push(action);
  saveData(); res.json({ ok: true, action: action });
});

app.delete('/api/actions/:id', adminOnly, function(req, res) {
  gameData.customActions = (gameData.customActions || []).filter(function(a) { return String(a.id) !== req.params.id; });
  saveData(); res.json({ ok: true });
});

// ── WebSocket ─────────────────────────────────
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

    // ── Messages joueur (sans mdp) ────────────
    switch(msg.type) {
      case 'set_pseudo':
        var rawPseudo = (msg.pseudo || '').toString().substring(0, 24).trim();
        // Refuser si le pseudo est le mot de passe admin
        if (!rawPseudo || rawPseudo === ADMIN_PASSWORD) {
          sendTo(ws, { type: 'error', message: 'Pseudo invalide' });
          return;
        }
        p.pseudo = rawPseudo;
        broadcastAll({ type: 'players_update', players: getPublicPlayersList() });
        broadcastAll({ type: 'chat', from: 'Systeme', text: p.pseudo + ' a rejoint la partie', system: true });
        return;

      case 'location_update':
        if (msg.lat && msg.lng) {
          p.location = { lat: msg.lat, lng: msg.lng, acc: msg.acc || 0 };
          p.lastSeen = Date.now();
          // Diffuser la position a tous (sans role)
          broadcastAll({ type: 'player_location', id: p.id, pseudo: p.pseudo, lat: msg.lat, lng: msg.lng, alive: p.alive });
        }
        return;

      case 'chat':
        var txt = (msg.text || '').toString().substring(0, 300).trim();
        if (!txt) return;
        broadcastAll({ type: 'chat', from: p.pseudo, id: p.id, text: txt });
        return;

      case 'private_msg':
        var txt2 = (msg.text || '').toString().substring(0, 300).trim();
        if (!txt2) return;
        var targetWs = null;
        players.forEach(function(pp, pws) { if (pp.id === msg.to) targetWs = pws; });
        if (targetWs) {
          send(targetWs, { type: 'private_msg', from: p.pseudo, fromId: p.id, text: txt2 });
          send(ws, { type: 'private_msg_sent', toPseudo: players.get(targetWs).pseudo, text: txt2 });
        }
        return;

      case 'use_action':
        // Joueur utilise une action sur une cible
        if (gameState.phase !== PHASES.PLAYING || !p.alive) return;
        var action = (gameData.customActions || []).find(function(a) { return String(a.id) === String(msg.actionId); });
        if (!action) return;
        // Notifier l'admin
        broadcastAll({ type: 'action_used', by: p.pseudo, byId: p.id, actionLabel: action.label, targetId: msg.targetId || null });
        return;
    }

    // ── Commandes admin ───────────────────────
    if (msg.password !== ADMIN_PASSWORD) {
      send(ws, { type: 'error', message: 'Mot de passe incorrect' });
      return;
    }
    p.isAdmin = true;

    switch(msg.type) {
      // Phases
      case 'set_phase':
        gameState.phase = msg.phase;
        if (msg.phase === PHASES.PLAYING) {
          gameState.timerStart = Date.now();
          gameState.timerElapsed = 0;
          gameState.timerPaused = false;
        }
        broadcastAll({ type: 'game_state', phase: gameState.phase, timerStart: gameState.timerStart, timerDuration: gameState.timerDuration, timerPaused: gameState.timerPaused, timerElapsed: gameState.timerElapsed });
        break;

      case 'set_timer':
        gameState.timerDuration = msg.duration || 3600;
        broadcastAll({ type: 'game_state', phase: gameState.phase, timerStart: gameState.timerStart, timerDuration: gameState.timerDuration, timerPaused: gameState.timerPaused, timerElapsed: gameState.timerElapsed });
        break;

      case 'pause_timer':
        if (!gameState.timerPaused && gameState.timerStart) {
          gameState.timerElapsed += Date.now() - gameState.timerStart;
          gameState.timerStart = null;
          gameState.timerPaused = true;
        }
        broadcastAll({ type: 'timer_update', paused: true, elapsed: gameState.timerElapsed, duration: gameState.timerDuration });
        break;

      case 'resume_timer':
        if (gameState.timerPaused) {
          gameState.timerStart = Date.now();
          gameState.timerPaused = false;
        }
        broadcastAll({ type: 'timer_update', paused: false, timerStart: gameState.timerStart, elapsed: gameState.timerElapsed, duration: gameState.timerDuration });
        break;

      // Attribution des roles
      case 'assign_role':
        var targetPlayer = null;
        players.forEach(function(pp) { if (pp.id === msg.playerId) targetPlayer = pp; });
        if (targetPlayer) {
          targetPlayer.role = msg.role;
          // Notifier le joueur de son role
          players.forEach(function(pp, pws) {
            if (pp.id === msg.playerId) send(pws, { type: 'your_role', role: msg.role, alive: pp.alive });
          });
          // Mettre a jour la liste admin
          send(ws, { type: 'players_update', players: getPlayersList(), admin: true });
        }
        break;

      case 'auto_assign_roles':
        // Attribution automatique aleatoire
        var allPlayers = [];
        players.forEach(function(pp) { if (!pp.isAdmin && pp.pseudo) allPlayers.push(pp); });
        var rolePool = msg.roles || [];
        // Melanger
        for (var i = rolePool.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var tmp = rolePool[i]; rolePool[i] = rolePool[j]; rolePool[j] = tmp;
        }
        allPlayers.forEach(function(pp, idx) {
          if (idx < rolePool.length) {
            pp.role = rolePool[idx];
            players.forEach(function(pp2, pws) {
              if (pp2.id === pp.id) send(pws, { type: 'your_role', role: pp.role, alive: pp.alive });
            });
          }
        });
        send(ws, { type: 'players_update', players: getPlayersList(), admin: true });
        break;

      // Elimination
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

      // Annonces
      case 'announce':
        var ann = { id: Date.now(), text: msg.text, targetRoles: msg.targetRoles || ['all'], from: 'Admin', ts: Date.now() };
        gameState.announcements.push(ann);
        if (gameState.announcements.length > 50) gameState.announcements.shift();
        if (ann.targetRoles[0] === 'all') {
          broadcastAll({ type: 'announcement', announcement: ann });
        } else {
          broadcastToRoles(ann.targetRoles, { type: 'announcement', announcement: ann });
          send(ws, { type: 'announcement', announcement: ann }); // admin voit aussi
        }
        break;

      // POIs
      case 'add_poi':
        var poi = { id: Date.now(), lat: msg.lat, lng: msg.lng, label: msg.label || 'Point', color: msg.color || '#7F77DD', visibleTo: msg.visibleTo || ['all'] };
        gameState.pois.push(poi);
        // Envoyer aux bonnes personnes
        players.forEach(function(pp, pws) {
          if (pp.isAdmin) { send(pws, { type: 'poi_added', poi: poi }); return; }
          var myR = pp.role;
          if (poi.visibleTo[0] === 'all' || poi.visibleTo.indexOf(myR) !== -1) {
            send(pws, { type: 'poi_added', poi: poi });
          }
        });
        break;

      case 'remove_poi':
        gameState.pois = gameState.pois.filter(function(poi) { return poi.id !== msg.poiId; });
        broadcastAll({ type: 'poi_removed', poiId: msg.poiId });
        break;

      case 'update_poi':
        gameState.pois.forEach(function(poi) {
          if (poi.id === msg.poiId) {
            if (msg.label) poi.label = msg.label;
            if (msg.color) poi.color = msg.color;
            if (msg.visibleTo) poi.visibleTo = msg.visibleTo;
          }
        });
        // Resync tous
        players.forEach(function(pp, pws) {
          var visiblePois = pp.isAdmin ? gameState.pois : gameState.pois.filter(function(poi) {
            return poi.visibleTo[0] === 'all' || poi.visibleTo.indexOf(pp.role) !== -1;
          });
          send(pws, { type: 'pois_update', pois: visiblePois });
        });
        break;

      // Musique
      case 'music_play':
        gameState.music.currentTime = msg.currentTime != null ? msg.currentTime : gameState.music.currentTime;
        gameState.music.startedAt = Date.now();
        gameState.music.status = 'playing';
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
        gameState.music.playlist = msg.playlist || []; gameState.music.playlistIndex = 0;
        broadcast({ type: 'music_playlist', playlist: gameState.music.playlist, index: 0 });
        break;

      case 'music_next':
        if (gameState.music.playlist.length > 0) {
          gameState.music.playlistIndex = (gameState.music.playlistIndex + 1) % gameState.music.playlist.length;
          var nt = gameState.music.playlist[gameState.music.playlistIndex];
          gameState.music.trackUrl = nt.url; gameState.music.trackName = nt.name;
          gameState.music.currentTime = 0; gameState.music.startedAt = Date.now(); gameState.music.status = 'playing';
          broadcast({ type: 'music_track_changed', trackUrl: nt.url, trackName: nt.name });
          broadcast({ type: 'music_play', currentTime: 0, serverTime: gameState.music.startedAt });
        }
        break;

      case 'music_prev':
        if (gameState.music.playlist.length > 0) {
          gameState.music.playlistIndex = (gameState.music.playlistIndex - 1 + gameState.music.playlist.length) % gameState.music.playlist.length;
          var pt = gameState.music.playlist[gameState.music.playlistIndex];
          gameState.music.trackUrl = pt.url; gameState.music.trackName = pt.name;
          gameState.music.currentTime = 0; gameState.music.startedAt = Date.now(); gameState.music.status = 'playing';
          broadcast({ type: 'music_track_changed', trackUrl: pt.url, trackName: pt.name });
          broadcast({ type: 'music_play', currentTime: 0, serverTime: gameState.music.startedAt });
        }
        break;

      case 'reset_game':
        gameState.phase = PHASES.WAITING;
        gameState.timerStart = null; gameState.timerElapsed = 0; gameState.timerPaused = false;
        gameState.announcements = []; gameState.pois = [];
        players.forEach(function(pp) { pp.role = null; pp.alive = true; });
        broadcastAll({ type: 'game_reset' });
        break;
    }
  });

  ws.on('close', function() {
    var p = players.get(ws);
    if (p && p.pseudo) {
      broadcastAll({ type: 'chat', from: 'Systeme', text: p.pseudo + ' a quitte la partie', system: true });
      broadcastAll({ type: 'player_left', id: p.id });
    }
    players.delete(ws);
    broadcastAll({ type: 'players_update', players: getPublicPlayersList() });
  });
});

server.listen(PORT, function() {
  console.log('Serveur JDR sur port ' + PORT);
  console.log('Mot de passe admin: ' + ADMIN_PASSWORD);
});
