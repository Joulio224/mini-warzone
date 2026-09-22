// ---------------------------------------------------------------------------
// Orchestration de l'écran de connexion + lobby (amis/groupes) avant de jouer
// ---------------------------------------------------------------------------
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
} from './groups.js';

// --- Éléments DOM ------------------------------------------------------------
const authScreen = document.getElementById('auth-screen');
const lobbyScreen = document.getElementById('lobby-screen');
const menuEl = document.getElementById('menu');

const tabLogin = document.getElementById('tab-login');
const tabSignup = document.getElementById('tab-signup');
const loginForm = document.getElementById('login-form');
const signupForm = document.getElementById('signup-form');
const authError = document.getElementById('auth-error');

const lobbyPseudoEl = document.getElementById('lobby-pseudo');
const logoutButton = document.getElementById('logout-button');
const lobbyError = document.getElementById('lobby-error');

const friendSearchForm = document.getElementById('friend-search-form');
const friendSearchInput = document.getElementById('friend-search-input');
const friendSearchResults = document.getElementById('friend-search-results');
const friendRequestsList = document.getElementById('friend-requests-list');
const friendsList = document.getElementById('friends-list');

const groupCreateForm = document.getElementById('group-create-form');
const groupNameInput = document.getElementById('group-name-input');
const groupsList = document.getElementById('groups-list');
const groupInvitesList = document.getElementById('group-invites-list');

const enterGameButton = document.getElementById('enter-game-button');

// Le menu du jeu (main.js) ne doit apparaître qu'une fois le lobby validé.
menuEl.style.display = 'none';

let currentUser = null;
let currentFriends = [];
let currentGroups = [];
let unsubscribers = [];

function clearSubscriptions() {
  unsubscribers.forEach((unsub) => unsub());
  unsubscribers = [];
}

function showAuthScreen() {
  authScreen.hidden = false;
  lobbyScreen.hidden = true;
  menuEl.style.display = 'none';
}

function showLobbyScreen() {
  authScreen.hidden = true;
  lobbyScreen.hidden = false;
  menuEl.style.display = 'none';
}

function showGameScreen() {
  lobbyScreen.hidden = true;
  menuEl.style.display = 'flex';
}

function emptyItem(text) {
  const li = document.createElement('li');
  li.className = 'muted';
  li.textContent = text;
  return li;
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

function renderGroups(groups) {
  if (!currentUser) return;
  currentGroups = groups;
  groupsList.innerHTML = '';
  if (groups.length === 0) {
    groupsList.appendChild(emptyItem('Pas encore de groupe.'));
    return;
  }
  groups.forEach((group) => {
    const li = document.createElement('li');
    li.className = 'group-item';

    const title = document.createElement('div');
    title.className = 'group-title';
    const memberCount = group.members.length;
    title.textContent = `${group.name} (${memberCount} membre${memberCount > 1 ? 's' : ''})`;
    li.appendChild(title);

    const memberNames = document.createElement('div');
    memberNames.className = 'muted';
    memberNames.textContent = group.members
      .map((uid) => group.memberPseudos[uid] || '?')
      .join(', ');
    li.appendChild(memberNames);

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
    leaveButton.textContent = group.ownerId === currentUser.uid ? 'Supprimer' : 'Quitter';
    leaveButton.addEventListener('click', () => {
      if (!currentUser) return;
      if (group.ownerId === currentUser.uid) {
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

// --- Entrer dans la partie ---------------------------------------------------
enterGameButton.addEventListener('click', () => {
  showGameScreen();
});

// --- État d'authentification -------------------------------------------------
onAuthChange((user) => {
  clearSubscriptions();
  currentUser = user;

  if (!user) {
    showAuthScreen();
    return;
  }

  lobbyPseudoEl.textContent = user.displayName || user.email;
  showLobbyScreen();

  unsubscribers.push(listenIncomingRequests(user.uid, renderIncomingRequests));
  unsubscribers.push(listenFriends(user.uid, renderFriends));
  unsubscribers.push(listenMyGroups(user.uid, renderGroups));
  unsubscribers.push(listenIncomingGroupInvites(user.uid, renderIncomingGroupInvites));
});
