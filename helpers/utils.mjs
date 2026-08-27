// Shared utility helpers — sleep, fmtDate, hex.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function fmtDate(tsSec) {
  return new Date(Number(tsSec) * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export const hex = (n) => "0x" + n.toString(16);
