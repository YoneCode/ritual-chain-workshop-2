/**
 * Full market lifecycle against a local Hardhat node — no Ritual Chain access needed.
 *
 *   npx hardhat run scripts/local-demo.ts
 *
 * Ritual Chain's system contracts and precompiles are the mocks from
 * contracts/mocks/RitualMocks.sol, installed at their canonical addresses with
 * `setCode`. Everything else is the real contract doing the real thing: it books its
 * own resolution with the Scheduler, reads the oracle through the HTTP precompile,
 * parses the answer with jq, and pays out pari-mutuel.
 *
 * The one thing we have to stand in for is the block builder: on Ritual Chain it fires
 * scheduled executions itself, so here we call the mock Scheduler's `execute` at the
 * block the contract asked to be woken at.
 *
 * Environment (optional):
 *   BLOCK_TIME_MS   assumed block time passed to the constructor (default 195, the
 *                   value measured on Ritual Chain with scripts/block-time.ts)
 */
import { network } from "hardhat";
import {
  encodePacked,
  formatEther,
  keccak256,
  parseEther,
  parseEventLogs,
  stringToHex,
} from "viem";

import { RITUAL } from "./ritual.ts";
import { COMPARATOR, MARKET_STATE, OUTCOME } from "./market-presets.ts";

/** Ritual Chain ran ~195 ms per block when this was written. */
const BLOCK_TIME_MS = BigInt(process.env.BLOCK_TIME_MS ?? 195);

/** Short windows keep the demo to a few hundred mined blocks. */
const MARKET = {
  question: "Will ETH/USD be at least $4,000 when this market resolves?",
  oracleUrl: "https://oracle.local/api/eth",
  jsonPath: ".price",
  target: 4000n,
  comparator: COMPARATOR.gte,
  bettingSeconds: 60n,
  resolveDelaySeconds: 30n,
};

/** What the (mock) oracle will answer: 4123 >= 4000, so YES wins. */
const OBSERVED_PRICE = 4123;

const rule = (overrides: Partial<typeof MARKET> = {}) => ({ ...MARKET, ...overrides });
const eth = (wei: bigint) => `${formatEther(wei)} RITUAL`;
const heading = (title: string) => {
  console.log("");
  console.log(`── ${title} ${"─".repeat(Math.max(0, 56 - title.length))}`);
};
/** JSON.stringify cannot serialise the bigints viem decodes out of event args. */
const replacer = (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value;

const connection = await network.create();
const { viem, networkHelpers } = connection;
const publicClient = await viem.getPublicClient();
const testClient = await viem.getTestClient();
const [deployer, alice, bob, carol, teeA, teeB] = await viem.getWalletClients();

const receiptOf = async (tx: Promise<`0x${string}`>) =>
  publicClient.waitForTransactionReceipt({ hash: await tx });

async function mineTo(target: bigint, label: string) {
  const head = await publicClient.getBlockNumber();
  if (target > head) {
    await networkHelpers.mine(Number(target - head));
    console.log(`Mined ${target - head} blocks → block ${target} (${label})`);
  }
}

heading("Install the Ritual system contracts");

// Deploy each mock, then copy its runtime code onto the canonical address. Storage
// then lives at that address, exactly like real chain state.
for (const [name, target] of [
  ["MockScheduler", RITUAL.scheduler],
  ["MockRitualWallet", RITUAL.ritualWallet],
  ["MockTEEServiceRegistry", RITUAL.teeServiceRegistry],
  ["MockHttpPrecompile", RITUAL.httpPrecompile],
  ["MockJQPrecompile", RITUAL.jqPrecompile],
] as const) {
  const deployed = await viem.deployContract(name);
  const bytecode = await publicClient.getCode({ address: deployed.address });
  if (bytecode === undefined) throw new Error(`no runtime code for ${name}`);
  await testClient.setCode({ address: target, bytecode });
  console.log(`${name.padEnd(24)} → ${target}`);
}

const scheduler = await viem.getContractAt("MockScheduler", RITUAL.scheduler);
const wallet = await viem.getContractAt("MockRitualWallet", RITUAL.ritualWallet);
const registry = await viem.getContractAt(
  "MockTEEServiceRegistry",
  RITUAL.teeServiceRegistry,
);
const http = await viem.getContractAt("MockHttpPrecompile", RITUAL.httpPrecompile);
const jq = await viem.getContractAt("MockJQPrecompile", RITUAL.jqPrecompile);

for (const tee of [teeA, teeB]) {
  await registry.write.registerExecutor([tee.account.address]);
}
console.log(
  `HTTP executors indexed:  ${await registry.read.getIndexedServiceCountByCapability([0])}`,
);

heading("Deploy and prepay execution fees");

const predict = await viem.deployContract("RitualPredict", [BLOCK_TIME_MS]);
console.log(`RitualPredict:           ${predict.address}`);
console.log(`Assumed block time:      ${BLOCK_TIME_MS} ms`);

// Every scheduled execution — and the HTTP precompile call inside it — is paid from
// the contract's own RitualWallet balance, because the contract is the `payer` it
// hands to Scheduler.schedule().
await receiptOf(predict.write.fundExecution([500_000n], { value: parseEther("0.5") }));
console.log(`Execution balance:       ${eth(await predict.read.executionBalance())}`);
console.log(
  `Held by RitualWallet:    ${eth(await wallet.read.balanceOf([predict.address]))}`,
);

heading("Create the market");

const created = await receiptOf(predict.write.createMarket([rule()]));
const marketId = await predict.read.marketCount();
const market = await predict.read.getMarket([marketId]);

console.log(`Market #${marketId}:               "${market.question}"`);
console.log(`Rule:                    ${market.jsonPath} >= ${market.target}`);
console.log(`Oracle:                  ${market.oracleUrl}`);
console.log(`Created at block:        ${created.blockNumber}`);
console.log(
  `Betting closes:          block ${market.closeBlock} ` +
    `(+${market.closeBlock - created.blockNumber} blocks = ${MARKET.bettingSeconds}s)`,
);
console.log(
  `Scheduled resolve:       block ${market.resolveBlock} ` +
    `(+${market.resolveBlock - created.blockNumber} blocks)`,
);

// The whole point of the design: the market booked its own wake-ups when it was born.
const call = await scheduler.read.calls([market.scheduleId]);
console.log(
  `Scheduler call #${market.scheduleId}:       ${call[3]} executions from block ${call[2]}, ` +
    `${call[4]} blocks apart, ${call[1]} gas each`,
);
console.log(`Payer:                   ${call[9]} (the contract itself)`);
console.log(`State:                   ${MARKET_STATE[market.state]}`);

heading("Take bets");

const bets = [
  { who: "alice", client: alice, isYes: true, amount: parseEther("1") },
  { who: "carol", client: carol, isYes: true, amount: parseEther("1") },
  { who: "bob  ", client: bob, isYes: false, amount: parseEther("3") },
];

for (const { who, client, isYes, amount } of bets) {
  await receiptOf(
    predict.write.bet([marketId, isYes], { account: client.account, value: amount }),
  );
  console.log(`${who} bet ${eth(amount).padEnd(14)} on ${isYes ? "YES" : "NO "}`);
}

const betting = await predict.read.getMarket([marketId]);
console.log(
  `Pool:                    YES ${eth(betting.totalYes)} vs NO ${eth(betting.totalNo)}` +
    ` — ${eth(await publicClient.getBalance({ address: predict.address }))} held`,
);

heading("Betting window closes");

await mineTo(betting.closeBlock, "closeBlock");
console.log(
  `State:                   ${MARKET_STATE[(await predict.read.getMarket([marketId])).state]}` +
    " — no transaction was needed, the block number decided",
);

try {
  await predict.write.bet([marketId, true], {
    account: alice.account,
    value: parseEther("1"),
  });
  throw new Error("a late bet was accepted");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("BettingClosed")) throw error;
  console.log("Late bet:                reverted with BettingClosed()");
}

heading("Settle the oracle the executor will be asked to fetch");

// The contract picks its executor from the registry with a seed of
// keccak256(marketId, executionIndex) — deliberately not block-scoped, so the
// settlement replay of the scheduled transaction resolves to the same executor.
const [executor] = await registry.read.pickServiceByCapability([
  0, // CAPABILITY_HTTP_CALL
  true,
  BigInt(keccak256(encodePacked(["uint256", "uint256"], [marketId, 0n]))),
  await predict.read.EXECUTOR_PROBES(),
]);
console.log(`Executor for attempt 1:  ${executor}`);

const body = `{"price": ${OBSERVED_PRICE}}`;
const request = await http.read.encodeGetRequest([
  executor,
  await predict.read.HTTP_TTL_BLOCKS(),
  MARKET.oracleUrl,
]);
await http.write.settle([request, 200, stringToHex(body), ""]);
await jq.write.setValue([MARKET.jsonPath, body, BigInt(OBSERVED_PRICE)]);
console.log(`HTTP request bytes:      ${(request.length - 2) / 2} (13-field HTTPCallRequest)`);
console.log(`Oracle will answer:      200 ${body}`);

heading("The Scheduler wakes the contract");

await mineTo(market.resolveBlock, "resolveBlock");

// On Ritual Chain the block builder fires this. Locally we are the builder.
const fired = await receiptOf(scheduler.write.execute([market.scheduleId, 0n]));
for (const log of parseEventLogs({ abi: predict.abi, logs: fired.logs })) {
  console.log(`event ${log.eventName}${JSON.stringify(log.args, replacer)}`);
}

const resolved = await predict.read.getMarket([marketId]);
console.log(`Attempts used:           ${resolved.attempts} of ${await predict.read.MAX_ATTEMPTS()}`);
console.log(`Observed value:          ${resolved.observedValue}`);
console.log(`Outcome:                 ${OUTCOME[resolved.outcome]}`);
console.log(`State:                   ${MARKET_STATE[resolved.state]}`);
console.log(
  `Remaining executions:    cancelled (Scheduler call state ${await scheduler.read.getCallState([market.scheduleId])})`,
);

heading("Winners claim");

// Pari-mutuel and pull-based: stake * totalPool / winningPool, no loop over bettors.
for (const { who, client } of bets) {
  const [, , , claimable] = await predict.read.stakesOf([
    marketId,
    client.account.address,
  ]);
  if (claimable === 0n) {
    console.log(`${who} nothing to claim (backed the losing side)`);
    continue;
  }
  const before = await publicClient.getBalance({ address: client.account.address });
  const claim = await receiptOf(
    predict.write.claimWinnings([marketId], { account: client.account }),
  );
  const after = await publicClient.getBalance({ address: client.account.address });
  const gas = claim.gasUsed * claim.effectiveGasPrice;
  console.log(
    `${who} claimed ${eth(claimable).padEnd(14)} (balance +${eth(after - before)} after ${eth(gas)} gas)`,
  );
}

console.log(
  `Contract balance:        ${eth(await publicClient.getBalance({ address: predict.address }))} — the pool is empty to the wei`,
);

heading("A market the oracle never answers");

// Same contract, second market, pointed at an endpoint nothing ever settles: the HTTP
// precompile keeps returning the pre-fulfillment envelope, so every attempt fails the
// decode. A failed read is never interpreted as NO — once the booked attempts run out
// the market becomes refundable instead.
await receiptOf(
  predict.write.createMarket([
    rule({
      question: "Will the oracle answer?",
      oracleUrl: "https://oracle.local/api/unreachable",
    }),
  ]),
);
const brokenId = await predict.read.marketCount();
const broken = await predict.read.getMarket([brokenId]);
await receiptOf(
  predict.write.bet([brokenId, true], {
    account: alice.account,
    value: parseEther("1"),
  }),
);
console.log(`Market #${brokenId}:               alice staked ${eth(parseEther("1"))} on YES`);

await mineTo(broken.resolveBlock, "resolveBlock");
for (const index of [0n, 1n, 2n]) {
  const attempt = await receiptOf(scheduler.write.execute([broken.scheduleId, index]));
  const [failure] = parseEventLogs({
    abi: predict.abi,
    eventName: "ResolutionFailed",
    logs: attempt.logs,
  });
  const state = MARKET_STATE[(await predict.read.getMarket([brokenId])).state];
  console.log(
    `attempt ${index + 1n}:               ${JSON.stringify(failure?.args.reason)} → ${state}`,
  );
}

const invalid = await predict.read.getMarket([brokenId]);
console.log(`Outcome:                 ${OUTCOME[invalid.outcome]} (never guessed)`);
console.log(`Invalid reason:          "${invalid.invalidReason}"`);

const beforeRefund = await publicClient.getBalance({ address: alice.account.address });
const refund = await receiptOf(
  predict.write.claimRefund([brokenId], { account: alice.account }),
);
const afterRefund = await publicClient.getBalance({ address: alice.account.address });
console.log(
  `alice refunded ${eth(parseEther("1"))} (balance +${eth(afterRefund - beforeRefund)} after ${eth(refund.gasUsed * refund.effectiveGasPrice)} gas)`,
);

heading("Board, as a frontend would read it");

for (const m of await predict.read.getMarkets()) {
  console.log(
    `#${m.id}  ${MARKET_STATE[m.state].padEnd(9)} ${OUTCOME[m.outcome].padEnd(10)}` +
      ` pool ${eth(m.totalYes + m.totalNo).padEnd(14)} "${m.question}"`,
  );
}

console.log("");
console.log(`Ran locally on ${await publicClient.getBlockNumber()} blocks. Deployer: ${deployer.account.address}`);

await connection.close();
