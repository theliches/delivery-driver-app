import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  limit,
  type Firestore,
  type Timestamp,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirestoreDb } from "./firebaseApp";
import type { ParsedAddress } from "./addressParser";

export type FirestoreStop = ParsedAddress & {
  id: string;
  completed: boolean;
};

export type SavedRouteSummary = {
  id: string;
  title: string;
  stopCount: number;
  updatedAt: Date | null;
};

export type SavedRoutePayload = {
  title: string;
  rawInput: string;
  stops: FirestoreStop[];
  activeStopId: string | null;
};

function routesColl(db: Firestore, uid: string) {
  return collection(db, "users", uid, "routes");
}

function routeDocRef(db: Firestore, uid: string, routeId: string) {
  return doc(db, "users", uid, "routes", routeId);
}

function tsToDate(v: unknown): Date | null {
  if (v && typeof v === "object" && "toDate" in v && typeof (v as Timestamp).toDate === "function") {
    return (v as Timestamp).toDate();
  }
  return null;
}

export function routeTitleFromStops(stops: { length: number }): string {
  const d = new Date();
  const dateStr = d.toLocaleDateString("da-DK", {
    day: "numeric",
    month: "short",
  });
  return `${dateStr} · ${stops.length} stop`;
}

export async function fetchUserRoute(
  uid: string,
  routeId: string,
): Promise<SavedRoutePayload | null> {
  const db = getFirestoreDb();
  if (!db) return null;
  try {
    const snap = await getDoc(routeDocRef(db, uid, routeId));
    if (!snap.exists()) return null;
    const d = snap.data() as Record<string, unknown>;
    const rawInput = typeof d.rawInput === "string" ? d.rawInput : "";
    const title = typeof d.title === "string" ? d.title : "Rute";
    const activeStopId =
      d.activeStopId === null || typeof d.activeStopId === "string"
        ? (d.activeStopId as string | null)
        : null;
    const stopsRaw = d.stops;
    if (!Array.isArray(stopsRaw)) return null;
    const stops: FirestoreStop[] = stopsRaw
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const o = row as Record<string, unknown>;
        const id = typeof o.id === "string" ? o.id : "";
        const street = typeof o.street === "string" ? o.street : "";
        const houseNumber = typeof o.houseNumber === "string" ? o.houseNumber : "";
        const zip = typeof o.zip === "string" ? o.zip : "";
        const city = typeof o.city === "string" ? o.city : "";
        const raw = typeof o.raw === "string" ? o.raw : "";
        const completed = Boolean(o.completed);
        if (!id || !street || !houseNumber || !zip || !city) return null;
        return {
          id,
          street,
          houseNumber,
          zip,
          city,
          raw,
          completed,
        };
      })
      .filter((s): s is FirestoreStop => s != null);
    return { title, rawInput, stops, activeStopId };
  } catch {
    return null;
  }
}

export async function saveUserRoute(
  uid: string,
  routeId: string,
  data: SavedRoutePayload,
): Promise<boolean> {
  const db = getFirestoreDb();
  if (!db) return false;
  try {
    const ref = routeDocRef(db, uid, routeId);
    const existing = await getDoc(ref);
    const base: Record<string, unknown> = {
      title: data.title.slice(0, 200),
      rawInput: data.rawInput.slice(0, 280_000),
      stops: data.stops,
      activeStopId: data.activeStopId,
      updatedAt: serverTimestamp(),
    };
    if (!existing.exists()) {
      base.createdAt = serverTimestamp();
    }
    await setDoc(ref, base, { merge: true });
    return true;
  } catch {
    return false;
  }
}

export function subscribeUserRouteSummaries(
  uid: string,
  onList: (routes: SavedRouteSummary[]) => void,
  onError?: (e: unknown) => void,
): Unsubscribe {
  const db = getFirestoreDb();
  if (!db) {
    onList([]);
    return () => {};
  }
  const q = query(routesColl(db, uid), orderBy("updatedAt", "desc"), limit(40));
  return onSnapshot(
    q,
    (snap) => {
      const list: SavedRouteSummary[] = [];
      for (const d of snap.docs) {
        const x = d.data() as Record<string, unknown>;
        const title = typeof x.title === "string" ? x.title : "Rute";
        const stops = x.stops;
        const stopCount = Array.isArray(stops) ? stops.length : 0;
        list.push({
          id: d.id,
          title: title.slice(0, 120),
          stopCount,
          updatedAt: tsToDate(x.updatedAt),
        });
      }
      onList(list);
    },
    (err) => onError?.(err),
  );
}
