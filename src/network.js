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
//   onCurrentLoot, onLootSpawned, onLootRemoved, onHitConfirmed, onTeamAssigned,
//   onYourShield, onPlayerShieldSteps, onYourMoney,
//   onCurrentVests, onVestSpawned, onVestRemoved,
// }
export function connectToServer(pseudo, handlers) {
  socket = io(SERVER_URL);

  socket.on('connect', () => {
    socket.emit('join', pseudo);
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

  socket.on('current-loot', (items) => {
    handlers.onCurrentLoot?.(items);
  });

  socket.on('loot-spawned', (data) => {
    handlers.onLootSpawned?.(data);
  });

  socket.on('loot-removed', (data) => {
    handlers.onLootRemoved?.(data);
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

  socket.on('current-vests', (items) => {
    handlers.onCurrentVests?.(items);
  });

  socket.on('vest-spawned', (data) => {
    handlers.onVestSpawned?.(data);
  });

  socket.on('vest-removed', (data) => {
    handlers.onVestRemoved?.(data);
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

export function sendShoot(origin, direction, weaponId) {
  if (!socket?.connected) return;
  socket.emit('shoot', { origin, direction, weaponId });
}

export function sendCollectLoot(lootId) {
  if (!socket?.connected) return;
  socket.emit('collect-loot', { lootId });
}

export function sendCollectVest(vestId) {
  if (!socket?.connected) return;
  socket.emit('collect-vest', { vestId });
}

export function isConnected() {
  return Boolean(socket?.connected);
}

export function disconnectFromServer() {
  socket?.disconnect();
  socket = null;
}
