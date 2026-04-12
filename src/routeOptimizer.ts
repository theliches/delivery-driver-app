import { cityBaseDisplay, type ParsedAddress } from "./addressParser";

export interface Coordinates {
  lat: number;
  lng: number;
}

/** Groft centrum pr. postnummer-præfix (2 cifre) — kun til lokal rækkefølge, ikke navigation. */
const ZIP_PREFIX_CENTERS: Record<string, Coordinates> = {
  "10": { lat: 55.6761, lng: 12.5683 },
  "11": { lat: 55.6761, lng: 12.5683 },
  "12": { lat: 55.6761, lng: 12.5683 },
  "13": { lat: 55.6761, lng: 12.5683 },
  "14": { lat: 55.6761, lng: 12.5683 },
  "15": { lat: 55.6761, lng: 12.5683 },
  "16": { lat: 55.6761, lng: 12.5683 },
  "17": { lat: 55.6761, lng: 12.5683 },
  "18": { lat: 55.6761, lng: 12.5683 },
  "19": { lat: 55.6761, lng: 12.5683 },
  "20": { lat: 55.6756, lng: 12.534 },
  "21": { lat: 55.6761, lng: 12.5683 },
  "22": { lat: 55.6415, lng: 12.0803 },
  "23": { lat: 55.6415, lng: 12.0803 },
  "24": { lat: 55.6415, lng: 12.0803 },
  "25": { lat: 55.6415, lng: 12.0803 },
  "26": { lat: 55.6415, lng: 12.0803 },
  "27": { lat: 55.6415, lng: 12.0803 },
  "28": { lat: 55.6415, lng: 12.0803 },
  "29": { lat: 55.6415, lng: 12.0803 },
  "30": { lat: 55.25, lng: 11.75 },
  "31": { lat: 55.25, lng: 11.75 },
  "32": { lat: 55.25, lng: 11.75 },
  "33": { lat: 55.25, lng: 11.75 },
  "34": { lat: 55.25, lng: 11.75 },
  "35": { lat: 55.25, lng: 11.75 },
  "36": { lat: 55.25, lng: 11.75 },
  "37": { lat: 55.25, lng: 11.75 },
  "38": { lat: 55.25, lng: 11.75 },
  "39": { lat: 55.25, lng: 11.75 },
  "40": { lat: 55.6413, lng: 12.0803 },
  "41": { lat: 55.6413, lng: 12.0803 },
  "42": { lat: 55.6413, lng: 12.0803 },
  "43": { lat: 55.6413, lng: 12.0803 },
  "44": { lat: 55.6413, lng: 12.0803 },
  "45": { lat: 55.6413, lng: 12.0803 },
  "46": { lat: 55.6413, lng: 12.0803 },
  "47": { lat: 55.6413, lng: 12.0803 },
  "48": { lat: 55.6413, lng: 12.0803 },
  "49": { lat: 55.6413, lng: 12.0803 },
  "50": { lat: 55.4038, lng: 10.4024 },
  "51": { lat: 55.4038, lng: 10.4024 },
  "52": { lat: 55.4038, lng: 10.4024 },
  "53": { lat: 55.4038, lng: 10.4024 },
  "54": { lat: 55.4038, lng: 10.4024 },
  "55": { lat: 55.4038, lng: 10.4024 },
  "56": { lat: 55.4038, lng: 10.4024 },
  "57": { lat: 55.4038, lng: 10.4024 },
  "58": { lat: 55.4038, lng: 10.4024 },
  "59": { lat: 55.4038, lng: 10.4024 },
  "60": { lat: 55.4942, lng: 9.4208 },
  "61": { lat: 55.4942, lng: 9.4208 },
  "62": { lat: 55.4942, lng: 9.4208 },
  "63": { lat: 55.4942, lng: 9.4208 },
  "64": { lat: 55.4942, lng: 9.4208 },
  "65": { lat: 55.4942, lng: 9.4208 },
  "66": { lat: 55.4942, lng: 9.4208 },
  "67": { lat: 55.4942, lng: 9.4208 },
  "68": { lat: 55.4942, lng: 9.4208 },
  "69": { lat: 55.4942, lng: 9.4208 },
  "70": { lat: 56.1629, lng: 10.2039 },
  "71": { lat: 56.1629, lng: 10.2039 },
  "72": { lat: 56.1629, lng: 10.2039 },
  "73": { lat: 56.1629, lng: 10.2039 },
  "74": { lat: 56.1629, lng: 10.2039 },
  "75": { lat: 56.1629, lng: 10.2039 },
  "76": { lat: 56.1629, lng: 10.2039 },
  "77": { lat: 56.1629, lng: 10.2039 },
  "78": { lat: 56.1629, lng: 10.2039 },
  "79": { lat: 56.1629, lng: 10.2039 },
  "80": { lat: 56.1572, lng: 10.2107 },
  "81": { lat: 56.1572, lng: 10.2107 },
  "82": { lat: 56.1572, lng: 10.2107 },
  "83": { lat: 56.1572, lng: 10.2107 },
  "84": { lat: 56.1572, lng: 10.2107 },
  "85": { lat: 56.1572, lng: 10.2107 },
  "86": { lat: 56.1572, lng: 10.2107 },
  "87": { lat: 56.1572, lng: 10.2107 },
  "88": { lat: 56.1572, lng: 10.2107 },
  "89": { lat: 56.1572, lng: 10.2107 },
  "90": { lat: 57.0488, lng: 9.9217 },
  "91": { lat: 57.0488, lng: 9.9217 },
  "92": { lat: 57.0488, lng: 9.9217 },
  "93": { lat: 57.0488, lng: 9.9217 },
  "94": { lat: 57.0488, lng: 9.9217 },
  "95": { lat: 57.0488, lng: 9.9217 },
  "96": { lat: 57.0488, lng: 9.9217 },
  "97": { lat: 57.0488, lng: 9.9217 },
  "98": { lat: 57.0488, lng: 9.9217 },
  "99": { lat: 57.0488, lng: 9.9217 },
};

/** Kendte byer → koordinater (til finere sortering end postnr alene). */
const CITY_CENTERS: Record<string, Coordinates> = {
  københavn: { lat: 55.6761, lng: 12.5683 },
  "københavn k": { lat: 55.6761, lng: 12.5683 },
  "københavn nv": { lat: 55.72, lng: 12.53 },
  "københavn sv": { lat: 55.65, lng: 12.55 },
  "københavn ø": { lat: 55.69, lng: 12.58 },
  frederiksberg: { lat: 55.6756, lng: 12.534 },
  roskilde: { lat: 55.6415, lng: 12.0803 },
  helsingør: { lat: 56.0361, lng: 12.6136 },
  hillerød: { lat: 55.9272, lng: 12.3006 },
  odense: { lat: 55.4038, lng: 10.4024 },
  esbjerg: { lat: 55.4668, lng: 8.4517 },
  kolding: { lat: 55.4904, lng: 9.4721 },
  vejle: { lat: 55.709, lng: 9.5357 },
  horsens: { lat: 55.8607, lng: 9.85 },
  randers: { lat: 56.4607, lng: 10.0364 },
  aarhus: { lat: 56.1572, lng: 10.2107 },
  århus: { lat: 56.1572, lng: 10.2107 },
  aalborg: { lat: 57.0488, lng: 9.9217 },
  ålborg: { lat: 57.0488, lng: 9.9217 },
  herning: { lat: 56.1357, lng: 8.9758 },
  silkeborg: { lat: 56.1697, lng: 9.5451 },
  viborg: { lat: 56.4533, lng: 9.402 },
  holstebro: { lat: 56.36, lng: 8.6167 },
  slagelse: { lat: 55.4028, lng: 11.3546 },
  næstved: { lat: 55.2298, lng: 11.761 },
  køge: { lat: 55.458, lng: 12.1821 },
  holbæk: { lat: 55.7167, lng: 11.7167 },
  sorø: { lat: 55.4318, lng: 11.5555 },
  ringsted: { lat: 55.4426, lng: 11.7901 },
  gentofte: { lat: 55.7484, lng: 12.5489 },
  lyngby: { lat: 55.7704, lng: 12.5038 },
  glostrup: { lat: 55.6665, lng: 12.4037 },
  ballerup: { lat: 55.7316, lng: 12.3633 },
  taastrup: { lat: 55.6516, lng: 12.2922 },
  fredericia: { lat: 55.5657, lng: 9.7526 },
  svendborg: { lat: 55.0598, lng: 10.6067 },
  nørrebro: { lat: 55.6935, lng: 12.5478 },
};

function normalizeCityKey(city: string): string {
  return cityBaseDisplay(city)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

function haversineKm(a: Coordinates, b: Coordinates): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Deterministisk hash til små koordinat-forskydninger (FNV-1a-lignende). */
function hashAddressSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Omtrentlige koordinater uden API: bynavn slår postnr-præfix.
 */
export function approximateCoordinates(addr: ParsedAddress): Coordinates {
  const key = normalizeCityKey(addr.city);
  const cityHit = CITY_CENTERS[key];
  if (cityHit) return cityHit;

  const prefix = addr.zip.slice(0, 2);
  return ZIP_PREFIX_CENTERS[prefix] ?? { lat: 55.86, lng: 9.84 };
}

/**
 * Koordinater til rute-sort: samme område som `approximateCoordinates`, men hvert
 * stop får et lille, stabilt offset fra gade+nr+postnr — ellers ligger alle punkter
 * oven i hinanden og nærmeste-nabo ændrer ikke rækkefølgen.
 */
export function coordinatesForRouteOptimization(
  addr: ParsedAddress,
): Coordinates {
  const base = approximateCoordinates(addr);
  const seed = hashAddressSeed(
    `${addr.zip}|${addr.street}|${addr.houseNumber}`.toLowerCase(),
  );
  const z = parseInt(addr.zip, 10);
  const zPart = Number.isFinite(z) ? (z % 97) / 97 - 0.5 : 0;
  const dx = ((seed & 0xffff) / 0xffff - 0.5) * 0.14 + zPart * 0.04;
  const dy =
    (((seed >>> 16) & 0xffff) / 0xffff - 0.5) * 0.1 - zPart * 0.025;
  return { lat: base.lat + dy, lng: base.lng + dx };
}

/** Sum af luftlinje mellem stop i rækkefølge (ikke kørevej). */
export function straightLineRouteLengthKm(
  stops: ParsedAddress[],
): number {
  if (stops.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < stops.length; i++) {
    sum += haversineKm(
      coordinatesForRouteOptimization(stops[i - 1]),
      coordinatesForRouteOptimization(stops[i]),
    );
  }
  return sum;
}

export type RouteOptimizeStats = {
  /** Afstand før omrokering (luftlinje mellem stop i den rækkefølge listen havde). */
  beforeKm: number;
  /** Efter nearest-neighbor. */
  afterKm: number;
  /** Negativ hvis rækkefølgen blev værre (sjældent). */
  savedKm: number;
  /** True hvis rækkefølgen (id-rækkefølge) ændrede sig. */
  orderChanged: boolean;
};

function sameOrder<T extends { id: string }>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false;
  }
  return true;
}

/**
 * Nærmeste-nabo på `coordinatesForRouteOptimization` + kort 2-opt forbedring
 * (byt ender af to kanter hvis det forkorter luftlinjeturen).
 */
export function optimizeRouteNearestNeighbor<T extends ParsedAddress>(
  stops: T[],
  startIndex = 0,
): T[] {
  if (stops.length <= 1) return [...stops];

  const unvisited = stops.map((s, i) => ({ stop: s, origIndex: i }));
  const startEntry = unvisited.splice(
    Math.min(Math.max(startIndex, 0), unvisited.length - 1),
    1,
  )[0];
  const ordered: T[] = [startEntry.stop];
  let current = coordinatesForRouteOptimization(startEntry.stop);

  while (unvisited.length) {
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < unvisited.length; i++) {
      const c = coordinatesForRouteOptimization(unvisited[i].stop);
      const d = haversineKm(current, c);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    const [next] = unvisited.splice(bestI, 1);
    ordered.push(next.stop);
    current = coordinatesForRouteOptimization(next.stop);
  }

  return twoOptImprove(ordered);
}

function twoOptImprove<T extends ParsedAddress>(route: T[]): T[] {
  if (route.length < 4) return route;

  const coords = route.map(coordinatesForRouteOptimization);
  let improved = true;
  let best = route.slice();
  let bestLen = tourLengthInternal(coords);

  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 2; i++) {
      for (let k = i + 2; k < best.length; k++) {
        const next = twoOptSwap(best, i, k);
        const nextCoords = next.map(coordinatesForRouteOptimization);
        const len = tourLengthInternal(nextCoords);
        if (len + 1e-9 < bestLen) {
          best = next;
          bestLen = len;
          improved = true;
        }
      }
    }
  }
  return best;
}

function tourLengthInternal(coords: Coordinates[]): number {
  let sum = 0;
  for (let i = 1; i < coords.length; i++) {
    sum += haversineKm(coords[i - 1], coords[i]);
  }
  return sum;
}

function twoOptSwap<T>(route: T[], i: number, k: number): T[] {
  const next = route.slice(0, i + 1);
  for (let x = k; x > i; x--) next.push(route[x]);
  next.push(...route.slice(k + 1));
  return next;
}

/**
 * Optimerer listen og returnerer ny rækkefølge + målinger så UI kan vise effekt.
 */
export function optimizeRouteWithStats<T extends ParsedAddress & { id: string }>(
  stops: T[],
  startIndex = 0,
): { ordered: T[]; stats: RouteOptimizeStats } {
  const beforeKm = straightLineRouteLengthKm(stops);
  const ordered = optimizeRouteNearestNeighbor(stops, startIndex);
  const afterKm = straightLineRouteLengthKm(ordered);
  return {
    ordered,
    stats: {
      beforeKm,
      afterKm,
      savedKm: beforeKm - afterKm,
      orderChanged: !sameOrder(stops, ordered),
    },
  };
}
