import { formatEther } from "viem";

/** Mirrors RitualPredict.MarketState. */
export const MarketState = {
  Open: 0,
  Closed: 1,
  Resolving: 2,
  Resolved: 3,
  Invalid: 4,
} as const;

/** Mirrors RitualPredict.Comparator. */
export const Comparator = { GT: 0, GTE: 1, LT: 2, LTE: 3 } as const;

/** Mirrors RitualPredict.Outcome. */
export const Outcome = { Unresolved: 0, Yes: 1, No: 2 } as const;

export const stateLabel = ["Open", "Closed", "Resolving", "Resolved", "Invalid"] as const;
export const outcomeLabel = ["Unresolved", "YES", "NO"] as const;
export const comparatorLabel = [">", "≥", "<", "≤"] as const;

/** The struct `getMarket` / `getMarkets` return, as viem decodes it. */
export type Market = {
  id: bigint;
  creator: `0x${string}`;
  question: string;
  oracleUrl: string;
  jsonPath: string;
  target: bigint;
  comparator: number;
  closeBlock: bigint;
  resolveBlock: bigint;
  scheduleId: bigint;
  totalYes: bigint;
  totalNo: bigint;
  state: number;
  outcome: number;
  attempts: number;
  observedValue: bigint;
  invalidReason: string;
};

export const ritualAmount = (wei: bigint) => `${trimZeros(formatEther(wei))} RITUAL`;

function trimZeros(value: string) {
  if (!value.includes(".")) return value;
  return value.replace(/\.?0+$/, "");
}

/**
 * Deadlines on this contract are block numbers, never timestamps, so every countdown
 * in the UI is derived: blocks remaining x the blockTimeMs the contract was deployed
 * with. Nothing here reads block.timestamp either.
 */
export function blocksAway(target: bigint, head: bigint | undefined) {
  if (head === undefined) return undefined;
  return target > head ? target - head : 0n;
}

export function approxSeconds(blocks: bigint | undefined, blockTimeMs: bigint | undefined) {
  if (blocks === undefined || blockTimeMs === undefined) return undefined;
  return Number((blocks * blockTimeMs) / 1000n);
}

export function humanDuration(seconds: number | undefined) {
  if (seconds === undefined) return "—";
  if (seconds <= 0) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Pari-mutuel: a winning stake is paid stake x totalPool / winningPool. With nothing
 * on the winning side there is no denominator, which is exactly why the contract
 * invalidates that case instead of dividing.
 */
export function impliedMultiplier(totalYes: bigint, totalNo: bigint, isYes: boolean) {
  const pool = totalYes + totalNo;
  const side = isYes ? totalYes : totalNo;
  if (side === 0n || pool === 0n) return undefined;
  return Number((pool * 10000n) / side) / 10000;
}

export function sharePercent(totalYes: bigint, totalNo: bigint, isYes: boolean) {
  const pool = totalYes + totalNo;
  if (pool === 0n) return 50;
  const side = isYes ? totalYes : totalNo;
  return Number((side * 10000n) / pool) / 100;
}

export const ruleText = (m: Market) =>
  `${m.jsonPath} ${comparatorLabel[m.comparator] ?? "?"} ${m.target}`;
