# Proof of Building — Bootcamp 2, self-resolving prediction market

Fork of [cozfuttu/ritual-chain-workshop-2](https://github.com/cozfuttu/ritual-chain-workshop-2).
The starter's README describes the design; this file is what I did to it.

Ritual Chain testnet was down while I worked, so nothing is deployed. Everything below runs on a
local Hardhat node with the Ritual system contracts and precompiles installed at their canonical
addresses, and every number in this file came out of a command I ran.

## What the starter left unimplemented

Five functions in `hardhat/contracts/RitualPredict.sol` were `// we'll fill this up`, and the
`contracts/mocks/` directory the hardhat README promised did not exist, so the test suite could not
run at all (`test/Counter.ts` also referenced a `Counter` contract that isn't in the repo).

| Function | What it had to do |
| --- | --- |
| `createMarket` | validate the rule, convert human durations to block counts at the deployed `blockTimeMs`, and book its own resolution in the same transaction |
| `_scheduleResolution` | 3 executions 200 blocks apart, first landing on `resolveBlock`, contract as `payer`, `uint256` placeholder first in the callback data because the Scheduler overwrites calldata bytes 4–35 with the real `executionIndex` |
| `onScheduledResolve` | idempotent, authorisation the only revert, cancels the remaining executions once settled, refundable when the winning side is empty |
| `_readOracle` | the 13-field `HTTPCallRequest` to `0x0801`, envelope decode through an external `try`, then `0x0803` for the number |
| `_pickExecutor` | `keccak256(marketId, executionIndex)` as the seed — deliberately not block-scoped |

The one design decision I had to make myself: **a failed oracle read is never a NO.** A precompile
failure, a non-200, an executor error string, an undecodable envelope and an unparseable body are
all failures. Three of them and the market becomes `Invalid` and everyone refunds. Details and the
rest of the reasoning: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What I added

- **`contracts/mocks/RitualMocks.sol`** — the Scheduler, RitualWallet, TEEServiceRegistry and the
  `0x0801` / `0x0803` precompiles, etched at their canonical addresses so `RitualPredict` is
  unmodified and cannot tell it is being tested. The HTTP mock reproduces the short-running async
  contract: until a settlement is registered it returns an empty `actualOutput` envelope — the
  pre-fulfillment simulation the contract must reject — and settlements are keyed on the full
  request calldata, so a test settles the exact bytes the contract will send.
- **20 Solidity tests** (`contracts/RitualPredict.t.sol`) and **2 TypeScript end-to-end tests**
  (`test/RitualPredict.e2e.ts`). Mapping of rule to test: [docs/TEST_PLAN.md](docs/TEST_PLAN.md).
- **`scripts/local-demo.ts`** — the whole lifecycle narrated on a throwaway node, output captured
  in [hardhat/docs/local-run.md](hardhat/docs/local-run.md).
- **`scripts/local-seed.ts`** — the same thing against a persistent `hardhat node`, leaving three
  markets behind for the frontend.
- **`web/`** — a Next.js board: create, bet, watch the block-driven state flip, claim.
  See [web/README.md](web/README.md).
- **Config fixes** — `pnpm-workspace.yaml` to unblock install, `viaIR` in both solc profiles
  (ABI-encoding the 13-field HTTP request overflows the legacy pipeline's stack), the deployer key
  variable renamed to the `RITUAL_PRIVATE_KEY` that `.env.example` and both READMEs already used,
  and `allowImportingTsExtensions` so `tsc --noEmit` accepts the `.ts` import specifiers Node's
  type stripping requires.

## Verified locally

```
$ cd hardhat && pnpm exec hardhat build
Compiled 4 Solidity files with solc 0.8.28 (evm target: cancun)

$ pnpm exec tsc --noEmit
(clean)

$ pnpm exec hardhat test
22 passing (20 solidity, 2 nodejs)

$ cd ../web && pnpm typecheck && pnpm build
✓ Compiled successfully
```

The frontend was run against the seeded node and its own generated ABI reads the board back:

```
$ pnpm exec hardhat run scripts/local-seed.ts
RitualPredict deployed:  0xa513e6e4b8f2a923d98304ec87f64353c4d5c853
#3  Invalid   Unresolved pool 0.4 RITUAL     "Will an oracle nobody answers resolve this market?"
#2  Resolved  YES        pool 3 RITUAL       "Did the oracle report ETH/USD at $4,000 or more?"
#1  Open      Unresolved pool 1.6 RITUAL     "Will ETH/USD be at least $4,000 …"

blockTimeMs() = 1000
stakesOf(2, alice) = yes 1 / no 0 / settled false / claimable 3
```

Alice staked 1 on YES, Bob 2 on NO, YES won: `1 × 3 ÷ 1 = 3`. Pari-mutuel, computed by the
contract, not by the UI.

I did not click through the page in a browser — there is none in the environment I built this in.
What I verified is that the production build serves the page (HTTP 200, the shell rendered) and
that the exact reads the components make return the seeded board through the ABI the app ships.

## Run all of it

```bash
cd hardhat && pnpm install
pnpm exec hardhat build
pnpm exec hardhat test
pnpm exec hardhat run scripts/local-demo.ts    # narrated lifecycle, no node needed

pnpm exec hardhat node                         # terminal 1
pnpm exec hardhat run scripts/local-seed.ts    # terminal 2
cd ../web && pnpm install && cp .env.example .env.local && pnpm dev
```

Nothing needs the faucet or a funded key. To point it at the live chain instead, put a funded
`RITUAL_PRIVATE_KEY` in `hardhat/.env` and use `scripts/deploy.ts` — same contract, same call
sites, real precompiles.
