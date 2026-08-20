# Ritual Predict — frontend

A Next.js board for the `RitualPredict` contract: create a market, stake on YES or NO, watch
the state flip at `closeBlock` with nobody sending a transaction, and pull your winnings.

Reads are polled every 2 s rather than event-subscribed, because the two most interesting
transitions happen without this app doing anything — `Open` becoming `Closed` is decided by the
block number alone, and resolution is the Ritual Scheduler calling the contract.

## Run it against a local node

Three terminals, no testnet and no faucet needed:

```bash
# 1 — a chain
cd hardhat && pnpm exec hardhat node

# 2 — deploy, install the Ritual mocks, seed three markets
cd hardhat && pnpm exec hardhat run scripts/local-seed.ts

# 3 — the app
cd web && pnpm install
cp .env.example .env.local          # paste the address the seed script printed
pnpm dev                            # http://localhost:3000
```

`scripts/local-seed.ts` leaves one market in each state worth looking at: **#1 Open** with bets on
both sides, **#2 Resolved** where the oracle answered 4123 and YES won (claimable), and **#3
Invalid** where the oracle never answered, all three attempts burned, and the stake is refundable.

Import one of the node's printed private keys into your wallet to bet as that account.

## Against Ritual Chain

```bash
NEXT_PUBLIC_CHAIN_ID=1979
NEXT_PUBLIC_PREDICT_ADDRESS=0x…    # from hardhat/scripts/deploy.ts
```

## Layout

```
src/app/       layout, the page, the wagmi + react-query providers
src/components ConnectBar, CreateMarket, MarketBoard, MarketCard, BetForm, Position
src/lib/
  chains.ts    Ritual Chain (1979) and the local node (31337) as viem chains
  wagmi.ts     one injected connector, no WalletConnect project id to sign up for
  predict.ts   the Market shape, the enums, and the block-based countdown helpers
  contract.ts  address + ABI in one place
  use-tx.ts    write, then wait for the receipt before re-enabling the button
  predict-abi.ts   generated — `cd hardhat && pnpm exec hardhat run scripts/export-abi.ts`
```

## Checks

```bash
pnpm typecheck     # tsc --noEmit
pnpm build         # next build
```
