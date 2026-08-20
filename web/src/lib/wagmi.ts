import type { Chain } from "viem";
import { cookieStorage, createConfig, createStorage, http, injected } from "wagmi";

import { activeChain, hardhat, ritual } from "./chains";

/**
 * Both chains are registered so a wallet pointed at either one still resolves, but the
 * chain NEXT_PUBLIC_CHAIN_ID selects goes first, which makes it the default every read
 * and write uses.
 */
const chains = (
  activeChain.id === ritual.id ? ([ritual, hardhat] as const) : ([hardhat, ritual] as const)
) satisfies readonly [Chain, ...Chain[]];

/**
 * One injected connector (MetaMask, Rabby, …) — no WalletConnect project id to sign up
 * for, so the app runs from a clean checkout.
 */
export const wagmiConfig = createConfig({
  chains,
  connectors: [injected()],
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
  transports: {
    [ritual.id]: http(),
    [hardhat.id]: http(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
