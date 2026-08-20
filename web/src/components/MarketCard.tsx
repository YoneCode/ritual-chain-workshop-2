"use client";

import {
  MarketState,
  approxSeconds,
  blocksAway,
  humanDuration,
  impliedMultiplier,
  outcomeLabel,
  ritualAmount,
  ruleText,
  sharePercent,
  stateLabel,
  type Market,
} from "@/lib/predict";

import { BetForm } from "./BetForm";
import { Position } from "./Position";

type Props = { market: Market; head: bigint | undefined; blockTimeMs: bigint | undefined };

export function MarketCard({ market, head, blockTimeMs }: Props) {
  const label = stateLabel[market.state] ?? "Unknown";
  const pool = market.totalYes + market.totalNo;
  const yesPct = sharePercent(market.totalYes, market.totalNo, true);
  const yesX = impliedMultiplier(market.totalYes, market.totalNo, true);
  const noX = impliedMultiplier(market.totalYes, market.totalNo, false);

  const toClose = blocksAway(market.closeBlock, head);
  const toResolve = blocksAway(market.resolveBlock, head);

  return (
    <article className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>
          <span className="meta mono">#{market.id.toString()}</span> {market.question}
        </h2>
        <span className={`badge ${label.toLowerCase()}`}>{label}</span>
      </div>

      <p className="meta" style={{ margin: "6px 0 0" }}>
        Resolves YES when <code>{ruleText(market)}</code> from{" "}
        <span className="mono">{market.oracleUrl}</span>
      </p>

      <div className="bar" role="img" aria-label={`${yesPct.toFixed(1)}% of the pool is on YES`}>
        <span className="y" style={{ width: `${yesPct}%` }} />
        <span className="n" style={{ width: `${100 - yesPct}%` }} />
      </div>
      <p className="meta" style={{ margin: 0 }}>
        <span style={{ color: "var(--yes)" }}>YES {ritualAmount(market.totalYes)}</span>
        {yesX && ` (×${yesX.toFixed(2)})`} ·{" "}
        <span style={{ color: "var(--no)" }}>NO {ritualAmount(market.totalNo)}</span>
        {noX && ` (×${noX.toFixed(2)})`} · pool {ritualAmount(pool)}
      </p>

      <div style={{ marginTop: 12 }}>
        <div className="dt">
          <span>Betting closes</span>
          <span className="mono">
            block {market.closeBlock.toString()}
            {toClose !== undefined &&
              (toClose > 0n
                ? ` · ${toClose} blocks (~${humanDuration(approxSeconds(toClose, blockTimeMs))})`
                : " · passed")}
          </span>
        </div>
        <div className="dt">
          <span>Scheduled resolve</span>
          <span className="mono">
            block {market.resolveBlock.toString()}
            {toResolve !== undefined &&
              (toResolve > 0n
                ? ` · ${toResolve} blocks (~${humanDuration(approxSeconds(toResolve, blockTimeMs))})`
                : " · due")}
          </span>
        </div>
        <div className="dt">
          <span>Scheduler call</span>
          <span className="mono">
            #{market.scheduleId.toString()} · attempt {market.attempts} of 3
          </span>
        </div>
        {market.state === MarketState.Resolved && (
          <div className="dt">
            <span>Oracle said</span>
            <span className="mono">
              {market.observedValue.toString()} → {outcomeLabel[market.outcome]}
            </span>
          </div>
        )}
        {market.state === MarketState.Invalid && (
          <div className="dt">
            <span>Invalid</span>
            <span className="mono">{market.invalidReason || "—"}</span>
          </div>
        )}
      </div>

      {market.state === MarketState.Open && <BetForm marketId={market.id} />}
      {market.state === MarketState.Closed && (
        <p className="meta" style={{ marginTop: 12 }}>
          Betting is over. Nobody has to press anything — the Scheduler fires at block{" "}
          {market.resolveBlock.toString()} and the contract settles itself.
        </p>
      )}
      {market.state === MarketState.Resolving && (
        <p className="meta" style={{ marginTop: 12 }}>
          An attempt ran and the oracle read failed. {3 - market.attempts} retries left, 200
          blocks apart. A failed read is never counted as NO.
        </p>
      )}

      <Position market={market} />
    </article>
  );
}
