"use client";

import { useState } from "react";
import type { Hex } from "viem";
import { useWaitForTransactionReceipt, useWriteContract } from "wagmi";

/**
 * One write plus the wait for its receipt. wagmi's `writeContractAsync` resolves as soon
 * as the wallet returns a hash, which is not the same thing as the state having changed —
 * every button in this app stays disabled until the receipt lands.
 *
 * `write` is handed back untouched rather than wrapped, so each call site keeps wagmi's
 * full ABI inference (a payable `bet` accepts `value`, a non-payable `claimWinnings`
 * does not). `send` only owns the hash and the receipt wait.
 */
export function useTx() {
  const [hash, setHash] = useState<Hex | undefined>(undefined);
  const { writeContractAsync, isPending, error, reset } = useWriteContract();
  const wait = useWaitForTransactionReceipt({ hash });

  async function send(build: () => Promise<Hex>) {
    reset();
    setHash(undefined);
    try {
      setHash(await build());
    } catch {
      // Rejected in the wallet or reverted on simulation — surfaced through `error`.
    }
  }

  return {
    write: writeContractAsync,
    send,
    hash,
    busy: isPending || (hash !== undefined && wait.isPending),
    confirmed: wait.isSuccess,
    error: error ?? wait.error ?? null,
  };
}

/** viem puts the useful one line in `shortMessage`; the full message is a wall. */
export function errorText(error: unknown) {
  if (!error) return null;
  const shortMessage = (error as { shortMessage?: unknown }).shortMessage;
  if (typeof shortMessage === "string") return shortMessage;
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}
