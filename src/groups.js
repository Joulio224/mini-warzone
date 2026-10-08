// ---------------------------------------------------------------------------
// Groupes : créer un groupe, inviter des amis (demande à accepter), quitter
// ---------------------------------------------------------------------------
// groups/{groupId} { name, ownerId, members: [uid...], memberPseudos: {uid: pseudo},
//                     mode: 'solo'|'team', memberTeams: {uid: 'red'|'blue'}, createdAt }
// groupInvites/{inviteId} { groupId, groupName, fromUid, fromPseudo, toUid, toPseudo, status, createdAt }
import {
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  onSnapshot,
  arrayUnion,
  arrayRemove,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase.js';

export async function createGroup(name, ownerUid, ownerPseudo) {
  const cleanName = name.trim();
  if (cleanName.length < 2) {
    throw new Error('Le nom du groupe doit faire au moins 2 caractères.');
  }
  const ref = doc(collection(db, 'groups'));
  await setDoc(ref, {
    name: cleanName,
    ownerId: ownerUid,
    members: [ownerUid],
    memberPseudos: { [ownerUid]: ownerPseudo },
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

// callback([{ id, name, ownerId, members, memberPseudos, createdAt }])
export function listenMyGroups(myUid, callback) {
  const q = query(collection(db, 'groups'), where('members', 'array-contains', myUid));
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

async function addMemberToGroup(groupId, memberUid, memberPseudo) {
  await updateDoc(doc(db, 'groups', groupId), {
    members: arrayUnion(memberUid),
    [`memberPseudos.${memberUid}`]: memberPseudo,
  });
}

export async function leaveGroup(groupId, myUid) {
  await updateDoc(doc(db, 'groups', groupId), {
    members: arrayRemove(myUid),
  });
}

export async function deleteGroup(groupId) {
  await deleteDoc(doc(db, 'groups', groupId));
}

// ---------------------------------------------------------------------------
// Mode de jeu du groupe : "solo" (par défaut, comportement inchangé — chacun
// peut tirer sur tout le monde) ou "team" (les coéquipiers ne peuvent pas se
// tuer entre eux, voir server.js). Seul le créateur du groupe (ownerId) doit
// pouvoir changer ça — c'est fait respecter côté UI (lobby.js n'affiche les
// contrôles qu'au créateur), PAS par les règles Firestore : comme le reste de
// ce fichier ("entre potes de confiance"), un membre qui bidouille la
// console pourrait techniquement l'appeler lui-même. Pas un souci pour ce
// projet, mais à savoir si un jour tu veux durcir ça.
// ---------------------------------------------------------------------------
export async function setGroupMode(groupId, mode) {
  await updateDoc(doc(db, 'groups', groupId), { mode: mode === 'team' ? 'team' : 'solo' });
}

// Assigne (ou réassigne) un membre à l'équipe rouge ou bleue. Active aussi
// mode:'team' dans le même appel — avant, les deux étaient séparés (bouton
// Mode + pastille par membre), et un groupe pouvait se retrouver à moitié
// configuré : des couleurs choisies mais le mode resté sur "Solo". Dans cet
// état, TOUT LE MONDE repartait en solo (voir lobby.js, teamOf), ce qui a
// fini par le même symptôme qu'un vieux bug côté serveur (tout le monde
// atterrissait dans l'équipe rouge — voir le commentaire au-dessus de
// assignTeam() dans server.js). Assigner une couleur n'a de sens QUE si le
// mode Équipes est actif, donc autant garantir que les deux vont toujours
// ensemble plutôt que de compter sur deux clics distincts dans le bon ordre.
export async function setMemberTeam(groupId, uid, team) {
  if (team !== 'red' && team !== 'blue') return;
  await updateDoc(doc(db, 'groups', groupId), {
    mode: 'team',
    [`memberTeams.${uid}`]: team,
  });
}

// --- Invitations -------------------------------------------------------------
// Même logique que les demandes d'ami : on ne rejoint plus un groupe direct,
// quelqu'un doit accepter une invitation d'abord.

function inviteDocId(groupId, toUid) {
  return `${groupId}_${toUid}`;
}

export async function sendGroupInvite(groupId, groupName, fromUid, fromPseudo, toUid, toPseudo) {
  if (fromUid === toUid) throw new Error("Tu ne peux pas t'inviter toi-même.");
  await setDoc(doc(db, 'groupInvites', inviteDocId(groupId, toUid)), {
    groupId,
    groupName,
    fromUid,
    fromPseudo,
    toUid,
    toPseudo,
    status: 'pending',
    createdAt: serverTimestamp(),
  });
}

// callback([{ id, groupId, groupName, fromUid, fromPseudo, toUid, toPseudo, status, createdAt }])
export function listenIncomingGroupInvites(myUid, callback) {
  const q = query(
    collection(db, 'groupInvites'),
    where('toUid', '==', myUid),
    where('status', '==', 'pending')
  );
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export async function acceptGroupInvite(invite) {
  await addMemberToGroup(invite.groupId, invite.toUid, invite.toPseudo);
  await deleteDoc(doc(db, 'groupInvites', invite.id));
}

export async function declineGroupInvite(inviteId) {
  await deleteDoc(doc(db, 'groupInvites', inviteId));
}
