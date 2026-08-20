# Architecture — how a market resolves itself

Everything here is about `hardhat/contracts/RitualPredict.sol`. The starter's
[hardhat/README.md](../hardhat/README.md) states the goal; this file is the reasoning behind the
implementation and the places where I had to choose.

## The resolution path, end to end

```
createMarket()                    ── same transaction ──►  Scheduler.schedule(3 calls, 200 apart)
   │                                                            │
   │ bets accepted until closeBlock                             │
   ▼                                                            ▼  at resolveBlock
getMarket() reports Closed                            onScheduledResolve(index, marketId)
(no transaction flips it — the view does)                       │
                                                                ├─► 0x0801 HTTP GET oracleUrl
                                                                ├─► 0x0803 jq jsonPath → uint256
                                                                ├─► compare against target
                                                                └─► Resolved | Resolving | Invalid
```

Two properties make this work without a keeper:

**Every deadline is a block number.** `bettingSeconds` / `resolveDelaySeconds` are converted once,
at creation, at the `blockTimeMs` the contract was deployed with. `block.timestamp` on Ritual Chain
is in milliseconds, which is a real trap, but the bigger reason is that the Scheduler triggers on
blocks. If betting closed on a timestamp and the wake-up arrived on a block, the two could disagree
and there would be a window where a bet lands after the oracle was read. With both on block numbers
that window cannot exist. `_secondsToBlocks` floors at 1 so a short window never collapses to "now".

**The market books its own resolution in the transaction that creates it.** There is no separate
"arm this market" call to forget, and the returned `scheduleId` is stored so the contract can cancel
the remaining attempts the moment it settles.

## Design decisions

### A failed oracle read is never a NO

This is the decision the starter leaves open, and it is load-bearing. "Could not read the price" and
"the price was below the target" are different facts. Collapsing them would let an oracle outage
silently pay out the NO side. So `_readOracle` returns a three-valued result and every one of these
is a *failure*, not an answer:

| Symptom | `reason` |
| --- | --- |
| the precompile call itself reverts | `http precompile call failed` |
| the envelope will not `abi.decode` | `undecodable http envelope` |
| `actualOutput` is empty (pre-fulfillment simulation) | `undecodable http envelope` |
| the executor set an error string | the executor's own message |
| HTTP status ≠ 200 | `non-200 response` |
| jq returned nothing usable | `jq parse failed` |

Three failures — `MAX_ATTEMPTS`, booked up front as the Scheduler's `numCalls` — and the market goes
`Invalid` with the last reason recorded on-chain, and everyone takes their stake back. Attempts 1 and
2 leave it in `Resolving` so the UI can say "retrying" rather than "broken".

### The callback reverts only on authorisation

`onScheduledResolve` reverts on `msg.sender != SCHEDULER` and nothing else. A revert anywhere else
would roll back `m.attempts = attempt` along with everything else in the execution, so a market whose
oracle reverts would burn its three scheduled calls without ever incrementing the counter and could
never reach `Invalid` — funds stuck forever. That is also why the envelope decode is an *external*
`try this.decodeHttpResponse(raw)`: malformed bytes must come back as a caught failure, not as a
revert of the scheduled transaction.

Everything else that could go wrong returns early instead: an out-of-range index, a market already
`Resolved`/`Invalid`, an attempt already counted, a wake-up before `resolveBlock`. The callback is
idempotent, which matters because the Scheduler replays an execution once its async HTTP request
settles.

### The executor seed is not block-scoped

`_pickExecutor` seeds `pickServiceByCapability` with `keccak256(marketId, executionIndex)` —
deliberately no `block.number`, `blockhash` or `block.timestamp`. A short-running async HTTP request
is simulated by the builder, fulfilled by one named TEE executor off-chain, and then the *same*
transaction is replayed with the output injected. If the seed moved between the simulation and the
replay, the replay would name a different executor than the commitment did and the settlement would
never match. Re-rolling per `executionIndex` still means one unhealthy TEE cannot sink a market: the
next attempt asks a different one.

### Pari-mutuel, pull-based, no loops

`stake × totalPool ÷ winningPool`, computed on demand in `_payout` and exposed through `stakesOf` so
the UI never does the arithmetic. Nothing iterates over participants, so no number of bettors can
make settlement run out of gas. The `settled` mapping is set before the transfer.

When the winning side is empty there is no denominator, so the outcome is recorded and the market is
made refundable instead — `MarketResolved` and `MarketInvalidated` both fire, which is intentional:
the oracle *did* answer, and that answer is worth keeping.

### Funding

Scheduled executions are paid by the contract itself (`payer = address(this)`), drawing on the
balance `fundExecution` deposits into `RitualWallet`. The constructor calls
`approveScheduler(SCHEDULER)` so the Scheduler may both call back and draw fees. Anyone can top the
contract up; nobody can withdraw it.

## Testing against the real system contracts

`contracts/mocks/RitualMocks.sol` implements the Scheduler, RitualWallet, TEEServiceRegistry and the
two precompiles, and the tests **etch** them at the canonical Ritual addresses. `RitualPredict` is
compiled and run exactly as it would be on chain — no test hooks, no injectable addresses, no
`if (testing)`. Etching copies runtime code only, not constructor-initialised storage, which is why
`MockScheduler` starts its call ids from a pre-incremented default rather than setting them in a
constructor.

The HTTP mock reproduces the part of the async contract that is easy to get wrong: until a
settlement is registered for a request it returns an envelope whose `actualOutput` is empty — the
pre-fulfillment simulation the contract must reject — and settlements are keyed on the full request
calldata, so a test has to settle the exact 13-field encoding the contract will send. A request the
contract never makes cannot be answered by accident.

One consequence worth knowing when reading the demo scripts: because the key is the request bytes
and those contain the URL but not the `marketId`, two markets pointing at the same URL share one
settlement. `scripts/local-seed.ts` gives its deliberately-unanswerable market its own URL for that
reason.

Rule-by-rule mapping to the 22 tests: [TEST_PLAN.md](TEST_PLAN.md).
