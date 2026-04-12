import { formatAddressForNav, type ParsedAddress } from "./addressParser";

/** Samme nøgle til Firestore og hukommelsescache — ingen dubletter. */
export function normalizedGeocodeQuery(addr: ParsedAddress): string {
  return `${formatAddressForNav(addr)}, denmark`
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}
