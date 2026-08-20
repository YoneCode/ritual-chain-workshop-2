"use client";

import { useState } from "react";
import { parseEther } from "viem";
import { useAccount } from "wagmi";

import { predictContract } from "@/lib/contract";
import { errorText, useTx } from "@/lib/use-tx";

/** Stake native RITUAL on one side. The contract holds it; nothing is minted. */
export function BetForm({ marketId }: { marketId: bigint }) {
  const { isConnected } = useAccount();
  const [amount, setAmount] = useState("0.1");
  const tx = useTx();

  function place(isYes: boolean) {
    let value: bigint;
    try {
      value = parseEther(amount.trim() || "0");
    } catch {
      return;
    }
    if (value <= 0n) return;
    void tx.send(() =>
      tx.write({
        ...predictContract,
        functionName: "bet",
        args: [marketId, isYes],
        value,
      }),
    );
  }

  const inputId = `stake-${marketId}`;

  return (
    <div style={{ marginTop: 14 }}>
      <div className="row">
        <div style={{ flex: "1 1 160px" }}>
          <label htmlFor={inputId}>Stake (RITUAL)</label>
          <input
            id={inputId}
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0.1"
          />
        </div>
        <button
          type="button"
          className="yes"
          disabled={!isConnected || tx.busy}
          onClick={() => place(true)}
        >
          Bet YES
        </button>
        <button
          type="button"
          className="no"
          disabled={!isConnected || tx.busy}
          onClick={() => place(false)}
        >
          Bet NO
        </button>
      </div>
      {!isConnected && <p className="meta" style={{ marginTop: 8 }}>Connect a wallet to bet.</p>}
      {tx.busy && <p className="meta" style={{ marginTop: 8 }}>Waiting for the receipt…</p>}
      {tx.confirmed && <p className="meta" style={{ marginTop: 8 }}>Bet confirmed.</p>}
      {tx.error && <p className="error">{errorText(tx.error)}</p>}
    </div>
  );
}
