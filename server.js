
// server.js — Terres de Konne
// Petit serveur Express qui sert le site et stocke l'état du monde
// (comptes, guildes, saison, donjon en cours...) dans un fichier JSON
// sur le disque. Convient très bien à un petit groupe de joueurs.

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

// ---------- Stockage sur disque ----------
function ensureDbFile() {
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({}), 'utf8');
}

function readDb() {
  ensureDbFile();
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (e) {
    console.error('Erreur de lecture de la base, réinitialisation.', e);
    return {};
  }
}

function writeDb(db) {
  ensureDbFile();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

// Simple queue to avoid overlapping writes clobbering each other
let dbCache = readDb();

// ---------- Middleware ----------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- API clé/valeur ----------
// GET  /api/kv/:key   -> { key, value }  ou 404 si absent
// POST /api/kv/:key   -> body { value }  -> sauvegarde value sous key
app.get('/api/kv/:key', (req, res) => {
  const key = req.params.key;
  if (!(key in dbCache)) {
    return res.status(404).json({ error: 'not found' });
  }
  res.json({ key, value: dbCache[key] });
});

app.post('/api/kv/:key', (req, res) => {
  const key = req.params.key;
  const value = req.body ? req.body.value : undefined;
  dbCache[key] = value;
  writeDb(dbCache);
  res.json({ key, value });
});

app.delete('/api/kv/:key', (req, res) => {
  const key = req.params.key;
  delete dbCache[key];
  writeDb(dbCache);
  res.json({ key, deleted: true });
});

// Route de secours : toute autre route sert index.html (site mono-page)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Terres de Konne écoute sur http://localhost:${PORT}`);
});
