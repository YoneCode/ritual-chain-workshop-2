/**
 * End-to-end walkthroughs of the workshop flow, driven from TypeScript against an
 * in-process Hardhat node.
 *
 * The Ritual system contracts and precompiles are the mocks from
 * contracts/mocks/RitualMocks.sol, installed at their canonical addresses with
 * `setCode` — the TypeScript equivalent of the `vm.etch` the Solidity suite uses. The
 * whole lifecycle therefore runs locally: no network access, no funded account.
 *
 * The Solidity suite (contracts/RitualPredict.t.sol) covers the contract unit by
 * unit. This layer covers what only an outside observer sees: real transactions, real
 * gas, the event log a frontend would index, and the exact wei that lands in each
 * account.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  encodePacked,
  getAddress,
  keccak256,
  parseEther,
  parseEventLogs,
  stringToHex,
  type Address,
  type Hex,
} from "viem";

/** Canonical Ritual Chain addresses — mirrors contracts/ritual/RitualChain.sol. */
const RITUAL = {
  scheduler: "0x56e776BAE2DD60664b69Bd5F865F1180ffB7D58B",
  wallet: "0x532F0dF0896F353d8C3DD8cc134e8129DA2a3948",
  teeRegistry: "0x9644e8562cE0Fe12b4deeC4163c064A8862Bf47F",
  httpPrecompile: "0x0000000000000000000000000000000000000801",
  jqPrecompile: "0x0000000000000000000000000000000000000803",
} as const satisfies Record<string, Address>;

// RitualPredict's enums. viem decodes them as plain numbers, not bigints.
const State = { Open: 0, Closed: 1, Resolving: 2, Resolved: 3, Invalid: 4 };
const Outcome = { Unresolved: 0, Yes: 1, No: 2 };
const Comparator = { GT: 0, GTE: 1, LT: 2, LTE: 3 };
const CallState = { Scheduled: 0, Executing: 1, Completed: 2, Cancelled: 3 };

/** 1 s per block makes every window a round number of blocks. */
const BLOCK_TIME_MS = 1000n;

/** The preset market, same rule scripts/create-market.ts uses. */
const RULE = {
  question: "Will ETH/USD be at least $4,000 when this market resolves?",
  oracleUrl: "https://oracle.example/api/eth",
  jsonPath: ".price",
  target: 4000n,
  comparator: Comparator.GTE,
  bettingSeconds: 30n,
  resolveDelaySeconds: 15n,
};

/**
 * A fresh chain per scenario. Etched code keeps whatever storage it accumulates, and
 * these mocks are stateful, so a new connection is the cheapest way to guarantee that
 * nothing leaks from one scenario into the next.
 */
async function bootstrap() {
  const { viem, networkHelpers } = await network.create();
  const publicClient = await viem.getPublicClient();
  const testClient = await viem.getTestClient();
  const [deployer, alice, bob, carol, teeA, teeB] = await viem.getWalletClients();

  // Deploy each mock, then copy its runtime code onto the canonical address. Only
  // code moves, which is why the mocks never rely on constructor-set storage.
  for (const [name, target] of [
    ["MockScheduler", RITUAL.scheduler],
    ["MockRitualWallet", RITUAL.wallet],
    ["MockTEEServiceRegistry", RITUAL.teeRegistry],
    ["MockHttpPrecompile", RITUAL.httpPrecompile],
    ["MockJQPrecompile", RITUAL.jqPrecompile],
  ] as const) {
    const deployed = await viem.deployContract(name);
    const bytecode = await publicClient.getCode({ address: deployed.address });
    assert.ok(bytecode, `no runtime code for ${name}`);
    await testClient.setCode({ address: target, bytecode });
  }

  const scheduler = await viem.getContractAt("MockScheduler", RITUAL.scheduler);
  const wallet = await viem.getContractAt("MockRitualWallet", RITUAL.wallet);
  const registry = await viem.getContractAt(
    "MockTEEServiceRegistry",
    RITUAL.teeRegistry,
  );
  const http = await viem.getContractAt("MockHttpPrecompile", RITUAL.httpPrecompile);
  const jq = await viem.getContractAt("MockJQPrecompile", RITUAL.jqPrecompile);

  // Two attested executors, so the seeded registry pick is a real choice.
  for (const tee of [teeA, teeB]) {
    await registry.write.registerExecutor([tee.account.address]);
  }

  const predict = await viem.deployContract("RitualPredict", [BLOCK_TIME_MS]);

  /** Await a write and its receipt, so gas and logs are observable. */
  const receiptOf = async (tx: Promise<Hex>) =>
    publicClient.waitForTransactionReceipt({ hash: await tx });

  /** Mine forward until the chain head sits on `target`. */
  async function mineTo(target: bigint) {
    const head = await publicClient.getBlockNumber();
    if (target > head) await networkHelpers.mine(Number(target - head));
  }

  /**
   * The executor RitualPredict will name in its HTTP request for this attempt. The
   * seed is reproduced from the contract: keccak256(marketId, executionIndex), then
   * resolved through the registry itself rather than re-implementing the pick.
   */
  async function executorFor(marketId: bigint, executionIndex: bigint) {
    const seed = BigInt(
      keccak256(encodePacked(["uint256", "uint256"], [marketId, executionIndex])),
    );
    const [executor, found] = await registry.read.pickServiceByCapability([
      0, // CAPABILITY_HTTP_CALL
      true,
      seed,
      await predict.read.EXECUTOR_PROBES(),
    ]);
    assert.ok(found, "the registry has an executor to pick");
    return executor;
  }

  /** Register the oracle answer for the exact request bytes the contract will send. */
  async function settleOracle(
    marketId: bigint,
    executionIndex: bigint,
    price: number,
  ) {
    const body = `{"price": ${price}}`;
    const request = await http.read.encodeGetRequest([
      await executorFor(marketId, executionIndex),
      await predict.read.HTTP_TTL_BLOCKS(),
      RULE.oracleUrl,
    ]);
    await http.write.settle([request, 200, stringToHex(body), ""]);
    await jq.write.setValue([RULE.jsonPath, body, BigInt(price)]);
  }

  return {
    viem,
    publicClient,
    predict,
    scheduler,
    wallet,
    deployer,
    alice,
    bob,
    carol,
    receiptOf,
    mineTo,
    executorFor,
    settleOracle,
  };
}

describe("RitualPredict — end to end on a local Hardhat node", () => {
  it("creates a market, takes bets, resolves itself from the oracle, and pays winners", async () => {
    const {
      viem,
      publicClient,
      predict,
      scheduler,
      wallet,
      deployer,
      alice,
      bob,
      carol,
      receiptOf,
      mineTo,
      executorFor,
      settleOracle,
    } = await bootstrap();

    // ── fund ── prepay execution fees, the way scripts/deploy.ts does.
    await receiptOf(
      predict.write.fundExecution([500_000n], { value: parseEther("0.1") }),
    );
    assert.equal(await predict.read.executionBalance(), parseEther("0.1"));
    assert.equal(await wallet.read.balanceOf([predict.address]), parseEther("0.1"));
    // The fee prepayment left the contract; only stakes ever sit in its balance.
    assert.equal(await publicClient.getBalance({ address: predict.address }), 0n);

    // ── create ──
    const created = await receiptOf(predict.write.createMarket([RULE]));
    const [marketCreated] = parseEventLogs({
      abi: predict.abi,
      eventName: "MarketCreated",
      logs: created.logs,
    });
    const [ruleSet] = parseEventLogs({
      abi: predict.abi,
      eventName: "ResolutionRuleSet",
      logs: created.logs,
    });
    assert.ok(marketCreated, "MarketCreated emitted");
    assert.ok(ruleSet, "ResolutionRuleSet emitted");

    const marketId = await predict.read.marketCount();
    assert.equal(marketId, 1n);
    assert.equal(marketCreated.args.marketId, marketId);
    assert.equal(
      getAddress(marketCreated.args.creator),
      getAddress(deployer.account.address),
    );
    assert.equal(marketCreated.args.question, RULE.question);
    assert.equal(ruleSet.args.oracleUrl, RULE.oracleUrl);
    assert.equal(ruleSet.args.jsonPath, RULE.jsonPath);
    assert.equal(ruleSet.args.target, RULE.target);

    const market = await predict.read.getMarket([marketId]);
    assert.equal(market.state, State.Open);
    assert.equal(market.scheduleId, 1n);
    // 30 s of betting, then 15 s before the wake-up, at 1 s per block.
    assert.equal(market.closeBlock - created.blockNumber, 30n);
    assert.equal(market.resolveBlock - created.blockNumber, 45n);

    // The market booked its own resolution in the same transaction it was born.
    const call = await scheduler.read.calls([market.scheduleId]);
    assert.equal(call[2], Number(market.resolveBlock), "first attempt at resolveBlock");
    assert.equal(call[3], await predict.read.MAX_ATTEMPTS(), "one call per attempt");
    assert.equal(call[4], await predict.read.RETRY_INTERVAL_BLOCKS());
    assert.equal(getAddress(call[9]), getAddress(predict.address), "contract pays");
    assert.equal(
      await scheduler.read.getCallState([market.scheduleId]),
      CallState.Scheduled,
    );

    // ── bet ── two on YES, one bigger position on NO.
    await receiptOf(
      predict.write.bet([marketId, true], {
        account: alice.account,
        value: parseEther("1"),
      }),
    );
    await receiptOf(
      predict.write.bet([marketId, true], {
        account: carol.account,
        value: parseEther("1"),
      }),
    );
    const noBet = await receiptOf(
      predict.write.bet([marketId, false], {
        account: bob.account,
        value: parseEther("3"),
      }),
    );
    const [placed] = parseEventLogs({
      abi: predict.abi,
      eventName: "BetPlaced",
      logs: noBet.logs,
    });
    assert.ok(placed, "BetPlaced emitted");
    assert.equal(placed.args.isYes, false);
    assert.equal(placed.args.amount, parseEther("3"));

    const betting = await predict.read.getMarket([marketId]);
    assert.equal(betting.totalYes, parseEther("2"));
    assert.equal(betting.totalNo, parseEther("3"));
    assert.equal(
      await publicClient.getBalance({ address: predict.address }),
      parseEther("5"),
      "the pool is held by the contract",
    );

    // ── close ── no transaction flips Open → Closed; the block number does.
    await mineTo(betting.closeBlock);
    assert.equal((await predict.read.getMarket([marketId])).state, State.Closed);
    await viem.assertions.revertWithCustomError(
      predict.write.bet([marketId, true], {
        account: alice.account,
        value: parseEther("1"),
      }),
      predict,
      "BettingClosed",
    );

    // ── resolve ── .price reads 4123, which is >= 4000, so YES wins.
    await settleOracle(marketId, 0n, 4123);
    await mineTo(betting.resolveBlock);

    const fired = await receiptOf(scheduler.write.execute([market.scheduleId, 0n]));
    const [attempted] = parseEventLogs({
      abi: predict.abi,
      eventName: "ResolutionAttempted",
      logs: fired.logs,
    });
    const [resolvedEvent] = parseEventLogs({
      abi: predict.abi,
      eventName: "MarketResolved",
      logs: fired.logs,
    });
    assert.ok(attempted, "ResolutionAttempted emitted");
    assert.ok(resolvedEvent, "MarketResolved emitted");
    assert.equal(attempted.args.attempt, 1);
    assert.equal(
      getAddress(attempted.args.executor),
      getAddress(await executorFor(marketId, 0n)),
      "the request named the executor the registry picked",
    );
    assert.equal(resolvedEvent.args.outcome, Outcome.Yes);
    assert.equal(resolvedEvent.args.observedValue, 4123n);

    const resolved = await predict.read.getMarket([marketId]);
    assert.equal(resolved.state, State.Resolved);
    assert.equal(resolved.outcome, Outcome.Yes);
    assert.equal(resolved.observedValue, 4123n);
    assert.equal(resolved.attempts, 1, "settled on the first attempt");
    // Nothing is left to do, so the contract cancelled its own remaining wake-ups.
    assert.equal(
      await scheduler.read.getCallState([market.scheduleId]),
      CallState.Cancelled,
    );

    // ── claim ── pari-mutuel: stake * totalPool / winningPool = 1 * 5 / 2.
    const share = parseEther("2.5");
    const [yesStake, noStake, alreadySettled, claimable] = await predict.read.stakesOf([
      marketId,
      alice.account.address,
    ]);
    assert.equal(yesStake, parseEther("1"));
    assert.equal(noStake, 0n);
    assert.equal(alreadySettled, false);
    assert.equal(claimable, share);

    for (const winner of [alice, carol]) {
      const before = await publicClient.getBalance({
        address: winner.account.address,
      });
      const claim = await receiptOf(
        predict.write.claimWinnings([marketId], { account: winner.account }),
      );
      const after = await publicClient.getBalance({ address: winner.account.address });
      const gas = claim.gasUsed * claim.effectiveGasPrice;
      assert.equal(after - before, share - gas, "winner receives its exact share");
    }

    // The losing side has nothing to claim, and the pool is empty to the wei.
    await viem.assertions.revertWithCustomError(
      predict.write.claimWinnings([marketId], { account: bob.account }),
      predict,
      "NothingToClaim",
    );
    assert.equal(await publicClient.getBalance({ address: predict.address }), 0n);

    // getMarkets() is the call a frontend makes to render the board.
    const board = await predict.read.getMarkets();
    assert.equal(board.length, 1);
    assert.equal(board[0].id, marketId);
    assert.equal(board[0].state, State.Resolved);
    assert.equal(board[0].question, RULE.question);
  });

  it("retries three times, invalidates when the oracle never answers, and refunds", async () => {
    const { viem, publicClient, predict, scheduler, alice, receiptOf, mineTo } =
      await bootstrap();

    await receiptOf(predict.write.createMarket([RULE]));
    const marketId = await predict.read.marketCount();
    const market = await predict.read.getMarket([marketId]);
    await receiptOf(
      predict.write.bet([marketId, true], {
        account: alice.account,
        value: parseEther("1"),
      }),
    );

    await mineTo(market.resolveBlock);

    // Nothing is settled for this request, so the precompile keeps answering with the
    // pre-fulfillment envelope (empty actualOutput) and every decode fails.
    const first = await receiptOf(scheduler.write.execute([market.scheduleId, 0n]));
    const [failed] = parseEventLogs({
      abi: predict.abi,
      eventName: "ResolutionFailed",
      logs: first.logs,
    });
    assert.ok(failed, "ResolutionFailed emitted");
    assert.equal(failed.args.reason, "undecodable http envelope");

    const retrying = await predict.read.getMarket([marketId]);
    assert.equal(retrying.state, State.Resolving, "still has attempts booked");
    assert.equal(retrying.attempts, 1);

    await receiptOf(scheduler.write.execute([market.scheduleId, 1n]));
    await receiptOf(scheduler.write.execute([market.scheduleId, 2n]));

    const invalid = await predict.read.getMarket([marketId]);
    assert.equal(invalid.state, State.Invalid);
    assert.equal(invalid.attempts, await predict.read.MAX_ATTEMPTS());
    assert.equal(
      invalid.outcome,
      Outcome.Unresolved,
      "a failed read is never read as NO",
    );
    assert.equal(invalid.invalidReason, "undecodable http envelope");
    assert.equal(
      await scheduler.read.getCallState([market.scheduleId]),
      CallState.Completed,
      "all booked executions ran",
    );

    // Stakes come back untouched instead of being paid out to one side.
    const before = await publicClient.getBalance({ address: alice.account.address });
    const refund = await receiptOf(
      predict.write.claimRefund([marketId], { account: alice.account }),
    );
    const after = await publicClient.getBalance({ address: alice.account.address });
    assert.equal(
      after - before,
      parseEther("1") - refund.gasUsed * refund.effectiveGasPrice,
    );
    assert.equal(await publicClient.getBalance({ address: predict.address }), 0n);

    await viem.assertions.revertWithCustomError(
      predict.write.claimRefund([marketId], { account: alice.account }),
      predict,
      "AlreadySettled",
    );
  });
});
