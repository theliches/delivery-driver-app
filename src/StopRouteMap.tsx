import { useEffect, useMemo, useState } from "react";
import { MapContainer, Marker, TileLayer, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import {
  buildingKey,
  formatAddressForNav,
  type ParsedAddress,
} from "./addressParser";
import { coordinatesForMapPlaceholder } from "./routeOptimizer";
import { geocodeForRouting } from "./roadRouting";

import "leaflet/dist/leaflet.css";

export type StopRouteMapStop = ParsedAddress & {
  id: string;
  completed: boolean;
};

function stopsKey(stops: StopRouteMapStop[]): string {
  return stops.map((s) => s.id).join("|");
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function FitBoundsEffect({ bounds }: { bounds: L.LatLngTuple[] }) {
  const map = useMap();
  useEffect(() => {
    if (bounds.length === 0) return;
    const latLngs = bounds.map(([lat, lng]) => L.latLng(lat, lng));
    if (latLngs.length === 1) {
      map.setView(latLngs[0]!, 14);
      return;
    }
    map.fitBounds(L.latLngBounds(latLngs), {
      padding: [32, 32],
      maxZoom: 14,
    });
  }, [map, bounds]);
  return null;
}

function makeDivIcon(opts: {
  label: string;
  active: boolean;
  completed: boolean;
  accentHex: string;
  title: string;
}) {
  const { label, active, completed, accentHex, title } = opts;
  const bg = completed ? "#64748b" : active ? accentHex : "#e4e4e7";
  const fg = completed ? "#f8fafc" : active ? "#0a0a0a" : "#18181b";
  const border = active
    ? `3px solid ${accentHex === "#e4e4e7" ? "#71717a" : accentHex}`
    : "2px solid #71717a";
  const safeTitle = escapeAttr(title);
  const html = `<div title="${safeTitle}" style="width:36px;height:36px;border-radius:9999px;background:${bg};color:${fg};border:${border};display:flex;align-items:center;justify-content:center;font:800 14px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.28)">${label}</div>`;
  return L.divIcon({
    className: "stop-route-marker",
    html,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });
}

type Cluster = StopRouteMapStop[];

/** Vælg repræsentant til geokodning når samme hus har flere postnr. i data. */
function pickClusterGeocodeRep<T extends ParsedAddress>(cluster: T[]): T {
  if (cluster.length <= 1) return cluster[0]!;
  const counts = new Map<string, number>();
  for (const s of cluster) {
    counts.set(s.zip, (counts.get(s.zip) ?? 0) + 1);
  }
  const topZip = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const subset = cluster.filter((s) => s.zip === topZip);
  return subset[0] ?? cluster[0]!;
}

function buildClustersInOrder(stops: StopRouteMapStop[]): Cluster[] {
  const byKey = new Map<string, StopRouteMapStop[]>();
  for (const s of stops) {
    const k = buildingKey(s);
    const list = byKey.get(k) ?? [];
    list.push(s);
    byKey.set(k, list);
  }
  const ordered: Cluster[] = [];
  const seen = new Set<string>();
  for (const s of stops) {
    const k = buildingKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    ordered.push(byKey.get(k)!);
  }
  return ordered;
}

export function StopRouteMap(props: {
  stops: StopRouteMapStop[];
  incompleteOrdered: StopRouteMapStop[];
  activeId: string | null;
  onSelectStop: (id: string) => void;
  accentHex: string;
}) {
  const { stops, incompleteOrdered, activeId, onSelectStop, accentHex } =
    props;
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const key = useMemo(() => stopsKey(stops), [stops]);

  const clusters = useMemo(() => buildClustersInOrder(stops), [key, stops]);

  const approxPositions = useMemo(() => {
    const o: Record<string, { lat: number; lng: number }> = {};
    for (const cluster of clusters) {
      const rep = pickClusterGeocodeRep(cluster);
      const k = buildingKey(rep);
      o[k] = coordinatesForMapPlaceholder(rep);
    }
    return o;
  }, [key, clusters]);

  const [refined, setRefined] = useState<Record<string, { lat: number; lng: number }>>(
    {},
  );

  useEffect(() => {
    setRefined({});
  }, [key]);

  useEffect(() => {
    if (clusters.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const cluster of clusters) {
        if (cancelled) break;
        const rep = pickClusterGeocodeRep(cluster);
        const bk = buildingKey(rep);
        try {
          const { coords } = await geocodeForRouting(rep);
          if (cancelled) break;
          setRefined((r) => ({ ...r, [bk]: coords }));
        } catch {
          /* behold approksimation */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, clusters]);

  const coordsByBuilding = useMemo(
    () => ({ ...approxPositions, ...refined }),
    [approxPositions, refined],
  );

  const stepById = useMemo(() => {
    const m = new Map<string, number>();
    incompleteOrdered.forEach((s, i) => m.set(s.id, i + 1));
    return m;
  }, [incompleteOrdered]);

  const bounds: L.LatLngTuple[] = useMemo(
    () =>
      clusters
        .map((c) => coordsByBuilding[buildingKey(c[0]!)])
        .filter((c): c is { lat: number; lng: number } => c != null)
        .map((c) => [c.lat, c.lng]),
    [clusters, coordsByBuilding],
  );

  const center: L.LatLngTuple = bounds[0] ?? [56.15, 10.21];

  const markerLabelAndState = (cluster: Cluster) => {
    const allDone = !cluster.some((s) => !s.completed);
    const active = cluster.some((s) => s.id === activeId);
    if (cluster.length >= 2) {
      const label = allDone ? "✓" : String(cluster.length);
      return { label, active, completed: allDone, showCount: true as const };
    }
    const s = cluster[0]!;
    const step = stepById.get(s.id);
    const label = s.completed ? "✓" : step != null ? String(step) : "·";
    return {
      label,
      active,
      completed: s.completed,
      showCount: false as const,
    };
  };

  const tooltipForCluster = (cluster: Cluster): string => {
    const rep = cluster[0]!;
    const base = `${rep.street} ${rep.houseNumber}`;
    if (cluster.length >= 2) {
      const steps = cluster
        .map((s) => ({ s, n: stepById.get(s.id) }))
        .filter((x): x is { s: StopRouteMapStop; n: number } => x.n != null)
        .sort((a, b) => a.n - b.n);
      const stepStr =
        steps.length > 0
          ? `Stop ${steps.map((x) => x.n).join(", ")} · `
          : "";
      return `${stepStr}${cluster.length} stop ved ${base}`;
    }
    const s = cluster[0]!;
    const nav = formatAddressForNav(s);
    const step = stepById.get(s.id);
    if (s.completed) return `Leveret · ${nav}`;
    if (step != null) return `Stop ${step} · ${nav}`;
    return nav;
  };

  if (!mounted) {
    return (
      <div className="flex min-h-[220px] items-center justify-center rounded-2xl border-2 border-zinc-300 bg-zinc-100 text-sm font-semibold text-zinc-600 dark:border-white/30 dark:bg-slate-900 dark:text-zinc-400">
        Indlæser kort…
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border-2 border-zinc-300 shadow-sm dark:border-white/30 dark:shadow-card">
      <MapContainer
        key={key}
        center={center}
        zoom={11}
        scrollWheelZoom
        className="z-0 w-full"
        style={{ height: "min(45vh, 320px)", minHeight: 220 }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitBoundsEffect bounds={bounds} />
        {clusters.map((cluster) => {
          const bk = buildingKey(cluster[0]!);
          const c = coordsByBuilding[bk];
          if (!c) return null;
          const { label, active, completed } = markerLabelAndState(cluster);
          const title = tooltipForCluster(cluster);
          return (
            <Marker
              key={bk}
              position={[c.lat, c.lng]}
              icon={makeDivIcon({
                label,
                active,
                completed,
                accentHex,
                title,
              })}
              eventHandlers={{
                click: () => {
                  const pick =
                    cluster.find((s) => !s.completed) ?? cluster[0]!;
                  onSelectStop(pick.id);
                },
              }}
            >
              <Tooltip direction="top" offset={[0, -18]}>
                {title}
              </Tooltip>
            </Marker>
          );
        })}
      </MapContainer>
      <p className="border-t border-zinc-200 bg-zinc-50 px-3 py-2 text-[11px] font-semibold leading-snug text-zinc-600 dark:border-white/15 dark:bg-slate-900 dark:text-zinc-400">
        Punkter flytter sig kort efter indlæsning, når adresser hentes fra
        OpenStreetMap. Ved samme hus ét punkt med antal; ellers kørerækkefølge
        som tal. Tryk en markør for at vælge stop til NAVIGÉR.
      </p>
    </div>
  );
}
