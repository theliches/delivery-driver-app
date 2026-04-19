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
import {
  canGenerateRouteToday,
  recordRouteGenerated,
  getDailyRouteUsageLabel,
  DAILY_ROUTE_LIMIT,
} from "./dailyRouteLimit";
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
import { StopRouteMap } from "./StopRouteMap";

const LS_KEY = "delivery-driver-route-v1";
const THEME_KEY = "delivery-driver-theme";
const ACCENT_KEY = "delivery-driver-accent";
const ACTIVE_FIREBASE_ROUTE_LS = "delivery-driver-firebase-active-route-id";
const LOCAL_TO_CLOUD_SEED_PREFIX = "delivery-driver-local-seeded-";

type AccentId = "orange" | "red" | "green" | "blue";

const ACCENT_PRESETS: Record<
  AccentId,
  { label: string; main: string; deep: string }
> = {
  orange: { label: "Orange", main: "#FF6B35", deep: "#E85A24" },
  /** Afdæmpet R — ikke neon */
  red: { label: "Rød", main: "#C45C5C", deep: "#9E4545" },
  /** Afdæmpet G — skovgrøn */
  green: { label: "Grøn", main: "#2F8F6B", deep: "#247A5A" },
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
  const [savedRoutes, setSavedRoutes] = useState<SavedRouteSummary[]>([]);
  const [cloudMessage, setCloudMessage] = useState<string | null>(null);
  const [routeName, setRouteName] = useState("");
  const [routeDate, setRouteDate] = useState(() => todayIsoLocal());
  const [routesRefreshing, setRoutesRefreshing] = useState(false);
  const [screen, setScreen] = useState<"home" | "editor">("home");
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
  /** Først `true` når auth-bootstrap (restore/seed) er færdig — undgår race med auto-attach. */
  const [cloudBootstrapReady, setCloudBootstrapReady] = useState(false);
  const cloudBootstrapDoneForUid = useRef<string | null>(null);
  const cloudBootstrapGeneration = useRef(0);
  const cloudRouteAttachLock = useRef(false);
  /** Auto-attach: stop efter gentagne fejl (undgår uendelig løkke); nulstilles ved uid/stoplængde-ændring. */
  const cloudAutoAttachFailCount = useRef(0);

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
    root.style.setProperty("--accent-rgb", hexToRgbTriplet(p.main));
    root.style.setProperty("--accent-deep-rgb", hexToRgbTriplet(p.deep));
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
        cloudBootstrapGeneration.current += 1;
        setCloudBootstrapReady(false);
        setFirebaseUid(null);
        return;
      }
      const uid = user.uid;
      setFirebaseUid(uid);
      if (cloudBootstrapDoneForUid.current === uid) return;
      cloudBootstrapDoneForUid.current = uid;
      cloudBootstrapGeneration.current += 1;
      const bootstrapGen = cloudBootstrapGeneration.current;
      setCloudBootstrapReady(false);
      void (async () => {
        try {
          setCloudMessage(null);
          let activeRid = localStorage.getItem(ACTIVE_FIREBASE_ROUTE_LS);
          if (activeRid) {
            const remote = await fetchUserRoute(uid, activeRid);
            if (remote) {
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
              return;
            }
            localStorage.removeItem(ACTIVE_FIREBASE_ROUTE_LS);
            activeRid = null;
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
            await saveUserRoute(uid, rid, {
              name: nm,
              title: routeTitleFromStops(st),
              routeName: typeof p.routeName === "string" ? p.routeName : "",
              routeDate: rd,
              rawInput: p.rawInput ?? "",
              stops: st,
              activeStopId: aid,
            });
            localStorage.setItem(seedKey, "1");
            setActiveFirestoreRouteId(rid);
          }
        } finally {
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
    }
  }, [firebaseUid]);

  useEffect(() => {
    cloudAutoAttachFailCount.current = 0;
    if (stops.length === 0) {
      cloudRouteAttachLock.current = false;
    }
  }, [stops.length]);

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
    if (cloudAutoAttachFailCount.current >= 6) return;
    if (cloudRouteAttachLock.current) return;
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

  useEffect(() => {
    if (!hydrated) return;
    savePersisted({ rawInput, stops, activeId, routeName, routeDate });
  }, [hydrated, rawInput, stops, activeId, routeName, routeDate]);

  useEffect(() => {
    if (!hydrated) return;
    if (activeFirestoreRouteId) {
      localStorage.setItem(ACTIVE_FIREBASE_ROUTE_LS, activeFirestoreRouteId);
    } else {
      localStorage.removeItem(ACTIVE_FIREBASE_ROUTE_LS);
    }
  }, [hydrated, activeFirestoreRouteId]);

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
        });
        setCloudSyncPhase(ok ? "synced" : "error");
        if (!ok) {
          setCloudMessage(
            "Sky-gem fejlede (ofte manglende/opdaterede Firestore-regler). Tjek `users/{uid}/routes`-regler og netværk.",
          );
        }
      })();
    }, 900);
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

  const handleParse = () => {
    setCopiedStopId(null);
    setRouteOptimizeFeedback(null);
    setOpenRouteDriveKm(null);
    const parsed = parseDanishAddresses(rawInput);
    const next = stopsFromParsed(parsed);
    setStops(next);
    ensureActive(next);
    if (firebaseUid && !activeFirestoreRouteId && next.length > 0) {
      const rid = newId();
      setActiveFirestoreRouteId(rid);
      const firstOpen =
        next.find((s) => !s.completed)?.id ?? next[0]?.id ?? null;
      const rd =
        routeDate && /^\d{4}-\d{2}-\d{2}$/.test(routeDate)
          ? routeDate
          : todayIsoLocal();
      void saveUserRoute(firebaseUid, rid, {
        name: routeName.trim() || routeTitleFromStops(next),
        title: routeTitleFromStops(next),
        routeName: routeName.trim(),
        routeDate: rd,
        rawInput,
        stops: next,
        activeStopId: firstOpen,
      });
    }
  };

  /** Ny række i sky-listen — gemmer nuværende `stops` uden at parse tekst igen. */
  const handleSaveAsNewCloudRoute = () => {
    setCopiedStopId(null);
    setRouteOptimizeFeedback(null);
    setOpenRouteDriveKm(null);
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
    void saveUserRoute(firebaseUid, rid, {
      name: "Ny rute",
      title: routeTitleFromStops(stops),
      routeName: routeName.trim(),
      routeDate: rd,
      rawInput,
      stops,
      activeStopId: firstOpen,
    });
  };

  const loadSavedRouteIntoApp = useCallback(
    async (routeId: string) => {
      if (!firebaseUid) return;
      const data = await fetchUserRoute(firebaseUid, routeId);
      if (!data) {
        setCloudMessage("Den rute findes ikke længere i skyen.");
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
      setActiveFirestoreRouteId(routeId);
      setMenuOpen(false);
      setScreen("editor");
    },
    [firebaseUid],
  );

  const goHome = useCallback(async () => {
    setMenuOpen(false);
    if (hydrated && firebaseUid && activeFirestoreRouteId) {
      setCloudSyncPhase("syncing");
      const ok = await flushActiveRouteToCloud();
      setCloudSyncPhase(ok ? "synced" : "error");
      if (!ok) {
        setCloudMessage(
          "Kunne ikke gemme til skyen før forsiden — prøv igen om et øjeblik.",
        );
      }
    }
    setScreen("home");
  }, [
    hydrated,
    firebaseUid,
    activeFirestoreRouteId,
    flushActiveRouteToCloud,
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

    if (!canGenerateRouteToday()) {
      setRouteOptimizeFeedback(
        `Maksimum ${DAILY_ROUTE_LIMIT} ruteberegninger per dag — prøv igen i morgen.`,
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
      recordRouteGenerated();
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
      recordRouteGenerated();
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

  const routeStepById = useMemo(() => {
    const m = new Map<string, number>();
    incompleteStops.forEach((s, i) => m.set(s.id, i + 1));
    return m;
  }, [incompleteStops]);

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

  return (
    <div className="flex min-h-full flex-col bg-zinc-100 text-zinc-900 dark:bg-[#070d14] dark:text-white">
      {screen === "home" ? (
        <header className="sticky top-0 z-20 border-b-2 border-zinc-300 bg-white shadow-lg dark:border-white/20 dark:bg-[#0a1522]">
          <div className="mx-auto flex max-w-lg flex-col gap-2 px-4 py-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h1 className="text-xl font-extrabold tracking-tight text-zinc-900 dark:text-white">
                  Leveringschauffør
                </h1>
                <p className="mt-1 text-sm font-semibold text-zinc-600 dark:text-zinc-400">
                  Forside — vælg gemt rute eller opret ny
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
      ) : (
        <header className="sticky top-0 z-20 border-b-2 border-zinc-300 bg-white shadow-lg dark:border-white/20 dark:bg-[#0a1522]">
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
                  Gemmes automatisk i skyen · forsiden viser alle ruter
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
            className="relative flex h-full w-full max-w-sm flex-col border-l-2 border-zinc-200 bg-white shadow-2xl dark:border-white/20 dark:bg-[#0d1824]"
          >
            <div className="flex items-center justify-between gap-2 border-b-2 border-zinc-200 px-4 py-3 dark:border-white/15">
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
                  Rød, grøn og blå er dæmpede nuancer — ikke skarpe neontoner.
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
              ) : (
                <p className="text-xs font-medium leading-snug text-zinc-500 dark:text-zinc-500">
                  Dine gemte ruter vises på forsiden. Brug «Opret ny rute» der.
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

          <section className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <p className="text-xs font-black uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Dine gemte ruter
              </p>
              <p className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
                Listen opdateres automatisk når du redigerer. Tryk på en rute for at åbne
                den.
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
                {savedRoutes.length === 0 ? (
                  <p className="text-sm font-medium leading-snug text-zinc-600 dark:text-zinc-400">
                    Ingen endnu — tryk «Opret ny rute», indsæt adresser og «Indlæs adresser».
                    Flere ruter: brug «Som ny rute i sky-listen» under tekstfeltet, eller
                    opret flere fra forsiden med «Opret ny rute» hver gang.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {savedRoutes.map((r) => {
                      const isActive = r.id === activeFirestoreRouteId;
                      const headline =
                        r.name.trim() || r.routeName.trim() || r.title || "Rute";
                      const dateStr =
                        r.routeDate && /^\d{4}-\d{2}-\d{2}$/.test(r.routeDate)
                          ? formatRouteDateDa(r.routeDate)
                          : null;
                      const when = r.updatedAt
                        ? formatDateTimeDdMmYyyyHm(r.updatedAt)
                        : "";
                      return (
                        <li key={r.id}>
                          <button
                            type="button"
                            onClick={() => void loadSavedRouteIntoApp(r.id)}
                            className={`flex w-full touch-manipulation flex-col gap-0.5 rounded-xl border-2 px-3 py-3 text-left transition ${
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
                        </li>
                      );
                    })}
                  </ul>
                )}
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
          . Brug pile ↑ ↓ ved åbne stop for manuel rækkefølge. Listen er fordelt
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
          <button
            type="button"
            onClick={handleSaveAsNewCloudRoute}
            disabled={stops.length === 0}
            title="Gemmer den nuværende rute som et nyt dokument i sky-listen."
            className="w-full touch-manipulation rounded-xl border-2 border-dashed border-zinc-400 bg-zinc-50 px-4 py-3 text-sm font-bold text-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/35 dark:bg-slate-800/80 dark:text-zinc-100"
          >
            Som ny rute i sky-listen
          </button>
          <p className="text-center text-xs font-medium leading-snug text-zinc-500 dark:text-zinc-500">
            «Indlæs adresser» opdaterer den <span className="font-semibold">aktive</span>{" "}
            sky-rute. Knappen herunder gemmer <span className="font-semibold">nuværende stop</span>{" "}
            som et nyt dokument («Ny rute») på forsiden.
          </p>
          <p className="text-center text-xs text-zinc-500 dark:text-zinc-500">
            {getDailyRouteUsageLabel()}
          </p>
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
          toggleComplete={toggleComplete}
          copyOneAddress={copyOneAddress}
          copiedStopId={copiedStopId}
        />
      </main>
      ) : null}

      {screen === "editor" ? (
      <div className="fixed bottom-0 left-0 right-0 z-30 border-t-2 border-zinc-200 bg-white p-4 shadow-[0_-10px_28px_rgba(0,0,0,0.12)] dark:border-white/20 dark:bg-[#0a1522] dark:shadow-[0_-10px_28px_rgba(0,0,0,0.65)]">
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
    </div>
  );
}
