"use client";

import { useAccount, useReadContract } from "wagmi";

import { POLL_MS, predictContract } from "@/lib/contract";
import { MarketState, ritualAmount, type Market } from "@/lib/predict";
import { errorText, useTx } from "@/lib/use-tx";

/**
 * The caller's own position, read straight from `stakesOf`, which returns
 * (yes, no, settled, claimable) — the contract computes the pari-mutuel share, so the
 * UI never has to reproduce that arithmetic.
 */
export function Position({ market }: { market: Market }) {
  const { address, isConnected } = useAccount();
  const tx = useTx();

  const { data } = useReadContract({
    ...predictContract,
    functionName: "stakesOf",
    args: address ? [market.id, address] : undefined,
    query: { enabled: isConnected && Boolean(address), refetchInterval: POLL_MS },
  });

  if (!isConnected || !data) return null;

  const [yes, no, settled, claimable] = data as readonly [bigint, bigint, boolean, bigint];
  if (yes === 0n && no === 0n) return null;

  const resolved = market.state === MarketState.Resolved;
  const invalid = market.state === MarketState.Invalid;
  const refundable = invalid && !settled;

  return (
    <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
      <p className="meta" style={{ margin: 0 }}>
        Your stake: {ritualAmount(yes)} YES · {ritualAmount(no)} NO
        {settled && " · already settled"}
      </p>

      {resolved && !settled && claimable > 0n && (
        <div className="row" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="primary"
            disabled={tx.busy}
            onClick={() =>
              void tx.send(() =>
                tx.write({
                  ...predictContract,
                  functionName: "claimWinnings",
                  args: [market.id],
                }),
              )
            }
          >
            Claim {ritualAmount(claimable)}
          </button>
        </div>
      )}

      {resolved && !settled && claimable === 0n && (
        <p className="meta" style={{ marginTop: 8 }}>
          Nothing to claim — this stake backed the losing side.
        </p>
      )}

      {refundable && (
        <div className="row" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="primary"
            disabled={tx.busy}
            onClick={() =>
              void tx.send(() =>
                tx.write({
                  ...predictContract,
                  functionName: "claimRefund",
                  args: [market.id],
                }),
              )
            }
          >
            Refund {ritualAmount(yes + no)}
          </button>
        </div>
      )}

      {tx.busy && <p className="meta" style={{ marginTop: 8 }}>Waiting for the receipt…</p>}
      {tx.confirmed && <p className="meta" style={{ marginTop: 8 }}>Paid out.</p>}
      {tx.error && <p className="error">{errorText(tx.error)}</p>}
    </div>
  );
}
