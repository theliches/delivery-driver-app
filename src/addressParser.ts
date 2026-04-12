/**
 * Udtrækker danske adresser fra rå tekst med regex.
 * Forventet mønster: [Gadenavn] [husnummer], [4-cifret postnr] [by]
 * Komma mellem husnummer og postnr kan udelades.
 *
 * Tekst deles først i bidder (linjer, semikolon, lodret streg), og hver bid
 * matches med ét regex — robust for typiske chauffør-lister.
 */

export interface ParsedAddress {
  street: string;
  houseNumber: string;
  zip: string;
  city: string;
  /** Den matchede tekstblok */
  raw: string;
}

/** Én linje / post: gade + nummer + postnr + by */
const LINE_ADDRESS_REGEX =
  /^(.+?)\s+(\d{1,4}[A-Za-z]?(?:\s*-\s*\d{1,4}[A-Za-z]?)?)\s*,?\s*(\d{4})\s+(.+)$/u;

/** Global søgning i fri tekst (flere adresser i samme streng) */
const INLINE_ADDRESS_REGEX =
  /([A-ZÆØÅa-zæøå][A-Za-zæøåÆØÅ0-9\s.'-]{2,80}?)\s+(\d{1,4}[A-Za-z]?(?:\s*-\s*\d{1,4}[A-Za-z]?)?)\s*,?\s*(\d{4})\s+([A-ZÆØÅa-zæøå][A-Za-zæøåÆØÅ0-9\s.'-]{2,60}?)(?=\s*(?:;|\||\n|\r|$))/gu;

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

function trimCity(name: string): string {
  return name.replace(/\s+/g, " ").replace(/[.,;:]+$/, "").trim();
}

function trimStreet(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

function pushUnique(
  results: ParsedAddress[],
  seen: Set<string>,
  street: string,
  houseNumber: string,
  zip: string,
  city: string,
  raw: string,
): void {
  const s = trimStreet(street);
  const h = houseNumber.replace(/\s*-\s*/g, "-").trim();
  const z = zip.trim();
  const c = trimCity(city);
  if (!s || !h || !/^\d{4}$/.test(z) || !c) return;
  if (seen.has(raw)) return;
  seen.add(raw);
  results.push({ street: s, houseNumber: h, zip: z, city: c, raw });
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
    .split(/(?:\n|\r|;|\|)+/)
    .map((c) => c.trim())
    .filter(Boolean);

  for (const chunk of chunks) {
    const chunkClean = stripLeadingEnumeration(chunk);
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
      pushUnique(results, seen, m[1], m[2], m[3], m[4], m[0].trim());
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
