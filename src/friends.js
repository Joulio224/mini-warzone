// ---------------------------------------------------------------------------
// Amis : recherche par pseudo, demandes d'ami, liste d'amis
// ---------------------------------------------------------------------------
// Modèle de données Firestore :
//   users/{uid}                 { pseudo, pseudoLower, createdAt }
//   friendRequests/{fromUid_toUid}  { fromUid, fromPseudo, toUid, status, createdAt }
//   friendships/{sortedUidA_sortedUidB}
//                                { users: [uidA, uidB], pseudos: {uid: pseudo}, createdAt }
//
// Le doc "friendships" a un ID déterministe (les deux uid triés) et un tableau
// `users` — ça permet à N'IMPORTE LEQUEL des deux amis de le lire/écrire avec
// une règle simple ("auth.uid in users"), sans avoir besoin d'écrire dans le
// document Firestore de l'autre personne (ce que les règles interdisent).
import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  query,
  where,
  getDocs,
  onSnapshot,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase.js';

function requestDocId(fromUid, toUid) {
  return `${fromUid}_${toUid}`;
}

function friendshipDocId(uidA, uidB) {
  return [uidA, uidB].sort().join('_');
}

export async function searchUserByPseudo(pseudo, myUid) {
  const pseudoLower = pseudo.trim().toLowerCase();
  if (!pseudoLower) return [];
  const q = query(collection(db, 'users'), where('pseudoLower', '==', pseudoLower));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() })).filter((u) => u.uid !== myUid);
}

export async function sendFriendRequest(fromUid, fromPseudo, toUid) {
  if (fromUid === toUid) throw new Error("Tu ne peux pas t'ajouter toi-même.");
  await setDoc(doc(db, 'friendRequests', requestDocId(fromUid, toUid)), {
    fromUid,
    fromPseudo,
    toUid,
    status: 'pending',
    createdAt: serverTimestamp(),
  });
}

// callback([{ id, fromUid, fromPseudo, toUid, status, createdAt }])
export function listenIncomingRequests(myUid, callback) {
  const q = query(
    collection(db, 'friendRequests'),
    where('toUid', '==', myUid),
    where('status', '==', 'pending')
  );
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export async function acceptFriendRequest(request, myPseudo) {
  const { fromUid, fromPseudo, toUid } = request;
  await setDoc(doc(db, 'friendships', friendshipDocId(fromUid, toUid)), {
    users: [fromUid, toUid],
    pseudos: { [fromUid]: fromPseudo, [toUid]: myPseudo },
    createdAt: serverTimestamp(),
  });
  // On supprime la demande plutôt que de la marquer "accepted" : c'est le
  // doc friendships qui devient la source de vérité de l'amitié.
  await deleteDoc(doc(db, 'friendRequests', request.id));
}

export async function declineFriendRequest(requestId) {
  await deleteDoc(doc(db, 'friendRequests', requestId));
}

// callback([{ uid, pseudo, friendshipId }])
export function listenFriends(myUid, callback) {
  const q = query(collection(db, 'friendships'), where('users', 'array-contains', myUid));
  return onSnapshot(q, (snap) => {
    const friends = snap.docs.map((d) => {
      const data = d.data();
      const friendUid = data.users.find((u) => u !== myUid);
      return { uid: friendUid, pseudo: data.pseudos[friendUid], friendshipId: d.id };
    });
    callback(friends);
  });
}

export async function removeFriend(friendshipId) {
  await deleteDoc(doc(db, 'friendships', friendshipId));
}