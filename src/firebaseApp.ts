import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  signInAnonymously,
  type Auth,
  type User,
} from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";

let app: FirebaseApp | null = null;
let db: Firestore | null = null;
let auth: Auth | null = null;

export function isFirestoreConfigured(): boolean {
  return Boolean(
    import.meta.env.VITE_FIREBASE_PROJECT_ID &&
      import.meta.env.VITE_FIREBASE_API_KEY,
  );
}

function ensureApp(): FirebaseApp | null {
  if (!isFirestoreConfigured()) return null;
  if (!app) {
    app = initializeApp({
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "",
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
      appId: import.meta.env.VITE_FIREBASE_APP_ID,
    });
    db = getFirestore(app);
    auth = getAuth(app);
  }
  return app;
}

/** null hvis env mangler — app kører uden Firestore. */
export function getFirestoreDb(): Firestore | null {
  ensureApp();
  return db;
}

export function getFirebaseAuth(): Auth | null {
  ensureApp();
  return auth;
}

/**
 * Anonym login så rutedata kan gemmes under users/{uid}/routes.
 * Kræver at Anonymous sign-in er slået til i Firebase Console → Authentication.
 */
export async function ensureAnonUser(): Promise<User | null> {
  const a = getFirebaseAuth();
  if (!a) return null;
  if (a.currentUser) return a.currentUser;
  try {
    const cred = await signInAnonymously(a);
    return cred.user;
  } catch {
    return null;
  }
}
