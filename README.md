# Mini Warzone

**Étape 1** (faite) : scène 3D jouable en solo, map chargée, déplacements FPS
basiques.

**Étape 2** (en cours) : comptes joueurs, amis et groupes via Firebase Auth +
Firestore, avant de jouer. Pas encore de réseau temps réel (Socket.io) ni de
zone qui rétrécit — ça viendra ensuite par-dessus cette base.

## Prérequis

- [Node.js](https://nodejs.org/) version 18 ou plus (inclut npm)
- Un éditeur de code (VS Code recommandé)
- Un navigateur à jour supportant WebGL2 (Chrome, Edge, Firefox)
- Un projet Firebase (gratuit) — voir ci-dessous

## Installation

```bash
npm install
```

## Configurer Firebase

1. Va sur la [Console Firebase](https://console.firebase.google.com/) et
   crée un nouveau projet (nom libre, ex. "mini-warzone"). **Ne réutilise
   pas** le projet Firebase de Jeux de Collégiens — garde les deux séparés.
2. Dans le projet, ouvre **Authentication > Sign-in method** et active le
   fournisseur **Email/Mot de passe**.
3. Ouvre **Firestore Database** et crée une base (mode production).
4. Dans **Paramètres du projet > Général**, ajoute une application **Web**
   (icône `</>`), donne-lui un nom, puis copie l'objet `firebaseConfig`
   affiché.
5. Copie `.env.example` en `.env` à la racine du projet, et colle les
   valeurs correspondantes (`VITE_FIREBASE_API_KEY`, etc.).
6. Copie le contenu de `firestore.rules` dans **Firestore Database >
   Règles**, dans la console Firebase, puis clique sur "Publier".

## Ajouter la map

1. Télécharge le fichier `.glb` de la map choisie (Low Poly Arena, voir le
   fichier `public/assets/PLACE_MAP_HERE.txt`).
2. Renomme-le `map.glb`.
3. Place-le dans `public/assets/map.glb`.

Si le fichier est absent, la scène se lance quand même avec un sol de
secours, pour ne pas bloquer le reste du développement.

## Lancer en dev

```bash
npm run dev
```

Ouvre l'URL donnée par Vite (en général http://localhost:5173). Tu arrives
sur un écran de connexion : crée un compte (pseudo + email + mot de passe),
puis tu accèdes au lobby (amis, groupes). Clique sur "Rejoindre l'arène"
pour lancer la scène 3D, puis sur "Cliquer pour jouer" pour activer la
souris (pointer lock). Déplace-toi en WASD/ZQSD, Échap pour libérer la
souris.

Pour tester les amis/groupes à plusieurs, crée deux comptes avec deux
pseudos différents (par exemple dans deux fenêtres de navigateur, une en
navigation privée) et ajoute-toi toi-même en ami depuis l'autre compte.

## Build de prod (pour déployer sur Netlify par ex.)

```bash
npm run build
```

Le résultat est généré dans `dist/`. **N'oublie pas** de configurer les
mêmes variables d'environnement (`VITE_FIREBASE_*`) dans les paramètres de
build de Netlify, sinon Firebase ne s'initialisera pas en prod.

## Structure du code

- `src/firebase.js` — initialisation Firebase (Auth + Firestore)
- `src/auth.js` — inscription / connexion / déconnexion
- `src/friends.js` — recherche de joueurs, demandes d'ami, liste d'amis
- `src/groups.js` — création de groupes, ajout/retrait de membres
- `src/lobby.js` — branche tout ça à l'écran de connexion et au lobby
- `src/main.js` — scène 3D Three.js et contrôleur FPS (inchangé pour
  l'instant)
- `firestore.rules` — règles de sécurité Firestore
