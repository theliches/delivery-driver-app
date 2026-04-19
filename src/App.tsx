import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { onAuthStateChanged } from "firebase/auth";
import {
  cityBaseDisplay,
  formatAddressForNav,
  parseDanishAddresses,
  clusterStopsByBuildingForDisplay,
  type ParsedAddress,
} from "./addressParser";
import { EditorStopList } from "./EditorStopList";
import { optimizeRouteWithStats } from "./routeOptimizer";
import { copyTextToClipboard } from "./clipboardWrite";
import { optimizeRouteByRoadWithStats } from "./roadRouting";
import { MAX_STOPS_PER_ROUTE } from "./routeConstants";
import {
  getFirebaseAuth,
  isFirestoreConfigured,
  signInWithGoogle,
  signOutUser,
} from "./firebaseApp";
import {
  deleteUserRoute,
  fetchUserRoute,
  fetchUserRouteSummaries,
  formatDateTimeDdMmYyyyHm,
  formatRouteDateDa,
  routeTitleFromStops,
  saveUserRoute,
  subscribeUserRouteSummaries,
  todayIsoLocal,
  type SavedRouteSummary,
} from "./routePersistenceFirestore";
import { RoutePositionNumpad } from "./RoutePositionNumpad";
import { StopRouteMap } from "./StopRouteMap";

const LS_KEY = "delivery-driver-route-v1";
const THEME_KEY = "delivery-driver-theme";
const ACCENT_KEY = "delivery-driver-accent";
const ACTIVE_FIREBASE_ROUTE_LS = "delivery-driver-firebase-active-route-id";
const ACTIVE_FIREBASE_MAPOVERVIEW_ROUTE_LS =
  "delivery-driver-firebase-map-overview-route-id";
const LOCAL_TO_CLOUD_SEED_PREFIX = "delivery-driver-local-seeded-";
/** Debounce for sky-synk — hold ved 900 ms for at undgå for hyppige Firestore-skrivninger. */
const CLOUD_SYNC_DEBOUNCE_MS = 900;

function readLsActiveFirebaseRouteId(): string | null {
  try {
    const v = localStorage.getItem(ACTIVE_FIREBASE_ROUTE_LS);
    return v && v.trim().length > 0 ? v.trim() : null;
  } catch {
    return null;
  }
}

function readLsActiveFirebaseMapOverviewRouteId(): string | null {
  try {
    const v = localStorage.getItem(ACTIVE_FIREBASE_MAPOVERVIEW_ROUTE_LS);
    return v && v.trim().length > 0 ? v.trim() : null;
  } catch {
    return null;
  }
}

type AccentId = "orange" | "red" | "green" | "blue";

type AccentPreset = {
  label: string;
  main: string;
  deep: string;
  /** Diskret neutral til flader/tryk (kun grønt tema har brand-neutral). */
  surface?: string;
};

const ACCENT_PRESETS: Record<AccentId, AccentPreset> = {
  orange: { label: "Orange", main: "#FF6B35", deep: "#E85A24" },
  /** Afdæmpet R — ikke neon */
  red: { label: "Rød", main: "#C45C5C", deep: "#9E4545" },
  /** Brand: #22913A / #186929 / #D6D6D6 */
  green: {
    label: "Grøn",
    main: "#22913A",
    deep: "#186929",
    surface: "#D6D6D6",
  },
  /** Afdæmpet B — stålblå */
  blue: { label: "Blå", main: "#4580C4", deep: "#35649A" },
};

function hexToRgbTriplet(hex: string): string {
  const n = hex.replace("#", "");
  const r = Number.parseInt(n.slice(0, 2), 16);
  const g = Number.parseInt(n.slice(2, 4), 16);
  const b = Number.parseInt(n.slice(4, 6), 16);
  if ([r, g, b].some((x) => Number.isNaN(x))) return "255 107 53";
  return `${r} ${g} ${b}`;
}

type CloudSyncPhase = "idle" | "pending" | "syncing" | "synced" | "error";

type AppScreen = "home" | "editor" | "mapOverview";

type Stop = ParsedAddress & {
  id: string;
  completed: boolean;
};

type Persisted = {
  rawInput: string;
  stops: Stop[];
  activeId: string | null;
  routeName?: string;
  routeDate?: string;
};

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function stopsFromParsed(parsed: ParsedAddress[]): Stop[] {
  return parsed.map((p) => ({
    ...p,
    id: newId(),
    completed: false,
  }));
}

/** Omrokerer ét åbent stop til 0-baseret indeks i den åbne del af ruten. */
function reorderIncompleteStopToIndex(
  stopsAll: Stop[],
  stopId: string,
  targetIndex0: number,
): Stop[] {
  const incomplete = stopsAll.filter((x) => !x.completed);
  const complete = stopsAll.filter((x) => x.completed);
  const from = incomplete.findIndex((x) => x.id === stopId);
  if (from < 0) return stopsAll;
  const clamped = Math.max(0, Math.min(incomplete.length - 1, targetIndex0));
  if (from === clamped) return stopsAll;
  const nextIncomplete = [...incomplete];
  const [item] = nextIncomplete.splice(from, 1);
  nextIncomplete.splice(clamped, 0, item!);
  return [...nextIncomplete, ...complete];
}

function loadPersisted(): Persisted | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Persisted;
  } catch {
    return null;
  }
}

function savePersisted(data: Persisted): void {
  localStorage.setItem(LS_KEY, JSON.stringify(data));
}

/** Sky-rute: Firestore `name` er primær visning; `routeName` er sekundær. */
function primaryRouteLabelFromPayload(r: {
  name: string;
  routeName: string;
}): string {
  const n = typeof r.name === "string" ? r.name.trim() : "";
  if (n) return n;
  return typeof r.routeName === "string" ? r.routeName.trim() : "";
}

/** Valgfrit navn + én kompakt «ny sky-rute»-handling (rute-siden og kortoversigt). */
function CloudSaveNewRow({
  inputId,
  titleValue,
  onTitleChange,
  onSave,
  saveDisabled,
  buttonTitle,
}: {
  inputId: string;
  titleValue: string;
  onTitleChange: (v: string) => void;
  onSave: () => void;
  saveDisabled: boolean;
  buttonTitle: string;
}) {
  const inputCls =
    "min-h-[44px] flex-1 touch-manipulation rounded-lg border-2 border-zinc-300 bg-white px-2.5 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40 dark:border-white/25 dark:bg-slate-900 dark:text-white dark:placeholder:text-zinc-500";
  const btnCls =
    "min-h-[44px] shrink-0 touch-manipulation rounded-lg border-2 border-zinc-500 bg-zinc-100 px-3 text-sm font-extrabold text-zinc-900 transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/40 dark:bg-slate-800 dark:text-zinc-100";
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
      <input
        id={inputId}
        type="text"
        value={titleValue}
        onChange={(e) => onTitleChange(e.target.value)}
        maxLength={100}
        placeholder="Valgfrit navn (sky-listen)"
        className={inputCls}
        aria-label="Valgfrit navn på ny sky-rute"
      />
      <button
        type="button"
        title={buttonTitle}
        onClick={onSave}
        disabled={saveDisabled}
        className={btnCls}
      >
        Gem som ny sky-rute
      </button>
    </div>
  );
}

function IconSun({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function IconMoon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function IconMenu({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

function IconClose({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

function IconArrowLeft({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function IconChevronUp({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      aria-hidden
    >
      <path d="M18 15l-6-6-6 6" />
    </svg>
  );
}

function IconChevronDown({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      aria-hidden
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function isIOSDevice(): boolean {
  return /iPad|iPhone|iPod/i.test(navigator.userAgent);
}

function openNativeNavigation(fullAddress: string): void {
  const q = encodeURIComponent(fullAddress);
  const url = isIOSDevice()
    ? `comgooglemaps://?daddr=${q}`
    : `google.navigation:q=${q}`;
  window.location.href = url;
}

export default function App() {
  const [rawInput, setRawInput] = useState("");
  const [stops, setStops] = useState<Stop[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [routeOptimizeFeedback, setRouteOptimizeFeedback] = useState<
    string | null
  >(null);
  const [optimizing, setOptimizing] = useState(false);
  const [openRouteDriveKm, setOpenRouteDriveKm] = useState<number | null>(
    null,
  );
  const [copiedStopId, setCopiedStopId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [firebaseUid, setFirebaseUid] = useState<string | null>(null);
  const [activeFirestoreRouteId, setActiveFirestoreRouteId] = useState<
    string | null
  >(null);
  const [activeMapOverviewFirestoreRouteId, setActiveMapOverviewFirestoreRouteId] =
    useState<string | null>(null);
  const [savedRoutes, setSavedRoutes] = useState<SavedRouteSummary[]>([]);
  const [cloudMessage, setCloudMessage] = useState<string | null>(null);
  const [routeName, setRouteName] = useState("");
  const [routeDate, setRouteDate] = useState(() => todayIsoLocal());
  const [routesRefreshing, setRoutesRefreshing] = useState(false);
  const [screen, setScreen] = useState<AppScreen>("home");
  const [mapOverviewRawInput, setMapOverviewRawInput] = useState("");
  const [mapOverviewStops, setMapOverviewStops] = useState<Stop[]>([]);
  const [mapOverviewActiveId, setMapOverviewActiveId] = useState<string | null>(
    null,
  );
  const [editorSaveAsNewTitle, setEditorSaveAsNewTitle] = useState("");
  const [mapOverviewCloudTitle, setMapOverviewCloudTitle] = useState("");
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      const t = localStorage.getItem(THEME_KEY);
      if (t === "light" || t === "dark") return t;
    } catch {
      /* ignore */
    }
    return "dark";
  });

  const [accentId, setAccentId] = useState<AccentId>(() => {
    try {
      const a = localStorage.getItem(ACCENT_KEY);
      if (a === "orange" || a === "red" || a === "green" || a === "blue")
        return a;
    } catch {
      /* ignore */
    }
    return "orange";
  });

  const [cloudSyncPhase, setCloudSyncPhase] =
    useState<CloudSyncPhase>("idle");
  const [mapOverviewCloudSyncPhase, setMapOverviewCloudSyncPhase] =
    useState<CloudSyncPhase>("idle");
  const [routePositionPicker, setRoutePositionPicker] = useState<{
    scope: "editor" | "mapOverview";
    stopId: string;
  } | null>(null);
  /** Først `true` når auth-bootstrap (restore/seed) er færdig — undgår race med auto-attach. */
  const [cloudBootstrapReady, setCloudBootstrapReady] = useState(false);
  const cloudBootstrapDoneForUid = useRef<string | null>(null);
  const cloudBootstrapGeneration = useRef(0);
  /** `true` under hele auth-bootstrap (fetch/seed) — auto-attach må ikke køre parallelt. */
  const cloudBootstrapInFlightRef = useRef(false);
  const cloudRouteAttachLock = useRef(false);
  /** Auto-attach: stop efter gentagne fejl (undgår uendelig løkke); nulstilles ved uid- eller rute-signatur-ændring. */
  const cloudAutoAttachFailCount = useRef(0);
  /** Undgår dobbelt oprettelse af sky-rute ved hurtigt dobbelttryk på «Indlæs adresser». */
  const handleParseCloudCreateLockRef = useRef(false);
  const handleMapOverviewParseCloudCreateLockRef = useRef(false);
  const cloudMapRouteAttachLock = useRef(false);
  const cloudMapAutoAttachFailCount = useRef(0);

  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  useLayoutEffect(() => {
    const p = ACCENT_PRESETS[accentId];
    const root = document.documentElement;
    root.dataset.accent = accentId;
    root.style.setProperty("--accent-rgb", hexToRgbTriplet(p.main));
    root.style.setProperty("--accent-deep-rgb", hexToRgbTriplet(p.deep));
    if (p.surface) {
      root.style.setProperty("--accent-surface-rgb", hexToRgbTriplet(p.surface));
    } else {
      root.style.removeProperty("--accent-surface-rgb");
    }
    try {
      localStorage.setItem(ACCENT_KEY, accentId);
    } catch {
      /* ignore */
    }
  }, [accentId]);

  useEffect(() => {
    const p = loadPersisted();
    if (p) {
      setRawInput(p.rawInput ?? "");
      setStops(p.stops ?? []);
      setActiveId(p.activeId ?? null);
      setRouteName(typeof p.routeName === "string" ? p.routeName : "");
      setRouteDate(
        p.routeDate && /^\d{4}-\d{2}-\d{2}$/.test(p.routeDate)
          ? p.routeDate
          : todayIsoLocal(),
      );
    }
    const lsActiveRid = readLsActiveFirebaseRouteId();
    if (lsActiveRid) {
      setActiveFirestoreRouteId(lsActiveRid);
    }
    const lsMapRid = readLsActiveFirebaseMapOverviewRouteId();
    if (lsMapRid) {
      setActiveMapOverviewFirestoreRouteId(lsMapRid);
    }
    setHydrated(true);
    setScreen("home");
  }, []);

  useEffect(() => {
    const auth = getFirebaseAuth();
    if (!isFirestoreConfigured() || !auth) {
      setFirebaseUid(null);
      return;
    }
    return onAuthStateChanged(auth, (user) => {
      if (!user) {
        cloudBootstrapDoneForUid.current = null;
        cloudBootstrapInFlightRef.current = false;
        cloudBootstrapGeneration.current += 1;
        setCloudBootstrapReady(false);
        setFirebaseUid(null);
        setActiveMapOverviewFirestoreRouteId(null);
        return;
      }
      const uid = user.uid;
      setFirebaseUid(uid);
      if (cloudBootstrapDoneForUid.current === uid) return;
      cloudBootstrapDoneForUid.current = uid;
      cloudBootstrapGeneration.current += 1;
      const bootstrapGen = cloudBootstrapGeneration.current;
      setCloudBootstrapReady(false);
      cloudBootstrapInFlightRef.current = true;
      void (async () => {
        try {
          setCloudMessage(null);
          let activeRid = localStorage.getItem(ACTIVE_FIREBASE_ROUTE_LS);
          if (activeRid) {
            const remote = await fetchUserRoute(uid, activeRid);
            if (remote && remote.workspace !== "mapOverview") {
              setRawInput(remote.rawInput);
              setStops(remote.stops as Stop[]);
              setRouteName(primaryRouteLabelFromPayload(remote));
              setRouteDate(
                remote.routeDate && /^\d{4}-\d{2}-\d{2}$/.test(remote.routeDate)
                  ? remote.routeDate
                  : todayIsoLocal(),
              );
              const nextActive =
                remote.activeStopId &&
                remote.stops.some((s) => s.id === remote.activeStopId)
                  ? remote.activeStopId
                  : remote.stops.find((s) => !s.completed)?.id ??
                    remote.stops[0]?.id ??
                    null;
              setActiveId(nextActive);
              setActiveFirestoreRouteId(activeRid);
            } else {
              try {
                localStorage.removeItem(ACTIVE_FIREBASE_ROUTE_LS);
              } catch {
                /* ignore */
              }
              activeRid = null;
              setActiveFirestoreRouteId(null);
            }
          }
          const lsMapBootstrap = readLsActiveFirebaseMapOverviewRouteId();
          if (lsMapBootstrap) {
            const mapRemote = await fetchUserRoute(uid, lsMapBootstrap);
            if (mapRemote && mapRemote.workspace === "mapOverview") {
              setMapOverviewRawInput(mapRemote.rawInput);
              setMapOverviewStops(mapRemote.stops as Stop[]);
              const nextMapActive =
                mapRemote.activeStopId &&
                mapRemote.stops.some((s) => s.id === mapRemote.activeStopId)
                  ? mapRemote.activeStopId
                  : mapRemote.stops.find((s) => !s.completed)?.id ??
                    mapRemote.stops[0]?.id ??
                    null;
              setMapOverviewActiveId(nextMapActive);
              setActiveMapOverviewFirestoreRouteId(lsMapBootstrap);
            } else {
              try {
                localStorage.removeItem(ACTIVE_FIREBASE_MAPOVERVIEW_ROUTE_LS);
              } catch {
                /* ignore */
              }
              setActiveMapOverviewFirestoreRouteId(null);
            }
          }
          const p = loadPersisted();
          const seedKey = `${LOCAL_TO_CLOUD_SEED_PREFIX}${uid}`;
          if (
            !activeRid &&
            !localStorage.getItem(seedKey) &&
            p &&
            (p.stops?.length ?? 0) > 0
          ) {
            const st = p.stops ?? [];
            const aid =
              p.activeId && st.some((s) => s.id === p.activeId)
                ? p.activeId
                : st.find((s) => !s.completed)?.id ?? st[0]?.id ?? null;
            const rd =
              p.routeDate && /^\d{4}-\d{2}-\d{2}$/.test(p.routeDate)
                ? p.routeDate
                : todayIsoLocal();
            const nm =
              typeof p.routeName === "string" && p.routeName.trim()
                ? p.routeName.trim()
                : routeTitleFromStops(st);
            const rid = newId();
            const seededOk = await saveUserRoute(uid, rid, {
              name: nm,
              title: routeTitleFromStops(st),
              routeName: typeof p.routeName === "string" ? p.routeName : "",
              routeDate: rd,
              rawInput: p.rawInput ?? "",
              stops: st,
              activeStopId: aid,
              workspace: "route",
            });
            if (seededOk) {
              localStorage.setItem(seedKey, "1");
              setActiveFirestoreRouteId(rid);
            } else {
              setCloudMessage(
                "Kunne ikke gemme lokal rute i skyen ved login — tjek netværk/regler og prøv «Indlæs adresser» igen.",
              );
            }
          }
        } finally {
          cloudBootstrapInFlightRef.current = false;
          if (cloudBootstrapGeneration.current === bootstrapGen) {
            setCloudBootstrapReady(true);
          }
        }
      })();
    });
  }, []);

  useEffect(() => {
    if (!firebaseUid) {
      setSavedRoutes([]);
      return;
    }
    return subscribeUserRouteSummaries(
      firebaseUid,
      (list) => setSavedRoutes(list),
      () => setCloudMessage("Kunne ikke hente rute-liste fra skyen."),
    );
  }, [firebaseUid]);

  useEffect(() => {
    if (!firebaseUid) {
      cloudRouteAttachLock.current = false;
      cloudAutoAttachFailCount.current = 0;
      cloudMapRouteAttachLock.current = false;
      cloudMapAutoAttachFailCount.current = 0;
    }
  }, [firebaseUid]);

  /** Nulstil auto-attach-fejltæller når ruten ændrer sig (fx nyt parse / nye stop-id), så gentagelse er mulig. */
  const cloudAutoAttachRouteSignature = useMemo(
    () => `${stops.length}:${stops.map((s) => s.id).join("|")}`,
    [stops],
  );

  useEffect(() => {
    cloudAutoAttachFailCount.current = 0;
    if (stops.length === 0) {
      cloudRouteAttachLock.current = false;
    }
  }, [cloudAutoAttachRouteSignature, stops.length]);

  const mapOverviewCloudAutoAttachRouteSignature = useMemo(
    () =>
      `${mapOverviewStops.length}:${mapOverviewStops.map((s) => s.id).join("|")}`,
    [mapOverviewStops],
  );

  useEffect(() => {
    cloudMapAutoAttachFailCount.current = 0;
    if (mapOverviewStops.length === 0) {
      cloudMapRouteAttachLock.current = false;
    }
  }, [mapOverviewCloudAutoAttachRouteSignature, mapOverviewStops.length]);

  /** Efter bootstrap: opret sky-dokument under `users/{uid}/routes/{id}` hvis der stadig mangler ét. */
  useEffect(() => {
    if (
      !hydrated ||
      !cloudBootstrapReady ||
      !firebaseUid ||
      activeFirestoreRouteId ||
      stops.length === 0
    ) {
      return;
    }
    if (cloudBootstrapInFlightRef.current) return;
    if (cloudAutoAttachFailCount.current >= 6) return;
    if (cloudRouteAttachLock.current) return;
    const lsRid = readLsActiveFirebaseRouteId();
    if (lsRid) {
      cloudRouteAttachLock.current = true;
      setActiveFirestoreRouteId(lsRid);
      const rd =
        routeDate && /^\d{4}-\d{2}-\d{2}$/.test(routeDate)
          ? routeDate
          : todayIsoLocal();
      const nm = routeName.trim() || routeTitleFromStops(stops);
      void saveUserRoute(firebaseUid, lsRid, {
        name: nm,
        title: routeTitleFromStops(stops),
        routeName: routeName.trim(),
        routeDate: rd,
        rawInput,
        stops,
        activeStopId: activeId,
        workspace: "route",
      }).then((ok) => {
        if (ok) {
          cloudAutoAttachFailCount.current = 0;
          return;
        }
        cloudAutoAttachFailCount.current += 1;
        setCloudMessage(
          "Kunne ikke oprette rute i skyen. Deploy `firestore.rules` med `match /users/{userId}/routes/{routeId}` (timestamps + ejerskab).",
        );
        setActiveFirestoreRouteId(null);
        try {
          localStorage.removeItem(ACTIVE_FIREBASE_ROUTE_LS);
        } catch {
          /* ignore */
        }
        cloudRouteAttachLock.current = false;
      });
      return;
    }
    cloudRouteAttachLock.current = true;
    const rid = newId();
    setActiveFirestoreRouteId(rid);
    const rd =
      routeDate && /^\d{4}-\d{2}-\d{2}$/.test(routeDate)
        ? routeDate
        : todayIsoLocal();
    const nm = routeName.trim() || routeTitleFromStops(stops);
    void saveUserRoute(firebaseUid, rid, {
      name: nm,
      title: routeTitleFromStops(stops),
      routeName: routeName.trim(),
      routeDate: rd,
      rawInput,
      stops,
      activeStopId: activeId,
      workspace: "route",
    }).then((ok) => {
      if (ok) {
        cloudAutoAttachFailCount.current = 0;
        return;
      }
      cloudAutoAttachFailCount.current += 1;
      setCloudMessage(
        "Kunne ikke oprette rute i skyen. Deploy `firestore.rules` med `match /users/{userId}/routes/{routeId}` (timestamps + ejerskab).",
      );
      setActiveFirestoreRouteId(null);
      try {
        localStorage.removeItem(ACTIVE_FIREBASE_ROUTE_LS);
      } catch {
        /* ignore */
      }
      cloudRouteAttachLock.current = false;
    });
  }, [
    hydrated,
    cloudBootstrapReady,
    firebaseUid,
    activeFirestoreRouteId,
    stops,
    routeName,
    routeDate,
    rawInput,
    activeId,
  ]);

  /** Efter bootstrap: kortoversigt får eget sky-dokument (adskilt fra leveringsrute). */
  useEffect(() => {
    if (
      !hydrated ||
      !cloudBootstrapReady ||
      !firebaseUid ||
      activeMapOverviewFirestoreRouteId ||
      mapOverviewStops.length === 0
    ) {
      return;
    }
    if (cloudBootstrapInFlightRef.current) return;
    if (cloudMapAutoAttachFailCount.current >= 6) return;
    if (cloudMapRouteAttachLock.current) return;
    const lsMapRid = readLsActiveFirebaseMapOverviewRouteId();
    if (lsMapRid) {
      cloudMapRouteAttachLock.current = true;
      setActiveMapOverviewFirestoreRouteId(lsMapRid);
      const rd = todayIsoLocal();
      const nm =
        mapOverviewCloudTitle.trim() ||
        routeTitleFromStops(mapOverviewStops);
      void saveUserRoute(firebaseUid, lsMapRid, {
        name: nm.slice(0, 200),
        title: routeTitleFromStops(mapOverviewStops),
        routeName: mapOverviewCloudTitle.trim().slice(0, 100),
        routeDate: rd,
        rawInput: mapOverviewRawInput,
        stops: mapOverviewStops,
        activeStopId: mapOverviewActiveId,
        workspace: "mapOverview",
      }).then((ok) => {
        if (ok) {
          cloudMapAutoAttachFailCount.current = 0;
          return;
        }
        cloudMapAutoAttachFailCount.current += 1;
        setCloudMessage(
          "Kunne ikke oprette kortoversigt-rute i skyen. Tjek netværk og Firestore-regler.",
        );
        setActiveMapOverviewFirestoreRouteId(null);
        try {
          localStorage.removeItem(ACTIVE_FIREBASE_MAPOVERVIEW_ROUTE_LS);
        } catch {
          /* ignore */
        }
        cloudMapRouteAttachLock.current = false;
      });
      return;
    }
    cloudMapRouteAttachLock.current = true;
    const rid = newId();
    setActiveMapOverviewFirestoreRouteId(rid);
    const rd = todayIsoLocal();
    const nm =
      mapOverviewCloudTitle.trim() || routeTitleFromStops(mapOverviewStops);
    void saveUserRoute(firebaseUid, rid, {
      name: nm.slice(0, 200),
      title: routeTitleFromStops(mapOverviewStops),
      routeName: mapOverviewCloudTitle.trim().slice(0, 100),
      routeDate: rd,
      rawInput: mapOverviewRawInput,
      stops: mapOverviewStops,
      activeStopId: mapOverviewActiveId,
      workspace: "mapOverview",
    }).then((ok) => {
      if (ok) {
        cloudMapAutoAttachFailCount.current = 0;
        return;
      }
      cloudMapAutoAttachFailCount.current += 1;
      setCloudMessage(
        "Kunne ikke oprette kortoversigt-rute i skyen. Tjek netværk og Firestore-regler.",
      );
      setActiveMapOverviewFirestoreRouteId(null);
      try {
        localStorage.removeItem(ACTIVE_FIREBASE_MAPOVERVIEW_ROUTE_LS);
      } catch {
        /* ignore */
      }
      cloudMapRouteAttachLock.current = false;
    });
  }, [
    hydrated,
    cloudBootstrapReady,
    firebaseUid,
    activeMapOverviewFirestoreRouteId,
    mapOverviewStops,
    mapOverviewRawInput,
    mapOverviewActiveId,
    mapOverviewCloudTitle,
  ]);

  useEffect(() => {
    if (!hydrated) return;
    savePersisted({ rawInput, stops, activeId, routeName, routeDate });
  }, [hydrated, rawInput, stops, activeId, routeName, routeDate]);

  useEffect(() => {
    if (!hydrated) return;
    if (!activeFirestoreRouteId) return;
    try {
      localStorage.setItem(ACTIVE_FIREBASE_ROUTE_LS, activeFirestoreRouteId);
    } catch {
      /* ignore */
    }
  }, [hydrated, activeFirestoreRouteId]);

  useEffect(() => {
    if (!hydrated) return;
    if (!activeMapOverviewFirestoreRouteId) return;
    try {
      localStorage.setItem(
        ACTIVE_FIREBASE_MAPOVERVIEW_ROUTE_LS,
        activeMapOverviewFirestoreRouteId,
      );
    } catch {
      /* ignore */
    }
  }, [hydrated, activeMapOverviewFirestoreRouteId]);

  useEffect(() => {
    if (!hydrated || !firebaseUid || !activeFirestoreRouteId) {
      setCloudSyncPhase("idle");
      return;
    }
    setCloudSyncPhase("pending");
    const t = window.setTimeout(() => {
      void (async () => {
        setCloudSyncPhase("syncing");
        const rd =
          routeDate && /^\d{4}-\d{2}-\d{2}$/.test(routeDate)
            ? routeDate
            : todayIsoLocal();
        const nm =
          routeName.trim() || routeTitleFromStops(stops);
        const ok = await saveUserRoute(firebaseUid, activeFirestoreRouteId, {
          name: nm,
          title: routeTitleFromStops(stops),
          routeName: routeName.trim(),
          routeDate: rd,
          rawInput,
          stops,
          activeStopId: activeId,
          workspace: "route",
        });
        setCloudSyncPhase(ok ? "synced" : "error");
        if (!ok) {
          setCloudMessage(
            "Sky-gem fejlede (ofte manglende/opdaterede Firestore-regler). Tjek `users/{uid}/routes`-regler og netværk.",
          );
        }
      })();
    }, CLOUD_SYNC_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [
    hydrated,
    firebaseUid,
    activeFirestoreRouteId,
    rawInput,
    stops,
    activeId,
    routeName,
    routeDate,
  ]);

  useEffect(() => {
    if (!hydrated || !firebaseUid || !activeMapOverviewFirestoreRouteId) {
      setMapOverviewCloudSyncPhase("idle");
      return;
    }
    setMapOverviewCloudSyncPhase("pending");
    const t = window.setTimeout(() => {
      void (async () => {
        setMapOverviewCloudSyncPhase("syncing");
        const rd = todayIsoLocal();
        const nm =
          mapOverviewCloudTitle.trim() ||
          routeTitleFromStops(mapOverviewStops);
        const ok = await saveUserRoute(
          firebaseUid,
          activeMapOverviewFirestoreRouteId,
          {
            name: nm.slice(0, 200),
            title: routeTitleFromStops(mapOverviewStops),
            routeName: mapOverviewCloudTitle.trim().slice(0, 100),
            routeDate: rd,
            rawInput: mapOverviewRawInput,
            stops: mapOverviewStops,
            activeStopId: mapOverviewActiveId,
            workspace: "mapOverview",
          },
        );
        setMapOverviewCloudSyncPhase(ok ? "synced" : "error");
        if (!ok) {
          setCloudMessage(
            "Sky-gem (kortoversigt) fejlede — tjek netværk og Firestore-regler.",
          );
        }
      })();
    }, CLOUD_SYNC_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [
    hydrated,
    firebaseUid,
    activeMapOverviewFirestoreRouteId,
    mapOverviewRawInput,
    mapOverviewStops,
    mapOverviewActiveId,
    mapOverviewCloudTitle,
  ]);

  useEffect(() => {
    if (!menuOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [menuOpen]);

  const total = stops.length;
  const completedCount = useMemo(
    () => stops.filter((s) => s.completed).length,
    [stops],
  );

  const motivation = useMemo(() => {
    if (total === 0) return "Klar til dagens rute — du klarer den!";
    if (completedCount === total && total > 0) {
      return "Alle pakker ude — stærkt arbejde!";
    }
    const left = total - completedCount;
    if (left <= 2) return `Kun ${left} tilbage — du er næsten i mål!`;
    if (left <= 5) return `${left} stop tilbage — god fremdrift!`;
    return `${left} stop — kør sikkert, du er på rette vej!`;
  }, [total, completedCount]);

  const activeStop = useMemo(
    () => stops.find((s) => s.id === activeId) ?? null,
    [stops, activeId],
  );

  const ensureActive = useCallback((next: Stop[]) => {
    if (next.length === 0) {
      setActiveId(null);
      return;
    }
    const firstOpen = next.find((s) => !s.completed);
    setActiveId((cur) => {
      if (cur && next.some((s) => s.id === cur)) return cur;
      return firstOpen?.id ?? next[0].id;
    });
  }, []);

  const ensureMapOverviewActive = useCallback((next: Stop[]) => {
    if (next.length === 0) {
      setMapOverviewActiveId(null);
      return;
    }
    setMapOverviewActiveId((cur) => {
      if (cur && next.some((s) => s.id === cur)) return cur;
      return next[0]!.id;
    });
  }, []);

  const flushActiveRouteToCloud = useCallback(async (): Promise<boolean> => {
    if (!hydrated || !firebaseUid || !activeFirestoreRouteId) return true;
    const rd =
      routeDate && /^\d{4}-\d{2}-\d{2}$/.test(routeDate)
        ? routeDate
        : todayIsoLocal();
    const nm = routeName.trim() || routeTitleFromStops(stops);
    return saveUserRoute(firebaseUid, activeFirestoreRouteId, {
      name: nm,
      title: routeTitleFromStops(stops),
      routeName: routeName.trim(),
      routeDate: rd,
      rawInput,
      stops,
      activeStopId: activeId,
      workspace: "route",
    });
  }, [
    hydrated,
    firebaseUid,
    activeFirestoreRouteId,
    routeDate,
    routeName,
    stops,
    rawInput,
    activeId,
  ]);

  const flushActiveMapOverviewRouteToCloud =
    useCallback(async (): Promise<boolean> => {
      if (!hydrated || !firebaseUid || !activeMapOverviewFirestoreRouteId) {
        return true;
      }
      const rd = todayIsoLocal();
      const nm =
        mapOverviewCloudTitle.trim() ||
        routeTitleFromStops(mapOverviewStops);
      return saveUserRoute(
        firebaseUid,
        activeMapOverviewFirestoreRouteId,
        {
          name: nm.slice(0, 200),
          title: routeTitleFromStops(mapOverviewStops),
          routeName: mapOverviewCloudTitle.trim().slice(0, 100),
          routeDate: rd,
          rawInput: mapOverviewRawInput,
          stops: mapOverviewStops,
          activeStopId: mapOverviewActiveId,
          workspace: "mapOverview",
        },
      );
    }, [
      hydrated,
      firebaseUid,
      activeMapOverviewFirestoreRouteId,
      mapOverviewCloudTitle,
      mapOverviewStops,
      mapOverviewRawInput,
      mapOverviewActiveId,
    ]);

  const handleMapOverviewParse = () => {
    const parsed = parseDanishAddresses(mapOverviewRawInput);
    const next = stopsFromParsed(parsed);
    setMapOverviewStops(next);
    ensureMapOverviewActive(next);
    if (firebaseUid && next.length > 0) {
      const fromLs = readLsActiveFirebaseMapOverviewRouteId();
      const existingRid = activeMapOverviewFirestoreRouteId ?? fromLs;
      const firstOpen =
        next.find((s) => !s.completed)?.id ?? next[0]?.id ?? null;
      const rd = todayIsoLocal();
      if (existingRid) {
        if (!activeMapOverviewFirestoreRouteId) {
          setActiveMapOverviewFirestoreRouteId(existingRid);
        }
        void saveUserRoute(firebaseUid, existingRid, {
          name:
            mapOverviewCloudTitle.trim() ||
            routeTitleFromStops(next).slice(0, 200),
          title: routeTitleFromStops(next),
          routeName: mapOverviewCloudTitle.trim().slice(0, 100),
          routeDate: rd,
          rawInput: mapOverviewRawInput,
          stops: next,
          activeStopId: firstOpen,
          workspace: "mapOverview",
        });
      } else if (!handleMapOverviewParseCloudCreateLockRef.current) {
        handleMapOverviewParseCloudCreateLockRef.current = true;
        const rid = newId();
        setActiveMapOverviewFirestoreRouteId(rid);
        void saveUserRoute(firebaseUid, rid, {
          name: routeTitleFromStops(next).slice(0, 200),
          title: routeTitleFromStops(next),
          routeName: mapOverviewCloudTitle.trim().slice(0, 100),
          routeDate: rd,
          rawInput: mapOverviewRawInput,
          stops: next,
          activeStopId: firstOpen,
          workspace: "mapOverview",
        }).finally(() => {
          handleMapOverviewParseCloudCreateLockRef.current = false;
        });
      }
    }
  };

  const handleMapOverviewClear = () => {
    setMapOverviewRawInput("");
    setMapOverviewStops([]);
    setMapOverviewActiveId(null);
    setActiveMapOverviewFirestoreRouteId(null);
    try {
      localStorage.removeItem(ACTIVE_FIREBASE_MAPOVERVIEW_ROUTE_LS);
    } catch {
      /* ignore */
    }
  };

  /** Ny sky-rute fra kortoversigt — skifter ikke den aktive rute under «Rute». */
  const handleSaveMapOverviewToCloud = () => {
    setCloudMessage(null);
    if (mapOverviewStops.length === 0) {
      setCloudMessage("Indlæs adresser først — ingen stop at gemme.");
      return;
    }
    if (!firebaseUid) {
      if (isFirestoreConfigured()) {
        setCloudMessage("Log ind med Google for at gemme i skyen.");
      }
      return;
    }
    const rid = newId();
    const firstOpen =
      mapOverviewStops.find((s) => !s.completed)?.id ??
      mapOverviewStops[0]?.id ??
      null;
    const rd = todayIsoLocal();
    const nm =
      mapOverviewCloudTitle.trim() ||
      routeTitleFromStops(mapOverviewStops);
    void saveUserRoute(firebaseUid, rid, {
      name: nm.slice(0, 200),
      title: routeTitleFromStops(mapOverviewStops),
      routeName: mapOverviewCloudTitle.trim().slice(0, 100),
      routeDate: rd,
      rawInput: mapOverviewRawInput,
      stops: mapOverviewStops,
      activeStopId: firstOpen,
      workspace: "mapOverview",
    }).then((ok) => {
      if (ok) {
        setMapOverviewCloudTitle("");
        setActiveMapOverviewFirestoreRouteId(rid);
        try {
          localStorage.setItem(ACTIVE_FIREBASE_MAPOVERVIEW_ROUTE_LS, rid);
        } catch {
          /* ignore */
        }
        setCloudMessage(
          "Rute gemt under «Kortoversigt» på forsiden — ikke blandet med leveringsruter.",
        );
      } else {
        setCloudMessage("Kunne ikke gemme — tjek netværk og prøv igen.");
      }
    });
  };

  const handleParse = () => {
    setCopiedStopId(null);
    setRouteOptimizeFeedback(null);
    setOpenRouteDriveKm(null);
    const parsed = parseDanishAddresses(rawInput);
    const next = stopsFromParsed(parsed);
    setStops(next);
    ensureActive(next);
    if (firebaseUid && next.length > 0) {
      const fromLs = readLsActiveFirebaseRouteId();
      const existingRid = activeFirestoreRouteId ?? fromLs;
      const firstOpen =
        next.find((s) => !s.completed)?.id ?? next[0]?.id ?? null;
      const rd =
        routeDate && /^\d{4}-\d{2}-\d{2}$/.test(routeDate)
          ? routeDate
          : todayIsoLocal();
      if (existingRid) {
        if (!activeFirestoreRouteId) {
          setActiveFirestoreRouteId(existingRid);
        }
        void saveUserRoute(firebaseUid, existingRid, {
          name: routeName.trim() || routeTitleFromStops(next),
          title: routeTitleFromStops(next),
          routeName: routeName.trim(),
          routeDate: rd,
          rawInput,
          stops: next,
          activeStopId: firstOpen,
          workspace: "route",
        });
      } else if (!handleParseCloudCreateLockRef.current) {
        handleParseCloudCreateLockRef.current = true;
        const rid = newId();
        setActiveFirestoreRouteId(rid);
        void saveUserRoute(firebaseUid, rid, {
          name: routeName.trim() || routeTitleFromStops(next),
          title: routeTitleFromStops(next),
          routeName: routeName.trim(),
          routeDate: rd,
          rawInput,
          stops: next,
          activeStopId: firstOpen,
          workspace: "route",
        }).finally(() => {
          handleParseCloudCreateLockRef.current = false;
        });
      }
    }
  };

  /** Ny række i sky-listen — gemmer nuværende `stops` uden at parse tekst igen. */
  const handleSaveAsNewCloudRoute = () => {
    setCopiedStopId(null);
    setRouteOptimizeFeedback(null);
    setOpenRouteDriveKm(null);
    setCloudMessage(null);
    if (stops.length === 0) {
      setCloudMessage(
        "Du har ingen stop at gemme — indlæs adresser først, eller tilføj stop.",
      );
      return;
    }
    if (!firebaseUid) {
      if (isFirestoreConfigured()) {
        setCloudMessage("Log ind med Google for at gemme ruten i skyen.");
      }
      return;
    }
    const rid = newId();
    setActiveFirestoreRouteId(rid);
    const firstOpen =
      stops.find((s) => !s.completed)?.id ?? stops[0]?.id ?? null;
    const rd =
      routeDate && /^\d{4}-\d{2}-\d{2}$/.test(routeDate)
        ? routeDate
        : todayIsoLocal();
    const listName = editorSaveAsNewTitle.trim() || "Ny rute";
    void saveUserRoute(firebaseUid, rid, {
      name: listName.slice(0, 200),
      title: routeTitleFromStops(stops),
      routeName: (editorSaveAsNewTitle.trim() || routeName.trim()).slice(
        0,
        100,
      ),
      routeDate: rd,
      rawInput,
      stops,
      activeStopId: firstOpen,
      workspace: "route",
    }).then((ok) => {
      if (ok) {
        setEditorSaveAsNewTitle("");
      } else {
        setCloudMessage("Kunne ikke gemme — tjek netværk og prøv igen.");
      }
    });
  };

  const loadSavedRouteIntoApp = useCallback(
    async (r: SavedRouteSummary) => {
      if (!firebaseUid) return;
      if (r.workspace === "mapOverview") {
        setCloudMessage(
          "Den rute hører til kortoversigt — åbn den under «Kortoversigt i skyen» på forsiden.",
        );
        return;
      }
      const data = await fetchUserRoute(firebaseUid, r.id);
      if (!data) {
        setCloudMessage("Den rute findes ikke længere i skyen.");
        return;
      }
      if (data.workspace === "mapOverview") {
        setCloudMessage(
          "Den rute hører til kortoversigt — åbn den under «Kortoversigt i skyen» på forsiden.",
        );
        return;
      }
      setCloudMessage(null);
      setCopiedStopId(null);
      setRouteOptimizeFeedback(null);
      setOpenRouteDriveKm(null);
      setRawInput(data.rawInput);
      setStops(data.stops as Stop[]);
      setRouteName(primaryRouteLabelFromPayload(data));
      setRouteDate(
        data.routeDate && /^\d{4}-\d{2}-\d{2}$/.test(data.routeDate)
          ? data.routeDate
          : todayIsoLocal(),
      );
      const nextActive =
        data.activeStopId &&
        data.stops.some((s) => s.id === data.activeStopId)
          ? data.activeStopId
          : data.stops.find((s) => !s.completed)?.id ??
            data.stops[0]?.id ??
            null;
      setActiveId(nextActive);
      setActiveFirestoreRouteId(r.id);
      setMenuOpen(false);
      setScreen("editor");
    },
    [firebaseUid],
  );

  const loadSavedRouteIntoMapOverview = useCallback(
    async (r: SavedRouteSummary) => {
      if (!firebaseUid) return;
      if (r.workspace !== "mapOverview") {
        setCloudMessage(
          "Den rute er en leveringsrute — åbn den under «Leveringsruter i skyen» på forsiden.",
        );
        return;
      }
      const data = await fetchUserRoute(firebaseUid, r.id);
      if (!data) {
        setCloudMessage("Den rute findes ikke længere i skyen.");
        return;
      }
      if (data.workspace !== "mapOverview") {
        setCloudMessage(
          "Den rute er en leveringsrute — åbn den under «Leveringsruter i skyen» på forsiden.",
        );
        return;
      }
      setCloudMessage(null);
      setMapOverviewRawInput(data.rawInput);
      setMapOverviewStops(data.stops as Stop[]);
      const nextMapActive =
        data.activeStopId &&
        data.stops.some((s) => s.id === data.activeStopId)
          ? data.activeStopId
          : data.stops.find((s) => !s.completed)?.id ??
            data.stops[0]?.id ??
            null;
      setMapOverviewActiveId(nextMapActive);
      setActiveMapOverviewFirestoreRouteId(r.id);
      try {
        localStorage.setItem(ACTIVE_FIREBASE_MAPOVERVIEW_ROUTE_LS, r.id);
      } catch {
        /* ignore */
      }
      setMenuOpen(false);
      setScreen("mapOverview");
    },
    [firebaseUid],
  );

  const transferEditorStopsToMapOverview = useCallback(() => {
    setCloudMessage(null);
    setMapOverviewRawInput(rawInput);
    const cloned = stops.map((s) => ({ ...s }));
    setMapOverviewStops(cloned);
    ensureMapOverviewActive(cloned);
    setActiveMapOverviewFirestoreRouteId(null);
    try {
      localStorage.removeItem(ACTIVE_FIREBASE_MAPOVERVIEW_ROUTE_LS);
    } catch {
      /* ignore */
    }
    setMenuOpen(false);
    setScreen("mapOverview");
  }, [rawInput, stops, ensureMapOverviewActive]);

  const transferMapOverviewStopsToEditor = useCallback(() => {
    setCloudMessage(null);
    setCopiedStopId(null);
    setRouteOptimizeFeedback(null);
    setOpenRouteDriveKm(null);
    setRawInput(mapOverviewRawInput);
    const cloned = mapOverviewStops.map((s) => ({ ...s }));
    setStops(cloned);
    ensureActive(cloned);
    setActiveFirestoreRouteId(null);
    try {
      localStorage.removeItem(ACTIVE_FIREBASE_ROUTE_LS);
    } catch {
      /* ignore */
    }
    setMenuOpen(false);
    setScreen("editor");
  }, [
    mapOverviewRawInput,
    mapOverviewStops,
    ensureActive,
  ]);

  const goHome = useCallback(async () => {
    setMenuOpen(false);
    if (hydrated && firebaseUid) {
      let hadErr = false;
      if (activeFirestoreRouteId) {
        setCloudSyncPhase("syncing");
        const ok = await flushActiveRouteToCloud();
        setCloudSyncPhase(ok ? "synced" : "error");
        if (!ok) hadErr = true;
      }
      if (activeMapOverviewFirestoreRouteId) {
        setMapOverviewCloudSyncPhase("syncing");
        const okM = await flushActiveMapOverviewRouteToCloud();
        setMapOverviewCloudSyncPhase(okM ? "synced" : "error");
        if (!okM) hadErr = true;
      }
      if (hadErr) {
        setCloudMessage(
          "Kunne ikke gemme alt til skyen før forsiden — prøv igen om et øjeblik.",
        );
      }
    }
    setScreen("home");
  }, [
    hydrated,
    firebaseUid,
    activeFirestoreRouteId,
    activeMapOverviewFirestoreRouteId,
    flushActiveRouteToCloud,
    flushActiveMapOverviewRouteToCloud,
  ]);

  const startNewActiveRoute = useCallback(() => {
    setCopiedStopId(null);
    setRouteOptimizeFeedback(null);
    setOpenRouteDriveKm(null);
    setRawInput("");
    setStops([]);
    setActiveId(null);
    setRouteName("");
    setRouteDate(todayIsoLocal());
    setActiveFirestoreRouteId(null);
    localStorage.removeItem(ACTIVE_FIREBASE_ROUTE_LS);
    localStorage.removeItem(LS_KEY);
    setMenuOpen(false);
  }, []);

  const goToCreateNewRoute = useCallback(() => {
    startNewActiveRoute();
    setScreen("editor");
  }, [startNewActiveRoute]);

  const refreshSavedRoutes = useCallback(async () => {
    if (!firebaseUid) return;
    setRoutesRefreshing(true);
    try {
      const list = await fetchUserRouteSummaries(firebaseUid);
      setSavedRoutes(list);
      setCloudMessage(null);
    } catch {
      setCloudMessage("Kunne ikke genindlæse ruter — tjek nettet og prøv igen.");
    } finally {
      setRoutesRefreshing(false);
    }
  }, [firebaseUid]);

  const handleDeleteSavedRoute = useCallback(
    async (r: SavedRouteSummary) => {
      if (!firebaseUid) return;
      const headline =
        r.name.trim() || r.routeName.trim() || r.title || "Ruten";
      if (
        !window.confirm(
          `Slet «${headline}» fra skyen?\n\nDu kan ikke fortryde.`,
        )
      ) {
        return;
      }
      const ok = await deleteUserRoute(firebaseUid, r.id);
      if (!ok) {
        setCloudMessage("Kunne ikke slette ruten — prøv igen.");
        return;
      }
      setCloudMessage(null);
      if (activeFirestoreRouteId === r.id) {
        startNewActiveRoute();
      }
      if (activeMapOverviewFirestoreRouteId === r.id) {
        setMapOverviewRawInput("");
        setMapOverviewStops([]);
        setMapOverviewActiveId(null);
        setActiveMapOverviewFirestoreRouteId(null);
        try {
          localStorage.removeItem(ACTIVE_FIREBASE_MAPOVERVIEW_ROUTE_LS);
        } catch {
          /* ignore */
        }
      }
    },
    [
      firebaseUid,
      activeFirestoreRouteId,
      activeMapOverviewFirestoreRouteId,
      startNewActiveRoute,
    ],
  );

  const handleOptimize = async () => {
    if (stops.length === 0) return;
    const incomplete = stops.filter((s) => !s.completed);
    const complete = stops.filter((s) => s.completed);
    if (incomplete.length === 0) return;

    if (incomplete.length < 2) {
      setRouteOptimizeFeedback(
        "Kun ét åbent stop — der er ikke flere at omrokere.",
      );
      return;
    }

    if (incomplete.length > MAX_STOPS_PER_ROUTE) {
      setRouteOptimizeFeedback(
        `Maximum ${MAX_STOPS_PER_ROUTE} stops allowed per route`,
      );
      return;
    }

    const localStart = incomplete.findIndex((s) => s.id === activeId);
    const idx = localStart >= 0 ? localStart : 0;

    setOptimizing(true);
    setRouteOptimizeFeedback(
      "Henter køreafstande (OpenStreetMap + OSRM, gratis — vent…) ",
    );

    const applyRoadStats = (
      ordered: Stop[],
      stats: {
        beforeKm: number;
        afterKm: number;
        savedKm: number;
        orderChanged: boolean;
      },
      extra: string,
      approxGeocode: boolean,
    ) => {
      const next = [...ordered, ...complete];
      setStops(next);
      ensureActive(next);
      setOpenRouteDriveKm(stats.afterKm);

      const b = stats.beforeKm.toFixed(1);
      const a = stats.afterKm.toFixed(1);
      const saved = stats.savedKm;
      let msg = "";
      if (!stats.orderChanged) {
        msg = `Rækkefølgen er uændret fra dit valgte stop — ca. ${a} km kørevej mellem åbne stop (OSRM). Ingen grund til at optimere igen, medmindre du ændrer listen eller vælger et andet startstop.`;
        if (approxGeocode) {
          msg += ` Nogle adresser bruger omtrentlige punkter (geokodning fejlede).`;
        }
      } else if (Math.abs(saved) < 0.3) {
        msg = `Lille justering: ca. ${b} → ${a} km kørevej (OSRM). ${extra}`.trim();
      } else if (saved >= 0.3) {
        msg = `Rute opdateret efter vej: ca. ${b} km → ${a} km kørt strækning (OSRM). Spar ca. ${saved.toFixed(1)} km. ${extra}`;
      } else if (saved > 0) {
        msg = `Finjusteret efter vej: ca. ${b} → ${a} km. ${extra}`;
      } else if (saved < -0.1) {
        msg = `Rækkefølgen er ændret; model siger ca. ${b} → ${a} km. ${extra}`;
      } else {
        msg = `Rute omrokéret efter vejnet: ca. ${b} → ${a} km. ${extra}`;
      }
      setRouteOptimizeFeedback(msg.trim());
    };

    try {
      const { ordered, stats, anyApproxGeocode } =
        await optimizeRouteByRoadWithStats(incomplete, idx, (line) => {
          setRouteOptimizeFeedback(line);
        });
      const extra = anyApproxGeocode
        ? "Nogle adresser brugte omtrentlige punkter (geokodning fejlede)."
        : "";
      applyRoadStats(ordered, stats, extra, anyApproxGeocode);
    } catch {
      setRouteOptimizeFeedback(
        "Kunne ikke hente vejdata online — bruger luftlinje lokalt i stedet.",
      );
      const { ordered, stats } = optimizeRouteWithStats(incomplete, idx);
      const next = [...ordered, ...complete];
      setStops(next);
      ensureActive(next);
      setOpenRouteDriveKm(null);
      const b = stats.beforeKm.toFixed(1);
      const a = stats.afterKm.toFixed(1);
      const saved = stats.savedKm;
      setRouteOptimizeFeedback(
        `Offline/fallback: luftlinje ca. ${b} → ${a} km (ca. ${saved.toFixed(1)} km). Tilslut internet for rigtig kørevej.`,
      );
    } finally {
      setOptimizing(false);
    }
  };

  const handleClear = () => {
    setRouteOptimizeFeedback(null);
    setOpenRouteDriveKm(null);
    setRawInput("");
    setStops([]);
    setActiveId(null);
    setRouteName("");
    setRouteDate(todayIsoLocal());
    setActiveFirestoreRouteId(null);
    localStorage.removeItem(LS_KEY);
    localStorage.removeItem(ACTIVE_FIREBASE_ROUTE_LS);
  };

  const copyOneAddress = async (e: MouseEvent<HTMLButtonElement>, s: Stop) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = await copyTextToClipboard(formatAddressForNav(s));
    if (ok) {
      setCopiedStopId(s.id);
    } else {
      setRouteOptimizeFeedback("Kunne ikke kopiere adressen.");
    }
  };

  const toggleComplete = (id: string) => {
    setOpenRouteDriveKm(null);
    setStops((prev) =>
      prev.map((s) => (s.id === id ? { ...s, completed: !s.completed } : s)),
    );
  };

  const toggleMapOverviewComplete = useCallback((id: string) => {
    setMapOverviewStops((prev) =>
      prev.map((s) => (s.id === id ? { ...s, completed: !s.completed } : s)),
    );
  }, []);

  const moveMapOverviewStopInRoute = useCallback(
    (stopId: string, direction: "up" | "down") => {
      setMapOverviewStops((prev) => {
        const incomplete = prev.filter((x) => !x.completed);
        const complete = prev.filter((x) => x.completed);
        const idx = incomplete.findIndex((x) => x.id === stopId);
        if (idx < 0) return prev;
        const j = direction === "up" ? idx - 1 : idx + 1;
        if (j < 0 || j >= incomplete.length) return prev;
        const nextIncomplete = incomplete.slice();
        const t = nextIncomplete[idx];
        nextIncomplete[idx] = nextIncomplete[j]!;
        nextIncomplete[j] = t!;
        return [...nextIncomplete, ...complete];
      });
    },
    [],
  );

  const selectStop = (id: string) => setActiveId(id);

  const moveStopInRoute = useCallback((stopId: string, direction: "up" | "down") => {
    setOpenRouteDriveKm(null);
    setStops((prev) => {
      const incomplete = prev.filter((x) => !x.completed);
      const complete = prev.filter((x) => x.completed);
      const idx = incomplete.findIndex((x) => x.id === stopId);
      if (idx < 0) return prev;
      const j = direction === "up" ? idx - 1 : idx + 1;
      if (j < 0 || j >= incomplete.length) return prev;
      const nextIncomplete = incomplete.slice();
      const t = nextIncomplete[idx];
      nextIncomplete[idx] = nextIncomplete[j]!;
      nextIncomplete[j] = t!;
      return [...nextIncomplete, ...complete];
    });
  }, []);

  const moveStopToRoutePositionOneBased = useCallback(
    (stopId: string, oneBased: number, scope: "editor" | "mapOverview") => {
      const target0 = oneBased - 1;
      if (scope === "editor") {
        setOpenRouteDriveKm(null);
        setStops((prev) =>
          reorderIncompleteStopToIndex(prev, stopId, target0),
        );
      } else {
        setMapOverviewStops((prev) =>
          reorderIncompleteStopToIndex(prev, stopId, target0),
        );
      }
    },
    [],
  );

  /** Grupperet efter postnr. + bynavn (som chauffører tænker geografisk). */
  const stopSectionsByCity = useMemo(() => {
    const sectionKey = (s: Stop) =>
      `${s.zip}|${cityBaseDisplay(s.city)}`;
    const order: string[] = [];
    const seen = new Set<string>();
    for (const s of stops) {
      const k = sectionKey(s);
      if (!seen.has(k)) {
        seen.add(k);
        order.push(k);
      }
    }
    const byKey = new Map<string, Stop[]>();
    for (const s of stops) {
      const k = sectionKey(s);
      const list = byKey.get(k) ?? [];
      list.push(s);
      byKey.set(k, list);
    }
    for (const k of order) {
      const list = byKey.get(k)!;
      list.sort((a, b) => {
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        return stops.indexOf(a) - stops.indexOf(b);
      });
    }
    return order.map((key) => {
      const list = byKey.get(key)!;
      const head = list[0]!;
      return {
        sectionKey: key,
        heading: `${head.zip} ${cityBaseDisplay(head.city)}`,
        clusters: clusterStopsByBuildingForDisplay(list),
      };
    });
  }, [stops]);

  const navLabel = activeStop
    ? formatAddressForNav(activeStop)
    : "Vælg et stop på kortet eller på listen herunder";

  const incompleteStops = useMemo(
    () => stops.filter((s) => !s.completed),
    [stops],
  );

  const mapOverviewIncompleteStops = useMemo(
    () => mapOverviewStops.filter((s) => !s.completed),
    [mapOverviewStops],
  );

  const mapOverviewRouteStepById = useMemo(() => {
    const m = new Map<string, number>();
    mapOverviewIncompleteStops.forEach((s, i) => m.set(s.id, i + 1));
    return m;
  }, [mapOverviewIncompleteStops]);

  const routeStepById = useMemo(() => {
    const m = new Map<string, number>();
    incompleteStops.forEach((s, i) => m.set(s.id, i + 1));
    return m;
  }, [incompleteStops]);

  const savedRoutesForEditor = useMemo(
    () => savedRoutes.filter((r) => r.workspace !== "mapOverview"),
    [savedRoutes],
  );
  const savedRoutesForMapOverview = useMemo(
    () => savedRoutes.filter((r) => r.workspace === "mapOverview"),
    [savedRoutes],
  );

  const mapOverviewCloudSyncBanner = useMemo(() => {
    if (!hydrated) return null;
    if (!isFirestoreConfigured()) {
      return (
        <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-500">
          Sky ikke konfigureret — kortoversigt gemmes kun lokalt.
        </p>
      );
    }
    if (!firebaseUid) {
      return (
        <p className="text-xs font-semibold text-amber-800 dark:text-amber-200">
          Log ind for at gemme kortoversigt i skyen (egen liste på forsiden).
        </p>
      );
    }
    if (!activeMapOverviewFirestoreRouteId) {
      return (
        <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
          Efter «Indlæs adresser» oprettes et separat sky-dokument — ikke blandet med
          leveringsruten.
        </p>
      );
    }
    switch (mapOverviewCloudSyncPhase) {
      case "idle":
        return null;
      case "pending":
        return (
          <p
            className="text-xs font-bold text-amber-800 dark:text-amber-200"
            role="status"
          >
            Venter på gem (kortoversigt)…
          </p>
        );
      case "syncing":
        return (
          <p
            className="text-xs font-bold text-sky-800 dark:text-sky-200"
            role="status"
          >
            Gemmer kortoversigt i skyen…
          </p>
        );
      case "synced":
        return (
          <p
            className="text-xs font-bold text-emerald-800 dark:text-emerald-200"
            role="status"
          >
            Kortoversigt synkroniseret
          </p>
        );
      case "error":
        return (
          <p
            className="text-xs font-bold text-red-700 dark:text-red-300"
            role="alert"
          >
            Kunne ikke gemme kortoversigt — tjek nettet
          </p>
        );
      default:
        return null;
    }
  }, [
    hydrated,
    firebaseUid,
    activeMapOverviewFirestoreRouteId,
    mapOverviewCloudSyncPhase,
  ]);

  const cloudSyncBanner = useMemo(() => {
    if (!hydrated) return null;
    if (!isFirestoreConfigured()) {
      return (
        <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-500">
          Sky ikke konfigureret — gemmes kun på denne enhed.
        </p>
      );
    }
    if (!firebaseUid) {
      return (
        <p className="text-xs font-semibold text-amber-800 dark:text-amber-200">
          Log ind med Google for at gemme denne rute i skyen.
        </p>
      );
    }
    if (!activeFirestoreRouteId) {
      return (
        <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
          Sky-gem starter, når du har trykket «Indlæs adresser» mindst én gang.
        </p>
      );
    }
    switch (cloudSyncPhase) {
      case "idle":
        return null;
      case "pending":
        return (
          <p
            className="text-xs font-bold text-amber-800 dark:text-amber-200"
            role="status"
          >
            Venter på gem… synkroniserer om et øjeblik
          </p>
        );
      case "syncing":
        return (
          <p
            className="text-xs font-bold text-sky-800 dark:text-sky-200"
            role="status"
          >
            Gemmer i skyen…
          </p>
        );
      case "synced":
        return (
          <p
            className="text-xs font-bold text-emerald-800 dark:text-emerald-200"
            role="status"
          >
            Synkroniseret med skyen
          </p>
        );
      case "error":
        return (
          <p
            className="text-xs font-bold text-red-700 dark:text-red-300"
            role="alert"
          >
            Kunne ikke gemme — tjek nettet og prøv igen
          </p>
        );
      default:
        return null;
    }
  }, [
    hydrated,
    firebaseUid,
    activeFirestoreRouteId,
    cloudSyncPhase,
  ]);

  /** Grøn accent: mindre «hvidt» skal (kun det valg); øvrige accenter uændret. */
  const accentShell = useMemo(() => {
    if (accentId !== "green") {
      return {
        app: "bg-zinc-100 dark:bg-[#070d14]",
        header:
          "border-b-2 border-zinc-300 bg-white shadow-lg dark:border-white/20 dark:bg-[#0a1522]",
        drawer:
          "border-l-2 border-zinc-200 bg-white shadow-2xl dark:border-white/20 dark:bg-[#0d1824]",
        drawerBar: "border-b-2 border-zinc-200 dark:border-white/15",
        navFooter:
          "border-t-2 border-zinc-200 bg-white shadow-[0_-10px_28px_rgba(0,0,0,0.12)] dark:border-white/20 dark:bg-[#0a1522] dark:shadow-[0_-10px_28px_rgba(0,0,0,0.65)]",
      };
    }
    return {
      app: "bg-[#cfdecc] dark:bg-[#070f0c]",
      header:
        "border-b-2 border-[#b0c4b4] bg-[#dfece1] shadow-lg dark:border-white/12 dark:bg-[#0b1513]",
      drawer:
        "border-l-2 border-[#b0c4b4] bg-[#e8f2ea] shadow-2xl dark:border-white/12 dark:bg-[#0c1816]",
      drawerBar: "border-b-2 border-[#b0c4b4] dark:border-white/12",
      navFooter:
        "border-t-2 border-[#b0c4b4] bg-[#dfece1] shadow-[0_-10px_28px_rgba(0,0,0,0.12)] dark:border-white/12 dark:bg-[#0b1513] dark:shadow-[0_-10px_28px_rgba(0,0,0,0.65)]",
    };
  }, [accentId]);

  return (
    <div
      className={`flex min-h-full flex-col text-zinc-900 dark:text-white ${accentShell.app}`}
    >
      {screen === "home" ? (
        <header className={`sticky top-0 z-20 ${accentShell.header}`}>
          <div className="mx-auto flex max-w-lg flex-col gap-2 px-4 py-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h1 className="text-xl font-extrabold tracking-tight text-zinc-900 dark:text-white">
                  Leveringschauffør
                </h1>
                <p className="mt-1 text-sm font-semibold text-zinc-600 dark:text-zinc-400">
                  Forside — vælg gemt rute eller opret ny · kortoversigt i menu
                </p>
              </div>
              <div className="flex shrink-0 items-start gap-2">
                {isFirestoreConfigured() && !firebaseUid ? (
                  <button
                    type="button"
                    onClick={() =>
                      void signInWithGoogle().then(({ errorMessage }) => {
                        if (errorMessage) setCloudMessage(errorMessage);
                      })
                    }
                    className="touch-manipulation rounded-xl border-2 border-zinc-400 bg-white px-3 py-2 text-xs font-extrabold text-zinc-900 dark:border-white/35 dark:bg-slate-800 dark:text-white"
                  >
                    Log ind
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-expanded={menuOpen}
                  aria-controls="app-drawer-menu"
                  onClick={() => setMenuOpen((o) => !o)}
                  className="touch-manipulation shrink-0 rounded-xl border-2 border-zinc-300 bg-zinc-100 p-2.5 text-zinc-900 dark:border-white/35 dark:bg-slate-800 dark:text-white"
                >
                  <span className="sr-only">Menu</span>
                  <IconMenu />
                </button>
              </div>
            </div>
          </div>
        </header>
      ) : screen === "mapOverview" ? (
        <header className={`sticky top-0 z-20 ${accentShell.header}`}>
          <div className="mx-auto flex max-w-lg flex-col gap-2 px-4 py-3">
            <div className="flex items-start gap-2">
              <button
                type="button"
                onClick={() => void goHome()}
                className="touch-manipulation shrink-0 rounded-xl border-2 border-zinc-300 bg-zinc-100 p-2.5 text-zinc-900 dark:border-white/35 dark:bg-slate-800 dark:text-white"
                aria-label="Tilbage til forsiden"
              >
                <IconArrowLeft />
              </button>
              <div className="min-w-0 flex-1">
                <h1 className="text-lg font-extrabold leading-tight text-zinc-900 dark:text-white">
                  Kortoversigt
                </h1>
                <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                  Egen sky-liste på forsiden — ikke blandet med leveringsruter. Overfør til
                  «Rute» via menu når du vil køre med optimering m.m.
                </p>
                {mapOverviewCloudSyncBanner ? (
                  <div
                    className="mt-1 rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1.5 dark:border-white/15 dark:bg-slate-900/80"
                    aria-live="polite"
                  >
                    {mapOverviewCloudSyncBanner}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-start gap-2">
                {isFirestoreConfigured() && !firebaseUid ? (
                  <button
                    type="button"
                    onClick={() =>
                      void signInWithGoogle().then(({ errorMessage }) => {
                        if (errorMessage) setCloudMessage(errorMessage);
                      })
                    }
                    className="touch-manipulation rounded-xl border-2 border-zinc-400 bg-white px-3 py-2 text-xs font-extrabold text-zinc-900 dark:border-white/35 dark:bg-slate-800 dark:text-white"
                  >
                    Log ind
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-expanded={menuOpen}
                  aria-controls="app-drawer-menu"
                  onClick={() => setMenuOpen((o) => !o)}
                  className="touch-manipulation shrink-0 rounded-xl border-2 border-zinc-300 bg-zinc-100 p-2.5 text-zinc-900 dark:border-white/35 dark:bg-slate-800 dark:text-white"
                >
                  <span className="sr-only">Menu</span>
                  <IconMenu />
                </button>
              </div>
            </div>
          </div>
        </header>
      ) : (
        <header className={`sticky top-0 z-20 ${accentShell.header}`}>
          <div className="mx-auto flex max-w-lg flex-col gap-2 px-4 py-3">
            <div className="flex items-start gap-2">
              <button
                type="button"
                onClick={() => void goHome()}
                className="touch-manipulation shrink-0 rounded-xl border-2 border-zinc-300 bg-zinc-100 p-2.5 text-zinc-900 dark:border-white/35 dark:bg-slate-800 dark:text-white"
                aria-label="Tilbage til forsiden"
              >
                <IconArrowLeft />
              </button>
              <div className="min-w-0 flex-1">
                <h1 className="text-lg font-extrabold leading-tight text-zinc-900 dark:text-white">
                  {activeFirestoreRouteId ? "Rediger rute" : "Opret ny rute"}
                </h1>
                <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                  Gemmes i skyen som leveringsrute — kortoversigt har sin egen liste på forsiden
                </p>
                {cloudSyncBanner ? (
                  <div
                    className="mt-1 rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1.5 dark:border-white/15 dark:bg-slate-900/80"
                    aria-live="polite"
                  >
                    {cloudSyncBanner}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-start gap-2">
                {isFirestoreConfigured() && !firebaseUid ? (
                  <button
                    type="button"
                    onClick={() =>
                      void signInWithGoogle().then(({ errorMessage }) => {
                        if (errorMessage) setCloudMessage(errorMessage);
                      })
                    }
                    className="touch-manipulation rounded-xl border-2 border-zinc-400 bg-white px-3 py-2 text-xs font-extrabold text-zinc-900 dark:border-white/35 dark:bg-slate-800 dark:text-white"
                  >
                    Log ind
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-expanded={menuOpen}
                  aria-controls="app-drawer-menu"
                  onClick={() => setMenuOpen((o) => !o)}
                  className="touch-manipulation shrink-0 rounded-xl border-2 border-zinc-300 bg-zinc-100 p-2.5 text-zinc-900 dark:border-white/35 dark:bg-slate-800 dark:text-white"
                >
                  <span className="sr-only">Menu</span>
                  <IconMenu />
                </button>
              </div>
            </div>
            <p className="text-base font-black text-accent dark:drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
              TOTAL: {completedCount} / {total} pakker
            </p>
            <p className="text-sm font-semibold leading-snug text-zinc-600 dark:text-zinc-300">
              {motivation}
            </p>
            {stops.length > 0 ? (
              <p className="text-sm font-bold leading-snug text-zinc-800 dark:text-zinc-100">
                <span className="font-semibold text-zinc-500 dark:text-zinc-400">
                  Rute:
                </span>{" "}
                {routeName.trim() || "Uden navn"}
                {routeDate && /^\d{4}-\d{2}-\d{2}$/.test(routeDate)
                  ? ` · ${formatRouteDateDa(routeDate)}`
                  : ""}
              </p>
            ) : null}
          </div>
        </header>
      )}

      {menuOpen ? (
        <div
          className="fixed inset-0 z-40 flex justify-end"
          role="dialog"
          aria-modal="true"
          aria-labelledby="drawer-menu-title"
        >
          <button
            type="button"
            className="absolute inset-0 bg-black/55"
            aria-label="Luk menu"
            onClick={() => setMenuOpen(false)}
          />
          <aside
            id="app-drawer-menu"
            className={`relative flex h-full w-full max-w-sm flex-col ${accentShell.drawer}`}
          >
            <div
              className={`flex items-center justify-between gap-2 px-4 py-3 ${accentShell.drawerBar}`}
            >
              <h2
                id="drawer-menu-title"
                className="text-lg font-extrabold text-zinc-900 dark:text-white"
              >
                Menu
              </h2>
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                className="touch-manipulation rounded-lg border-2 border-zinc-300 p-2 text-zinc-800 dark:border-white/30 dark:text-zinc-100"
                aria-label="Luk"
              >
                <IconClose />
              </button>
            </div>

            <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">
              <button
                type="button"
                onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
                className="flex w-full touch-manipulation items-center gap-3 rounded-xl border-2 border-zinc-300 bg-zinc-50 px-4 py-3 text-left font-bold text-zinc-900 dark:border-white/30 dark:bg-slate-800 dark:text-white"
              >
                {theme === "dark" ? (
                  <>
                    <IconSun className="shrink-0 text-amber-500" />
                    <span>Lyst tema</span>
                  </>
                ) : (
                  <>
                    <IconMoon className="shrink-0 text-indigo-400" />
                    <span>Mørkt tema</span>
                  </>
                )}
              </button>

              <div className="flex flex-col gap-2">
                <p className="text-xs font-black uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
                  Accentfarve (knapper &amp; markering)
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {(Object.keys(ACCENT_PRESETS) as AccentId[]).map((id) => {
                    const preset = ACCENT_PRESETS[id];
                    const selected = accentId === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setAccentId(id)}
                        aria-pressed={selected}
                        className={`flex items-center gap-2 rounded-xl border-2 px-3 py-2.5 text-left text-sm font-extrabold transition ${
                          selected
                            ? "border-accent bg-accent/15 ring-2 ring-accent/35 dark:bg-accent/10"
                            : "border-zinc-300 bg-zinc-50 dark:border-white/30 dark:bg-slate-800"
                        } text-zinc-900 dark:text-white`}
                      >
                        <span
                          className="size-5 shrink-0 rounded-full border-2 border-black/20 dark:border-white/25"
                          style={{ backgroundColor: preset.main }}
                          aria-hidden
                        />
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs font-medium leading-snug text-zinc-500 dark:text-zinc-500">
                  Rød og blå er dæmpede nuancer; grøn følger brandfarver (22913A / 186929).
                </p>
              </div>

              {!isFirestoreConfigured() ? (
                <p className="text-sm font-medium leading-snug text-zinc-600 dark:text-zinc-400">
                  Sæt <code className="rounded bg-zinc-200 px-1 dark:bg-slate-700">VITE_FIREBASE_*</code>{" "}
                  for at gemme ruter i skyen.
                </p>
              ) : null}

              {cloudMessage ? (
                <p className="rounded-xl border-2 border-amber-400/80 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-950 dark:border-amber-500/50 dark:bg-amber-950/40 dark:text-amber-100">
                  {cloudMessage}
                </p>
              ) : null}

              {screen === "home" || screen === "editor" ? (
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setScreen("mapOverview");
                  }}
                  className="touch-manipulation rounded-xl border-2 border-zinc-400 bg-white px-4 py-3 text-left text-sm font-extrabold text-zinc-900 dark:border-white/35 dark:bg-slate-800 dark:text-white"
                >
                  Kortoversigt
                </button>
              ) : null}

              {screen === "editor" ? (
                <button
                  type="button"
                  disabled={stops.length === 0}
                  onClick={() => {
                    setMenuOpen(false);
                    transferEditorStopsToMapOverview();
                  }}
                  className="touch-manipulation rounded-xl border-2 border-zinc-400 bg-white px-4 py-3 text-left text-sm font-extrabold text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/35 dark:bg-slate-800 dark:text-white"
                >
                  Overfør til kortoversigt (kladde)
                </button>
              ) : null}

              {screen === "mapOverview" ? (
                <button
                  type="button"
                  disabled={mapOverviewStops.length === 0}
                  onClick={() => {
                    setMenuOpen(false);
                    transferMapOverviewStopsToEditor();
                  }}
                  className="touch-manipulation rounded-xl border-2 border-zinc-400 bg-white px-4 py-3 text-left text-sm font-extrabold text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/35 dark:bg-slate-800 dark:text-white"
                >
                  Overfør til rute (kladde)
                </button>
              ) : null}

              {screen === "editor" ? (
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    void goHome();
                  }}
                  className="touch-manipulation rounded-xl border-2 border-zinc-300 bg-zinc-100 px-4 py-3 text-left text-sm font-extrabold text-zinc-900 dark:border-white/30 dark:bg-slate-800 dark:text-white"
                >
                  Forside
                </button>
              ) : screen === "mapOverview" ? (
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    void goHome();
                  }}
                  className="touch-manipulation rounded-xl border-2 border-zinc-300 bg-zinc-100 px-4 py-3 text-left text-sm font-extrabold text-zinc-900 dark:border-white/30 dark:bg-slate-800 dark:text-white"
                >
                  Forside
                </button>
              ) : (
                <p className="text-xs font-medium leading-snug text-zinc-500 dark:text-zinc-500">
                  Dine gemte ruter vises på forsiden. Brug «Opret ny rute» der — eller «Kortoversigt»
                  herover.
                </p>
              )}

              {firebaseUid ? (
                <>
                  <button
                    type="button"
                    onClick={() => void signOutUser()}
                    className="touch-manipulation rounded-xl border-2 border-zinc-300 bg-zinc-50 px-4 py-2 text-left text-xs font-bold text-zinc-700 dark:border-white/30 dark:bg-slate-800 dark:text-zinc-200"
                  >
                    Log ud
                  </button>
                  <button
                    type="button"
                    disabled={routesRefreshing}
                    onClick={() => void refreshSavedRoutes()}
                    className="touch-manipulation rounded-xl border-2 border-zinc-300 bg-zinc-100 px-4 py-2.5 text-left text-sm font-bold text-zinc-800 disabled:opacity-50 dark:border-white/30 dark:bg-slate-800 dark:text-zinc-100"
                  >
                    {routesRefreshing
                      ? "Henter ruter fra skyen…"
                      : "Genindlæs ruter fra skyen"}
                  </button>
                  <p className="text-xs font-medium leading-snug text-zinc-500 dark:text-zinc-500">
                    Opdaterer listen på forsiden (live + manuelt).
                  </p>

                  {screen === "editor" ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-xs font-black uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
                        Start forfra
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          setMenuOpen(false);
                          startNewActiveRoute();
                          setScreen("editor");
                        }}
                        className="touch-manipulation rounded-xl border-2 border-accent bg-accent/90 px-4 py-3 text-left text-sm font-extrabold text-black dark:border-accent dark:bg-accent/80"
                      >
                        Ny aktiv rute (tøm skærm)
                      </button>
                      <p className="text-xs font-medium leading-snug text-zinc-500 dark:text-zinc-500">
                        Gemte ruter i skyen påvirkes ikke — find dem på forsiden.
                      </p>
                    </div>
                  ) : null}
                </>
              ) : isFirestoreConfigured() ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                    Log ind med Google for at synkronisere ruter.
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      void signInWithGoogle().then(({ errorMessage }) => {
                        if (errorMessage) setCloudMessage(errorMessage);
                      })
                    }
                    className="touch-manipulation rounded-xl border-2 border-zinc-400 bg-white px-4 py-2.5 text-left text-sm font-extrabold text-zinc-900 dark:border-white/35 dark:bg-slate-800 dark:text-white"
                  >
                    Log ind med Google
                  </button>
                </div>
              ) : null}
            </div>
          </aside>
        </div>
      ) : null}

      {screen === "home" ? (
        <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-5 px-4 pb-12 pt-5">
          {cloudMessage ? (
            <p className="rounded-xl border-2 border-amber-400/80 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-950 dark:border-amber-500/50 dark:bg-amber-950/40 dark:text-amber-100">
              {cloudMessage}
            </p>
          ) : null}
          <p className="text-center text-sm font-medium leading-snug text-zinc-600 dark:text-zinc-400">
            Ændringer gemmes <span className="font-semibold">automatisk i skyen</span> kort
            efter du har indlæst adresser — du behøver ikke en «gem»-knap.
          </p>
          {cloudSyncBanner ? (
            <div
              className="rounded-xl border border-zinc-200 bg-white px-3 py-2 dark:border-white/20 dark:bg-slate-800/80"
              aria-live="polite"
            >
              {cloudSyncBanner}
            </div>
          ) : null}
          <button
            type="button"
            onClick={goToCreateNewRoute}
            className="min-h-[58px] w-full touch-manipulation rounded-2xl border-2 border-accentDeep bg-accent px-4 text-base font-extrabold text-black shadow-sm transition active:scale-[0.98] dark:shadow-card"
          >
            Opret ny rute
          </button>
          {stops.length > 0 ? (
            <button
              type="button"
              onClick={() => setScreen("editor")}
              className="min-h-[52px] w-full touch-manipulation rounded-xl border-2 border-zinc-400 bg-white px-4 text-sm font-extrabold text-zinc-900 dark:border-white/35 dark:bg-slate-800 dark:text-white"
            >
              Fortsæt seneste rute ({stops.length} stop)
            </button>
          ) : null}

          <section className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <p className="text-xs font-black uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Sky-gemte ruter
              </p>
              <p className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
                To adskilte lister — leveringsruter vises ikke under kortoversigt og omvendt.
                Brug menu «Overfør …» for at kopiere mellem sider uden at flytte sky-lager.
              </p>
            </div>
            {firebaseUid ? (
              <>
                <button
                  type="button"
                  disabled={routesRefreshing}
                  onClick={() => void refreshSavedRoutes()}
                  className="touch-manipulation rounded-xl border-2 border-zinc-300 bg-zinc-100 px-4 py-2.5 text-left text-sm font-bold text-zinc-800 disabled:opacity-50 dark:border-white/30 dark:bg-slate-800 dark:text-zinc-100"
                >
                  {routesRefreshing
                    ? "Henter ruter fra skyen…"
                    : "Genindlæs ruter fra skyen"}
                </button>
                {savedRoutesForEditor.length === 0 &&
                savedRoutesForMapOverview.length === 0 ? (
                  <p className="text-sm font-medium leading-snug text-zinc-600 dark:text-zinc-400">
                    Ingen endnu — tryk «Opret ny rute» eller «Kortoversigt», indsæt adresser og
                    «Indlæs adresser». Flere dokumenter: «Gem som ny sky-rute» på den side, hvor
                    ruten hører til.
                  </p>
                ) : null}

                <div className="flex flex-col gap-2">
                  <p className="text-[11px] font-black uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    Leveringsruter
                  </p>
                  {savedRoutesForEditor.length === 0 ? (
                    <p className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
                      Ingen leveringsruter i skyen endnu.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {savedRoutesForEditor.map((r) => {
                        const isActive = r.id === activeFirestoreRouteId;
                        const headline =
                          r.name.trim() ||
                          r.routeName.trim() ||
                          r.title ||
                          "Rute";
                        const dateStr =
                          r.routeDate && /^\d{4}-\d{2}-\d{2}$/.test(r.routeDate)
                            ? formatRouteDateDa(r.routeDate)
                            : null;
                        const when = r.updatedAt
                          ? formatDateTimeDdMmYyyyHm(r.updatedAt)
                          : "";
                        return (
                          <li key={r.id} className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => void loadSavedRouteIntoApp(r)}
                              className={`flex min-w-0 flex-1 touch-manipulation flex-col gap-0.5 rounded-xl border-2 px-3 py-3 text-left transition ${
                                isActive
                                  ? "border-accent bg-accent/15 dark:bg-accent/10"
                                  : "border-zinc-200 bg-zinc-50 dark:border-white/20 dark:bg-slate-800/80"
                              }`}
                            >
                              <span className="flex items-center justify-between gap-2">
                                <span className="line-clamp-2 text-sm font-extrabold text-zinc-900 dark:text-white">
                                  {headline}
                                </span>
                                {isActive ? (
                                  <span className="shrink-0 rounded-md bg-accent px-2 py-0.5 text-[10px] font-black uppercase text-black">
                                    Aktiv
                                  </span>
                                ) : null}
                              </span>
                              <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                                {dateStr ? `${dateStr} · ` : ""}
                                {r.stopCount} stop
                                {when ? ` · opd. ${when}` : ""}
                              </span>
                            </button>
                            <button
                              type="button"
                              aria-label={`Slet ruten ${headline}`}
                              onClick={() => void handleDeleteSavedRoute(r)}
                              className="shrink-0 touch-manipulation self-stretch rounded-xl border-2 border-red-300 bg-red-50 px-3 py-2 text-xs font-extrabold text-red-900 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-100"
                            >
                              Slet
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                <div className="flex flex-col gap-2 border-t border-zinc-200 pt-4 dark:border-white/15">
                  <p className="text-[11px] font-black uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    Kortoversigt i skyen
                  </p>
                  {savedRoutesForMapOverview.length === 0 ? (
                    <p className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
                      Ingen kortoversigt-ruter gemt endnu.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {savedRoutesForMapOverview.map((r) => {
                        const isActive = r.id === activeMapOverviewFirestoreRouteId;
                        const headline =
                          r.name.trim() ||
                          r.routeName.trim() ||
                          r.title ||
                          "Rute";
                        const dateStr =
                          r.routeDate && /^\d{4}-\d{2}-\d{2}$/.test(r.routeDate)
                            ? formatRouteDateDa(r.routeDate)
                            : null;
                        const when = r.updatedAt
                          ? formatDateTimeDdMmYyyyHm(r.updatedAt)
                          : "";
                        return (
                          <li key={r.id} className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => void loadSavedRouteIntoMapOverview(r)}
                              className={`flex min-w-0 flex-1 touch-manipulation flex-col gap-0.5 rounded-xl border-2 px-3 py-3 text-left transition ${
                                isActive
                                  ? "border-accent bg-accent/15 dark:bg-accent/10"
                                  : "border-zinc-200 bg-zinc-50 dark:border-white/20 dark:bg-slate-800/80"
                              }`}
                            >
                              <span className="flex items-center justify-between gap-2">
                                <span className="line-clamp-2 text-sm font-extrabold text-zinc-900 dark:text-white">
                                  {headline}
                                </span>
                                {isActive ? (
                                  <span className="shrink-0 rounded-md bg-accent px-2 py-0.5 text-[10px] font-black uppercase text-black">
                                    Aktiv
                                  </span>
                                ) : null}
                              </span>
                              <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                                {dateStr ? `${dateStr} · ` : ""}
                                {r.stopCount} stop
                                {when ? ` · opd. ${when}` : ""}
                              </span>
                            </button>
                            <button
                              type="button"
                              aria-label={`Slet ruten ${headline}`}
                              onClick={() => void handleDeleteSavedRoute(r)}
                              className="shrink-0 touch-manipulation self-stretch rounded-xl border-2 border-red-300 bg-red-50 px-3 py-2 text-xs font-extrabold text-red-900 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-100"
                            >
                              Slet
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </>
            ) : isFirestoreConfigured() ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                  Log ind med Google for at se gemte ruter.
                </p>
                <button
                  type="button"
                  onClick={() =>
                    void signInWithGoogle().then(({ errorMessage }) => {
                      if (errorMessage) setCloudMessage(errorMessage);
                    })
                  }
                  className="touch-manipulation rounded-xl border-2 border-accent bg-accent/90 px-4 py-3 text-sm font-extrabold text-black dark:border-accent dark:bg-accent/80"
                >
                  Log ind med Google
                </button>
              </div>
            ) : (
              <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                Denne side har ikke Firebase-nøgler i build-miljøet. Tilføj{" "}
                <code className="rounded bg-zinc-200 px-1 dark:bg-slate-700">
                  VITE_FIREBASE_API_KEY
                </code>{" "}
                og{" "}
                <code className="rounded bg-zinc-200 px-1 dark:bg-slate-700">
                  VITE_FIREBASE_PROJECT_ID
                </code>{" "}
                i <code className="rounded bg-zinc-200 px-1 dark:bg-slate-700">.env.local</code>{" "}
                (lokalt) eller i hostens miljøvariabler, og kør <code className="rounded bg-zinc-200 px-1 dark:bg-slate-700">npm run build</code>{" "}
                igen — ellers gemmes ruter kun lokalt.
              </p>
            )}
          </section>
        </main>
      ) : null}

      {screen === "mapOverview" ? (
        <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-4 px-4 pb-12 pt-4">
          <section className="flex flex-col gap-2" aria-label="Kort">
            <h2 className="text-xs font-black uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Kort
            </h2>
            <StopRouteMap
              stops={mapOverviewStops}
              incompleteOrdered={mapOverviewIncompleteStops}
              activeId={mapOverviewActiveId}
              onSelectStop={setMapOverviewActiveId}
              accentHex={ACCENT_PRESETS[accentId].main}
              variant="overview"
              mapHeight="min(52vh, 440px)"
            />
          </section>

          <section className="flex flex-col gap-2">
            <label
              className="text-sm font-semibold text-zinc-700 dark:text-zinc-300"
              htmlFor="raw-map-overview"
            >
              Rå tekst — én adresse pr. linje (samme format som under rute).
            </label>
            <textarea
              id="raw-map-overview"
              value={mapOverviewRawInput}
              onChange={(e) => setMapOverviewRawInput(e.target.value)}
              rows={8}
              className="touch-manipulation rounded-xl border-2 border-zinc-300 bg-white px-3 py-3 text-base text-zinc-900 shadow-sm placeholder:text-zinc-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40 dark:border-white/30 dark:bg-slate-900 dark:text-white dark:placeholder:text-zinc-500 dark:shadow-card"
              placeholder={
                "1. Nørregade 15, 4000 Roskilde\n2. Hovedgaden 2, 5000 Odense"
              }
              spellCheck={false}
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleMapOverviewParse}
                className="min-h-[56px] flex-1 touch-manipulation rounded-xl border-2 border-zinc-400 bg-accent px-4 text-base font-extrabold text-black shadow-sm transition active:scale-[0.98] active:bg-accentDeep dark:border-white/40 dark:shadow-card"
              >
                Indlæs adresser
              </button>
              <button
                type="button"
                onClick={handleMapOverviewClear}
                className="min-h-[56px] touch-manipulation rounded-xl border-2 border-zinc-300 px-4 text-sm font-bold text-zinc-600 dark:border-white/25 dark:text-zinc-400"
              >
                Ryd
              </button>
            </div>
            <CloudSaveNewRow
              inputId="map-overview-cloud-save-title"
              titleValue={mapOverviewCloudTitle}
              onTitleChange={setMapOverviewCloudTitle}
              onSave={handleSaveMapOverviewToCloud}
              saveDisabled={mapOverviewStops.length === 0}
              buttonTitle="Opretter nyt sky-dokument uden at skifte den aktive rute under Rute."
            />
          </section>

          {mapOverviewStops.length > 0 ? (
            <section
              className="flex flex-col gap-2"
              aria-label="Rækkefølge som indtastet"
            >
              <h2 className="text-xs font-black uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Rækkefølge — pil ved åbne stop (samme som rute-siden)
              </h2>
              <p className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
                Nr. følger kun <span className="font-semibold">ikke-leverede</span> stop. Pile eller
                tryk på <span className="font-semibold">Nr.</span> (numpad) flytter rækkefølge og
                opdaterer kortet.
              </p>
              <ol className="flex list-none flex-col gap-2 p-0">
                {mapOverviewStops.map((s) => {
                  const step = mapOverviewRouteStepById.get(s.id);
                  const routePos = mapOverviewIncompleteStops.findIndex(
                    (x) => x.id === s.id,
                  );
                  const showReorder =
                    !s.completed &&
                    step != null &&
                    mapOverviewIncompleteStops.length >= 2 &&
                    routePos >= 0;
                  const active = mapOverviewActiveId === s.id;
                  return (
                    <li
                      key={s.id}
                      className={`flex flex-col gap-3 rounded-xl border-2 px-2 py-2 sm:px-3 ${
                        active
                          ? "border-accent bg-accent/15 dark:bg-accent/10"
                          : "border-zinc-200 bg-zinc-50 dark:border-white/20 dark:bg-slate-800/80"
                      } ${s.completed ? "opacity-[0.78] dark:opacity-[0.68]" : ""}`}
                    >
                      <div className="flex min-h-[72px] items-stretch gap-2">
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                          {s.completed ? (
                            <span
                              className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border-2 border-zinc-300 bg-zinc-100 text-lg font-black text-zinc-400 dark:border-white/25 dark:bg-black/30 dark:text-white/50"
                              aria-hidden
                            >
                              ✓
                            </span>
                          ) : showReorder ? (
                            <button
                              type="button"
                              title="Tryk for at vælge nyt stopnr."
                              onClick={() =>
                                setRoutePositionPicker({
                                  scope: "mapOverview",
                                  stopId: s.id,
                                })
                              }
                              className={`touch-manipulation flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-xl border-2 bg-zinc-100 transition active:scale-[0.97] dark:bg-[#0a1522] ${
                                active
                                  ? "border-accent text-accent"
                                  : "border-accent/60 text-accent dark:border-accent/50"
                              }`}
                            >
                              <span className="text-[10px] font-bold uppercase leading-none text-zinc-500 dark:text-white/55">
                                Nr.
                              </span>
                              <span className="text-2xl font-black leading-none text-zinc-900 dark:text-white">
                                {step}
                              </span>
                            </button>
                          ) : (
                            <span
                              className={`flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-xl border-2 bg-zinc-100 dark:bg-[#0a1522] ${
                                active
                                  ? "border-accent text-accent"
                                  : "border-accent/60 text-accent dark:border-accent/50"
                              }`}
                              aria-hidden
                            >
                              <span className="text-[10px] font-bold uppercase leading-none text-zinc-500 dark:text-white/55">
                                Nr.
                              </span>
                              <span className="text-2xl font-black leading-none text-zinc-900 dark:text-white">
                                {step}
                              </span>
                            </span>
                          )}
                          <p className="min-w-0 flex-1 text-sm font-semibold leading-snug text-zinc-900 dark:text-zinc-100">
                            {formatAddressForNav(s)}
                          </p>
                        </div>
                        {showReorder ? (
                          <div
                            className="flex shrink-0 flex-col gap-0.5 self-center"
                            title="Skift rækkefølge og stopnr. (Nr.)"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              aria-label="Flyt stop op i rækkefølgen"
                              disabled={routePos <= 0}
                              onClick={() =>
                                moveMapOverviewStopInRoute(s.id, "up")
                              }
                              className="touch-manipulation flex h-9 w-10 items-center justify-center rounded-lg border-2 border-zinc-300 bg-zinc-100 text-zinc-800 disabled:cursor-not-allowed disabled:opacity-35 dark:border-white/30 dark:bg-slate-700 dark:text-zinc-100"
                            >
                              <IconChevronUp />
                            </button>
                            <button
                              type="button"
                              aria-label="Flyt stop ned i rækkefølgen"
                              disabled={
                                routePos >= mapOverviewIncompleteStops.length - 1
                              }
                              onClick={() =>
                                moveMapOverviewStopInRoute(s.id, "down")
                              }
                              className="touch-manipulation flex h-9 w-10 items-center justify-center rounded-lg border-2 border-zinc-300 bg-zinc-100 text-zinc-800 disabled:cursor-not-allowed disabled:opacity-35 dark:border-white/30 dark:bg-slate-700 dark:text-zinc-100"
                            >
                              <IconChevronDown />
                            </button>
                          </div>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-2 border-t border-zinc-200 pt-3 dark:border-white/15">
                        <button
                          type="button"
                          onClick={() =>
                            openNativeNavigation(formatAddressForNav(s))
                          }
                          className="min-h-[48px] min-w-[8.5rem] flex-1 touch-manipulation rounded-xl border-2 border-accentDeep bg-accent px-3 text-sm font-black text-black shadow-sm transition active:scale-[0.98] dark:shadow-card sm:flex-initial"
                        >
                          NAVIGÉR
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleMapOverviewComplete(s.id)}
                          aria-pressed={s.completed}
                          className={`min-h-[48px] flex-1 touch-manipulation rounded-xl border-2 px-3 text-sm font-extrabold shadow-sm transition active:scale-[0.98] sm:max-w-[11rem] sm:flex-initial ${
                            s.completed
                              ? "border-accentDeep bg-accent text-black dark:border-accent"
                              : "border-zinc-300 bg-zinc-200 text-zinc-900 dark:border-white/35 dark:bg-slate-800 dark:text-white"
                          }`}
                        >
                          {s.completed ? "Leveret!" : "Leveret"}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : (
            <p className="text-center text-sm font-medium text-zinc-600 dark:text-zinc-400">
              Indsæt adresser og tryk «Indlæs adresser» for nummereret liste — kortet opdateres
              ovenfor.
            </p>
          )}
        </main>
      ) : null}

      {screen === "editor" ? (
      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-4 px-4 pb-36 pt-4">
        {stops.length > 0 ? (
          <section
            className="flex flex-col gap-2"
            aria-label="Kort med stop"
          >
            <h2 className="text-xs font-black uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Kort — stop efter kørerækkefølge
            </h2>
            <StopRouteMap
              stops={stops}
              incompleteOrdered={incompleteStops}
              activeId={activeId}
              onSelectStop={selectStop}
              accentHex={ACCENT_PRESETS[accentId].main}
            />
          </section>
        ) : null}

        <p className="text-center text-sm font-medium text-zinc-600 dark:text-zinc-400">
          Tryk på et stop på{" "}
          <span className="font-semibold text-zinc-800 dark:text-zinc-200">
            kortet
          </span>{" "}
          (OpenStreetMap) eller på et stop i listen for at vælge · derefter{" "}
          <span className="font-bold text-accent">NAVIGÉR</span>
          . Ved åbne stop: brug pile ↑ ↓ eller{" "}
          <span className="font-semibold text-zinc-800 dark:text-zinc-200">
            tryk på Nr.
          </span>{" "}
          for numpad — kørerækkefølge og stopnr. opdateres med det samme. Listen er fordelt
          under overskrifter pr. postnr. og by; flere leveringer til samme hus
          vises som ét kort med antal.
        </p>

        {(stops.length > 0 || activeFirestoreRouteId != null) && (
          <section className="flex flex-col gap-3 rounded-2xl border-2 border-zinc-300 bg-white px-3 py-3 shadow-sm dark:border-white/25 dark:bg-slate-800/70 dark:shadow-card">
            <p className="text-xs font-black uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Denne rute (hele dagen)
            </p>
            <div className="flex flex-col gap-1">
              <label
                className="text-sm font-semibold text-zinc-700 dark:text-zinc-300"
                htmlFor="routeName"
              >
                Navn / overskrift
              </label>
              <input
                id="routeName"
                type="text"
                value={routeName}
                onChange={(e) => setRouteName(e.target.value)}
                maxLength={100}
                placeholder="Fx Roskilde vest · bud 2"
                className="touch-manipulation rounded-xl border-2 border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder:text-zinc-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40 dark:border-white/30 dark:bg-slate-900 dark:text-white dark:placeholder:text-zinc-500"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label
                className="text-sm font-semibold text-zinc-700 dark:text-zinc-300"
                htmlFor="routeDate"
              >
                Rutedato (vises som dd-mm-yyyy)
              </label>
              <input
                id="routeDate"
                type="date"
                value={routeDate}
                onChange={(e) => setRouteDate(e.target.value)}
                className="touch-manipulation rounded-xl border-2 border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40 dark:border-white/30 dark:bg-slate-900 dark:text-white"
              />
            </div>
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
              Vises på forsiden og gemmes sammen med stop — ikke på de enkelte
              adresser.
            </p>
          </section>
        )}

        <section className="flex flex-col gap-2">
          <label
            className="text-sm font-semibold text-zinc-700 dark:text-zinc-300"
            htmlFor="raw"
          >
            Rå tekst — én adresse pr. linje. Postnr og by til sidst (fx «…, Stue
            3, 4070 Kirke Hyllinge» eller «…, Herslev, 4000 Roskilde»). Nummererede
            linjer (1. …) er fint.
          </label>
          <textarea
            id="raw"
            value={rawInput}
            onChange={(e) => setRawInput(e.target.value)}
            rows={6}
            className="touch-manipulation rounded-xl border-2 border-zinc-300 bg-white px-3 py-3 text-base text-zinc-900 shadow-sm placeholder:text-zinc-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40 dark:border-white/30 dark:bg-slate-900 dark:text-white dark:placeholder:text-zinc-500 dark:shadow-card"
            placeholder={
              "1. Nørregade 15, 4000 Roskilde\n2. Hovedgaden 2, 5000 Odense"
            }
            spellCheck={false}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleParse}
              className="min-h-[60px] flex-1 touch-manipulation rounded-xl border-2 border-zinc-400 bg-accent px-4 text-base font-extrabold text-black shadow-sm transition active:scale-[0.98] active:bg-accentDeep dark:border-white/40 dark:shadow-card"
            >
              Indlæs adresser
            </button>
            <button
              type="button"
              onClick={handleOptimize}
              disabled={stops.length < 2 || optimizing}
              className="min-h-[60px] flex-1 touch-manipulation rounded-xl border-2 border-zinc-300 bg-slate-200 px-4 text-base font-extrabold text-zinc-900 shadow-sm transition active:scale-[0.98] disabled:opacity-40 dark:border-white/25 dark:bg-slate-700 dark:text-white dark:shadow-card"
            >
              {optimizing ? "Optimerer…" : "Optimér rute"}
            </button>
            <button
              type="button"
              onClick={handleClear}
              className="min-h-[60px] touch-manipulation rounded-xl border-2 border-zinc-300 px-4 text-sm font-bold text-zinc-600 dark:border-white/25 dark:text-zinc-400"
            >
              Ryd
            </button>
          </div>
          <CloudSaveNewRow
            inputId="editor-cloud-save-as-new-title"
            titleValue={editorSaveAsNewTitle}
            onTitleChange={setEditorSaveAsNewTitle}
            onSave={handleSaveAsNewCloudRoute}
            saveDisabled={stops.length === 0}
            buttonTitle="Opretter nyt sky-dokument og sætter det som aktiv rute. «Indlæs adresser» opdaterer i stedet den aktive sky-rute."
          />
          {incompleteStops.length >= 2 && openRouteDriveKm != null && (
            <p className="text-center text-sm font-bold text-zinc-600 dark:text-zinc-400">
              Åbne stop (kørevej, sidst beregnet) ≈{" "}
              <span className="text-zinc-900 dark:text-white">
                {openRouteDriveKm.toFixed(1)} km
              </span>
            </p>
          )}
          {incompleteStops.length >= 2 && openRouteDriveKm == null && (
            <p className="text-center text-xs font-semibold text-zinc-500 dark:text-zinc-500">
              Tryk «Optimér rute» for kørelængde langs vej (OSRM).
            </p>
          )}
          {routeOptimizeFeedback && (
            <div
              className="rounded-xl border-2 border-accent/70 bg-white px-3 py-3 text-sm font-semibold leading-snug text-zinc-800 shadow-sm dark:bg-slate-900 dark:text-zinc-200 dark:shadow-card"
              role="status"
            >
              {routeOptimizeFeedback}
            </div>
          )}
        </section>

        <EditorStopList
          sectionsByCity={stopSectionsByCity}
          activeId={activeId}
          routeStepById={routeStepById}
          incompleteStops={incompleteStops}
          selectStop={selectStop}
          moveStopInRoute={moveStopInRoute}
          onOpenRoutePositionPicker={(stopId) =>
            setRoutePositionPicker({ scope: "editor", stopId })
          }
          toggleComplete={toggleComplete}
          copyOneAddress={copyOneAddress}
          copiedStopId={copiedStopId}
        />
      </main>
      ) : null}

      {screen === "editor" ? (
      <div
        className={`fixed bottom-0 left-0 right-0 z-30 p-4 ${accentShell.navFooter}`}
      >
        <div className="mx-auto max-w-lg">
          <p className="mb-2 line-clamp-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
            {navLabel}
          </p>
          <button
            type="button"
            onClick={() => {
              if (activeStop) openNativeNavigation(formatAddressForNav(activeStop));
            }}
            disabled={!activeStop}
            className="flex w-full min-h-[64px] touch-manipulation items-center justify-center rounded-2xl border-2 border-accentDeep bg-accent text-xl font-black text-black shadow-sm transition active:scale-[0.98] active:bg-accentDeep disabled:cursor-not-allowed disabled:opacity-45 dark:shadow-card"
          >
            NAVIGÉR
          </button>
          <p className="mt-2 text-center text-xs font-bold text-zinc-500 dark:text-zinc-500">
            Kør sikkert — vi hepper på dig
          </p>
        </div>
      </div>
      ) : null}

      <RoutePositionNumpad
        open={routePositionPicker != null}
        maxPosition={
          routePositionPicker?.scope === "editor"
            ? incompleteStops.length
            : mapOverviewIncompleteStops.length
        }
        onClose={() => setRoutePositionPicker(null)}
        onConfirm={(oneBased) => {
          if (!routePositionPicker) return;
          moveStopToRoutePositionOneBased(
            routePositionPicker.stopId,
            oneBased,
            routePositionPicker.scope,
          );
        }}
      />
    </div>
  );
}
