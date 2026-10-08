// ---------------------------------------------------------------------------
// Connexion au serveur temps réel (mini-warzone-server/) via Socket.io
// ---------------------------------------------------------------------------
import { io } from 'socket.io-client';

// En dev comme via un tunnel (ngrok), on se connecte par défaut à la même
// origine que la page elle-même : le proxy configuré dans vite.config.js
// redirige en interne les requêtes /socket.io vers le vrai serveur (port
// 3001). Une seule URL à partager avec tes amis, donc.
// Pour un vrai déploiement (Render/Railway/Suga), mets l'URL publique du
// serveur dans VITE_REALTIME_SERVER_URL (.env), et le proxy n'est plus
// nécessaire.
const SERVER_URL = import.meta.env.VITE_REALTIME_SERVER_URL || undefined;

let socket = null;

// handlers = {
//   onPlayerJoined, onPlayerMoved, onPlayerShoot, onPlayerLeft, onConnectError,
//   onHpUpdate, onYouDied, onPlayerDied, onYouRespawned, onPlayerRespawned,
//   onHitConfirmed, onTeamAssigned,
//   onYourShield, onPlayerShieldSteps, onYourMoney,
//   onYourVestCount, onYourWeapons,
//   onYourAbilities,
//   onCurrentVests, onVestSpawned, onVestRemoved,
//   onCurrentWeaponPickups, onWeaponPickupSpawned, onWeaponPickupRemoved,
// }
// groupId : identifiant du groupe Firestore actif (voir game-session.js), ou
// null. Permet au serveur de mettre les membres d'un même groupe dans la
// même équipe et de les faire spawn ensemble (voir server.js).
// mode/team : 'team' + une couleur si le créateur du groupe a activé le mode
// Équipes et assigné ce joueur — dans ce cas les coéquipiers ne peuvent pas
// se tirer dessus (voir server.js). 'solo'/null sinon (comportement inchangé).
export function connectToServer(pseudo, appearance, groupId, mode, team, handlers) {
  socket = io(SERVER_URL);

  socket.on('connect', () => {
    socket.emit('join', { pseudo, appearance, groupId, mode, team });
  });

  socket.on('team-assigned', (data) => {
    handlers.onTeamAssigned?.(data);
  });

  socket.on('current-players', (players) => {
    players.forEach((player) => handlers.onPlayerJoined(player));
  });

  socket.on('player-joined', (player) => {
    handlers.onPlayerJoined(player);
  });

  socket.on('player-moved', (data) => {
    handlers.onPlayerMoved(data);
  });

  socket.on('player-shoot', (data) => {
    handlers.onPlayerShoot(data);
  });

  socket.on('player-left', ({ id }) => {
    handlers.onPlayerLeft(id);
  });

  socket.on('your-hp', ({ hp }) => {
    handlers.onYourHp?.(hp);
  });

  socket.on('you-died', () => {
    handlers.onYouDied?.();
  });

  socket.on('player-died', (data) => {
    handlers.onPlayerDied?.(data);
  });

  socket.on('you-respawned', (data) => {
    handlers.onYouRespawned?.(data);
  });

  socket.on('player-respawned', (data) => {
    handlers.onPlayerRespawned?.(data);
  });

  socket.on('hit-confirmed', (data) => {
    handlers.onHitConfirmed?.(data);
  });

  socket.on('your-shield', ({ shield }) => {
    handlers.onYourShield?.(shield);
  });

  socket.on('player-shield-steps', (data) => {
    handlers.onPlayerShieldSteps?.(data);
  });

  socket.on('your-money', ({ money }) => {
    handlers.onYourMoney?.(money);
  });

  socket.on('your-vest-count', ({ count }) => {
    handlers.onYourVestCount?.(count);
  });

  socket.on('your-weapons', ({ weapons }) => {
    handlers.onYourWeapons?.(weapons);
  });

  // Économie : capacités spéciales débloquées pour la partie en cours (ex.
  // 3e emplacement de gilet) et solde d'argent à jour — voir shop.js.
  socket.on('your-abilities', (data) => {
    handlers.onYourAbilities?.(data);
  });

  // Stuff tombé au sol à la mort d'un joueur (voir dropLoot dans server.js) —
  // gilets ramassés automatiquement en marchant dessus, armes à la touche E
  // (configurable, voir keybinds.js). current-* arrive une fois à la
  // connexion pour le stuff déjà par terre ; les autres événements suivent
  // en direct.
  socket.on('current-vests', (items) => {
    handlers.onCurrentVests?.(items);
  });
  socket.on('vest-spawned', (data) => {
    handlers.onVestSpawned?.(data);
  });
  socket.on('vest-removed', (data) => {
    handlers.onVestRemoved?.(data);
  });
  socket.on('current-weapon-pickups', (items) => {
    handlers.onCurrentWeaponPickups?.(items);
  });
  socket.on('weapon-pickup-spawned', (data) => {
    handlers.onWeaponPickupSpawned?.(data);
  });
  socket.on('weapon-pickup-removed', (data) => {
    handlers.onWeaponPickupRemoved?.(data);
  });

  socket.on('connect_error', (error) => {
    console.error('[network] Connexion au serveur temps réel impossible :', error.message);
    handlers.onConnectError?.(error);
  });

  return socket;
}

export function sendMove(position, rotationY) {
  if (!socket?.connected) return;
  socket.emit('move', { position, rotationY });
}

// `slot` (0 ou 1) plutôt qu'un identifiant d'arme : le serveur retrouve
// lui-même l'arme + la rareté équipées dans cet emplacement, il ne fait
// jamais confiance au client pour les dégâts (voir server.js).
export function sendShoot(origin, direction, slot) {
  if (!socket?.connected) return;
  socket.emit('shoot', { origin, direction, slot });
}

export function sendUseVest() {
  if (!socket?.connected) return;
  socket.emit('use-vest');
}

// pickupId : identifiant de l'arme au sol (voir onCurrentWeaponPickups /
// onWeaponPickupSpawned). slot (0 ou 1) : slot actuellement sélectionné,
// utilisé par le serveur seulement si le stuff est déjà plein pour savoir
// lequel remplacer (voir server.js).
export function sendCollectWeapon(pickupId, slot) {
  if (!socket?.connected) return;
  socket.emit('collect-weapon', { pickupId, slot });
}

// Boutique : itemId vient du catalogue défini dans shop.js (ex. "vest",
// "weapon:rifle:red", "ability-extra-vest-slot"). Le serveur reste seul
// juge de la validité de l'achat (fonds, plafonds…).
export function sendBuyItem(itemId) {
  if (!socket?.connected) return;
  socket.emit('buy-item', { itemId });
}

export function isConnected() {
  return Boolean(socket?.connected);
}

export function disconnectFromServer() {
  socket?.disconnect();
  socket = null;
}
