import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type MouseEvent,
} from "react";
import {
  formatAddressForNav,
  parseDanishAddresses,
  cityBaseDisplay,
  type ParsedAddress,
} from "./addressParser";
import {
  canGenerateRouteToday,
  recordRouteGenerated,
  getDailyRouteUsageLabel,
} from "./dailyRouteLimit";
import { optimizeRouteWithStats } from "./routeOptimizer";
import { copyTextToClipboard } from "./clipboardWrite";
import { optimizeRouteByRoadWithStats } from "./roadRouting";
import { MAX_STOPS_PER_ROUTE } from "./routeConstants";
import { ensureAnonUser, isFirestoreConfigured } from "./firebaseApp";
import {
  fetchUserRoute,
  routeTitleFromStops,
  saveUserRoute,
  subscribeUserRouteSummaries,
  type SavedRouteSummary,
} from "./routePersistenceFirestore";

const LS_KEY = "delivery-driver-route-v1";
const THEME_KEY = "delivery-driver-theme";
const ACTIVE_FIREBASE_ROUTE_LS = "delivery-driver-firebase-active-route-id";

type Stop = ParsedAddress & {
  id: string;
  completed: boolean;
};

type Persisted = {
  rawInput: string;
  stops: Stop[];
  activeId: string | null;
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

function zipGroupOrder(stops: Stop[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const s of stops) {
    if (!seen.has(s.zip)) {
      seen.add(s.zip);
      order.push(s.zip);
    }
  }
  return order;
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
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      const t = localStorage.getItem(THEME_KEY);
      if (t === "light" || t === "dark") return t;
    } catch {
      /* ignore */
    }
    return "dark";
  });

  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const user = await ensureAnonUser();
      if (cancelled) return;
      if (user) {
        setFirebaseUid(user.uid);
        setCloudMessage(null);
      } else {
        setFirebaseUid(null);
        if (isFirestoreConfigured()) {
          setCloudMessage(
            "Kunne ikke logge på skyen (anonym). Tjek internet — og at Anonymous sign-in er slået til under Firebase → Authentication.",
          );
        }
      }

      let activeRid = localStorage.getItem(ACTIVE_FIREBASE_ROUTE_LS);
      if (user && activeRid) {
        const remote = await fetchUserRoute(user.uid, activeRid);
        if (!cancelled && remote) {
          setRawInput(remote.rawInput);
          setStops(remote.stops as Stop[]);
          const nextActive =
            remote.activeStopId &&
            remote.stops.some((s) => s.id === remote.activeStopId)
              ? remote.activeStopId
              : remote.stops.find((s) => !s.completed)?.id ??
                remote.stops[0]?.id ??
                null;
          setActiveId(nextActive);
          setActiveFirestoreRouteId(activeRid);
          setHydrated(true);
          return;
        }
        if (!cancelled) {
          localStorage.removeItem(ACTIVE_FIREBASE_ROUTE_LS);
          activeRid = null;
        }
      }

      const p = loadPersisted();
      if (!cancelled && p) {
        setRawInput(p.rawInput ?? "");
        setStops(p.stops ?? []);
        setActiveId(p.activeId ?? null);
      }
      if (!cancelled && user && !activeRid && p && (p.stops?.length ?? 0) > 0) {
        const st = p.stops ?? [];
        const aid =
          p.activeId && st.some((s) => s.id === p.activeId)
            ? p.activeId
            : st.find((s) => !s.completed)?.id ?? st[0]?.id ?? null;
        const rid = newId();
        await saveUserRoute(user.uid, rid, {
          title: routeTitleFromStops(st),
          rawInput: p.rawInput ?? "",
          stops: st,
          activeStopId: aid,
        });
        if (!cancelled) setActiveFirestoreRouteId(rid);
      }
      if (!cancelled) setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
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
    if (!hydrated) return;
    savePersisted({ rawInput, stops, activeId });
  }, [hydrated, rawInput, stops, activeId]);

  useEffect(() => {
    if (!hydrated) return;
    if (activeFirestoreRouteId) {
      localStorage.setItem(ACTIVE_FIREBASE_ROUTE_LS, activeFirestoreRouteId);
    } else {
      localStorage.removeItem(ACTIVE_FIREBASE_ROUTE_LS);
    }
  }, [hydrated, activeFirestoreRouteId]);

  useEffect(() => {
    if (!hydrated || !firebaseUid || !activeFirestoreRouteId) return;
    const t = window.setTimeout(() => {
      void saveUserRoute(firebaseUid, activeFirestoreRouteId, {
        title: routeTitleFromStops(stops),
        rawInput,
        stops,
        activeStopId: activeId,
      });
    }, 1400);
    return () => window.clearTimeout(t);
  }, [
    hydrated,
    firebaseUid,
    activeFirestoreRouteId,
    rawInput,
    stops,
    activeId,
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
      void saveUserRoute(firebaseUid, rid, {
        title: routeTitleFromStops(next),
        rawInput,
        stops: next,
        activeStopId: firstOpen,
      });
    }
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
    },
    [firebaseUid],
  );

  const startNewActiveRoute = useCallback(() => {
    setCopiedStopId(null);
    setRouteOptimizeFeedback(null);
    setOpenRouteDriveKm(null);
    setRawInput("");
    setStops([]);
    setActiveId(null);
    setActiveFirestoreRouteId(null);
    localStorage.removeItem(ACTIVE_FIREBASE_ROUTE_LS);
    localStorage.removeItem(LS_KEY);
    setMenuOpen(false);
  }, []);

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
      setRouteOptimizeFeedback("Daily limit reached (5 routes per day)");
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

  const zipOrder = useMemo(() => zipGroupOrder(stops), [stops]);

  const grouped = useMemo(() => {
    const map = new Map<string, Stop[]>();
    for (const s of stops) {
      const list = map.get(s.zip) ?? [];
      list.push(s);
      map.set(s.zip, list);
    }
    for (const [, list] of map) {
      list.sort((a, b) => {
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        return stops.indexOf(a) - stops.indexOf(b);
      });
    }
    return map;
  }, [stops]);

  const navLabel = activeStop
    ? formatAddressForNav(activeStop)
    : "Tryk på et stop på kortet herover";

  const incompleteStops = useMemo(
    () => stops.filter((s) => !s.completed),
    [stops],
  );

  const routeStepById = useMemo(() => {
    const m = new Map<string, number>();
    incompleteStops.forEach((s, i) => m.set(s.id, i + 1));
    return m;
  }, [incompleteStops]);

  return (
    <div className="flex min-h-full flex-col bg-zinc-100 text-zinc-900 dark:bg-[#070d14] dark:text-white">
      <header className="sticky top-0 z-20 border-b-2 border-zinc-300 bg-white shadow-lg dark:border-white/20 dark:bg-[#0a1522]">
        <div className="mx-auto flex max-w-lg flex-col gap-2 px-4 py-3">
          <div className="flex items-start justify-between gap-2">
            <h1 className="text-xl font-extrabold tracking-tight text-zinc-900 dark:text-white">
              Leveringschauffør
            </h1>
            <button
              type="button"
              aria-expanded={menuOpen}
              aria-controls="app-drawer-menu"
              onClick={() => setMenuOpen((o) => !o)}
              className="touch-manipulation rounded-xl border-2 border-zinc-300 bg-zinc-100 p-2.5 text-zinc-900 dark:border-white/35 dark:bg-slate-800 dark:text-white"
            >
              <span className="sr-only">Menu</span>
              <IconMenu />
            </button>
          </div>
          <p className="text-base font-black text-safety drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
            TOTAL: {completedCount} / {total} pakker
          </p>
          <p className="text-sm font-semibold leading-snug text-zinc-600 dark:text-zinc-300">
            {motivation}
          </p>
        </div>
      </header>

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

              {firebaseUid ? (
                <>
                  <div className="flex flex-col gap-2">
                    <p className="text-xs font-black uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
                      Dagens rute
                    </p>
                    <button
                      type="button"
                      onClick={startNewActiveRoute}
                      className="touch-manipulation rounded-xl border-2 border-safety bg-safety/90 px-4 py-3 text-left text-sm font-extrabold text-black dark:border-safety dark:bg-safety/80"
                    >
                      Ny aktiv rute (ny dag)
                    </button>
                    <p className="text-xs font-medium leading-snug text-zinc-500 dark:text-zinc-500">
                      Tømmer skærmen og starter forfra. Gamle ruter bliver i listen — vælg én nedenfor hvis du vil fortsætte en tidligere.
                    </p>
                  </div>

                  <div className="flex flex-col gap-2">
                    <p className="text-xs font-black uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
                      Tidligere ruter
                    </p>
                    {savedRoutes.length === 0 ? (
                      <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                        Ingen endnu — tryk «Indlæs adresser» for at oprette din første rute i skyen.
                      </p>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {savedRoutes.map((r) => {
                          const isActive = r.id === activeFirestoreRouteId;
                          const when = r.updatedAt
                            ? r.updatedAt.toLocaleString("da-DK", {
                                day: "numeric",
                                month: "short",
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            : "";
                          return (
                            <li key={r.id}>
                              <button
                                type="button"
                                onClick={() => void loadSavedRouteIntoApp(r.id)}
                                className={`flex w-full touch-manipulation flex-col gap-0.5 rounded-xl border-2 px-3 py-3 text-left transition ${
                                  isActive
                                    ? "border-safety bg-safety/15 dark:bg-safety/10"
                                    : "border-zinc-200 bg-zinc-50 dark:border-white/20 dark:bg-slate-800/80"
                                }`}
                              >
                                <span className="flex items-center justify-between gap-2">
                                  <span className="line-clamp-2 text-sm font-extrabold text-zinc-900 dark:text-white">
                                    {r.title}
                                  </span>
                                  {isActive ? (
                                    <span className="shrink-0 rounded-md bg-safety px-2 py-0.5 text-[10px] font-black uppercase text-black">
                                      Aktiv
                                    </span>
                                  ) : null}
                                </span>
                                <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                                  {r.stopCount} stop
                                  {when ? ` · ${when}` : ""}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </>
              ) : isFirestoreConfigured() ? (
                <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                  Logger ind i skyen… hvis det hænger, genindlæs siden.
                </p>
              ) : null}
            </div>
          </aside>
        </div>
      ) : null}

      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-4 px-4 pb-36 pt-4">
        <p className="text-center text-sm font-medium text-zinc-600 dark:text-zinc-400">
          Tryk på et stop (hele kortet) for at vælge · derefter{" "}
          <span className="font-bold text-safety">NAVIGÉR</span>
        </p>

        <section className="flex flex-col gap-2">
          <label
            className="text-sm font-semibold text-zinc-700 dark:text-zinc-300"
            htmlFor="raw"
          >
            Rå tekst — du kan indsætte nummererede linjer (1. … 2. …)
          </label>
          <textarea
            id="raw"
            value={rawInput}
            onChange={(e) => setRawInput(e.target.value)}
            rows={6}
            className="touch-manipulation rounded-xl border-2 border-zinc-300 bg-white px-3 py-3 text-base text-zinc-900 shadow-sm placeholder:text-zinc-400 focus:border-safety focus:outline-none focus:ring-2 focus:ring-safety/40 dark:border-white/30 dark:bg-slate-900 dark:text-white dark:placeholder:text-zinc-500 dark:shadow-card"
            placeholder={
              "1. Nørregade 15, 4000 Roskilde\n2. Hovedgaden 2, 5000 Odense"
            }
            spellCheck={false}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleParse}
              className="min-h-[60px] flex-1 touch-manipulation rounded-xl border-2 border-zinc-400 bg-safety px-4 text-base font-extrabold text-black shadow-sm transition active:scale-[0.98] active:bg-safetyDeep dark:border-white/40 dark:shadow-card"
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
              className="rounded-xl border-2 border-safety/70 bg-white px-3 py-3 text-sm font-semibold leading-snug text-zinc-800 shadow-sm dark:bg-slate-900 dark:text-zinc-200 dark:shadow-card"
              role="status"
            >
              {routeOptimizeFeedback}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-4">
          {zipOrder.map((zip) => {
            const list = grouped.get(zip) ?? [];
            const done = list.filter((s) => s.completed).length;
            const earliest =
              list.length > 0
                ? list.reduce((a, b) =>
                    stops.indexOf(a) <= stops.indexOf(b) ? a : b,
                  )
                : null;
            const heading = earliest
              ? `${zip} ${cityBaseDisplay(earliest.city)}`
              : zip;
            return (
              <div key={zip}>
                <h2 className="mb-2 text-sm font-extrabold uppercase tracking-wide text-zinc-700 drop-shadow-sm dark:text-zinc-300">
                  {heading} ({done}/{list.length})
                </h2>
                <ul className="flex flex-col gap-3">
                  {list.map((s) => {
                    const isActive = s.id === activeId;
                    const step = routeStepById.get(s.id);
                    return (
                      <li
                        key={s.id}
                        className={`overflow-hidden rounded-2xl shadow-sm transition dark:shadow-card ${
                          isActive
                            ? "border-4 border-safety"
                            : "border-2 border-zinc-300 dark:border-white/35"
                        } bg-white dark:bg-slate-800 ${s.completed ? "opacity-[0.72] dark:opacity-[0.62]" : "opacity-100"}`}
                      >
                        <div className="flex min-h-[88px] items-stretch gap-2 px-2 py-2 sm:px-3">
                          <button
                            type="button"
                            onClick={() => selectStop(s.id)}
                            className="touch-manipulation flex min-w-0 flex-1 items-stretch gap-3 rounded-lg px-2 py-3 text-left transition active:bg-zinc-100 dark:active:bg-white/10"
                          >
                            {step != null ? (
                              <span
                                className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-xl border-2 border-safety bg-zinc-100 text-safety dark:bg-[#0a1522]"
                                aria-hidden
                              >
                                <span className="text-[10px] font-bold uppercase leading-none text-zinc-500 dark:text-white/55">
                                  Nr.
                                </span>
                                <span className="text-2xl font-black leading-none">
                                  {step}
                                </span>
                              </span>
                            ) : (
                              <span
                                className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border-2 border-zinc-300 bg-zinc-100 text-lg font-black text-zinc-400 dark:border-white/25 dark:bg-black/30 dark:text-white/50"
                                aria-hidden
                              >
                                ✓
                              </span>
                            )}
                            <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
                              {isActive ? (
                                <span className="text-xs font-black uppercase tracking-wide text-safety">
                                  Valgt · brug NAVIGÉR nedenfor
                                </span>
                              ) : (
                                <span className="text-xs font-bold text-zinc-500 dark:text-zinc-500">
                                  Tryk her for at vælge stop
                                </span>
                              )}
                              <p className="text-lg font-extrabold leading-tight text-zinc-900 dark:text-white">
                                {s.street} {s.houseNumber}
                              </p>
                              <p className="text-base font-semibold text-zinc-600 dark:text-zinc-300">
                                {s.zip} {s.city}
                              </p>
                            </div>
                          </button>
                          <button
                            type="button"
                            onClick={(e) => void copyOneAddress(e, s)}
                            className={`touch-manipulation shrink-0 self-center rounded-lg border-2 px-2 py-2 text-xs font-extrabold ${
                              copiedStopId === s.id
                                ? "border-emerald-600 bg-emerald-100 text-emerald-900 dark:border-emerald-500 dark:bg-emerald-950/60 dark:text-emerald-100"
                                : "border-zinc-300 bg-zinc-100 text-zinc-800 dark:border-white/30 dark:bg-slate-700 dark:text-zinc-100"
                            }`}
                          >
                            {copiedStopId === s.id ? "Kopieret" : "Kopiér"}
                          </button>
                        </div>

                        <div className="border-t-2 border-safety bg-zinc-50 px-3 py-2 dark:bg-slate-900/90">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold uppercase tracking-wide text-zinc-500">
                              Status
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleComplete(s.id);
                              }}
                              aria-pressed={s.completed}
                              className={`touch-manipulation inline-flex min-h-[46px] max-w-[11rem] shrink-0 items-center justify-center gap-2 rounded-xl border-2 px-4 text-sm font-extrabold shadow-md transition active:scale-[0.97] ${
                                s.completed
                                  ? "border-safetyDeep bg-safety text-black"
                                  : "border-zinc-300 bg-zinc-200 text-zinc-900 dark:border-white/35 dark:bg-slate-800 dark:text-white"
                              } `}
                            >
                              <span
                                className={`flex size-7 shrink-0 items-center justify-center rounded-md border-2 text-base font-black ${
                                  s.completed
                                    ? "border-black/30 bg-black/10 text-black"
                                    : "border-zinc-400 bg-white/80 text-transparent dark:border-white/40 dark:bg-black/40"
                                }`}
                                aria-hidden
                              >
                                ✓
                              </span>
                              {s.completed ? "Leveret!" : "Leveret"}
                            </button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}

          {stops.length === 0 && (
            <p className="text-center text-base font-medium text-zinc-600 dark:text-zinc-400">
              Indsæt adresser og tryk &quot;Indlæs adresser&quot; — så er du i
              gang!
            </p>
          )}
        </section>
      </main>

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
            className="flex w-full min-h-[64px] touch-manipulation items-center justify-center rounded-2xl border-2 border-safetyDeep bg-safety text-xl font-black text-black shadow-sm transition active:scale-[0.98] active:bg-safetyDeep disabled:cursor-not-allowed disabled:opacity-45 dark:shadow-card"
          >
            NAVIGÉR
          </button>
          <p className="mt-2 text-center text-xs font-bold text-zinc-500 dark:text-zinc-500">
            Kør sikkert — vi hepper på dig
          </p>
        </div>
      </div>
    </div>
  );
}
