import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  limit,
  type Firestore,
  type QueryDocumentSnapshot,
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
  routeName: string;
  routeDate: string;
  stopCount: number;
  updatedAt: Date | null;
};

export type SavedRoutePayload = {
  title: string;
  routeName: string;
  routeDate: string;
  rawInput: string;
  stops: FirestoreStop[];
  activeStopId: string | null;
};

/** I dag som YYYY-MM-DD (lokal kalender). */
export function todayIsoLocal(): string {
  const t = new Date();
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, "0");
  const d = String(t.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** ISO YYYY-MM-DD → dansk visning dd-mm-yyyy */
export function formatRouteDateDa(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [ys, ms, ds] = iso.split("-");
  return `${ds}-${ms}-${ys}`;
}

/** Dato + klokkeslæt som dd-mm-yyyy HH:mm (24 t) */
export function formatDateTimeDdMmYyyyHm(d: Date): string {
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${day}-${month}-${year} ${h}:${min}`;
}

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

function docToRouteSummary(d: QueryDocumentSnapshot): SavedRouteSummary {
  const x = d.data() as Record<string, unknown>;
  const title = typeof x.title === "string" ? x.title : "Rute";
  const routeName = typeof x.routeName === "string" ? x.routeName : "";
  const routeDateRaw = typeof x.routeDate === "string" ? x.routeDate : "";
  const routeDate = /^\d{4}-\d{2}-\d{2}$/.test(routeDateRaw)
    ? routeDateRaw
    : "";
  const stops = x.stops;
  const stopCount = Array.isArray(stops) ? stops.length : 0;
  return {
    id: d.id,
    title: title.slice(0, 120),
    routeName: routeName.slice(0, 100),
    routeDate,
    stopCount,
    updatedAt: tsToDate(x.updatedAt),
  };
}

/** Engangs-hentning af rute-listen (samme sortering som live-listener). */
export async function fetchUserRouteSummaries(
  uid: string,
): Promise<SavedRouteSummary[]> {
  const db = getFirestoreDb();
  if (!db) return [];
  const q = query(routesColl(db, uid), orderBy("updatedAt", "desc"), limit(40));
  const snap = await getDocs(q);
  return snap.docs.map(docToRouteSummary);
}

export function routeTitleFromStops(stops: { length: number }): string {
  const dateStr = formatRouteDateDa(todayIsoLocal());
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
    const routeName = typeof d.routeName === "string" ? d.routeName : "";
    const routeDateRaw = typeof d.routeDate === "string" ? d.routeDate : "";
    const routeDate = /^\d{4}-\d{2}-\d{2}$/.test(routeDateRaw)
      ? routeDateRaw
      : "";
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
    return { title, routeName, routeDate, rawInput, stops, activeStopId };
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
    const rd =
      /^\d{4}-\d{2}-\d{2}$/.test(data.routeDate)
        ? data.routeDate
        : todayIsoLocal();
    const base: Record<string, unknown> = {
      title: data.title.slice(0, 200),
      routeName: data.routeName.trim().slice(0, 100),
      routeDate: rd,
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
      onList(snap.docs.map(docToRouteSummary));
    },
    (err) => onError?.(err),
  );
}
