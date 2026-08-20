# Test plan — rule to test

```
$ cd hardhat && pnpm exec hardhat test
22 passing   (20 solidity, 2 nodejs)
```

Two suites, because they answer different questions.

**`contracts/RitualPredict.t.sol`** — 20 `forge-std` unit tests. Cheatcodes make the awkward states
cheap: `vm.roll` to a `closeBlock`, `vm.etch` to put the Ritual system contracts at their canonical
addresses, `vm.prank` for a bettor, `vm.expectRevert` for a selector. This is where the failure
taxonomy is pinned down.

**`test/RitualPredict.e2e.ts`** — 2 tests through viem on a real `edr-simulated` node. No cheatcodes
beyond mining: every step is a transaction with a receipt, balances are checked in wei against
before/after, and the ABI encoding the frontend uses is exercised for real.

## Behaviour → test

| Rule under test | Test |
| --- | --- |
| the constructor authorises the Scheduler as payer | `test_ConstructorApprovesScheduler` |
| creation books 3 executions, `startBlock == resolveBlock`, 200 apart, TTL 150, contract as payer, market id in the callback data, `resolveBlock > closeBlock` | `test_CreateMarketBooksThreeCallsAtResolveBlock` |
| a window shorter than the minimum, a resolve delay shorter than the minimum, and a total over one day are all rejected | `test_CreateMarket_RejectsBadDurations` |
| empty question, URL or json path is rejected | `test_CreateMarket_RejectsEmptyStrings` |
| bets accumulate per account and per side | `test_Bet_AcceptedAndPoolsTracked` |
| a zero-value bet reverts | `test_Bet_RejectsZeroValue` |
| `getMarket` reports `Closed` at `closeBlock` with no transaction, and bets then revert | `test_Bet_RejectsAfterCloseAndViewFlipsToClosed` |
| betting on a market that does not exist reverts | `test_Bet_RejectsUnknownMarket` |
| oracle 4123 ≥ 4000 → YES, remaining executions cancelled, winner takes the pool, loser has nothing | `test_Resolve_HappyPathYes_Payouts` |
| oracle 3500 < 4000 → NO, and the NO side is paid | `test_Resolve_NoSide_NoWins` |
| the oracle answers but nobody backed the winner: outcome recorded, market refundable, no double refund | `test_Resolve_EmptyWinningSide_BecomesRefundable` |
| three unanswered attempts → `Invalid`, `attempts == 3`, outcome stays `Unresolved`, stakes refunded | `test_Resolve_ThreeFailuresInvalidateAndRefund` |
| **an executor error and an HTTP 500 are failures, not NO** — the market stays `Resolving` and a later healthy read still settles it | `test_Resolve_Non200OrError_IsAFailureNotNo` |
| replaying an execution does not double-count the attempt or re-settle the market, and a claim cannot be repeated | `test_Resolve_IsIdempotent` |
| anyone other than the Scheduler calling the callback reverts | `test_Resolve_RevertsForNonScheduler` |
| an execution index past `MAX_ATTEMPTS` is ignored rather than reverting | `test_Resolve_OutOfRangeIndexIgnored` |
| two winners split the pool by stake: `1 × 5 ÷ 2` each | `test_Resolve_ProportionalMultiWinner` |
| `fundExecution` lands in RitualWallet under the contract's address | `test_FundExecution_DepositsIntoWallet` |
| `getMarkets` returns newest first | `test_GetMarkets_NewestFirst` |
| the pre-fulfillment envelope (empty `actualOutput`) is rejected, and the rejection is catchable | `test_DecodeHttpResponse_RejectsEmptyActualOutput` |
| the whole happy lifecycle as transactions: create → bet both sides → close → scheduled wake-up reads the oracle → YES → winners' balances grow by the pari-mutuel amount | `e2e: creates a market, takes bets, resolves itself from the oracle, and pays winners` |
| the whole failure lifecycle: three wake-ups 200 blocks apart with no oracle answer → `Invalid` with the reason on-chain → every bettor refunded to the wei | `e2e: retries three times, invalidates when the oracle never answers, and refunds` |

## What is deliberately not covered

- **Live precompile behaviour.** The mocks reproduce the interface and the async envelope, not the
  TEE network. A live run is the only way to test that, and the testnet was down.
- **Fee accounting.** `MockRitualWallet` tracks deposits and balances; it does not debit realistic
  per-execution fees, so "does 0.5 RITUAL cover three attempts" is unanswered here.
- **Fuzzing.** The arithmetic that would benefit (`stake × pool ÷ winningPool`) is one expression
  over unsigned integers with the zero-denominator case handled explicitly and tested; the
  interesting bugs in this contract are in the state machine, which the unit tests walk directly.
