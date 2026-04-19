import type { ParsedAddress } from "./addressParser";
import { cityBaseDisplay } from "./addressParser";

export type AddressIconKind = "door" | "frost" | "alert";

export type AddressIconFlags = {
  door: boolean;
  frost: boolean;
  alert: boolean;
};

export const DEFAULT_ADDRESS_ICON_FLAGS: AddressIconFlags = {
  door: false,
  frost: false,
  alert: false,
};

/** FNV-1a 64-bit → hex (kort, sikkert som Firestore-doc-id). */
function fnv1a64Hex(input: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i) & 0xff);
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/** Ét gemmenøgle pr. fysisk adresse (på tværs af ruter og stop-id). */
export function parsedAddressIconKey(address: ParsedAddress): string {
  const canonical = [
    address.street.trim().toLowerCase(),
    address.houseNumber.trim().toLowerCase(),
    address.zip.trim(),
    cityBaseDisplay(address.city).trim().toLowerCase(),
    (address.unit ?? "").trim().toLowerCase(),
  ].join("|");
  return fnv1a64Hex(canonical);
}

export function canonicalAddressLabel(address: ParsedAddress): string {
  return [
    address.street.trim(),
    address.houseNumber.trim(),
    address.zip.trim(),
    cityBaseDisplay(address.city).trim(),
    (address.unit ?? "").trim(),
  ]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 400);
}
