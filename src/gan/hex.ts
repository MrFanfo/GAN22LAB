export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

export function dataViewToBytes(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

export function dataViewToHex(view: DataView): string {
  return bytesToHex(dataViewToBytes(view));
}

export function diffBytes(
  previous: Uint8Array | null,
  current: Uint8Array
): Array<{ index: number; previous: string | null; current: string }> {
  const maxLen = previous
    ? Math.max(previous.length, current.length)
    : current.length;

  const result: Array<{ index: number; previous: string | null; current: string }> = [];

  for (let i = 0; i < maxLen; i++) {
    const prevByte = previous && i < previous.length ? previous[i] : undefined;
    const currByte = i < current.length ? current[i] : undefined;

    if (previous === null) {
      result.push({
        index: i,
        previous: null,
        current: (currByte ?? 0).toString(16).padStart(2, "0"),
      });
    } else if (prevByte !== currByte) {
      result.push({
        index: i,
        previous: prevByte !== undefined ? prevByte.toString(16).padStart(2, "0") : null,
        current: (currByte ?? 0).toString(16).padStart(2, "0"),
      });
    }
  }

  return result;
}

export function tryDecodeUtf8(view: DataView): string | null {
  try {
    const bytes = dataViewToBytes(view);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // Reject if more than half the chars are non-printable
    const printable = text.split("").filter((c) => c.charCodeAt(0) >= 32).length;
    if (printable < text.length / 2) return null;
    return text;
  } catch {
    return null;
  }
}
