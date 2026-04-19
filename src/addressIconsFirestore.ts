import {
  collection,
  doc,
  limit,
  onSnapshot,
  query,
  setDoc,
  serverTimestamp,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseAuth, getFirestoreDb } from "./firebaseApp";
import type { ParsedAddress } from "./addressParser";
import {
  canonicalAddressLabel,
  parsedAddressIconKey,
  type AddressIconFlags,
} from "./addressIconKey";

const LOG = "[delivery-driver addressIcons]";

function authUid(callerUid: string | undefined, op: string): string | null {
  const auth = getFirebaseAuth();
  const uid = auth?.currentUser?.uid ?? null;
  if (!uid) {
    console.warn(LOG, "NOT AUTHENTICATED", { op });
    return null;
  }
  if (callerUid != null && callerUid !== uid) {
    console.warn(LOG, "UID_MISMATCH", { op, callerUid, authUid: uid });
  }
  return uid;
}

function iconsColl(db: NonNullable<ReturnType<typeof getFirestoreDb>>, uid: string) {
  return collection(db, "users", uid, "addressIcons");
}

export async function saveAddressIconFlags(
  uid: string,
  address: ParsedAddress,
  flags: AddressIconFlags,
): Promise<boolean> {
  const authUser = authUid(uid, "saveAddressIconFlags");
  if (!authUser) return false;
  const db = getFirestoreDb();
  if (!db) return false;
  const id = parsedAddressIconKey(address);
  const ref = doc(iconsColl(db, authUser), id);
  try {
    await setDoc(
      ref,
      {
        door: flags.door,
        frost: flags.frost,
        alert: flags.alert,
        canonical: canonicalAddressLabel(address),
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
    return true;
  } catch (e) {
    console.error(LOG, "save failed", e);
    return false;
  }
}

export function subscribeAddressIconFlags(
  uid: string,
  onMap: (map: Record<string, AddressIconFlags>) => void,
  onError?: (e: unknown) => void,
): Unsubscribe {
  const authUser = authUid(uid, "subscribeAddressIconFlags");
  if (!authUser) {
    onMap({});
    return () => {};
  }
  const db = getFirestoreDb();
  if (!db) {
    onMap({});
    return () => {};
  }
  const q = query(iconsColl(db, authUser), limit(5000));
  return onSnapshot(
    q,
    (snap) => {
      const out: Record<string, AddressIconFlags> = {};
      for (const d of snap.docs) {
        const x = d.data() as Record<string, unknown>;
        out[d.id] = {
          door: Boolean(x.door),
          frost: Boolean(x.frost),
          alert: Boolean(x.alert),
        };
      }
      onMap(out);
    },
    (e) => {
      console.error(LOG, "subscribe error", e);
      onError?.(e);
    },
  );
}
