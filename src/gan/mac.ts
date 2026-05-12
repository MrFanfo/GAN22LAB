import type { MacSource } from "./types";

const MAC_RE = /^([0-9a-f]{2})[:\-]([0-9a-f]{2})[:\-]([0-9a-f]{2})[:\-]([0-9a-f]{2})[:\-]([0-9a-f]{2})[:\-]([0-9a-f]{2})$/i;
const MAC_COMPACT_RE = /^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

export function normalizeMac(input: string): string | null {
  if (!input || input.trim() === "") return null;
  const trimmed = input.trim();

  const colonOrDash = MAC_RE.exec(trimmed);
  if (colonOrDash) {
    return colonOrDash
      .slice(1)
      .map((b) => b.toUpperCase())
      .join(":");
  }

  const compact = MAC_COMPACT_RE.exec(trimmed);
  if (compact) {
    return compact
      .slice(1)
      .map((b) => b.toUpperCase())
      .join(":");
  }

  return null;
}

export function getMacSourceLabel(args: {
  manualMac: string | null;
  autoMac: string | null;
  preferManualMac: boolean;
}): MacSource {
  const { manualMac, autoMac, preferManualMac } = args;
  if (manualMac && preferManualMac) return "manual";
  if (autoMac) return "auto";
  if (manualMac) return "manual";
  return "missing";
}

export function chooseMac(args: {
  manualMac: string | null;
  autoMac: string | null;
  preferManualMac: boolean;
}): { mac: string | null; source: MacSource } {
  const { manualMac, autoMac, preferManualMac } = args;

  if (manualMac && preferManualMac) return { mac: manualMac, source: "manual" };
  if (autoMac) return { mac: autoMac, source: "auto" };
  if (manualMac) return { mac: manualMac, source: "manual" };
  return { mac: null, source: "missing" };
}
