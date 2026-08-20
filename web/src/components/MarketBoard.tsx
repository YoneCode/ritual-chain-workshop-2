"use client";

import { useBlockNumber, useReadContract } from "wagmi";

import { isAddressConfigured } from "@/lib/chains";
import { POLL_MS, predictContract } from "@/lib/contract";
import type { Market } from "@/lib/predict";
import { errorText } from "@/lib/use-tx";

import { MarketCard } from "./MarketCard";

/**
 * `getMarkets()` returns every market newest-first in one call, so the board is one
 * read. It is polled rather than event-subscribed because two of the interesting
 * transitions — Open becoming Closed, and the Scheduler resolving a market — happen
 * without anyone sending a transaction from this app.
 */
export function MarketBoard() {
  const { data: head } = useBlockNumber({ query: { refetchInterval: POLL_MS } });

  const { data: blockTimeMs } = useReadContract({
    ...predictContract,
    functionName: "blockTimeMs",
    query: { enabled: isAddressConfigured },
  });

  const { data, error, isLoading } = useReadContract({
    ...predictContract,
    functionName: "getMarkets",
    query: { enabled: isAddressConfigured, refetchInterval: POLL_MS },
  });

  if (!isAddressConfigured) {
    return (
      <div className="notice">
        <strong>No contract address set.</strong> Deploy the contract, then put its address in{" "}
        <code>web/.env.local</code> as <code>NEXT_PUBLIC_PREDICT_ADDRESS</code> and restart{" "}
        <code>pnpm dev</code>.
      </div>
    );
  }

  if (error) {
    return (
      <div className="notice">
        <strong>Could not read the contract.</strong> {errorText(error)}
      </div>
    );
  }

  if (isLoading) return <p className="meta">Reading the board…</p>;

  const markets = (data ?? []) as readonly Market[];
  if (markets.length === 0) {
    return <p className="meta">No markets yet. Create the first one above.</p>;
  }

  return (
    <>
      {markets.map((market) => (
        <MarketCard
          key={market.id.toString()}
          market={market}
          head={head}
          blockTimeMs={blockTimeMs as bigint | undefined}
        />
      ))}
    </>
  );
}
