// ---------------------------------------------------------------------------
// Petit état partagé entre lobby.js (qui connaît les groupes Firestore, voir
// groups.js) et main.js/network.js (qui démarrent la connexion au serveur de
// jeu). lobby.js et main.js sont chargés comme deux scripts de modules
// indépendants (voir index.html), sans dépendre l'un de l'autre : ce fichier
// évite d'avoir à créer un import direct entre les deux juste pour se passer
// un identifiant.
// ---------------------------------------------------------------------------

let activeGroupId = null;
let activeMode = 'solo';
let activeTeam = null;

// Appelé par lobby.js juste avant d'entrer en jeu (bouton "Jouer"). Un
// joueur peut appartenir à plusieurs groupes, mais un seul sert à une partie
// donnée — c'est celui-là qu'on retient.
//
// mode/team : résolus par lobby.js à partir du groupe actif — 'team' + une
// couleur seulement si le créateur du groupe a activé le mode "Équipes" ET
// déjà assigné CE joueur à une équipe ; sinon 'solo' (équipe auto-équilibrée
// côté serveur, pas d'immunité aux tirs alliés).
export function setActiveGroupId(groupId, mode = 'solo', team = null) {
  activeGroupId = groupId || null;
  activeMode = mode === 'team' && team ? 'team' : 'solo';
  activeTeam = activeMode === 'team' ? team : null;
}

// Appelés par main.js (startNetwork) au moment de se connecter au serveur.
export function getActiveGroupId() {
  return activeGroupId;
}
export function getActiveMode() {
  return activeMode;
}
export function getActiveTeam() {
  return activeTeam;
}
