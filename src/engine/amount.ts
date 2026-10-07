const STROOPS = 10_000_000n;

/** Parse a decimal with up to 7 fractional digits into stroops. */
export function toStroops(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(s);
  if (!m) throw new RangeError(`invalid amount ${JSON.stringify(s)}`);
  return BigInt(m[1]!) * STROOPS + BigInt((m[2] ?? "").padEnd(7, "0"));
}

export function fromStroops(v: bigint): string {
  if (v < 0n) throw new RangeError("negative amount");
  return `${v / STROOPS}.${String(v % STROOPS).padStart(7, "0")}`;
}
