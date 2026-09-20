// ---------------------------------------------------------------------------
// Connexion au serveur temps réel (mini-warzone-server/) via Socket.io
// ---------------------------------------------------------------------------
import { io } from 'socket.io-client';

// En dev comme via un tunnel (ngrok), on se connecte par défaut à la même
// origine que la page elle-même : le proxy configuré dans vite.config.js
// redirige en interne les requêtes /socket.io vers le vrai serveur (port
// 3001). Une seule URL à partager avec tes amis, donc.
// Pour un vrai déploiement (Render/Railway), mets l'URL publique du serveur
// dans VITE_REALTIME_SERVER_URL (.env), et le proxy n'est plus nécessaire.
const SERVER_URL = import.meta.env.VITE_REALTIME_SERVER_URL || undefined;

let socket = null;

// handlers = { onPlayerJoined, onPlayerMoved, onPlayerShoot, onPlayerLeft, onConnectError }
export function connectToServer(pseudo, handlers) {
  socket = io(SERVER_URL);

  socket.on('connect', () => {
    socket.emit('join', pseudo);
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

export function sendShoot(origin, direction) {
  if (!socket?.connected) return;
  socket.emit('shoot', { origin, direction });
}

export function isConnected() {
  return Boolean(socket?.connected);
}

export function disconnectFromServer() {
  socket?.disconnect();
  socket = null;
}
