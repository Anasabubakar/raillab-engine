import { EPOCH_MS } from "./clock.ts";
import { fromStroops, toStroops } from "./amount.ts";
import { rngFor } from "./prng.ts";
import { TERMINAL_STATUSES, type Scenario, type Sep24Status } from "./scenario.ts";

/** Synthetic anchor account: the all-zero Ed25519 key. No private key exists for it. */
export const SIM_ANCHOR_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export interface Step {
  atMs: number;
  status: Sep24Status;
  message?: string;
}

/** A SEP-24 withdrawal transaction record as returned by GET /transaction. */
export interface Sep24Transaction {
  id: string;
  kind: "withdrawal";
  status: Sep24Status;
  more_info_url: string;
  amount_in: string;
  amount_out: string;
  amount_fee: string;
  started_at: string;
  updated_at: string;
  completed_at?: string;
  stellar_transaction_id?: string;
  external_transaction_id?: string;
  withdraw_anchor_account?: string;
  withdraw_memo?: string;
  withdraw_memo_type?: "id";
  message?: string;
}

/**
 * The simulated anchor's view of one withdrawal. Transition times come from the scenario plus seeded jitter, so the
 * same scenario and seed always produce the same schedule. All identifiers are synthetic and say so.
 */
export class AnchorModel {
  readonly id: string;
  readonly schedule: Step[];
  private readonly stellarTx: string;
  private readonly bankRef: string;
  private readonly memo: string;

  private readonly scenario: Scenario;
  private readonly toIso: (ms: number) => string;

  constructor(scenario: Scenario, seed: number, toIso: (ms: number) => string) {
    this.scenario = scenario;
    this.toIso = toIso;
    const rng = rngFor(seed, "anchor");
    this.id = `sim-${rng.hex(12)}`;
    this.stellarTx = rng.hex(64);
    this.bankRef = `SIMBANK-${rng.hex(8).toUpperCase()}`;
    this.memo = String(rng.int(1_000_000, 9_999_999));
    const jr = rngFor(seed, "anchor-jitter");
    let prev = -1;
    this.schedule = scenario.anchor.timeline.map((e, i) => {
      const jitter = i === 0 || scenario.anchor.jitterMs === 0 ? 0 : jr.int(0, scenario.anchor.jitterMs);
      const at = Math.max(e.atMs + jitter, prev + 1);
      prev = at;
      return { atMs: i === 0 ? 0 : at, status: e.status, message: e.message };
    });
  }

  /** Index of the schedule entry in force at a virtual time. */
  indexAt(ms: number): number {
    let idx = 0;
    for (let i = 0; i < this.schedule.length; i++) if (this.schedule[i]!.atMs <= ms) idx = i;
    return idx;
  }

  rankOf(status: Sep24Status): number {
    return this.schedule.findIndex((s) => s.status === status);
  }

  isTerminal(status: Sep24Status): boolean {
    return TERMINAL_STATUSES.includes(status);
  }

  record(ms: number): Sep24Transaction {
    const idx = this.indexAt(ms);
    const step = this.schedule[idx]!;
    const amountIn = toStroops(this.scenario.anchor.amountIn);
    const fee = toStroops(this.scenario.anchor.fee);
    const out = amountIn > fee ? amountIn - fee : 0n;
    const reached = (s: Sep24Status) => {
      const r = this.rankOf(s);
      return r !== -1 && r <= idx;
    };
    const t: Sep24Transaction = {
      id: this.id,
      kind: "withdrawal",
      status: step.status,
      more_info_url: `https://sim.anchor.invalid/transaction/${this.id}`,
      amount_in: fromStroops(amountIn),
      amount_out: fromStroops(out),
      amount_fee: fromStroops(fee),
      started_at: this.toIso(0),
      updated_at: this.toIso(step.atMs),
    };
    if (step.status === "pending_user_transfer_start") {
      t.withdraw_anchor_account = SIM_ANCHOR_ACCOUNT;
      t.withdraw_memo = this.memo;
      t.withdraw_memo_type = "id";
    }
    if (reached("pending_stellar") || reached("pending_external") || reached("completed") || reached("pending_user_transfer_complete")) t.stellar_transaction_id = this.stellarTx;
    if (reached("pending_external") || reached("completed")) t.external_transaction_id = this.bankRef;
    if (step.status === "completed" || step.status === "refunded") t.completed_at = this.toIso(step.atMs);
    t.message = step.message ?? "SIMULATED: no real bank, funds or Stellar payment are involved.";
    return t;
  }

  /** Epoch-relative helper for tests. */
  static epochMs(): number {
    return EPOCH_MS;
  }
}
