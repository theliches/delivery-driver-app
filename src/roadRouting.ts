import { readAddressCache, writeAddressCache } from "./addressCacheFirestore";
import { normalizedGeocodeQuery } from "./addressKey";
import { formatAddressForNav, type ParsedAddress } from "./addressParser";
import { approximateCoordinates } from "./routeOptimizer";

/** Offentlig OSRM-demo + Nominatim — ingen API-nøgle; kræver netværk. */
const NOMINATIM =
  import.meta.env.DEV
    ? "/api/nominatim/search"
    : "https://nominatim.openstreetmap.org/search";

const OSRM_TABLE =
  import.meta.env.DEV
    ? "/api/osrm/table/v1/driving"
    : "https://router.project-osrm.org/table/v1/driving";

const geoCache = new Map<string, { lat: number; lng: number }>();

export type GeocodeSource = "memory" | "firestore" | "nominatim" | "approx";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let lastNomRequest = 0;
const NOM_GAP_MS = 1100;

async function nominatimThrottle(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, NOM_GAP_MS - (now - lastNomRequest));
  if (wait > 0) await sleep(wait);
  lastNomRequest = Date.now();
}

export type LatLng = { lat: number; lng: number };

/**
 * Geokodning: hukommelse → Firestore → Nominatim → omtrentligt punkt.
 */
export async function geocodeForRouting(
  addr: ParsedAddress,
  onProgress?: (label: string) => void,
): Promise<{ coords: LatLng; usedApprox: boolean; source: GeocodeSource }> {
  const q = `${formatAddressForNav(addr)}, Denmark`;
  const norm = normalizedGeocodeQuery(addr);

  const mem = geoCache.get(norm);
  if (mem) return { coords: mem, usedApprox: false, source: "memory" };

  const fsHit = await readAddressCache(norm);
  if (fsHit) {
    geoCache.set(norm, fsHit);
    return { coords: fsHit, usedApprox: false, source: "firestore" };
  }

  await nominatimThrottle();
  onProgress?.(`Geokoder: ${addr.street} ${addr.houseNumber}…`);

  try {
    const url = `${NOMINATIM}?format=json&limit=1&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Language": "da,en",
      },
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { lat?: string; lon?: string }[];
    if (data?.[0]?.lat != null && data[0].lon != null) {
      const lat = parseFloat(data[0].lat);
      const lng = parseFloat(data[0].lon);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        const coords = { lat, lng };
        geoCache.set(norm, coords);
        void writeAddressCache(norm, lat, lng);
        return { coords, usedApprox: false, source: "nominatim" };
      }
    }
  } catch {
    /* fallback nedenfor */
  }

  const a = approximateCoordinates(addr);
  return {
    coords: { lat: a.lat, lng: a.lng },
    usedApprox: true,
    source: "approx",
  };
}

type OsrmTableResponse = {
  distances?: (number | null)[][];
  code?: string;
};

function buildOsrmCoordinatePath(coords: LatLng[]): string {
  return coords.map((c) => `${c.lng},${c.lat}`).join(";");
}

export async function fetchDrivingDistanceMatrix(
  coords: LatLng[],
): Promise<(number | null)[][]> {
  if (coords.length === 0) return [];
  if (coords.length === 1) return [[0]];
  const path = buildOsrmCoordinatePath(coords);
  const url = `${OSRM_TABLE}/${path}?annotations=distance`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const json = (await res.json()) as OsrmTableResponse;
  if (json.code !== "Ok" || !json.distances) {
    throw new Error("OSRM: ugyldigt svar");
  }
  return json.distances;
}

const BIG = 1e15;

function distM(
  mx: (number | null)[][],
  i: number,
  j: number,
): number {
  const v = mx[i]?.[j];
  if (v == null || !Number.isFinite(v)) return BIG;
  return v;
}

function pathLengthM(order: number[], mx: (number | null)[][]): number {
  let s = 0;
  for (let i = 1; i < order.length; i++) {
    s += distM(mx, order[i - 1], order[i]);
  }
  return s;
}

/** Køreafstand langs nuværende liste, startende ved valgte stop (idx) — fair sammenligning med NN. */
function orderRotatingFromStart(n: number, startIndex: number): number[] {
  const safe = Math.min(Math.max(startIndex, 0), Math.max(0, n - 1));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push((safe + i) % n);
  }
  return out;
}

function twoOptSwapOrder(order: number[], i: number, k: number): number[] {
  const next = order.slice(0, i + 1);
  for (let x = k; x > i; x--) next.push(order[x]);
  next.push(...order.slice(k + 1));
  return next;
}

function nearestNeighborOrder(
  n: number,
  mx: (number | null)[][],
  startIndex: number,
): number[] {
  const unvisited = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (i !== startIndex) unvisited.add(i);
  }
  const order: number[] = [startIndex];
  let current = startIndex;
  while (unvisited.size) {
    let bestJ = -1;
    let bestD = BIG;
    for (const j of unvisited) {
      const d = distM(mx, current, j);
      if (d < bestD) {
        bestD = d;
        bestJ = j;
      }
    }
    if (bestJ < 0) break;
    unvisited.delete(bestJ);
    order.push(bestJ);
    current = bestJ;
  }
  return order;
}

function twoOptOpenPath(
  order: number[],
  mx: (number | null)[][],
): number[] {
  if (order.length < 4) return order.slice();
  let best = order.slice();
  let bestLen = pathLengthM(best, mx);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 2; i++) {
      for (let k = i + 2; k < best.length; k++) {
        const next = twoOptSwapOrder(best, i, k);
        const len = pathLengthM(next, mx);
        if (len + 1e-3 < bestLen) {
          best = next;
          bestLen = len;
          improved = true;
        }
      }
    }
  }
  return best;
}

function sameOrderById<T extends { id: string }>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false;
  }
  return true;
}

export type RoadRouteStats = {
  beforeKm: number;
  afterKm: number;
  savedKm: number;
  orderChanged: boolean;
};

/**
 * Geokoder alle stop, henter køreafstande-matrix fra OSRM, NN + 2-opt på vejnettet.
 */
export async function optimizeRouteByRoadWithStats<
  T extends ParsedAddress & { id: string },
>(
  stops: T[],
  startIndex: number,
  onProgress?: (label: string) => void,
): Promise<{
  ordered: T[];
  stats: RoadRouteStats;
  anyApproxGeocode: boolean;
}> {
  if (stops.length <= 1) {
    return {
      ordered: [...stops],
      stats: {
        beforeKm: 0,
        afterKm: 0,
        savedKm: 0,
        orderChanged: false,
      },
      anyApproxGeocode: false,
    };
  }

  const latLngs: LatLng[] = [];
  let anyApprox = false;
  let saidCache = false;
  let saidFetch = false;
  for (let i = 0; i < stops.length; i++) {
    onProgress?.(`Adresse ${i + 1} / ${stops.length}…`);
    const { coords, usedApprox, source } = await geocodeForRouting(
      stops[i],
      onProgress,
    );
    if (
      (source === "memory" || source === "firestore") &&
      !saidCache
    ) {
      onProgress?.("Using cached addresses");
      saidCache = true;
    }
    if (source === "nominatim" && !saidFetch) {
      onProgress?.("Fetching new addresses...");
      saidFetch = true;
    }
    latLngs.push(coords);
    if (usedApprox) anyApprox = true;
  }

  onProgress?.("Henter køreafstande (OSRM)…");
  const mx = await fetchDrivingDistanceMatrix(latLngs);

  const n = stops.length;
  const safeStart = Math.min(Math.max(startIndex, 0), n - 1);
  const initialOrder = orderRotatingFromStart(n, safeStart);
  const beforeM = pathLengthM(initialOrder, mx);
  const beforeKm = beforeM >= BIG ? NaN : beforeM / 1000;

  let order = nearestNeighborOrder(n, mx, safeStart);
  order = twoOptOpenPath(order, mx);

  const afterM = pathLengthM(order, mx);
  const afterKm = afterM >= BIG ? NaN : afterM / 1000;

  const ordered = order.map((i) => stops[i]);
  const baselineStops = initialOrder.map((i) => stops[i]);
  const savedKm =
    Number.isFinite(beforeKm) && Number.isFinite(afterKm)
      ? beforeKm - afterKm
      : 0;

  return {
    ordered,
    stats: {
      beforeKm: Number.isFinite(beforeKm) ? beforeKm : 0,
      afterKm: Number.isFinite(afterKm) ? afterKm : 0,
      savedKm,
      orderChanged: !sameOrderById(baselineStops, ordered),
    },
    anyApproxGeocode: anyApprox,
  };
}
