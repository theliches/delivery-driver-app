/**
 * Udtrækker danske adresser fra rå tekst med regex.
 * Understøtter fx "Gade 1, Herslev, 4000 Roskilde" og "Gade 200, Stue 12, 4070 Kirke Hyllinge"
 * (postnr + by til sidst; etage/stue/lokalitet i `unit`).
 *
 * Tekst deles i bidder (linjer, semikolon, lodret streg), og hver bid matches.
 */

export interface ParsedAddress {
  street: string;
  houseNumber: string;
  zip: string;
  city: string;
  /** Den matchede tekstblok */
  raw: string;
  /** Etage, stue, bolignr., lokalitet før postnr — med i navigationsadresse */
  unit?: string;
}

/** Klassisk én linje: gade + nummer + postnr + by (uden ekstra led mellem nummer og postnr). */
const LINE_ADDRESS_REGEX =
  /^(.+?)\s+(\d{1,4}(?:[A-Za-zæøåÆØÅ]+)?(?:\s*-\s*\d{1,4}(?:[A-Za-zæøåÆØÅ]+)?)?)\s*,?\s*(\d{4})\s+(.+)$/u;

/** Global søgning i fri tekst (flere adresser i samme streng) */
const INLINE_ADDRESS_REGEX =
  /([A-ZÆØÅa-zæøå][A-Za-zæøåÆØÅ0-9\s.'-]{2,80}?)\s+(\d{1,4}(?:[A-Za-zæøåÆØÅ]+)?(?:\s*-\s*\d{1,4}(?:[A-Za-zæøåÆØÅ]+)?)?(?:\s+[A-Za-zæøåÆØÅ]+(?:\s+[A-Za-zæøåÆØÅ]+){0,2})?)(?:\s*,\s*([^,]*?))?\s*,?\s*(\d{4})\s+([A-ZÆØÅa-zæøå][A-Za-zæøåÆØÅ0-9\s.'-]{2,60}?)(?=\s*(?:;|\||\n|\r|$))/gu;

/**
 * Fjerner foranstillet linjenummer så lister kan copy-pastes ind
 * (fx "12. Nørregade 1, 4000 Roskilde" eller "3) …").
 */
export function stripLeadingEnumeration(line: string): string {
  let s = line.trim();
  s = s.replace(/^\d{1,4}\s*[.):\-]\s+/u, "");
  s = s.replace(/^\d{1,4}\s*\u2013\s+/u, "");
  if (/^\d{1,3}\s+[A-ZÆØÅa-zæøå]/.test(s)) {
    s = s.replace(/^\d{1,3}\s+/, "");
  }
  return s.trim();
}

/** Linjer der typisk følger med fra copy/paste uden at være adresser. */
function isNoiseOrSeparatorLine(s: string): boolean {
  const t = s.trim();
  if (t.length === 0) return true;
  if (/^[-=*_#.\s•·▪─═_|\\/]{3,}$/u.test(t)) return true;
  if (
    /^(obs|note|notat|info|bemærk|afsender|modtager|kunde|ordre|pakkenr|pakke\s*nr|tracking|leverings|instruks|afhent|hentes)\s*:/iu.test(
      t,
    )
  ) {
    if (/\d{4}\s+[A-ZÆØÅa-zæøå]/u.test(t)) return false;
    return true;
  }
  return false;
}

/** Tabs, NBSP, bullets og bindestregs-punktopstillinger før adresse. */
function preprocessAddressChunk(chunk: string): string | null {
  let s = chunk.replace(/\t/g, " ").replace(/\u00a0/g, " ").trim();
  if (isNoiseOrSeparatorLine(s)) return null;
  s = stripLeadingEnumeration(s);
  s = s.replace(/^\s*[•·▪▸‣►]\s*/u, "");
  s = s.replace(/^\s*[-*–—]\s+(?=\S)/u, "");
  s = s.trim();
  if (!s || isNoiseOrSeparatorLine(s)) return null;
  return s;
}

function trimCity(name: string): string {
  return name.replace(/\s+/g, " ").replace(/[.,;:]+$/, "").trim();
}

function trimStreet(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

function splitTrailingZipHead(text: string): { head: string; zip: string; city: string } | null {
  const t = text.trim();
  const m = t.match(/^(.*?)\b(\d{4})\s+([A-ZÆØÅa-zæøå][^\n\r]*)$/u);
  if (!m) return null;
  const zip = m[2];
  if (!/^\d{4}$/.test(zip)) return null;
  const city = trimCity(m[3]);
  if (!city) return null;
  const head = m[1].replace(/[\s,]+$/u, "").trim();
  if (!head) return null;
  return { head, zip, city };
}

function parseHeadStreetHouseUnit(head: string): {
  street: string;
  houseNumber: string;
  unit: string;
} | null {
  const h = head.replace(/[\s,]+$/u, "").trim();
  const re =
    /^(.+?)\s+(\d{1,4}(?:[A-Za-zæøåÆØÅ]+)?(?:\s*-\s*\d{1,4}(?:[A-Za-zæøåÆØÅ]+)?)?(?:\s+[A-Za-zæøåÆØÅ]+(?:\s+[A-Za-zæøåÆØÅ]+){0,2})?)(?:\s*,\s*(.+))?$/u;
  const m = h.match(re);
  if (!m) return null;
  const street = trimStreet(m[1]);
  const houseNumber = m[2].replace(/\s+/g, " ").trim();
  const unit = m[3] ? m[3].replace(/\s+/g, " ").trim() : "";
  if (!street || !houseNumber) return null;
  return { street, houseNumber, unit };
}

function tryParseTrailingZipLine(chunk: string): ParsedAddress | null {
  const split = splitTrailingZipHead(chunk.trim());
  if (!split) return null;
  const parts = parseHeadStreetHouseUnit(split.head);
  if (!parts) return null;
  const { street, houseNumber, unit } = parts;
  const zip = split.zip;
  const city = split.city;
  if (!/^\d{4}$/.test(zip) || !city) return null;
  const raw = chunk.trim();
  const addr: ParsedAddress = { street, houseNumber, zip, city, raw };
  if (unit) addr.unit = unit;
  return addr;
}

function pushUnique(
  results: ParsedAddress[],
  seen: Set<string>,
  street: string,
  houseNumber: string,
  zip: string,
  city: string,
  raw: string,
  unit?: string,
): void {
  const s = trimStreet(street);
  const h = houseNumber.replace(/\s*-\s*/g, "-").trim();
  const z = zip.trim();
  const c = trimCity(city);
  if (!s || !h || !/^\d{4}$/.test(z) || !c) return;
  if (seen.has(raw)) return;
  seen.add(raw);
  const addr: ParsedAddress = { street: s, houseNumber: h, zip: z, city: c, raw };
  if (unit && unit.length > 0) addr.unit = unit;
  results.push(addr);
}

/** Nøgle til samme bygning (gade + husnr., uanset postnr./etage i data). */
export function buildingKey(a: ParsedAddress): string {
  const h = a.houseNumber.replace(/\s+/g, " ").trim().toLowerCase();
  return `${a.street.trim().toLowerCase()}|${h}`;
}

/**
 * Grupperer stop efter bygning, sorteret efter første forekomst i ruten.
 */
export function clusterStopsByBuildingForDisplay<T extends ParsedAddress>(
  stops: T[],
): { key: string; stops: T[]; minIndex: number }[] {
  const byKey = new Map<string, T[]>();
  for (const s of stops) {
    const k = buildingKey(s);
    const list = byKey.get(k) ?? [];
    list.push(s);
    byKey.set(k, list);
  }
  const out: { key: string; stops: T[]; minIndex: number }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i]!;
    const k = buildingKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ key: k, stops: byKey.get(k)!, minIndex: i });
  }
  return out;
}

/** Unikke postnr.+by (til overskrift ved grupperet liste). */
export function uniquePostalLabels(stops: ParsedAddress[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const s of stops) {
    const p = `${s.zip} ${cityBaseDisplay(s.city)}`;
    if (!seen.has(p)) {
      seen.add(p);
      parts.push(p);
    }
  }
  return parts.join(" · ");
}

/**
 * Finder alle adresser i teksten.
 */
export function parseDanishAddresses(text: string): ParsedAddress[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const seen = new Set<string>();
  const results: ParsedAddress[] = [];

  const chunks = normalized
    .split(/(?:\n\s*\n|\n|\r|;|\|)+/)
    .map((c) => c.trim())
    .filter(Boolean);

  for (const chunk of chunks) {
    const chunkClean = preprocessAddressChunk(chunk);
    if (chunkClean == null) continue;

    const trailing = tryParseTrailingZipLine(chunkClean);
    if (trailing) {
      pushUnique(
        results,
        seen,
        trailing.street,
        trailing.houseNumber,
        trailing.zip,
        trailing.city,
        chunkClean,
        trailing.unit,
      );
      continue;
    }

    const lineMatch = chunkClean.match(LINE_ADDRESS_REGEX);
    if (lineMatch) {
      pushUnique(
        results,
        seen,
        lineMatch[1],
        lineMatch[2],
        lineMatch[3],
        lineMatch[4],
        chunkClean,
      );
      continue;
    }

    const re = new RegExp(INLINE_ADDRESS_REGEX.source, INLINE_ADDRESS_REGEX.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(chunkClean)) !== null) {
      const u = (m[3] ?? "").trim();
      pushUnique(
        results,
        seen,
        m[1],
        m[2],
        m[4],
        m[5],
        m[0].trim(),
        u.length > 0 ? u : undefined,
      );
    }
  }

  return results;
}

/**
 * By til visning og gruppering: fjerner ekstra tekst (parentes, komma, tankestreg)
 * og almindelige danske postdistrikter (fx "Roskilde SV" → "Roskilde").
 */
export function cityBaseDisplay(city: string): string {
  let s = city.trim();
  s = s.split(/\(/)[0].trim();
  s = s.split(/,/)[0].trim();
  s = s.split(/\s*[–—]\s*/)[0].trim();
  s = s.split(/\s+-\s+/)[0].trim();
  s = s.replace(
    /\s+(C|SV|NV|NØ|SW|SY|Ø|K|N|S|V|TV|MV|ØST)$/iu,
    "",
  ).trim();
  return s;
}

export function formatAddressForNav(a: ParsedAddress): string {
  if (a.unit && a.unit.trim().length > 0) {
    return `${a.street} ${a.houseNumber}, ${a.unit.trim()}, ${a.zip} ${a.city}`;
  }
  return `${a.street} ${a.houseNumber}, ${a.zip} ${a.city}`;
}

/** Tekst klar til indsætning i feltet med numre pr. stop. */
export function formatStopsAsNumberedLines(
  addresses: ParsedAddress[],
): string {
  return addresses
    .map((a, i) => `${i + 1}. ${formatAddressForNav(a)}`)
    .join("\n");
}
