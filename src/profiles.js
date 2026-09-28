// ---------------------------------------------------------------------------
// Skin publié dans le profil public (users/{uid}.appearance)
// ---------------------------------------------------------------------------
// Le skin choisi est stocké en local (voir appearance.js), donc invisible
// pour les autres joueurs. Pour que le lobby puisse afficher le perso de tes
// coéquipiers, chacun publie le sien dans son doc users/{uid} — déjà lisible
// par tout compte connecté et modifiable par son propriétaire uniquement
// (voir firestore.rules), donc aucune règle à changer.
//
//   users/{uid} { pseudo, pseudoLower, createdAt, appearance: { bodyColor, face } }
import { doc, setDoc, onSnapshot } from 'firebase/firestore';
import { db } from './firebase.js';
import { sanitizeAppearance } from './appearance.js';

export async function saveMyAppearance(uid, appearance) {
  await setDoc(doc(db, 'users', uid), { appearance: sanitizeAppearance(appearance) }, { merge: true });
}

// callback(appearance) — toujours une apparence valide : ce qui vient de
// Firestore passe par sanitizeAppearance (couleur hex + emoji de la liste),
// donc un doc modifié à la main ne peut rien injecter dans la page. Un profil
// sans skin publié (ou illisible) donne le skin par défaut.
export function listenUserAppearance(uid, callback) {
  return onSnapshot(
    doc(db, 'users', uid),
    (snap) => callback(sanitizeAppearance(snap.data()?.appearance)),
    () => callback(sanitizeAppearance(null))
  );
}
