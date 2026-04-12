import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { getFirestoreDb } from "./firebaseApp";

export type CachedLatLng = { lat: number; lng: number };

async function docIdFromNormalized(normalized: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function readAddressCache(
  normalized: string,
): Promise<CachedLatLng | null> {
  const db = getFirestoreDb();
  if (!db) return null;
  try {
    const id = await docIdFromNormalized(normalized);
    const snap = await getDoc(doc(db, "addressCache", id));
    if (!snap.exists()) return null;
    const d = snap.data() as { lat?: unknown; lng?: unknown };
    const lat = Number(d.lat);
    const lng = Number(d.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

export async function writeAddressCache(
  normalized: string,
  lat: number,
  lng: number,
): Promise<void> {
  const db = getFirestoreDb();
  if (!db) return;
  try {
    const id = await docIdFromNormalized(normalized);
    await setDoc(
      doc(db, "addressCache", id),
      {
        address: normalized,
        lat,
        lng,
        createdAt: serverTimestamp(),
      },
      { merge: true },
    );
  } catch {
    /* fail open */
  }
}
