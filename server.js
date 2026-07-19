
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

// ---------- Hôtel des ventes : opérations atomiques ----------
// Ces deux routes existent en plus de l'API clé/valeur générique parce
// qu'un achat ou une vente touche à la fois "users" et "market". Faits
// en deux appels séparés depuis le client (get puis set), deux joueurs
// agissant presque en même temps pouvaient s'écraser mutuellement (l'or
// gagné en vendant pouvait disparaître si un achat était passé juste
// avant que ce gain soit sauvegardé). Ici, tout se fait en une seule
// requête traitée de façon synchrone par le serveur, donc sans course.
app.post('/api/market/buy', (req, res) => {
  const { buyerKey, listingId } = req.body || {};
  const db = dbCache;
  db.users = db.users || {};
  db.market = db.market || { listings: [] };
  const buyer = db.users[buyerKey];
  if (!buyer) return res.status(400).json({ ok: false, error: 'buyer_not_found' });
  const idx = (db.market.listings || []).findIndex(l => l.id === listingId);
  if (idx === -1) return res.status(409).json({ ok: false, error: 'listing_gone' });
  const listing = db.market.listings[idx];
  if (listing.sellerKey === buyerKey) return res.status(400).json({ ok: false, error: 'own_listing' });
  if ((buyer.gold || 0) < listing.price) return res.status(400).json({ ok: false, error: 'not_enough_gold' });

  db.market.listings.splice(idx, 1);
  buyer.gold = (buyer.gold || 0) - listing.price;
  buyer.items = buyer.items || [];
  buyer.items.push(listing.itemName);
  const powerGain = POWER_BY_RARITY[listing.rarity] || 0;
  if (powerGain) buyer.power = (buyer.power || 0) + powerGain;
  const seller = db.users[listing.sellerKey];
  if (seller) seller.gold = (seller.gold || 0) + listing.price;

  writeDb(db);
  res.json({ ok: true, listing, gold: buyer.gold, items: buyer.items });
});

app.post('/api/market/sell', (req, res) => {
  const { sellerKey, itemName, price } = req.body || {};
  const db = dbCache;
  db.users = db.users || {};
  db.market = db.market || { listings: [] };
  db.itemCatalog = db.itemCatalog || {};
  const seller = db.users[sellerKey];
  if (!seller) return res.status(400).json({ ok: false, error: 'seller_not_found' });
  const idx = (seller.items || []).indexOf(itemName);
  if (idx === -1) return res.status(400).json({ ok: false, error: 'item_not_owned' });
  const numericPrice = parseInt(price, 10);
  if (!numericPrice || numericPrice <= 0) return res.status(400).json({ ok: false, error: 'invalid_price' });

  seller.items.splice(idx, 1);

  // On retrouve la rareté (et la catégorie) d'origine de l'objet dans le
  // catalogue de l'admin, pour que la revente affiche toujours sa rareté
  // au lieu de rien du tout.
  const catalogMatch = Object.values(db.itemCatalog).find(it => it.name === itemName);

  const listing = {
    id: 'lst_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    itemId: null,
    itemName,
    rarity: catalogMatch ? catalogMatch.rarity : null,
    price: numericPrice,
    categoryTopId: catalogMatch ? catalogMatch.categoryTopId : null,
    categorySubId: catalogMatch ? catalogMatch.categorySubId : null,
    categoryLabel: catalogMatch ? catalogMatch.categoryLabel : '',
    sellerKey, sellerPseudo: seller.pseudo, createdAt: Date.now()
  };
  db.market.listings.push(listing);

  writeDb(db);
  res.json({ ok: true, listing, items: seller.items });
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

// Bonus de puissance gagné en achetant un objet, selon sa rareté.
const POWER_BY_RARITY = { commun: 1, rare: 3, tres_rare: 6, legendaire: 12 };

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
      level: 0,
      xp: 0,
      gold: randInt(5, 40),
      power: 0,
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
    // rythme modéré : plus rapide qu'avant, mais chaque niveau demande
    // toujours un peu plus d'xp que le précédent (comme pour un joueur).
    if (Math.random() > 0.25) return;
    const target = bot.botTargetLevel || 20;
    if (bot.level >= target) return;
    let xp = bot.xp + randInt(2, 4);
    let level = bot.level;
    while (level < target && xp >= xpNeeded(level)) {
      xp -= xpNeeded(level);
      level++;
    }
    bot.xp = xp;
    bot.level = level;
    if (Math.random() < 0.3) bot.gold = (bot.gold || 0) + 1;
  });
}

function growBotGuilds(db) {
  db.guilds = db.guilds || {};
  const users = db.users || {};
  let ungrouped = Object.keys(users).filter(k => users[k].isBot && !users[k].guildId);
  const usedNames = new Set(Object.values(db.guilds).map(g => g.name));

  // Formation de guildes de bots : par lots de 3 à 5, avec une probabilité
  // assez haute pour que ça se voie rapidement plutôt que de dépendre d'un
  // tirage rare qui pourrait ne jamais se déclencher.
  while (ungrouped.length >= 3 && Math.random() < 0.5) {
    const groupSize = Math.min(ungrouped.length, randInt(3, 5));
    const founders = [];
    for (let i = 0; i < groupSize; i++) {
      const idx = randInt(0, ungrouped.length - 1);
      founders.push(ungrouped.splice(idx, 1)[0]);
    }
    const id = 'g_bot_' + Date.now().toString(36) + randInt(1000, 9999);
    // usedNames doit être mise à jour à CHAQUE guilde créée dans cette
    // boucle, sinon deux guildes formées lors du même cycle peuvent
    // recevoir le même nom (le Set n'était calculé qu'une fois avant
    // la boucle).
    let name = pick(BOT_GUILD_NAMES);
    let attempts = 0;
    while (usedNames.has(name) && attempts < 40) {
      name = pick(BOT_GUILD_NAMES) + ' ' + randInt(2, 999);
      attempts++;
    }
    usedNames.add(name);
    const guild = {
      id, name, emblem: pick(GUILD_EMBLEMS),
      founder: founders[0],
      reputation: 0,
      members: founders.slice(),
      bank: { gold: 0, items: [] },
      invitesPending: []
    };
    db.guilds[id] = guild;
    founders.forEach(k => { users[k].guildId = id; });
    console.log(`[bots] Nouvelle guilde de bots : "${name}" (${founders.length} membres).`);
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
    if (Math.random() < 0.04 && g.reputation < 45) {
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

// Les bots achètent aussi de temps en temps ce qui est en vente — que ce
// soit posté par un autre bot ou par un vrai joueur. Ça évite que le
// marché ne fasse que s'empiler, et ça donne de l'or aux joueurs qui
// vendent leurs objets.
function botsBuyItems(db) {
  db.market = db.market || { listings: [] };
  db.users = db.users || {};
  db.botPendingResale = db.botPendingResale || [];
  if (!db.market.listings.length) return;
  const users = db.users;
  const bots = Object.values(users).filter(u => u.isBot);

  bots.forEach(bot => {
    if (Math.random() > 0.0012) return; // très rare : ~1 achat toutes les minutes environ, tous bots confondus
    if (!db.market.listings.length) return;
    const botKey = Object.keys(users).find(k => users[k] === bot);
    const affordable = db.market.listings.filter(l => l.sellerKey !== botKey && l.price <= (bot.gold || 0));
    if (!affordable.length) return;
    const listing = pick(affordable);
    const idx = db.market.listings.indexOf(listing);
    if (idx === -1) return;
    db.market.listings.splice(idx, 1);
    bot.gold -= listing.price;
    bot.items = bot.items || [];
    bot.items.push(listing.itemName);
    bot.power = (bot.power || 0) + (POWER_BY_RARITY[listing.rarity] || 0);
    const seller = users[listing.sellerKey];
    if (seller) seller.gold = (seller.gold || 0) + listing.price;

    // Le bot garde l'objet, et retentera sa chance de le revendre à chaque cycle.
    db.botPendingResale.push({
      itemName: listing.itemName,
      rarity: listing.rarity,
      price: listing.price,
      categoryTopId: listing.categoryTopId || null,
      categorySubId: listing.categorySubId || null,
      categoryLabel: listing.categoryLabel || '',
      botKey
    });
  });
}

// À chaque cycle (~10s), chaque objet détenu par un bot a 1 chance sur 3
// d'être remis en vente. Le cycle ne s'arrête jamais : tant que le bot n'a
// pas revendu, il retente sa chance au cycle suivant.
function processBotResales(db) {
  db.botPendingResale = db.botPendingResale || [];
  db.market = db.market || { listings: [] };
  const users = db.users || {};
  if (!db.botPendingResale.length) return;

  const stillPending = [];
  db.botPendingResale.forEach(entry => {
    const bot = users[entry.botKey];
    if (!bot) return; // le bot n'existe plus, on arrête de suivre cet objet
    const idx = (bot.items || []).indexOf(entry.itemName);
    if (idx === -1) return; // il ne l'a plus (donné à sa guilde, etc.)

    if (Math.random() < (1 / 3)) {
      bot.items.splice(idx, 1);
      db.market.listings.push({
        id: 'lst_' + Date.now().toString(36) + randInt(100, 999),
        itemId: null,
        itemName: entry.itemName,
        rarity: entry.rarity,
        price: entry.price,
        categoryTopId: entry.categoryTopId,
        categorySubId: entry.categorySubId,
        categoryLabel: entry.categoryLabel,
        sellerKey: entry.botKey,
        sellerPseudo: bot.pseudo,
        createdAt: Date.now()
      });
      // revendu : on ne le remet pas dans la liste d'attente
    } else {
      stillPending.push(entry); // retentera au prochain cycle
    }
  });
  db.botPendingResale = stillPending;
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
    botsBuyItems(dbCache);
    checkBotDungeonTimer(dbCache);
    writeDb(dbCache);
  } catch (e) {
    console.error('[bots] Erreur pendant le cycle de simulation :', e);
  }
}

// Cycle séparé, plus rapide, dédié uniquement à la revente des objets que
// les bots viennent d'acheter : à chaque passage, 1 chance sur 3 de
// remettre l'objet en vente. Ce cycle ne s'arrête jamais tant que le bot
// n'a pas revendu.
function resaleTick() {
  try {
    processBotResales(dbCache);
    writeDb(dbCache);
  } catch (e) {
    console.error('[bots] Erreur pendant le cycle de revente :', e);
  }
}

// Premier cycle rapide au démarrage, puis toutes les 15 secondes.
setTimeout(botTick, 2000);
setInterval(botTick, 15000);

// Cycle de revente : toutes les 10 secondes, comme demandé.
setInterval(resaleTick, 10000);
