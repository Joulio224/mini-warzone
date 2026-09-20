// ---------------------------------------------------------------------------
// Comptes joueurs (Firebase Auth par email/mot de passe + doc Firestore)
// ---------------------------------------------------------------------------
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
} from 'firebase/auth';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from './firebase.js';

// callback(user | null) — appelé immédiatement puis à chaque changement d'état
export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

export async function signUp(email, password, pseudo) {
  const cleanPseudo = pseudo.trim();
  if (cleanPseudo.length < 3) {
    throw new Error('Le pseudo doit faire au moins 3 caractères.');
  }
  if (cleanPseudo.length > 20) {
    throw new Error('Le pseudo doit faire moins de 20 caractères.');
  }

  const credential = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(credential.user, { displayName: cleanPseudo });

  // Doc public minimal, utilisé pour la recherche d'amis par pseudo.
  await setDoc(doc(db, 'users', credential.user.uid), {
    pseudo: cleanPseudo,
    pseudoLower: cleanPseudo.toLowerCase(),
    createdAt: serverTimestamp(),
  });

  return credential.user;
}

export async function signIn(email, password) {
  const credential = await signInWithEmailAndPassword(auth, email, password);
  return credential.user;
}

export async function signOutUser() {
  await signOut(auth);
}

// Traduit les codes d'erreur Firebase en messages compréhensibles pour un lycéen
export function friendlyAuthError(error) {
  const map = {
    'auth/email-already-in-use': 'Ce compte existe déjà — connecte-toi plutôt.',
    'auth/invalid-email': 'Adresse email invalide.',
    'auth/weak-password': 'Mot de passe trop court (6 caractères minimum).',
    'auth/invalid-credential': 'Email ou mot de passe incorrect.',
    'auth/wrong-password': 'Email ou mot de passe incorrect.',
    'auth/user-not-found': 'Aucun compte avec cet email.',
    'auth/too-many-requests': 'Trop de tentatives — réessaie dans un moment.',
  };
  return map[error.code] || error.message;
}
