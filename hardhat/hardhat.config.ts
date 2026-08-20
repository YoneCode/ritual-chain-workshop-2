import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          // The precompile mocks ABI-encode/decode the 13-field HTTP call request.
          // The legacy pipeline runs out of stack on that encoding; via-IR solves
          // it without touching the ABI.
          viaIR: true,
        },
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    // A `pnpm exec hardhat node` on 8545. scripts/local-seed.ts uses this to leave
    // real state on a persistent chain for the frontend to read; accounts come from
    // the node itself.
    localhost: {
      type: "http",
      chainType: "l1",
      url: "http://127.0.0.1:8545",
    },
    // Ritual Chain testnet. Requires EIP-1559 (type-2) transactions; viem sends
    // those by default.
    ritual: {
      type: "http",
      chainType: "l1",
      chainId: 1979,
      url: process.env.RITUAL_RPC_URL ?? "https://rpc.ritualfoundation.org",
      accounts: [configVariable("RITUAL_PRIVATE_KEY")],
    },
  },
});
