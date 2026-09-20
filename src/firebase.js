// ---------------------------------------------------------------------------
// Initialisation Firebase (Auth + Firestore)
// ---------------------------------------------------------------------------
// La config vient des variables d'environnement Vite (fichier .env, jamais
// commité — voir .env.example). Toutes les clés d'un projet Firebase "web"
// sont publiques par design : ce qui protège vraiment les données, ce sont
// les règles Firestore (firestore.rules) et l'activation d'App Check plus
// tard si besoin.
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

if (!firebaseConfig.apiKey) {
  console.warn(
    '[firebase] Config manquante — copie .env.example en .env et remplis les clés de ton projet Firebase.'
  );
}

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
