# Mini Warzone

Jeu de tir multijoueur en 3D (Three.js) à jouer entre amis : comptes, amis et
groupes via Firebase, parties en temps réel via un serveur Socket.io
(`mini-warzone-server`), boutique, équipes, kill feed et tableau des scores.

## Gameplay

Touches par défaut — **toutes réglables** dans l'onglet *Paramètres* du lobby.

| Action | Touche |
| --- | --- |
| Bouger / sauter / s'accroupir | ZQSD/WASD · Espace · C |
| Courir (endurance) | Maj gauche (maintenu, en avançant) |
| Glissade | C pendant la course |
| Tirer / viser | Clic gauche / clic droit |
| Recharger | R (automatique quand le chargeur est vide) |
| Changer d'arme | 1 / 2 ou molette |
| Ramasser une arme au sol | E |
| Gilet | P |
| Grenade / fumigène | G / H |
| Carte et pings d'équipe | M |
| Boutique | B |
| Scores (maintenu) | Tab |

**Armes** (boutique, 3 raretés chacune) : pistolet (départ), mitraillette,
fusil, fusil à pompe (8 plombs, dégâts décroissants avec la distance) et
sniper (lunette, un tir à la tête tue). Chaque arme a son chargeur, son
temps de rechargement et sa dispersion (plus large en mouvement, en l'air et
en rafale ; le cercle du réticule la montre en direct).

**Course** : +60 % de vitesse, consomme l'endurance (barre jaune sous la vie),
impossible de tirer ou viser en courant. Épuisée, il faut en récupérer un peu
avant de repartir. **Glissade** : C en pleine course, courte et qui ralentit ;
sauter pendant la glissade garde l'élan.

**Grenades** (boutique > Équipement, 2 max de chaque) : la grenade explose
2,4 s après le lancer (jusqu'à 100 dégâts selon la distance, bloquée par les
murs, pas de dégâts aux coéquipiers en mode Équipes) ; le fumigène crée un
nuage de 14 s qui bloque la vue.

**Butin au sol** : les armes et gilets d'un joueur mort tombent par terre (chute
avec petit rebond) et disparaissent au bout d'**1 minute**, comptée à partir du
moment où ils touchent le sol (et qui repart de zéro chaque fois qu'un objet
retombe au sol). Ils clignotent pendant les 5 dernières secondes. Le serveur
décide de tout (`LOOT_LIFETIME_MS` dans `server.js`, 60 000 ms ; la variable
d'environnement du même nom permet de tester avec une durée plus courte).
Le ramassage se fait maintenant à portée horizontale, l'objet étant au sol et non
plus à hauteur d'yeux.

**Ambiance** : cycle jour / coucher de soleil / nuit de 15 min (même heure
pour tous les joueurs, calculée d'après l'horloge, rien à synchroniser), ciel
avec soleil, lune et étoiles, brouillard plus dense au ras du sol, nappes de
brume, ombres en cascade (très nettes autour du joueur). Quatre cases dans
Paramètres : cycle jour/nuit, brume, ombres nettes (recharger la page après
changement), effets d'impact — à décocher sur une machine modeste.

**Effets de combat** : étincelles et poussière à l'impact, petits trous dans
les murs (160 derniers conservés), douilles éjectées (laiton, rouge pour le
fusil à pompe), flash de tir plus marqué (aussi chez les autres joueurs),
traceurs fins partant de la bouche du canon, chiffres de dégâts flottants
(jaunes + ✦ pour une tête, additionnés en rafale), flèche rouge qui indique d'où
vient un coup, vignette rouge sous 45 PV. Tout est visuel, rien ne change le
gameplay.

**Viseur** : un point + 4 traits fins. À la hanche l'écart suit la dispersion
réelle de l'arme ; en visant, les traits se resserrent en petit plus.

**Carte et pings** : M ouvre la carte (le jeu continue derrière). Clic gauche
pose un ping à cet endroit, dans la couleur de ton skin, visible par tes
alliés sur la carte *et* dans le monde 3D (losange + distance, même à travers
les murs) pendant 15 s ; clic droit retire ton ping. Alliés = ta couleur
d'équipe en mode Équipes, ou les membres de ton groupe en mode Solo.

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

Le résultat est généré dans `dist/`. Sur Netlify, le fichier `netlify.toml`
règle déjà la commande de build (`npm run build`) et le dossier publié
(`dist`) : rien à saisir pour ça dans l'interface. Sans build, Netlify publie
les fichiers sources bruts et la page reste inerte (erreurs « Failed to
resolve module specifier "three" » dans la console).

**N'oublie pas** de configurer les variables d'environnement dans
Netlify (Project configuration > Environment variables), puis de relancer un
déploiement — elles ne sont lues qu'au moment du build :

- les six `VITE_FIREBASE_*` (voir `.env.example`) ;
- `VITE_REALTIME_SERVER_URL` : l'URL publique du serveur temps réel
  (`mini-warzone-server`), sinon le lobby marche mais pas la partie.

Ne coche **pas** « Contains secret values » sur ces variables : Vite les
écrit dans le JavaScript envoyé au navigateur (les clés Firebase web sont
publiques par conception, c'est `firestore.rules` qui protège les données), et
Netlify ferait échouer le build en les retrouvant dans le résultat.

## Structure du code

- `src/firebase.js` — initialisation Firebase (Auth + Firestore)
- `src/auth.js` — inscription / connexion / déconnexion
- `src/friends.js` — recherche de joueurs, demandes d'ami, liste d'amis
- `src/groups.js` — création de groupes, ajout/retrait de membres
- `src/lobby.js` — branche tout ça à l'écran de connexion et au lobby
- `src/main.js` — scène 3D Three.js, contrôleur FPS, branchement de tous les modules
- `src/weapons.js` — armes, grenades, dispersion, course (doit rester identique à `server.js`)
- `src/ambiance.js` — cycle jour/nuit, ciel, brouillard bas, brume, ombres en cascade
- `src/fx.js` — étincelles, poussière, trous d'impact, douilles, traceurs, flashs
- `src/hudfx.js` — chiffres de dégâts, direction des coups, vignette de vie basse
- `src/minimap.js` — carte et pings d'équipe
- `src/map-align.js` — place la map visible au niveau du sol des collisions (Y = 0)
- `firestore.rules` — règles de sécurité Firestore

## Outils de test (mode dev uniquement)

Avec `npm run dev`, la console du navigateur expose `__mw` (absent du build de
production) : par exemple `__mw.ambiance.setPhaseOverride(0.6)` fige l'heure au
coucher du soleil (0 = lever, 0.31 = midi, 0.62 = coucher, 0.8 = nuit ;
`setPhaseOverride(null)` repart sur l'horloge), `__mw.fx.impact(...)` ou
`__mw.hudFx.showDamageNumber(...)` pour voir un effet sans tirer.
