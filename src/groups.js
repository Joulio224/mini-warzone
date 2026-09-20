// ---------------------------------------------------------------------------
// Groupes : créer un groupe, y ajouter des amis, le quitter
// ---------------------------------------------------------------------------
// groups/{groupId} { name, ownerId, members: [uid...], memberPseudos: {uid: pseudo}, createdAt }
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

export async function addMemberToGroup(groupId, memberUid, memberPseudo) {
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
