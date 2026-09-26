// ---------------------------------------------------------------------------
// Petit état partagé entre lobby.js (qui connaît les groupes Firestore, voir
// groups.js) et main.js/network.js (qui démarrent la connexion au serveur de
// jeu). lobby.js et main.js sont chargés comme deux scripts de modules
// indépendants (voir index.html), sans dépendre l'un de l'autre : ce fichier
// évite d'avoir à créer un import direct entre les deux juste pour se passer
// un identifiant.
// ---------------------------------------------------------------------------

let activeGroupId = null;

// Appelé par lobby.js juste avant d'entrer en jeu (bouton "Rejoindre
// l'arène"). Simplification : un joueur peut appartenir à plusieurs groupes,
// mais un seul peut servir au matchmaking d'une partie donnée — c'est celui-là
// qu'on retient.
export function setActiveGroupId(groupId) {
  activeGroupId = groupId || null;
}

// Appelé par main.js (startNetwork) au moment de se connecter au serveur.
export function getActiveGroupId() {
  return activeGroupId;
}
