// ---------------------------------------------------------------------------
// Messagerie — onglet "Messages" du lobby
// ---------------------------------------------------------------------------
// Deux types de conversations, construites à partir de ce que lobby.js
// connaît déjà (amis et groupes, voir setMessagingFriends/setMessagingGroups) :
//
//   Message privé avec un ami : dms/{friendshipId}/messages/{id}
//     friendshipId = l'id du doc friendships (uids triés, voir friends.js) :
//     les règles Firestore s'en servent pour n'autoriser que les deux amis
//     — et la conversation devient illisible dès qu'on retire l'ami.
//   Chat d'un groupe : groupChats/{groupId}/messages/{id}
//     lisible/écrivable par les membres actuels du groupe seulement.
//
//   message = { fromUid, fromPseudo, text, createdAt }
//
// Les règles à copier dans Firebase Console sont dans firestore.rules (sans
// elles, l'onglet affiche une erreur au lieu de planter).
//
// "Non lu" = le dernier message d'une conversation vient de quelqu'un d'autre
// et est plus récent que ce que cet appareil a déjà affiché (stocké en local,
// comme le skin et les touches — pas de réseau pour ça). On compare des dates
// serveur entre elles, donc aucun souci d'horloge de l'ordinateur.
import {
  collection,
  addDoc,
  query,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase.js';

const MAX_LENGTH = 500; // doit rester identique à la limite dans firestore.rules
const THREAD_LIMIT = 100; // messages gardés à l'écran par conversation

let me = null; // { uid, pseudo } quand connecté
let friendsSource = [];
let groupsSource = [];
let conversations = []; // [{ id, kind, title, icon, root, docId }]
const latestByConv = new Map(); // id -> { ms, fromUid, text }
const latestUnsubs = new Map(); // id -> fonction de désabonnement
let activeId = null;
let threadUnsub = null;
let tabVisible = false;
let readState = {}; // id -> ms du dernier message affiché
let onUnreadChange = () => {};

let listEl = null;
let headerEl = null;
let messagesEl = null;
let formEl = null;
let inputEl = null;
let errorEl = null;

// --- Lu / non lu ---------------------------------------------------------------
function readKey() {
  return `mw_chat_read_${me?.uid}`;
}
function loadReadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(readKey()));
    readState = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    readState = {};
  }
}
function markRead(id, ms) {
  if (!me || !ms || (readState[id] || 0) >= ms) return;
  readState[id] = ms;
  try {
    localStorage.setItem(readKey(), JSON.stringify(readState));
  } catch {
    // stockage plein/indisponible : pas grave, ça redeviendra "non lu" au prochain chargement
  }
}
function isUnread(id) {
  const latest = latestByConv.get(id);
  return Boolean(latest && latest.fromUid !== me?.uid && latest.ms > (readState[id] || 0));
}
function notifyUnread() {
  const count = conversations.filter((c) => isUnread(c.id)).length;
  onUnreadChange(count);
}

// --- Conversations -------------------------------------------------------------
function messagesCollection(conv) {
  return collection(db, conv.root, conv.docId, 'messages');
}

function rebuildConversations() {
  if (!me) return;
  conversations = [
    ...friendsSource.map((f) => ({
      id: `dm:${f.friendshipId}`,
      kind: 'dm',
      title: f.pseudo || '?',
      icon: '👤',
      root: 'dms',
      docId: f.friendshipId,
    })),
    ...groupsSource.map((g) => ({
      id: `group:${g.id}`,
      kind: 'group',
      title: g.name,
      icon: '👥',
      root: 'groupChats',
      docId: g.id,
    })),
  ];

  const wanted = new Set(conversations.map((c) => c.id));

  // On arrête d'écouter ce qui n'existe plus (ami retiré, groupe quitté).
  latestUnsubs.forEach((unsub, id) => {
    if (wanted.has(id)) return;
    unsub();
    latestUnsubs.delete(id);
    latestByConv.delete(id);
  });
  if (activeId && !wanted.has(activeId)) closeThread();

  // On écoute le dernier message de chaque conversation : aperçu + non-lus.
  conversations.forEach((conv) => {
    if (latestUnsubs.has(conv.id)) return;
    const q = query(messagesCollection(conv), orderBy('createdAt', 'desc'), limit(1));
    latestUnsubs.set(
      conv.id,
      onSnapshot(
        q,
        (snap) => {
          const data = snap.docs[0]?.data({ serverTimestamps: 'estimate' });
          if (data) {
            latestByConv.set(conv.id, {
              ms: data.createdAt?.toMillis?.() ?? Date.now(),
              fromUid: data.fromUid,
              text: data.text,
            });
          } else {
            latestByConv.delete(conv.id);
          }
          if (tabVisible && activeId === conv.id) {
            markRead(conv.id, latestByConv.get(conv.id)?.ms);
          }
          renderList();
          notifyUnread();
        },
        (error) => {
          // Typiquement : règles Firestore pas encore mises à jour.
          console.warn(`[messagerie] lecture impossible (${conv.id})`, error.code || error);
        }
      )
    );
  });

  renderList();
  notifyUnread();
}

function sortedConversations() {
  return [...conversations].sort((a, b) => {
    const ma = latestByConv.get(a.id)?.ms ?? 0;
    const mb = latestByConv.get(b.id)?.ms ?? 0;
    if (ma !== mb) return mb - ma;
    return a.title.localeCompare(b.title, 'fr');
  });
}

function renderList() {
  if (!listEl) return;
  listEl.innerHTML = '';
  if (conversations.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'muted';
    empty.textContent = 'Ajoute un ami ou crée un groupe pour discuter.';
    listEl.appendChild(empty);
    return;
  }
  sortedConversations().forEach((conv) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'conversation-item';
    button.classList.toggle('active', conv.id === activeId);

    const icon = document.createElement('span');
    icon.className = 'conversation-icon';
    icon.textContent = conv.icon;
    button.appendChild(icon);

    const text = document.createElement('span');
    text.className = 'conversation-text';
    const title = document.createElement('span');
    title.className = 'conversation-title';
    title.textContent = conv.title;
    text.appendChild(title);
    const latest = latestByConv.get(conv.id);
    if (latest) {
      const preview = document.createElement('span');
      preview.className = 'conversation-preview';
      preview.textContent = `${latest.fromUid === me?.uid ? 'Toi : ' : ''}${latest.text}`;
      text.appendChild(preview);
    }
    button.appendChild(text);

    const dot = document.createElement('span');
    dot.className = 'conversation-unread-dot';
    dot.hidden = !isUnread(conv.id);
    button.appendChild(dot);

    button.addEventListener('click', () => openConversation(conv.id));
    li.appendChild(button);
    listEl.appendChild(li);
  });
}

// --- Fil de discussion -----------------------------------------------------------
function closeThread() {
  threadUnsub?.();
  threadUnsub = null;
  activeId = null;
  if (headerEl) headerEl.textContent = 'Choisis une conversation';
  if (messagesEl) messagesEl.innerHTML = '';
  if (formEl) formEl.hidden = true;
  if (errorEl) errorEl.textContent = '';
}

function formatTime(date) {
  const now = new Date();
  const time = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return time;
  return `${date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} ${time}`;
}

function renderMessages(messages, conv) {
  if (!messagesEl) return;
  messagesEl.innerHTML = '';
  if (messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'thread-empty';
    empty.textContent = 'Aucun message pour l\u2019instant. Dis bonjour !';
    messagesEl.appendChild(empty);
    return;
  }
  messages.forEach((m) => {
    const mine = m.fromUid === me?.uid;
    const bubble = document.createElement('div');
    bubble.className = `message${mine ? ' mine' : ''}`;

    // Dans un groupe on voit qui parle ; en privé c'est évident.
    if (conv.kind === 'group' && !mine) {
      const author = document.createElement('div');
      author.className = 'message-author';
      author.textContent = m.fromPseudo || '?';
      bubble.appendChild(author);
    }

    // textContent, jamais innerHTML : un message ne doit jamais pouvoir
    // injecter de HTML dans la page des autres.
    const text = document.createElement('div');
    text.className = 'message-text';
    text.textContent = m.text;
    bubble.appendChild(text);

    const time = document.createElement('div');
    time.className = 'message-time';
    time.textContent = formatTime(new Date(m.ms));
    bubble.appendChild(time);

    messagesEl.appendChild(bubble);
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function openConversation(id) {
  const conv = conversations.find((c) => c.id === id);
  if (!conv) return;
  threadUnsub?.();
  activeId = id;
  if (headerEl) headerEl.textContent = `${conv.icon} ${conv.title}`;
  if (formEl) formEl.hidden = false;
  if (errorEl) errorEl.textContent = '';
  if (messagesEl) messagesEl.innerHTML = '';

  const q = query(messagesCollection(conv), orderBy('createdAt', 'desc'), limit(THREAD_LIMIT));
  threadUnsub = onSnapshot(
    q,
    (snap) => {
      const messages = snap.docs
        .map((d) => {
          const data = d.data({ serverTimestamps: 'estimate' });
          return {
            fromUid: data.fromUid,
            fromPseudo: data.fromPseudo,
            text: String(data.text ?? ''),
            ms: data.createdAt?.toMillis?.() ?? Date.now(),
          };
        })
        .reverse(); // récents en bas
      renderMessages(messages, conv);
      if (tabVisible && messages.length > 0) markRead(id, messages[messages.length - 1].ms);
      renderList();
      notifyUnread();
    },
    (error) => {
      console.warn(`[messagerie] conversation illisible (${id})`, error.code || error);
      if (errorEl) {
        errorEl.textContent =
          error.code === 'permission-denied'
            ? 'Messagerie indisponible : les règles Firestore doivent être mises à jour (voir firestore.rules).'
            : 'Impossible de charger cette conversation.';
      }
    }
  );
  renderList();
  inputEl?.focus();
}

async function sendMessage(text) {
  const conv = conversations.find((c) => c.id === activeId);
  const clean = text.trim();
  if (!me || !conv || clean.length === 0) return;
  try {
    await addDoc(messagesCollection(conv), {
      fromUid: me.uid,
      fromPseudo: String(me.pseudo || '?').slice(0, 40),
      text: clean.slice(0, MAX_LENGTH),
      createdAt: serverTimestamp(),
    });
    if (errorEl) errorEl.textContent = '';
  } catch (error) {
    console.warn('[messagerie] envoi impossible', error.code || error);
    if (errorEl) {
      errorEl.textContent =
        error.code === 'permission-denied'
          ? 'Envoi refusé : règles Firestore à mettre à jour, ou vous n\u2019êtes plus amis / dans ce groupe.'
          : 'Message non envoyé, réessaie.';
    }
  }
}

// --- API pour lobby.js ---------------------------------------------------------------
// À appeler une fois au démarrage. onUnreadChange(n) reçoit le nombre de
// conversations avec au moins un message non lu (pour la pastille du menu).
export function initMessaging({ onUnreadChange: onChange } = {}) {
  if (onChange) onUnreadChange = onChange;
  listEl = document.getElementById('conversation-list');
  headerEl = document.getElementById('thread-header');
  messagesEl = document.getElementById('thread-messages');
  formEl = document.getElementById('thread-form');
  inputEl = document.getElementById('thread-input');
  errorEl = document.getElementById('thread-error');
  if (!listEl || !formEl) return; // markup absent : on n'échoue pas silencieusement pour autant

  formEl.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = inputEl.value;
    inputEl.value = '';
    sendMessage(text);
  });
  renderList();
}

// user = { uid, pseudo } à la connexion, null à la déconnexion.
export function setMessagingUser(user) {
  latestUnsubs.forEach((unsub) => unsub());
  latestUnsubs.clear();
  latestByConv.clear();
  closeThread();
  friendsSource = [];
  groupsSource = [];
  conversations = [];
  me = user ? { uid: user.uid, pseudo: user.pseudo } : null;
  if (me) loadReadState();
  else readState = {};
  renderList();
  notifyUnread();
}

export function setMessagingFriends(friends) {
  friendsSource = friends || [];
  rebuildConversations();
}

export function setMessagingGroups(groups) {
  groupsSource = groups || [];
  rebuildConversations();
}

// Appelé à chaque changement d'onglet du lobby : les messages ne sont "lus"
// que quand l'onglet Messages est réellement à l'écran.
export function setMessagesTabVisible(visible) {
  tabVisible = Boolean(visible);
  if (!tabVisible || !me) return;
  if (!activeId && conversations.length > 0) {
    openConversation(sortedConversations()[0].id);
  } else if (activeId) {
    markRead(activeId, latestByConv.get(activeId)?.ms);
  }
  renderList();
  notifyUnread();
}
