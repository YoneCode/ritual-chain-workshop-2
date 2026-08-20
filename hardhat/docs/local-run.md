# Local run log

Captured output from real runs on a local Hardhat node — no Ritual Chain access, no funded
account. Reproduce each section with the command in its heading.

## `pnpm exec hardhat build`

```

Compiled 4 Solidity files with solc 0.8.28 (evm target: cancun)
```

## `pnpm exec tsc --noEmit`

```
(no output — clean)
```

## `pnpm exec hardhat test`

```
No contracts to compile

Running Solidity tests

  contracts/RitualPredict.t.sol:RitualPredictTest
    ✔ test_Resolve_ThreeFailuresInvalidateAndRefund()
    ✔ test_Resolve_RevertsForNonScheduler()
    ✔ test_Resolve_ProportionalMultiWinner()
    ✔ test_Resolve_OutOfRangeIndexIgnored()
    ✔ test_Resolve_Non200OrError_IsAFailureNotNo()
    ✔ test_Resolve_NoSide_NoWins()
    ✔ test_Resolve_IsIdempotent()
    ✔ test_Resolve_HappyPathYes_Payouts()
    ✔ test_Resolve_EmptyWinningSide_BecomesRefundable()
    ✔ test_GetMarkets_NewestFirst()
    ✔ test_FundExecution_DepositsIntoWallet()
    ✔ test_DecodeHttpResponse_RejectsEmptyActualOutput()
    ✔ test_CreateMarket_RejectsEmptyStrings()
    ✔ test_CreateMarket_RejectsBadDurations()
    ✔ test_CreateMarketBooksThreeCallsAtResolveBlock()
    ✔ test_ConstructorApprovesScheduler()
    ✔ test_Bet_RejectsZeroValue()
    ✔ test_Bet_RejectsUnknownMarket()
    ✔ test_Bet_RejectsAfterCloseAndViewFlipsToClosed()
    ✔ test_Bet_AcceptedAndPoolsTracked()

Running node:test tests

  RitualPredict — end to end on a local Hardhat node
    ✔ creates a market, takes bets, resolves itself from the oracle, and pays winners (1288ms)
    ✔ retries three times, invalidates when the oracle never answers, and refunds


22 passing (20 solidity, 2 nodejs)

```

## `pnpm exec hardhat run scripts/local-demo.ts`

```


── Install the Ritual system contracts ─────────────────────
MockScheduler            → 0x56e776BAE2DD60664b69Bd5F865F1180ffB7D58B
MockRitualWallet         → 0x532F0dF0896F353d8C3DD8cc134e8129DA2a3948
MockTEEServiceRegistry   → 0x9644e8562cE0Fe12b4deeC4163c064A8862Bf47F
MockHttpPrecompile       → 0x0000000000000000000000000000000000000801
MockJQPrecompile         → 0x0000000000000000000000000000000000000803
HTTP executors indexed:  2

── Deploy and prepay execution fees ────────────────────────
RitualPredict:           0xa513e6e4b8f2a923d98304ec87f64353c4d5c853
Assumed block time:      195 ms
Execution balance:       0.5 RITUAL
Held by RitualWallet:    0.5 RITUAL

── Create the market ───────────────────────────────────────
Market #1:               "Will ETH/USD be at least $4,000 when this market resolves?"
Rule:                    .price >= 4000
Oracle:                  https://oracle.local/api/eth
Created at block:        10
Betting closes:          block 317 (+307 blocks = 60s)
Scheduled resolve:       block 470 (+460 blocks)
Scheduler call #1:       3 executions from block 470, 200 blocks apart, 2000000 gas each
Payer:                   0xa513E6E4b8f2a923D98304ec87F64353C4D5C853 (the contract itself)
State:                   Open

── Take bets ───────────────────────────────────────────────
alice bet 1 RITUAL       on YES
carol bet 1 RITUAL       on YES
bob   bet 3 RITUAL       on NO 
Pool:                    YES 2 RITUAL vs NO 3 RITUAL — 5 RITUAL held

── Betting window closes ───────────────────────────────────
Mined 304 blocks → block 317 (closeBlock)
State:                   Closed — no transaction was needed, the block number decided
Late bet:                reverted with BettingClosed()

── Settle the oracle the executor will be asked to fetch ───
Executor for attempt 1:  0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc
HTTP request bytes:      672 (13-field HTTPCallRequest)
Oracle will answer:      200 {"price": 4123}

── The Scheduler wakes the contract ────────────────────────
Mined 151 blocks → block 470 (resolveBlock)
event ResolutionAttempted{"marketId":"1","attempt":1,"executor":"0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"}
event MarketResolved{"marketId":"1","outcome":1,"observedValue":"4123"}
Attempts used:           1 of 3
Observed value:          4123
Outcome:                 YES
State:                   Resolved
Remaining executions:    cancelled (Scheduler call state 3)

── Winners claim ───────────────────────────────────────────
alice claimed 2.5 RITUAL     (balance +2.499932735768340237 RITUAL after 0.000067264231659763 RITUAL gas)
carol claimed 2.5 RITUAL     (balance +2.499933116355901652 RITUAL after 0.000066883644098348 RITUAL gas)
bob   nothing to claim (backed the losing side)
Contract balance:        0 RITUAL — the pool is empty to the wei

── A market the oracle never answers ───────────────────────
Market #2:               alice staked 1 RITUAL on YES
Mined 459 blocks → block 934 (resolveBlock)
attempt 1:               "undecodable http envelope" → Resolving
attempt 2:               "undecodable http envelope" → Resolving
attempt 3:               "undecodable http envelope" → Invalid
Outcome:                 Unresolved (never guessed)
Invalid reason:          "undecodable http envelope"
alice refunded 1 RITUAL (balance +0.999937538308375338 RITUAL after 0.000062461691624662 RITUAL gas)

── Board, as a frontend would read it ──────────────────────
#2  Invalid   Unresolved pool 1 RITUAL       "Will the oracle answer?"
#1  Resolved  YES        pool 5 RITUAL       "Will ETH/USD be at least $4,000 when this market resolves?"

Ran locally on 938 blocks. Deployer: 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266
```
