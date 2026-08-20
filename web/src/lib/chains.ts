import { defineChain } from "viem";

/**
 * Ritual Chain testnet. Not in viem's chain list, so it is defined here — the same
 * chain id, RPC and explorer the Hardhat config uses.
 */
export const ritual = defineChain({
  id: 1979,
  name: "Ritual Chain",
  nativeCurrency: { name: "Ritual", symbol: "RITUAL", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_RITUAL_RPC_URL ?? "https://rpc.ritualfoundation.org"],
    },
  },
  blockExplorers: {
    default: { name: "Ritual Explorer", url: "https://explorer.ritualfoundation.org" },
  },
  testnet: true,
});

/** The local Hardhat node, so the whole UI can be driven without the testnet. */
export const hardhat = defineChain({
  id: 31337,
  name: "Hardhat",
  nativeCurrency: { name: "Ritual", symbol: "RITUAL", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_LOCAL_RPC_URL ?? "http://127.0.0.1:8545"],
    },
  },
  testnet: true,
});

/** Which one the app talks to, from NEXT_PUBLIC_CHAIN_ID (default: the local node). */
export const activeChain =
  Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 31337) === ritual.id ? ritual : hardhat;

export const predictAddress = (process.env.NEXT_PUBLIC_PREDICT_ADDRESS ??
  "0x0000000000000000000000000000000000000000") as `0x${string}`;

export const isAddressConfigured =
  predictAddress !== "0x0000000000000000000000000000000000000000";
