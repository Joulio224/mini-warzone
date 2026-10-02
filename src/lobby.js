// ---------------------------------------------------------------------------
// Orchestration de l'écran de connexion + lobby avant de jouer
// ---------------------------------------------------------------------------
// Le lobby est organisé en catégories (colonne grisée à gauche) :
//   Accueil    — ton perso (ou celui de tout ton groupe) + gros bouton Jouer
//   Amis       — recherche/demandes/liste d'amis + création et gestion des groupes
//   Apparence  — choix du skin
//   Paramètres — touches personnalisables (voir keybinds.js)
//   Compte     — pseudo, email, déconnexion
import { onAuthChange, signUp, signIn, signOutUser, friendlyAuthError } from './auth.js';
import {
  searchUserByPseudo,
  sendFriendRequest,
  listenIncomingRequests,
  acceptFriendRequest,
  declineFriendRequest,
  listenFriends,
  removeFriend,
} from './friends.js';
import {
  createGroup,
  listenMyGroups,
  leaveGroup,
  deleteGroup,
  sendGroupInvite,
  listenIncomingGroupInvites,
  acceptGroupInvite,
  declineGroupInvite,
  setGroupMode,
  setMemberTeam,
} from './groups.js';
import {
  initAppearancePicker,
  getAppearance,
  createCharacterElement,
  DEFAULT_APPEARANCE,
} from './appearance.js';
import { saveMyAppearance, listenUserAppearance } from './profiles.js';
import { initKeybindsPicker, getKeybinds, keyLabel, describeMovementKeys } from './keybinds.js';
import { setActiveGroupId } from './game-session.js';

// --- Éléments DOM ------------------------------------------------------------
const authScreen = document.getElementById('auth-screen');
const lobbyScreen = document.getElementById('lobby-screen');
const menuEl = document.getElementById('menu');

const tabLogin = document.getElementById('tab-login');
const tabSignup = document.getElementById('tab-signup');
const loginForm = document.getElementById('login-form');
const signupForm = document.getElementById('signup-form');
const authError = document.getElementById('auth-error');

const navItems = Array.from(document.querySelectorAll('.lobby-nav-item'));
const friendsBadge = document.getElementById('friends-badge');
const lobbyError = document.getElementById('lobby-error');

const homePartyEl = document.getElementById('home-party');
const homeModeLabelEl = document.getElementById('home-mode-label');
const enterGameButton = document.getElementById('enter-game-button');
const menuHelpEl = document.getElementById('menu-help');

const friendSearchForm = document.getElementById('friend-search-form');
const friendSearchInput = document.getElementById('friend-search-input');
const friendSearchResults = document.getElementById('friend-search-results');
const friendRequestsList = document.getElementById('friend-requests-list');
const friendsList = document.getElementById('friends-list');

const groupCreateForm = document.getElementById('group-create-form');
const groupNameInput = document.getElementById('group-name-input');
const groupsList = document.getElementById('groups-list');
const groupInvitesList = document.getElementById('group-invites-list');

const lobbyPseudoEl = document.getElementById('lobby-pseudo');
const lobbyEmailEl = document.getElementById('lobby-email');
const logoutButton = document.getElementById('logout-button');

// Le menu du jeu (main.js) ne doit apparaître qu'une fois le lobby validé.
menuEl.style.display = 'none';

// --- État --------------------------------------------------------------------
let currentUser = null;
let currentFriends = [];
let currentGroups = [];
let unsubscribers = [];

let pendingFriendRequestCount = 0;
let pendingGroupInviteCount = 0;

// Skins des autres membres du groupe actif (uid -> apparence), alimentés par
// un abonnement à leur profil public — voir profiles.js. Le tien vient
// directement du stockage local (getAppearance), inutile de passer par le réseau.
const memberAppearanceUnsubs = new Map();
const memberAppearances = new Map();

let saveAppearanceTimer = null;

// Le skin peut être réglé dès le lobby, avant même de rejoindre l'arène : il
// est stocké en local (voir appearance.js), puis republié dans ton profil
// public pour que tes coéquipiers te voient dans leur accueil.
initAppearancePicker({
  onChange: () => {
    renderHomeParty();
    scheduleAppearanceSave();
  },
});

function clearSubscriptions() {
  unsubscribers.forEach((unsub) => unsub());
  unsubscribers = [];
  memberAppearanceUnsubs.forEach((unsub) => unsub());
  memberAppearanceUnsubs.clear();
  memberAppearances.clear();
  clearTimeout(saveAppearanceTimer);

  currentFriends = [];
  currentGroups = [];
  pendingFriendRequestCount = 0;
  pendingGroupInviteCount = 0;
  updateFriendsBadge();
}

// Régénère l'aide du menu de jeu ("ZQSD/WASD pour bouger, ...") d'après les
// touches actuellement configurées — sinon elle mentirait dès qu'on change
// une touche dans Paramètres. Appelée au chargement ET à chaque changement
// de touche (onChange d'initKeybindsPicker) ET juste avant d'afficher le
// menu, pour ne jamais rester périmée.
function updateMenuHelp() {
  if (!menuHelpEl) return;
  const k = getKeybinds();
  menuHelpEl.textContent =
    `${describeMovementKeys(k)} pour bouger, souris pour regarder, clic pour tirer, ` +
    `molette ou ${keyLabel(k.weaponSlot1)}/${keyLabel(k.weaponSlot2)} pour changer d'arme, ` +
    `${keyLabel(k.useVest)} pour utiliser un gilet, ${keyLabel(k.shop)} pour la boutique, Échap pour sortir`;
}
updateMenuHelp();
initKeybindsPicker({ onChange: updateMenuHelp });

function showAuthScreen() {
  authScreen.hidden = false;
  lobbyScreen.hidden = true;
  menuEl.style.display = 'none';
}

function showLobbyScreen() {
  authScreen.hidden = true;
  lobbyScreen.hidden = false;
  menuEl.style.display = 'none';
  showTab('home');
}

function showGameScreen() {
  lobbyScreen.hidden = true;
  updateMenuHelp();
  menuEl.style.display = 'flex';
}

function emptyItem(text) {
  const li = document.createElement('li');
  li.className = 'muted';
  li.textContent = text;
  return li;
}

// --- Catégories (colonne de gauche) -------------------------------------------
function showTab(name) {
  navItems.forEach((item) => item.classList.toggle('active', item.dataset.tab === name));
  document.querySelectorAll('.lobby-tab').forEach((section) => {
    section.hidden = section.id !== `lobby-tab-${name}`;
  });
  lobbyError.textContent = '';
}

navItems.forEach((item) => {
  item.addEventListener('click', () => showTab(item.dataset.tab));
});

// Pastille sur "Amis" : demandes d'ami + invitations de groupe en attente.
function updateFriendsBadge() {
  const total = pendingFriendRequestCount + pendingGroupInviteCount;
  friendsBadge.hidden = total === 0;
  friendsBadge.textContent = String(total);
}

// --- Onglets connexion / inscription -----------------------------------------
tabLogin.addEventListener('click', () => {
  tabLogin.classList.add('active');
  tabSignup.classList.remove('active');
  loginForm.hidden = false;
  signupForm.hidden = true;
  authError.textContent = '';
});

tabSignup.addEventListener('click', () => {
  tabSignup.classList.add('active');
  tabLogin.classList.remove('active');
  signupForm.hidden = false;
  loginForm.hidden = true;
  authError.textContent = '';
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authError.textContent = '';
  try {
    await signIn(
      document.getElementById('login-email').value,
      document.getElementById('login-password').value
    );
  } catch (error) {
    authError.textContent = friendlyAuthError(error);
  }
});

signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authError.textContent = '';
  try {
    await signUp(
      document.getElementById('signup-email').value,
      document.getElementById('signup-password').value,
      document.getElementById('signup-pseudo').value
    );
  } catch (error) {
    authError.textContent = friendlyAuthError(error);
  }
});

logoutButton.addEventListener('click', () => signOutUser());

// --- Accueil : ton perso, ou celui de tout ton groupe --------------------------
// Simplification : un joueur peut être dans plusieurs groupes, mais un seul
// sert pour une partie donnée — le premier de la liste. C'est celui qu'on
// affiche ici ET celui qu'on envoie au serveur en cliquant sur Jouer.
function getActiveGroup() {
  return currentGroups[0] || null;
}

// Toi en premier, puis les autres membres du groupe actif. Seul, tu es seul.
function getPartyMembers() {
  const group = getActiveGroup();
  const teamOf = (uid) => (group?.mode === 'team' ? group.memberTeams?.[uid] || null : null);
  const me = {
    uid: currentUser.uid,
    pseudo: currentUser.displayName || currentUser.email,
    appearance: getAppearance(),
    team: teamOf(currentUser.uid),
  };
  if (!group) return [me];

  const others = group.members
    .filter((uid) => uid !== currentUser.uid)
    .map((uid) => ({
      uid,
      pseudo: group.memberPseudos?.[uid] || '?',
      appearance: memberAppearances.get(uid) || DEFAULT_APPEARANCE,
      team: teamOf(uid),
    }));
  return [me, ...others];
}

function renderHomeParty() {
  if (!currentUser) return;
  const group = getActiveGroup();
  const mode = group?.mode === 'team' ? 'team' : 'solo';
  homeModeLabelEl.textContent = group
    ? `Mode : ${mode === 'team' ? 'Équipes' : 'Solo'}`
    : '';

  homePartyEl.innerHTML = '';
  getPartyMembers().forEach((member) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'party-member';
    const characterEl = createCharacterElement(member.appearance);
    if (member.team) characterEl.classList.add(`team-${member.team}`);
    wrapper.appendChild(characterEl);

    const name = document.createElement('div');
    name.className = 'party-name';
    name.textContent = member.pseudo;
    wrapper.appendChild(name);

    homePartyEl.appendChild(wrapper);
  });
}

// Garde un abonnement au profil de chaque membre du groupe actif (et
// seulement lui) pour afficher leur skin, en ajoutant/retirant ce qu'il faut
// quand le groupe change.
function syncMemberAppearanceListeners() {
  // Membres de TOUS tes groupes (et pas seulement du groupe actif) : l'accueil
  // n'affiche que le groupe actif, mais la liste de gestion (onglet Amis)
  // montre les persos des membres de chaque groupe.
  const wanted = new Set(
    currentUser
      ? currentGroups.flatMap((g) => g.members).filter((uid) => uid !== currentUser.uid)
      : []
  );

  memberAppearanceUnsubs.forEach((unsub, uid) => {
    if (wanted.has(uid)) return;
    unsub();
    memberAppearanceUnsubs.delete(uid);
    memberAppearances.delete(uid);
  });

  wanted.forEach((uid) => {
    if (memberAppearanceUnsubs.has(uid)) return;
    memberAppearanceUnsubs.set(
      uid,
      listenUserAppearance(uid, (appearance) => {
        memberAppearances.set(uid, appearance);
        renderHomeParty();
        renderGroupsList();
      })
    );
  });
}

// Le sélecteur de couleur déclenche un événement à chaque pixel de
// déplacement : on attend qu'il se calme avant d'écrire dans Firestore.
function scheduleAppearanceSave() {
  if (!currentUser) return;
  clearTimeout(saveAppearanceTimer);
  const uid = currentUser.uid;
  saveAppearanceTimer = setTimeout(() => {
    saveMyAppearance(uid, getAppearance()).catch((error) => {
      console.warn('[apparence] impossible de publier le skin', error);
    });
  }, 400);
}

enterGameButton.addEventListener('click', () => {
  // Le groupe actif sert au serveur à mettre les coéquipiers dans la même
  // équipe et à les faire spawn ensemble (voir game-session.js et network.js).
  // Mode/équipe : seulement si le créateur du groupe a activé "Équipes" ET
  // déjà assigné CE joueur à une couleur — sinon on part en solo, comme avant.
  const group = getActiveGroup();
  const myTeam = group?.mode === 'team' ? group.memberTeams?.[currentUser.uid] || null : null;
  setActiveGroupId(group?.id || null, group?.mode || 'solo', myTeam);
  showGameScreen();
});

// --- Amis ----------------------------------------------------------------
function isAlreadyFriend(uid) {
  return currentFriends.some((f) => f.uid === uid);
}

function renderSearchResults(results) {
  friendSearchResults.innerHTML = '';
  if (results.length === 0) {
    friendSearchResults.appendChild(emptyItem('Aucun joueur avec ce pseudo.'));
    return;
  }
  results.forEach((u) => {
    const li = document.createElement('li');
    const nameSpan = document.createElement('span');
    nameSpan.textContent = u.pseudo;
    li.appendChild(nameSpan);

    const already = isAlreadyFriend(u.uid);
    const button = document.createElement('button');
    button.textContent = already ? 'Déjà ami' : 'Ajouter';
    button.disabled = already;
    button.addEventListener('click', async () => {
      if (!currentUser) return;
      button.disabled = true;
      button.textContent = 'Envoyée';
      try {
        await sendFriendRequest(currentUser.uid, currentUser.displayName, u.uid);
      } catch (error) {
        lobbyError.textContent = error.message;
        button.disabled = false;
        button.textContent = 'Ajouter';
      }
    });
    li.appendChild(button);
    friendSearchResults.appendChild(li);
  });
}

friendSearchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUser) return;
  lobbyError.textContent = '';
  const results = await searchUserByPseudo(friendSearchInput.value, currentUser.uid);
  renderSearchResults(results);
});

function renderIncomingRequests(requests) {
  if (!currentUser) return;
  pendingFriendRequestCount = requests.length;
  updateFriendsBadge();

  friendRequestsList.innerHTML = '';
  if (requests.length === 0) {
    friendRequestsList.appendChild(emptyItem('Aucune demande en attente.'));
    return;
  }
  requests.forEach((request) => {
    const li = document.createElement('li');
    const nameSpan = document.createElement('span');
    nameSpan.textContent = request.fromPseudo;
    li.appendChild(nameSpan);

    const acceptButton = document.createElement('button');
    acceptButton.textContent = 'Accepter';
    acceptButton.addEventListener('click', () => {
      if (!currentUser) return;
      acceptFriendRequest(request, currentUser.displayName);
    });

    const declineButton = document.createElement('button');
    declineButton.textContent = 'Refuser';
    declineButton.className = 'secondary';
    declineButton.addEventListener('click', () => declineFriendRequest(request.id));

    li.appendChild(acceptButton);
    li.appendChild(declineButton);
    friendRequestsList.appendChild(li);
  });
}

function renderFriends(friends) {
  if (!currentUser) return;
  currentFriends = friends;
  friendsList.innerHTML = '';
  if (friends.length === 0) {
    friendsList.appendChild(emptyItem("Pas encore d'amis ajoutés."));
  } else {
    friends.forEach((friend) => {
      const li = document.createElement('li');
      const nameSpan = document.createElement('span');
      nameSpan.textContent = friend.pseudo;
      li.appendChild(nameSpan);

      const removeButton = document.createElement('button');
      removeButton.textContent = 'Retirer';
      removeButton.className = 'secondary';
      removeButton.addEventListener('click', () => removeFriend(friend.friendshipId));
      li.appendChild(removeButton);
      friendsList.appendChild(li);
    });
  }
  // La liste d'amis disponibles pour un groupe dépend de currentFriends : on
  // ré-affiche les groupes pour rafraîchir leurs menus "Ajouter un ami".
  renderGroups(currentGroups);
}

// --- Groupes ---------------------------------------------------------------
groupCreateForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUser) return;
  lobbyError.textContent = '';
  try {
    await createGroup(groupNameInput.value, currentUser.uid, currentUser.displayName);
    groupNameInput.value = '';
  } catch (error) {
    lobbyError.textContent = error.message;
  }
});

function renderIncomingGroupInvites(invites) {
  if (!currentUser) return;
  pendingGroupInviteCount = invites.length;
  updateFriendsBadge();

  groupInvitesList.innerHTML = '';
  if (invites.length === 0) {
    groupInvitesList.appendChild(emptyItem('Aucune invitation en attente.'));
    return;
  }
  invites.forEach((invite) => {
    const li = document.createElement('li');
    const nameSpan = document.createElement('span');
    nameSpan.textContent = `${invite.groupName} — invité par ${invite.fromPseudo}`;
    li.appendChild(nameSpan);

    const acceptButton = document.createElement('button');
    acceptButton.textContent = 'Rejoindre';
    acceptButton.addEventListener('click', () => {
      acceptGroupInvite(invite).catch((error) => {
        lobbyError.textContent = error.message;
      });
    });

    const declineButton = document.createElement('button');
    declineButton.textContent = 'Refuser';
    declineButton.className = 'secondary';
    declineButton.addEventListener('click', () => declineGroupInvite(invite.id));

    li.appendChild(acceptButton);
    li.appendChild(declineButton);
    groupInvitesList.appendChild(li);
  });
}

// Un membre de groupe : avatar (skin choisi) + pseudo en dessous, plutôt
// qu'une simple liste de noms à plat. En mode "Équipes", ajoute un repère de
// couleur d'équipe — éditable seulement par le créateur du groupe.
function buildMemberCard(uid, pseudo, group, isOwner) {
  const appearance =
    uid === currentUser?.uid ? getAppearance() : memberAppearances.get(uid) || DEFAULT_APPEARANCE;

  const card = document.createElement('div');
  card.className = 'member-card';

  const avatar = document.createElement('div');
  avatar.className = 'member-avatar';
  avatar.style.background = appearance.bodyColor;
  const face = document.createElement('span');
  face.className = 'member-face';
  face.textContent = appearance.face;
  avatar.appendChild(face);
  card.appendChild(avatar);

  const name = document.createElement('div');
  name.className = 'member-name';
  name.textContent = pseudo || '?';
  card.appendChild(name);

  if (group?.mode === 'team') {
    const currentTeam = group.memberTeams?.[uid] || null;
    avatar.classList.toggle('team-red', currentTeam === 'red');
    avatar.classList.toggle('team-blue', currentTeam === 'blue');

    const picker = document.createElement('div');
    picker.className = 'member-team-picker';
    ['red', 'blue'].forEach((team) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = `team-dot team-dot-${team}`;
      dot.classList.toggle('selected', currentTeam === team);
      dot.title = team === 'red' ? 'Équipe rouge' : 'Équipe bleue';
      dot.disabled = !isOwner;
      dot.addEventListener('click', () => setMemberTeam(group.id, uid, team));
      picker.appendChild(dot);
    });
    card.appendChild(picker);
  }

  return card;
}

// Liste de gestion des groupes (onglet Amis) : c'est ici qu'on crée, invite,
// quitte ou supprime. L'accueil, lui, n'affiche pas de nom de groupe mais
// directement les persos des membres.
function renderGroupsList() {
  groupsList.innerHTML = '';
  if (currentGroups.length === 0) {
    groupsList.appendChild(emptyItem('Pas encore de groupe.'));
    return;
  }
  currentGroups.forEach((group, index) => {
    const li = document.createElement('li');
    li.className = 'group-item';
    const isOwner = group.ownerId === currentUser.uid;

    const title = document.createElement('div');
    title.className = 'group-title';
    const memberCount = group.members.length;
    title.textContent = `${group.name} (${memberCount} membre${memberCount > 1 ? 's' : ''})`;
    // Un seul groupe sert à jouer (voir getActiveGroup) : on le signale
    // quand il y en a plusieurs pour ne pas se demander lequel s'affiche à l'accueil.
    if (currentGroups.length > 1 && index === 0) title.textContent += ' — actif';
    li.appendChild(title);

    // Mode de jeu : Solo (par défaut, comme avant) ou Équipes (coéquipiers
    // increvables entre eux, équipe choisie par le créateur ci-dessous).
    // Seul le créateur peut le changer — les autres voient juste le mode actif.
    const modeRow = document.createElement('div');
    modeRow.className = 'group-mode-row';
    const modeLabel = document.createElement('span');
    modeLabel.className = 'group-mode-label';
    modeLabel.textContent = 'Mode :';
    modeRow.appendChild(modeLabel);
    [
      { id: 'solo', label: 'Solo' },
      { id: 'team', label: 'Équipes' },
    ].forEach(({ id, label }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mode-button';
      button.textContent = label;
      button.classList.toggle('active', (group.mode || 'solo') === id);
      button.disabled = !isOwner;
      button.addEventListener('click', () => setGroupMode(group.id, id));
      modeRow.appendChild(button);
    });
    li.appendChild(modeRow);

    // Les joueurs du groupe, directement — avatar (skin choisi) + pseudo dessous.
    const membersRow = document.createElement('div');
    membersRow.className = 'group-members-row';
    group.members.forEach((uid) => {
      membersRow.appendChild(buildMemberCard(uid, group.memberPseudos?.[uid], group, isOwner));
    });
    li.appendChild(membersRow);

    const actions = document.createElement('div');
    actions.className = 'group-actions';

    const friendsNotInGroup = currentFriends.filter((f) => !group.members.includes(f.uid));
    if (friendsNotInGroup.length > 0) {
      const select = document.createElement('select');
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Inviter un ami…';
      select.appendChild(placeholder);
      friendsNotInGroup.forEach((f) => {
        const option = document.createElement('option');
        option.value = f.uid;
        option.textContent = f.pseudo;
        select.appendChild(option);
      });
      select.addEventListener('change', () => {
        if (!select.value || !currentUser) return;
        const friend = friendsNotInGroup.find((f) => f.uid === select.value);
        sendGroupInvite(
          group.id,
          group.name,
          currentUser.uid,
          currentUser.displayName,
          friend.uid,
          friend.pseudo
        ).catch((error) => {
          lobbyError.textContent = error.message;
        });
        select.value = '';
      });
      actions.appendChild(select);
    }

    const leaveButton = document.createElement('button');
    leaveButton.className = 'secondary';
    leaveButton.textContent = isOwner ? 'Supprimer' : 'Quitter';
    leaveButton.addEventListener('click', () => {
      if (!currentUser) return;
      if (isOwner) {
        deleteGroup(group.id);
      } else {
        leaveGroup(group.id, currentUser.uid);
      }
    });
    actions.appendChild(leaveButton);

    li.appendChild(actions);
    groupsList.appendChild(li);
  });
}

function renderGroups(groups) {
  if (!currentUser) return;
  currentGroups = groups;
  renderGroupsList();
  syncMemberAppearanceListeners();
  renderHomeParty();
}

// --- État d'authentification -------------------------------------------------
onAuthChange((user) => {
  clearSubscriptions();
  currentUser = user;

  if (!user) {
    showAuthScreen();
    return;
  }

  lobbyPseudoEl.textContent = user.displayName || user.email;
  lobbyEmailEl.textContent = user.email || '';
  showLobbyScreen();
  renderHomeParty(); // ton perso s'affiche tout de suite, sans attendre les groupes

  // Republie le skin de cet appareil dans ton profil public : c'est ce que
  // verront tes coéquipiers dans leur accueil.
  saveMyAppearance(user.uid, getAppearance()).catch((error) => {
    console.warn('[apparence] impossible de publier le skin', error);
  });

  unsubscribers.push(listenIncomingRequests(user.uid, renderIncomingRequests));
  unsubscribers.push(listenFriends(user.uid, renderFriends));
  unsubscribers.push(listenMyGroups(user.uid, renderGroups));
  unsubscribers.push(listenIncomingGroupInvites(user.uid, renderIncomingGroupInvites));
});
