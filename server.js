# 🎵 LARP Music — Système de diffusion musicale synchronisée

Diffuse de la musique en temps réel à tous tes joueurs via leur navigateur.

## 🚀 Lancement en local (test)

```bash
npm install
npm start
```

Puis ouvre `http://localhost:3000` sur tous les appareils du même réseau Wi-Fi.

## 🔑 Mot de passe admin

Par défaut : `admin1234`

Pour le changer, définis la variable d'environnement avant de lancer :
```bash
ADMIN_PASSWORD=monMotDePasse npm start
```

## 🌐 Déploiement pour un vrai événement

### Option 1 — Render.com (gratuit, recommandé)
1. Crée un compte sur https://render.com
2. "New Web Service" → connecte ton repo GitHub
3. Build command : `npm install`
4. Start command : `node server.js`
5. Ajoute la variable d'env `ADMIN_PASSWORD`
6. L'URL générée (ex: `https://larp-music.onrender.com`) est partagée aux joueurs

### Option 2 — Railway.app
Même principe, très simple aussi.

### Option 3 — ngrok (local, réseau local ou internet)
```bash
npm start
# Dans un autre terminal :
npx ngrok http 3000
```
Donne l'URL ngrok aux joueurs.

## 📱 Utilisation

### Joueurs
- Ouvrent l'URL sur leur téléphone
- Restent sur l'onglet "🎧 Écouter"
- La musique se lance automatiquement quand l'admin appuie sur Play

### Admin
- Clique sur "🎛️ Admin"
- Entre le mot de passe
- **Charge une piste** : URL directe vers un fichier MP3/OGG/WAV
  - Ex: Freesound.org, Dropbox (lien direct), Google Drive (lien direct), serveur perso
- **Contrôles** : Play / Pause / Stop / Avance rapide / Volume

## 🎵 Sources de musique libres de droits
- https://freesound.org
- https://freemusicarchive.org
- https://opengameart.org

## ⚠️ Notes importantes
- Les navigateurs bloquent l'autoplay audio sans interaction utilisateur.
  → Les joueurs doivent cliquer une fois sur la page avant que ça fonctionne.
- Pour un son parfaitement synchronisé, un réseau Wi-Fi stable est recommandé.
- Le serveur gratuit Render peut "dormir" après inactivité — plan payant pour un event.
