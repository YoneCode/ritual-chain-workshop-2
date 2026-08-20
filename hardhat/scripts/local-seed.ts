/**
 * Seed a running local node with markets in every interesting state, so the frontend
 * has something real to read.
 *
 *   pnpm exec hardhat node                       # terminal 1
 *   pnpm exec hardhat run scripts/local-seed.ts  # terminal 2
 *
 * Leaves behind:
 *   #1  Open      — long betting window, bets on both sides, bettable from the UI
 *   #2  Resolved  — oracle answered 4123, YES won, winnings claimable
 *   #3  Invalid   — oracle never answered, three attempts burned, stake refundable
 *
 * Prints the line to paste into web/.env.local.
 */
import { network } from "hardhat";
import {
  createTestClient,
  encodePacked,
  formatEther,
  http as viemHttp,
  keccak256,
  parseEther,
  stringToHex,
} from "viem";

import { RITUAL } from "./ritual.ts";
import { COMPARATOR, MARKET_STATE, OUTCOME } from "./market-presets.ts";

const RPC_URL = process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8545";

/** 1 s per block keeps the seconds-to-blocks arithmetic readable on a local node. */
const BLOCK_TIME_MS = 1000n;
const OBSERVED_PRICE = 4123;

const eth = (wei: bigint) => `${formatEther(wei)} RITUAL`;

const connection = await network.create({ network: "localhost", chainType: "l1" });
const { viem } = connection;
const publicClient = await viem.getPublicClient();
const [deployer, alice, bob, carol, teeA, teeB] = await viem.getWalletClients();

if (deployer === undefined) {
  throw new Error(`No accounts at ${RPC_URL}. Is \`pnpm exec hardhat node\` running?`);
}

/**
 * Built straight from viem rather than through hardhat-viem, which only hands out a
 * test client for in-process networks. `hardhat node` answers hardhat_* all the same.
 */
const testClient = createTestClient({ mode: "hardhat", transport: viemHttp(RPC_URL) });

const receiptOf = async (tx: Promise<`0x${string}`>) =>
  publicClient.waitForTransactionReceipt({ hash: await tx });

async function mineTo(target: bigint) {
  const head = await publicClient.getBlockNumber();
  if (target > head) await testClient.mine({ blocks: Number(target - head) });
}

// ── the Ritual system contracts, etched at their canonical addresses ──
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
}
console.log(`Ritual system contracts installed at their canonical addresses`);

const scheduler = await viem.getContractAt("MockScheduler", RITUAL.scheduler);
const registry = await viem.getContractAt("MockTEEServiceRegistry", RITUAL.teeServiceRegistry);
const http = await viem.getContractAt("MockHttpPrecompile", RITUAL.httpPrecompile);
const jq = await viem.getContractAt("MockJQPrecompile", RITUAL.jqPrecompile);

for (const tee of [teeA, teeB]) {
  if (tee) await receiptOf(registry.write.registerExecutor([tee.account.address]));
}

const predict = await viem.deployContract("RitualPredict", [BLOCK_TIME_MS]);
await receiptOf(predict.write.fundExecution([500_000n], { value: parseEther("0.5") }));
console.log(`RitualPredict deployed:  ${predict.address}`);
console.log(`Execution balance:       ${eth(await predict.read.executionBalance())}`);

const base = {
  oracleUrl: "https://oracle.local/api/eth",
  jsonPath: ".price",
  target: 4000n,
  comparator: COMPARATOR.gte,
  resolveDelaySeconds: 15n,
};

/** Settle the mock oracle for the exact request bytes attempt `index` will send. */
async function settleOracle(marketId: bigint, index: bigint, oracleUrl: string) {
  const [executor] = await registry.read.pickServiceByCapability([
    0,
    true,
    BigInt(keccak256(encodePacked(["uint256", "uint256"], [marketId, index]))),
    await predict.read.EXECUTOR_PROBES(),
  ]);
  const body = `{"price": ${OBSERVED_PRICE}}`;
  const request = await http.read.encodeGetRequest([
    executor,
    await predict.read.HTTP_TTL_BLOCKS(),
    oracleUrl,
  ]);
  await receiptOf(http.write.settle([request, 200, stringToHex(body), ""]));
  await receiptOf(jq.write.setValue([base.jsonPath, body, BigInt(OBSERVED_PRICE)]));
}

// ── #1 stays open: a one-hour betting window at 1 s per block ──
await receiptOf(
  predict.write.createMarket([
    {
      ...base,
      question: "Will ETH/USD be at least $4,000 when this market resolves?",
      bettingSeconds: 3600n,
    },
  ]),
);
const openId = await predict.read.marketCount();
for (const [who, isYes, amount] of [
  [alice, true, "1"],
  [bob, false, "0.6"],
] as const) {
  if (who) {
    await receiptOf(
      predict.write.bet([openId, isYes], { account: who.account, value: parseEther(amount) }),
    );
  }
}

// ── #2 resolves YES from the oracle ──
await receiptOf(
  predict.write.createMarket([
    { ...base, question: "Did the oracle report ETH/USD at $4,000 or more?", bettingSeconds: 30n },
  ]),
);
const resolvedId = await predict.read.marketCount();
if (alice) {
  await receiptOf(
    predict.write.bet([resolvedId, true], { account: alice.account, value: parseEther("1") }),
  );
}
if (bob) {
  await receiptOf(
    predict.write.bet([resolvedId, false], { account: bob.account, value: parseEther("2") }),
  );
}
const resolvedMarket = await predict.read.getMarket([resolvedId]);
await settleOracle(resolvedId, 0n, base.oracleUrl);
await mineTo(resolvedMarket.resolveBlock);
await receiptOf(scheduler.write.execute([resolvedMarket.scheduleId, 0n]));

// ── #3 never gets an answer: three attempts, then refunds ──
await receiptOf(
  predict.write.createMarket([
    {
      ...base,
      question: "Will an oracle nobody answers resolve this market?",
      oracleUrl: "https://oracle.local/api/unreachable",
      bettingSeconds: 30n,
    },
  ]),
);
const invalidId = await predict.read.marketCount();
if (carol) {
  await receiptOf(
    predict.write.bet([invalidId, true], { account: carol.account, value: parseEther("0.4") }),
  );
}
const invalidMarket = await predict.read.getMarket([invalidId]);
await mineTo(invalidMarket.resolveBlock);
for (const index of [0n, 1n, 2n]) {
  await receiptOf(scheduler.write.execute([invalidMarket.scheduleId, index]));
}

console.log("");
for (const m of await predict.read.getMarkets()) {
  console.log(
    `#${m.id}  ${MARKET_STATE[m.state]?.padEnd(9)} ${OUTCOME[m.outcome]?.padEnd(10)}` +
      ` pool ${eth(m.totalYes + m.totalNo).padEnd(14)} "${m.question}"`,
  );
}

console.log("");
console.log("Paste into web/.env.local:");
console.log(`  NEXT_PUBLIC_PREDICT_ADDRESS=${predict.address}`);
console.log(`  NEXT_PUBLIC_CHAIN_ID=31337`);
console.log("");
console.log(`Bettors seeded: alice ${alice?.account.address}, bob ${bob?.account.address}`);
console.log(`Head is at block ${await publicClient.getBlockNumber()}.`);

await connection.close();
