import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
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

function defaultAuthDomain(): string {
  const pid = import.meta.env.VITE_FIREBASE_PROJECT_ID;
  return typeof pid === "string" && pid
    ? `${pid}.firebaseapp.com`
    : "";
}

function ensureApp(): FirebaseApp | null {
  if (!isFirestoreConfigured()) return null;
  if (!app) {
    const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID as string;
    app = initializeApp({
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain:
        (import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined)
          ?.trim() || defaultAuthDomain(),
      projectId,
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

export function formatFirebaseAuthError(e: unknown): string {
  if (e && typeof e === "object" && "code" in e) {
    const c = String((e as { code?: string }).code);
    if (c === "auth/popup-closed-by-user") {
      return "Popup lukket før login — prøv igen.";
    }
    if (c === "auth/unauthorized-domain") {
      return "Domænet er ikke godkendt: Firebase Console → Authentication → Settings → Authorized domains.";
    }
    if (c === "auth/operation-not-allowed") {
      return "Google-login er ikke slået til i Firebase Console → Authentication.";
    }
    return `Login-fejl (${c}).`;
  }
  return "Login mislykkedes.";
}

export async function signInWithGoogle(): Promise<{
  user: User | null;
  errorMessage?: string;
}> {
  const a = getFirebaseAuth();
  if (!a) return { user: null, errorMessage: "Firebase er ikke konfigureret i denne build." };
  try {
    const cred = await signInWithPopup(a, new GoogleAuthProvider());
    return { user: cred.user };
  } catch (e) {
    return { user: null, errorMessage: formatFirebaseAuthError(e) };
  }
}

export async function signOutUser(): Promise<void> {
  const a = getFirebaseAuth();
  if (!a) return;
  try {
    await signOut(a);
  } catch {
    /* ignore */
  }
}
