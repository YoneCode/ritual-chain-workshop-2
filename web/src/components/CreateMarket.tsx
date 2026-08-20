"use client";

import { useState } from "react";
import { useAccount } from "wagmi";

import { predictContract } from "@/lib/contract";
import { Comparator, comparatorLabel } from "@/lib/predict";
import { errorText, useTx } from "@/lib/use-tx";

/**
 * `createMarket` takes human durations in seconds; the contract converts them to block
 * counts with the `blockTimeMs` it was deployed with and books its own three Scheduler
 * wake-ups in the same transaction. Minimums are the contract's own:
 * MIN_BETTING_SECONDS 30, MIN_RESOLVE_DELAY_SECONDS 15, MAX_MARKET_SECONDS 1 day.
 */
export function CreateMarket() {
  const { isConnected } = useAccount();
  const tx = useTx();
  const [form, setForm] = useState({
    question: "Will ETH/USD be at least $4,000 when this market resolves?",
    oracleUrl: "https://oracle.local/api/eth",
    jsonPath: ".price",
    target: "4000",
    comparator: String(Comparator.GTE),
    bettingSeconds: "300",
    resolveDelaySeconds: "60",
  });

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  function submit() {
    void tx.send(() =>
      tx.write({
        ...predictContract,
        functionName: "createMarket",
        args: [
          {
            question: form.question.trim(),
            oracleUrl: form.oracleUrl.trim(),
            jsonPath: form.jsonPath.trim(),
            target: BigInt(form.target || "0"),
            comparator: Number(form.comparator),
            bettingSeconds: BigInt(form.bettingSeconds || "0"),
            resolveDelaySeconds: BigInt(form.resolveDelaySeconds || "0"),
          },
        ],
      }),
    );
  }

  return (
    <details className="card">
      <summary style={{ cursor: "pointer" }}>
        Create a market <span className="meta">— it schedules its own resolution</span>
      </summary>

      <div style={{ marginTop: 14 }}>
        <label htmlFor="question">Question</label>
        <input
          id="question"
          value={form.question}
          onChange={(event) => set("question")(event.target.value)}
        />
      </div>

      <div className="grid" style={{ marginTop: 12 }}>
        <div>
          <label htmlFor="oracleUrl">Oracle URL (read in a TEE)</label>
          <input
            id="oracleUrl"
            value={form.oracleUrl}
            onChange={(event) => set("oracleUrl")(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="jsonPath">jq path</label>
          <input
            id="jsonPath"
            value={form.jsonPath}
            onChange={(event) => set("jsonPath")(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="comparator">Comparator</label>
          <select
            id="comparator"
            value={form.comparator}
            onChange={(event) => set("comparator")(event.target.value)}
          >
            {comparatorLabel.map((symbol, index) => (
              <option key={symbol} value={index}>
                observed {symbol} target
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="target">Target</label>
          <input
            id="target"
            inputMode="numeric"
            value={form.target}
            onChange={(event) => set("target")(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="bettingSeconds">Betting window (s, min 30)</label>
          <input
            id="bettingSeconds"
            inputMode="numeric"
            value={form.bettingSeconds}
            onChange={(event) => set("bettingSeconds")(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="resolveDelaySeconds">Resolve delay (s, min 15)</label>
          <input
            id="resolveDelaySeconds"
            inputMode="numeric"
            value={form.resolveDelaySeconds}
            onChange={(event) => set("resolveDelaySeconds")(event.target.value)}
          />
        </div>
      </div>

      <div className="row" style={{ marginTop: 14 }}>
        <button type="button" className="primary" disabled={!isConnected || tx.busy} onClick={submit}>
          {tx.busy ? "Creating…" : "Create market"}
        </button>
        {!isConnected && <span className="meta">Connect a wallet first.</span>}
        {tx.confirmed && <span className="meta">Created — it is on the board below.</span>}
      </div>
      {tx.error && <p className="error">{errorText(tx.error)}</p>}
    </details>
  );
}
