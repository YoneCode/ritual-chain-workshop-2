"use client";

import { useAccount, useBalance, useBlockNumber, useConnect, useDisconnect } from "wagmi";

import { activeChain, predictAddress } from "@/lib/chains";
import { POLL_MS } from "@/lib/contract";
import { ritualAmount } from "@/lib/predict";

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export function ConnectBar() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { data: head } = useBlockNumber({ query: { refetchInterval: POLL_MS } });
  const { data: balance } = useBalance({
    address,
    query: { enabled: isConnected, refetchInterval: POLL_MS },
  });

  const injected = connectors[0];
  const wrongChain = isConnected && chainId !== activeChain.id;

  return (
    <div className="chain">
      <div>
        {activeChain.name} · chain {activeChain.id} · block{" "}
        <span className="mono">{head?.toString() ?? "…"}</span>
      </div>
      <div className="mono" title={predictAddress}>
        {short(predictAddress)}
      </div>
      {isConnected && address ? (
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <span className="mono" title={address}>
            {short(address)} · {balance ? ritualAmount(balance.value) : "…"}
          </span>
          <button type="button" onClick={() => disconnect()}>
            Disconnect
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="primary"
          disabled={!injected || isPending}
          onClick={() => injected && connect({ connector: injected })}
        >
          {injected ? (isPending ? "Connecting…" : "Connect wallet") : "No wallet found"}
        </button>
      )}
      {wrongChain && (
        <span style={{ color: "var(--warn)" }}>
          Wallet is on chain {chainId} — switch to {activeChain.id}
        </span>
      )}
    </div>
  );
}
