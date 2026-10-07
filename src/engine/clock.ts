/** Fixed simulation epoch. Every timestamp the simulator emits is this plus virtual milliseconds. */
export const EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

/**
 * A controllable clock. It only moves when the engine or a cooperating consumer advances it, so a timeline never
 * depends on wall-clock speed.
 */
export class VirtualClock {
  private ms = 0;
  now(): number {
    return this.ms;
  }
  advance(ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError("cannot move the clock backwards or by a non-finite amount");
    this.ms += Math.floor(ms);
    return this.ms;
  }
  iso(atMs = this.ms): string {
    return new Date(EPOCH_MS + atMs).toISOString().replace(".000Z", "Z");
  }
}

/** What a consumer needs from time: reading it and waiting. In-process consumers wait by advancing the virtual clock. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
