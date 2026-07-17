
// server.js — Terres de Konne
// Petit serveur Express qui sert le site et stocke l'état du monde
// (comptes, guildes, saison, donjon en cours...) dans un fichier JSON
// sur le disque. Convient très bien à un petit groupe de joueurs.
//
// Ce serveur fait aussi vivre le monde tout seul : une centaine de
// "bots" (faux joueurs) évoluent en tâche de fond — ils montent de
// niveau, fondent des guildes ensemble, et mettent en vente à l'hôtel
// des ventes les objets que l'admin leur confie. Il gère également le
// minuteur secret qui permet à l'admin de faire terminer un donjon par
// les bots si les joueurs mettent trop de temps.

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

// =========================================================
// SIMULATION DU MONDE — les bots vivent même sans joueur connecté
// =========================================================

const BOT_COUNT = 140; // "une centaine minimum" — on vise large
const BOT_CLASSES = ['guerrier', 'mage', 'paladin'];

const NAME_ROOTS = [
  'Thal','Kor','Bran','Eldu','Wyn','Fael','Grim','Ash','Rhea','Sil',
  'Dorn','Kael','Myr','Sora','Tarn','Vel','Ysolde','Zan','Orin','Nyx',
  'Fenn','Garr','Isolde','Jor','Lira','Morg','Nael','Quen','Ros','Syl',
  'Bry','Cade','Dree','Erl','Fina','Gwen','Halk','Ivar','Jora','Kess'
];
const NAME_SUFFIXES = [
  'dor','wyn','ric','ael','mir','ion','wen','ard','iel','oth',
  'ryn','dan','lor','vek','ash','thas','nor','wick','shade','storm',
  'blade','fyr','holt','moor','vane','gard','wyth','rune','fell','crest'
];

const BOT_GUILD_NAMES = [
  "Les Loups de Fer","La Confrérie Grise","L'Ordre du Corbeau","Les Lames Silencieuses",
  "La Garde d'Ébène","Les Fils de la Brume","L'Alliance du Levant","Les Cendres Ardentes",
  "La Horde du Nord","Les Gardiens du Sceau","L'Éveil Sylvestre","La Compagnie Pourpre",
  "Les Chasseurs d'Ombre","Le Cercle Doré","Les Brise-Lames","La Légion d'Argent",
  "Les Enfants de Konne","L'Ordre du Tonnerre","Les Voiles Noires","La Fraternité des Pics"
];
const GUILD_EMBLEMS = ['🐺','🦅','⚔️','🛡️','🔥','🌙','🐉','⚡','🦁','🕊️','💀','🌪️','🐍','🦂','🏹'];

function xpNeeded(level) { return 10 * (level + 1); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

function makeBotPseudo(takenLower) {
  for (let i = 0; i < 60; i++) {
    const candidate = pick(NAME_ROOTS) + pick(NAME_SUFFIXES);
    if (!takenLower.has(candidate.toLowerCase())) return candidate;
  }
  // filet de sécurité en cas de collisions répétées
  return 'Voyageur' + randInt(1000, 999999);
}

function ensureBots(db) {
  db.users = db.users || {};
  const existingBots = Object.keys(db.users).filter(k => db.users[k] && db.users[k].isBot);
  const missing = BOT_COUNT - existingBots.length;
  if (missing <= 0) return;

  const takenLower = new Set(Object.keys(db.users));
  let created = 0;
  let nextIdx = existingBots.length + 1;
  while (created < missing) {
    const pseudo = makeBotPseudo(takenLower);
    const key = 'bot_' + (nextIdx++) + '_' + pseudo.toLowerCase();
    takenLower.add(key);
    db.users[key] = {
      pseudo,
      password: null,
      isAdmin: false,
      isBot: true,
      class: pick(BOT_CLASSES),
      level: randInt(1, 6),
      xp: 0,
      gold: randInt(5, 40),
      items: [],
      guildId: null,
      botTargetLevel: randInt(12, 27) // les bots plafonnent sous le niveau max
    };
    created++;
  }
  console.log(`[bots] ${created} nouveaux bots générés (total visé: ${BOT_COUNT}).`);
}

function levelUpBots(db) {
  const bots = Object.values(db.users || {}).filter(u => u.isBot);
  bots.forEach(bot => {
    // seule une partie des bots progresse à chaque cycle, pour un rythme organique
    if (Math.random() > 0.22) return;
    const target = bot.botTargetLevel || 20;
    if (bot.level >= target) return;
    let xp = bot.xp + randInt(1, 4);
    let level = bot.level;
    while (level < target && xp >= xpNeeded(level)) {
      xp -= xpNeeded(level);
      level++;
    }
    bot.xp = xp;
    bot.level = level;
    bot.gold = (bot.gold || 0) + randInt(0, 2);
  });
}

function growBotGuilds(db) {
  db.guilds = db.guilds || {};
  const users = db.users || {};
  const bots = Object.values(users).filter(u => u.isBot);

  // Formation spontanée de nouvelles guildes de bots
  const ungrouped = bots.filter(b => !b.guildId);
  if (ungrouped.length >= 3 && Math.random() < 0.10) {
    const founders = [];
    const pool = ungrouped.slice();
    for (let i = 0; i < 3 && pool.length; i++) {
      const idx = randInt(0, pool.length - 1);
      founders.push(pool.splice(idx, 1)[0]);
    }
    const id = 'g_bot_' + Date.now().toString(36) + randInt(100, 999);
    const usedNames = new Set(Object.values(db.guilds).map(g => g.name));
    let name = pick(BOT_GUILD_NAMES);
    if (usedNames.has(name)) name = name + ' ' + randInt(2, 99);
    const guild = {
      id, name, emblem: pick(GUILD_EMBLEMS),
      founder: null,
      reputation: 0,
      members: founders.map(f => Object.keys(users).find(k => users[k] === f)),
      bank: { gold: 0, items: [] },
      invitesPending: []
    };
    guild.founder = guild.members[0];
    db.guilds[id] = guild;
    founders.forEach(f => { f.guildId = id; });
  }

  // Des bots isolés rejoignent parfois une guilde de bots existante
  Object.values(db.guilds).forEach(g => {
    const memberUsers = (g.members || []).map(m => users[m]).filter(Boolean);
    const allBots = memberUsers.length > 0 && memberUsers.every(m => m.isBot);
    if (!allBots) return;
    if (memberUsers.length >= 6) return;
    if (Math.random() < 0.06) {
      const stillUngrouped = Object.keys(users).filter(k => users[k].isBot && !users[k].guildId);
      if (stillUngrouped.length) {
        const rec = pick(stillUngrouped);
        users[rec].guildId = g.id;
        g.members.push(rec);
      }
    }
    // réputation des guildes 100% bot : progression lente, plafonnée
    if (Math.random() < 0.15 && g.reputation < 45) {
      g.reputation += 1;
    }
  });
}

function autoListAssignedItems(db) {
  db.itemCatalog = db.itemCatalog || {};
  db.market = db.market || { listings: [] };
  const users = db.users || {};

  Object.values(db.itemCatalog).forEach(item => {
    if (!item.assignedTo || item.listed) return;
    const seller = users[item.assignedTo];
    if (!seller) return;
    const listing = {
      id: 'lst_' + Date.now().toString(36) + randInt(100, 999),
      itemId: item.id,
      itemName: item.name,
      rarity: item.rarity,
      price: item.value,
      categoryTopId: item.categoryTopId || null,
      categorySubId: item.categorySubId || null,
      categoryLabel: item.categoryLabel || '',
      sellerKey: item.assignedTo,
      sellerPseudo: seller.pseudo,
      createdAt: Date.now()
    };
    db.market.listings.push(listing);
    item.listed = true;
  });
}

function checkBotDungeonTimer(db) {
  const timer = db.dungeonBotTimer;
  const dungeon = db.dungeon;
  if (!timer || !timer.enabled || !dungeon) return;
  if (dungeon.status !== 'active') return;
  if (Date.now() < timer.deadline) return;

  // Les bots terminent le donjon à la place des joueurs.
  dungeon.status = 'lost';
  dungeon.onBreak = false;
  dungeon.finishedByBots = true;
  if (dungeon.guildId && !dungeon.repAdded) {
    const g = (db.guilds || {})[dungeon.guildId];
    if (g) g.reputation += dungeon.tiersCompleted;
    dungeon.repAdded = true;
  }
  db.dungeon = dungeon;
  db.season = { started: false };
  timer.enabled = false;
  timer.deadline = null;
  console.log('[bots] Le minuteur secret a expiré : les bots ont terminé le donjon avant les joueurs.');
}

function botTick() {
  try {
    ensureBots(dbCache);
    levelUpBots(dbCache);
    growBotGuilds(dbCache);
    autoListAssignedItems(dbCache);
    checkBotDungeonTimer(dbCache);
    writeDb(dbCache);
  } catch (e) {
    console.error('[bots] Erreur pendant le cycle de simulation :', e);
  }
}

// Premier cycle rapide au démarrage, puis toutes les 15 secondes.
setTimeout(botTick, 2000);
setInterval(botTick, 15000);
