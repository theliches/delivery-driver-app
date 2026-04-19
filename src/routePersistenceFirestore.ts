import {
  collection,
  deleteDoc,
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
import { getFirebaseAuth, getFirestoreDb } from "./firebaseApp";
import type { ParsedAddress } from "./addressParser";

export type FirestoreStop = ParsedAddress & {
  id: string;
  completed: boolean;
};

/** Hvilken del af appen ruten hører til (adskilte lister på forsiden). */
export type RouteWorkspace = "route" | "mapOverview";

export function normalizeRouteWorkspace(v: unknown): RouteWorkspace {
  return v === "mapOverview" ? "mapOverview" : "route";
}

export type SavedRouteSummary = {
  id: string;
  /** Primær visningslabel i sky-listen (Firestore `name`). */
  name: string;
  title: string;
  routeName: string;
  routeDate: string;
  stopCount: number;
  updatedAt: Date | null;
  workspace: RouteWorkspace;
};

export type SavedRoutePayload = {
  /** Vises i sky-listen; kræves i Firestore-reglerne. */
  name: string;
  title: string;
  routeName: string;
  routeDate: string;
  rawInput: string;
  stops: FirestoreStop[];
  activeStopId: string | null;
  /** Standard `route` (leveringsrute); `mapOverview` vises kun under kortoversigt-listen. */
  workspace?: RouteWorkspace;
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
  const name = typeof x.name === "string" ? x.name : "";
  const title =
    typeof x.title === "string"
      ? x.title
      : name
        ? name
        : "Rute";
  const routeName = typeof x.routeName === "string" ? x.routeName : "";
  const routeDateRaw = typeof x.routeDate === "string" ? x.routeDate : "";
  const routeDate = /^\d{4}-\d{2}-\d{2}$/.test(routeDateRaw)
    ? routeDateRaw
    : "";
  const stops = x.stops;
  const stopCount = Array.isArray(stops) ? stops.length : 0;
  return {
    id: d.id,
    name: name.slice(0, 120),
    title: title.slice(0, 120),
    routeName: routeName.slice(0, 100),
    routeDate,
    stopCount,
    updatedAt: tsToDate(x.updatedAt) ?? tsToDate(x.createdAt),
    workspace: normalizeRouteWorkspace(x.workspace),
  };
}

const ROUTE_LIST_LIMIT = 40;
/** Max antal dokumenter der hentes (sorteres i app’en). */
const ROUTE_FETCH_CAP = 200;

const ROUTE_LOG = "[delivery-driver routes]";

/** Sti og skrivninger må kun bruge Firebase Auth’s uid — aldrig før bruger er logget ind. */
function getAuthenticatedUid(
  callerUid: string | undefined,
  op: string,
): string | null {
  const auth = getFirebaseAuth();
  const uid = auth?.currentUser?.uid ?? null;
  if (!uid) {
    console.warn(ROUTE_LOG, "NOT AUTHENTICATED", { op });
    return null;
  }
  if (callerUid != null && callerUid !== uid) {
    console.warn(ROUTE_LOG, "UID_MISMATCH — bruger auth.currentUser.uid til sti", {
      op,
      callerUid,
      authUid: uid,
    });
  }
  return uid;
}

function routeDocumentPath(uid: string, routeId: string): string {
  return `users/${uid}/routes/${routeId}`;
}

/** Log (uden FieldValue-objekter) — egnet til Vercel / browser console. */
function logRouteWritePayload(
  path: string,
  base: Record<string, unknown>,
  isCreate: boolean,
): void {
  const rawLen =
    typeof base.rawInput === "string" ? base.rawInput.length : 0;
  const stopsLen = Array.isArray(base.stops) ? base.stops.length : 0;
  console.info(ROUTE_LOG, "write payload", {
    path,
    keys: Object.keys(base),
    name: base.name,
    title: base.title,
    routeName: base.routeName,
    routeDate: base.routeDate,
    rawInputLength: rawLen,
    stopsCount: stopsLen,
    activeStopId: base.activeStopId,
    workspace: base.workspace,
    updatedAt: "[serverTimestamp]",
    createdAt: isCreate
      ? "[serverTimestamp]"
      : "(kun merge-felter — createdAt sættes ikke igen)",
  });
}

function logFirestoreError(op: string, path: string, err: unknown): void {
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: string }).code)
      : undefined;
  const message =
    err && typeof err === "object" && "message" in err
      ? String((err as { message?: string }).message)
      : String(err);
  console.error(ROUTE_LOG, "Firestore error", {
    op,
    path,
    code,
    message,
    err,
  });
}

function sortSummariesNewestFirst(list: SavedRouteSummary[]): SavedRouteSummary[] {
  return [...list].sort(
    (a, b) =>
      (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0),
  );
}

/**
 * Engangs-hentning — prøver `orderBy` (hurtig/korrekt); ved fejl (fx manglende index)
 * hentes et batch og sorteres i app’en.
 */
export async function fetchUserRouteSummaries(
  uid: string,
): Promise<SavedRouteSummary[]> {
  const authUid = getAuthenticatedUid(uid, "fetchUserRouteSummaries");
  if (!authUid) return [];
  const db = getFirestoreDb();
  if (!db) return [];
  const coll = routesColl(db, authUid);
  const pathPrefix = `users/${authUid}/routes`;
  try {
    const q = query(
      coll,
      orderBy("updatedAt", "desc"),
      limit(ROUTE_LIST_LIMIT),
    );
    const snap = await getDocs(q);
    console.info(ROUTE_LOG, "fetchUserRouteSummaries ok", {
      uid: authUid,
      path: pathPrefix,
      count: snap.docs.length,
    });
    return snap.docs.map(docToRouteSummary);
  } catch (e) {
    logFirestoreError("fetchUserRouteSummaries", pathPrefix, e);
    const q2 = query(coll, limit(ROUTE_FETCH_CAP));
    try {
      const snap = await getDocs(q2);
      const list = sortSummariesNewestFirst(snap.docs.map(docToRouteSummary));
      return list.slice(0, ROUTE_LIST_LIMIT);
    } catch (e2) {
      logFirestoreError("fetchUserRouteSummaries(fallback)", pathPrefix, e2);
      return [];
    }
  }
}

export function routeTitleFromStops(stops: { length: number }): string {
  const dateStr = formatRouteDateDa(todayIsoLocal());
  return `${dateStr} · ${stops.length} stop`;
}

export async function fetchUserRoute(
  uid: string,
  routeId: string,
): Promise<SavedRoutePayload | null> {
  const authUid = getAuthenticatedUid(uid, "fetchUserRoute");
  if (!authUid) return null;
  const db = getFirestoreDb();
  if (!db) return null;
  const path = routeDocumentPath(authUid, routeId);
  try {
    const snap = await getDoc(routeDocRef(db, authUid, routeId));
    if (!snap.exists()) return null;
    const d = snap.data() as Record<string, unknown>;
    const rawInput = typeof d.rawInput === "string" ? d.rawInput : "";
    const nm = typeof d.name === "string" ? d.name : "";
    const title =
      typeof d.title === "string" ? d.title : nm ? nm : "Rute";
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
        const unit = typeof o.unit === "string" ? o.unit.trim() : "";
        const completed = Boolean(o.completed);
        if (!id || !street || !houseNumber || !zip || !city) return null;
        const stop: FirestoreStop = {
          id,
          street,
          houseNumber,
          zip,
          city,
          raw,
          completed,
        };
        if (unit) stop.unit = unit;
        return stop;
      })
      .filter((s): s is FirestoreStop => s != null);
    const name =
      nm ||
      (typeof d.routeName === "string" && d.routeName.trim()
        ? d.routeName.trim()
        : title);
    const workspace = normalizeRouteWorkspace(d.workspace);
    console.info(ROUTE_LOG, "fetchUserRoute ok", { uid: authUid, path });
    return {
      name,
      title,
      routeName,
      routeDate,
      rawInput,
      stops,
      activeStopId,
      workspace,
    };
  } catch (e) {
    logFirestoreError("fetchUserRoute", path, e);
    return null;
  }
}

export async function saveUserRoute(
  uid: string,
  routeId: string,
  data: SavedRoutePayload,
): Promise<boolean> {
  const authUid = getAuthenticatedUid(uid, "saveUserRoute");
  if (!authUid) return false;
  const db = getFirestoreDb();
  if (!db) {
    console.warn(ROUTE_LOG, "NO_DB", { op: "saveUserRoute" });
    return false;
  }
  const path = routeDocumentPath(authUid, routeId);
  const ref = routeDocRef(db, authUid, routeId);
  try {
    const existing = await getDoc(ref);
    const rd =
      /^\d{4}-\d{2}-\d{2}$/.test(data.routeDate)
        ? data.routeDate
        : todayIsoLocal();
    const nm = data.name.trim().slice(0, 200) || "Ny rute";
    const title =
      (data.title.trim() || nm || "Rute").slice(0, 300);
    const ws = normalizeRouteWorkspace(data.workspace);
    const base: Record<string, unknown> = {
      name: nm,
      title,
      routeName: data.routeName.trim().slice(0, 100),
      routeDate: rd,
      rawInput: data.rawInput.slice(0, 280_000),
      stops: data.stops,
      activeStopId: data.activeStopId,
      workspace: ws,
      updatedAt: serverTimestamp(),
    };
    const isCreate = !existing.exists();
    if (isCreate) {
      base.createdAt = serverTimestamp();
    }
    console.info(ROUTE_LOG, "saveUserRoute start", {
      uid: authUid,
      path,
      isCreate,
    });
    logRouteWritePayload(path, base, isCreate);
    await setDoc(ref, base, { merge: true });
    console.info(ROUTE_LOG, "saveUserRoute ok", { uid: authUid, path, isCreate });
    return true;
  } catch (e) {
    logFirestoreError("saveUserRoute", path, e);
    return false;
  }
}

export async function deleteUserRoute(
  uid: string,
  routeId: string,
): Promise<boolean> {
  const authUid = getAuthenticatedUid(uid, "deleteUserRoute");
  if (!authUid) return false;
  const db = getFirestoreDb();
  if (!db) {
    console.warn(ROUTE_LOG, "NO_DB", { op: "deleteUserRoute" });
    return false;
  }
  const path = routeDocumentPath(authUid, routeId);
  const ref = routeDocRef(db, authUid, routeId);
  try {
    await deleteDoc(ref);
    console.info(ROUTE_LOG, "deleteUserRoute ok", { uid: authUid, path });
    return true;
  } catch (e) {
    logFirestoreError("deleteUserRoute", path, e);
    return false;
  }
}

export function subscribeUserRouteSummaries(
  uid: string,
  onList: (routes: SavedRouteSummary[]) => void,
  onError?: (e: unknown) => void,
): Unsubscribe {
  const authUid = getAuthenticatedUid(uid, "subscribeUserRouteSummaries");
  if (!authUid) {
    onList([]);
    return () => {};
  }
  const db = getFirestoreDb();
  if (!db) {
    onList([]);
    return () => {};
  }
  const pathPrefix = `users/${authUid}/routes`;
  const q = query(routesColl(db, authUid), limit(ROUTE_FETCH_CAP));
  console.info(ROUTE_LOG, "subscribeUserRouteSummaries", {
    uid: authUid,
    path: pathPrefix,
  });
  return onSnapshot(
    q,
    (snap) => {
      const list = sortSummariesNewestFirst(snap.docs.map(docToRouteSummary));
      onList(list.slice(0, ROUTE_LIST_LIMIT));
    },
    (err) => {
      logFirestoreError("subscribeUserRouteSummaries", pathPrefix, err);
      onError?.(err);
    },
  );
}
