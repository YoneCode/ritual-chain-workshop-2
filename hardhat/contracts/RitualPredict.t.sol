// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {RitualPredict} from "./RitualPredict.sol";
import {RitualChain} from "./ritual/RitualChain.sol";
import {
    MockScheduler,
    MockRitualWallet,
    MockTEEServiceRegistry,
    MockHttpPrecompile,
    MockJQPrecompile
} from "./mocks/RitualMocks.sol";

/**
 * Unit tests for RitualPredict. All Ritual system contracts are mocks `vm.etch`ed at
 * the canonical addresses, so the whole suite runs in the local EVM with no network
 * access or funded account.
 */
contract RitualPredictTest is Test {
    // 1 s per block keeps betting windows trivial to reason about (and roll).
    uint256 internal constant BLOCK_TIME_MS = 1000;

    RitualPredict internal predict;
    MockScheduler internal scheduler;
    MockRitualWallet internal wallet;
    MockTEEServiceRegistry internal registry;
    MockHttpPrecompile internal http;
    MockJQPrecompile internal jq;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal tee = makeAddr("tee");

    string internal constant QUESTION =
        "Will ETH/USD be at least $4,000 when this market resolves?";
    string internal constant ORACLE_URL = "https://oracle.example/api/eth";
    string internal constant JSON_PATH = ".price";

    RitualPredict.NewMarket internal rule;

    function setUp() public {
        // Deploy each mock, then etch its runtime code at the canonical address so
        // the contract's calls land on etched storage at exactly that address.
        scheduler = MockScheduler(_etch(address(new MockScheduler()), RitualChain.SCHEDULER));
        wallet =
            MockRitualWallet(_etch(address(new MockRitualWallet()), RitualChain.RITUAL_WALLET));
        registry = MockTEEServiceRegistry(
            _etch(address(new MockTEEServiceRegistry()), RitualChain.TEE_SERVICE_REGISTRY)
        );
        http = MockHttpPrecompile(_etch(address(new MockHttpPrecompile()), RitualChain.HTTP_PRECOMPILE));
        jq = MockJQPrecompile(_etch(address(new MockJQPrecompile()), RitualChain.JQ_PRECOMPILE));

        registry.registerExecutor(tee);

        predict = new RitualPredict(BLOCK_TIME_MS);

        rule = RitualPredict.NewMarket({
            question: QUESTION,
            oracleUrl: ORACLE_URL,
            jsonPath: JSON_PATH,
            target: 4000,
            comparator: RitualPredict.Comparator.GTE,
            bettingSeconds: 30,
            resolveDelaySeconds: 15
        });

        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    // ── deployment & scheduling ──────────────────────────────────────

    function test_ConstructorApprovesScheduler() public view {
        // In the constructor the contract calls approveScheduler(SCHEDULER): it
        // authorises the Scheduler to use this contract as payer for executions.
        assertTrue(MockScheduler(RitualChain.SCHEDULER).approved(RitualChain.SCHEDULER));
    }

    function test_CreateMarketBooksThreeCallsAtResolveBlock() public {
        uint256 marketId = _createMarket();
        RitualPredict.Market memory m = predict.getMarket(marketId);

        // The public struct getter returns a flat tuple of fields.
        (
            bytes memory callbackData,
            uint32 gasLimit,
            uint32 startBlock,
            uint32 numCalls,
            uint32 frequency,
            uint32 ttl,
            uint256 maxFeePerGas,
            ,
            ,
            address payer,
            ,
        ) = MockScheduler(RitualChain.SCHEDULER).calls(m.scheduleId);

        assertEq(startBlock, uint32(m.resolveBlock), "first attempt at resolveBlock");
        assertEq(numCalls, predict.MAX_ATTEMPTS(), "one execution per retry");
        assertEq(frequency, predict.RETRY_INTERVAL_BLOCKS(), "200 blocks apart");
        assertEq(ttl, predict.SCHEDULER_TTL_BLOCKS(), "ttl covers async settlement");
        assertEq(gasLimit, predict.RESOLVE_GAS_LIMIT(), "sized for one HTTP + one jq call");
        assertEq(payer, address(predict), "contract pays from its wallet");
        assertEq(maxFeePerGas, predict.MIN_MAX_FEE_PER_GAS(), "fee floor");

        // The callback data encodes the market id, with an executionIndex placeholder
        // as the first argument (the Scheduler overwrites bytes 4-35 at fire time).
        // Skip the 4-byte selector, then decode the two arguments.
        bytes memory args = new bytes(callbackData.length - 4);
        for (uint256 i = 0; i < args.length; i++) args[i] = callbackData[4 + i];
        (, uint256 encodedMarket) = abi.decode(args, (uint256, uint256));
        assertEq(encodedMarket, marketId, "callback targets the market");

        // resolveBlock is strictly after closeBlock, so betting is over when we wake.
        assertGt(m.resolveBlock, m.closeBlock);
    }

    function test_CreateMarket_RejectsBadDurations() public {
        rule.bettingSeconds = 1; // < MIN_BETTING_SECONDS
        vm.expectRevert(RitualPredict.BadDuration.selector);
        predict.createMarket(rule);

        rule.bettingSeconds = 30;
        rule.resolveDelaySeconds = 1; // < MIN_RESOLVE_DELAY_SECONDS
        vm.expectRevert(RitualPredict.BadDuration.selector);
        predict.createMarket(rule);

        // Individual durations are fine, but the total exceeds MAX_MARKET_SECONDS.
        rule.resolveDelaySeconds = 15;
        rule.bettingSeconds = 1 days;
        vm.expectRevert(RitualPredict.BadDuration.selector);
        predict.createMarket(rule);
    }

    function test_CreateMarket_RejectsEmptyStrings() public {
        rule.question = "";
        vm.expectRevert(RitualPredict.EmptyString.selector);
        predict.createMarket(rule);

        rule.question = QUESTION;
        rule.oracleUrl = "";
        vm.expectRevert(RitualPredict.EmptyString.selector);
        predict.createMarket(rule);

        rule.oracleUrl = ORACLE_URL;
        rule.jsonPath = "";
        vm.expectRevert(RitualPredict.EmptyString.selector);
        predict.createMarket(rule);
    }

    // ── betting ───────────────────────────────────────────────────────

    function test_Bet_AcceptedAndPoolsTracked() public {
        uint256 marketId = _createMarket();

        _bet(alice, marketId, true, 1 ether);
        _bet(bob, marketId, false, 2 ether);

        (uint256 yes, uint256 no, , ) = predict.stakesOf(marketId, alice);
        assertEq(yes, 1 ether);
        assertEq(no, 0);

        (uint256 yesB, uint256 noB, , ) = predict.stakesOf(marketId, bob);
        assertEq(yesB, 0);
        assertEq(noB, 2 ether);

        RitualPredict.Market memory m = predict.getMarket(marketId);
        assertEq(m.totalYes, 1 ether);
        assertEq(m.totalNo, 2 ether);
    }

    function test_Bet_RejectsZeroValue() public {
        uint256 marketId = _createMarket();
        vm.prank(alice);
        vm.expectRevert(RitualPredict.ZeroStake.selector);
        predict.bet(marketId, true);
    }

    function test_Bet_RejectsAfterCloseAndViewFlipsToClosed() public {
        uint256 marketId = _createMarket();
        RitualPredict.Market memory m = predict.getMarket(marketId);
        assertEq(uint8(m.state), uint8(RitualPredict.MarketState.Open));

        vm.roll(m.closeBlock);

        // The view flips Open → Closed without any state-changing transaction.
        m = predict.getMarket(marketId);
        assertEq(uint8(m.state), uint8(RitualPredict.MarketState.Closed));

        vm.prank(alice);
        vm.expectRevert(RitualPredict.BettingClosed.selector);
        predict.bet{value: 1 ether}(marketId, true);
    }

    function test_Bet_RejectsUnknownMarket() public {
        vm.prank(alice);
        vm.expectRevert(RitualPredict.UnknownMarket.selector);
        predict.bet(999, true);
    }

    // ── resolution ────────────────────────────────────────────────────

    function test_Resolve_HappyPathYes_Payouts() public {
        uint256 marketId = _createMarket();
        RitualPredict.Market memory m = predict.getMarket(marketId);

        _bet(alice, marketId, true, 1 ether);
        _bet(bob, marketId, false, 1 ether);

        // Oracle reads .price = 4123, which is >= 4000 → YES wins.
        _settleOracle(4123);

        _resolve(m.scheduleId, 0);

        m = predict.getMarket(marketId);
        assertEq(uint8(m.state), uint8(RitualPredict.MarketState.Resolved));
        assertEq(uint8(m.outcome), uint8(RitualPredict.Outcome.Yes));
        assertEq(m.observedValue, 4123);
        assertEq(m.attempts, 1);

        // Remaining executions are cancelled once the market settles.
        assertEq(
            uint8(MockScheduler(RitualChain.SCHEDULER).getCallState(m.scheduleId)),
            3 // CANCELLED
        );

        // Alice (YES) wins the whole pool: 1 in, 2 out.
        uint256 before = alice.balance;
        _claim(alice, marketId);
        assertEq(alice.balance - before, 2 ether);

        // The loser has nothing to claim.
        vm.prank(bob);
        vm.expectRevert(RitualPredict.NothingToClaim.selector);
        predict.claimWinnings(marketId);
    }

    function test_Resolve_NoSide_NoWins() public {
        uint256 marketId = _createMarket();
        RitualPredict.Market memory m = predict.getMarket(marketId);

        _bet(alice, marketId, true, 1 ether);
        _bet(bob, marketId, false, 1 ether);

        // Oracle reads 3500 < 4000 → NO wins.
        _settleOracle(3500);
        _resolve(m.scheduleId, 0);

        m = predict.getMarket(marketId);
        assertEq(uint8(m.state), uint8(RitualPredict.MarketState.Resolved));
        assertEq(uint8(m.outcome), uint8(RitualPredict.Outcome.No));
        assertEq(m.observedValue, 3500);

        uint256 before = bob.balance;
        _claim(bob, marketId);
        assertEq(bob.balance - before, 2 ether);

        vm.prank(alice);
        vm.expectRevert(RitualPredict.NothingToClaim.selector);
        predict.claimWinnings(marketId);
    }

    function test_Resolve_EmptyWinningSide_BecomesRefundable() public {
        uint256 marketId = _createMarket();
        RitualPredict.Market memory m = predict.getMarket(marketId);

        // Only NO is funded; the oracle resolves YES — nobody backed the winner.
        _bet(bob, marketId, false, 1 ether);
        _settleOracle(4123);
        _resolve(m.scheduleId, 0);

        m = predict.getMarket(marketId);
        assertEq(uint8(m.state), uint8(RitualPredict.MarketState.Invalid));
        assertEq(uint8(m.outcome), uint8(RitualPredict.Outcome.Yes), "outcome still recorded");
        assertEq(m.observedValue, 4123);
        assertEq(m.invalidReason, "nobody bet the winning side");

        // Bob gets his full stake back (1 in, 1 out).
        uint256 before = bob.balance;
        _claim(bob, marketId); // refund path
        assertEq(bob.balance - before, 1 ether);

        // An already-settled account cannot claim twice.
        vm.prank(bob);
        vm.expectRevert(RitualPredict.AlreadySettled.selector);
        predict.claimRefund(marketId);
    }

    function test_Resolve_ThreeFailuresInvalidateAndRefund() public {
        uint256 marketId = _createMarket();
        RitualPredict.Market memory m = predict.getMarket(marketId);
        _bet(alice, marketId, true, 1 ether);

        // No settlement is registered: the precompile answers the pre-fulfillment
        // envelope (empty actualOutput), which fails the decode.
        _resolve(m.scheduleId, 0);
        _resolve(m.scheduleId, 1);
        _resolve(m.scheduleId, 2);

        m = predict.getMarket(marketId);
        assertEq(uint8(m.state), uint8(RitualPredict.MarketState.Invalid));
        assertEq(m.attempts, 3);
        assertEq(uint8(m.outcome), uint8(RitualPredict.Outcome.Unresolved));

        uint256 before = alice.balance;
        _claim(alice, marketId);
        assertEq(alice.balance - before, 1 ether);
    }

    function test_Resolve_Non200OrError_IsAFailureNotNo() public {
        uint256 marketId = _createMarket();
        RitualPredict.Market memory m = predict.getMarket(marketId);
        _bet(bob, marketId, false, 1 ether);

        // Executor-side error message — attempt 1 fails, market keeps retrying.
        _settleHttp(200, bytes(""), "timeout");
        _resolve(m.scheduleId, 0);
        m = predict.getMarket(marketId);
        assertEq(uint8(m.state), uint8(RitualPredict.MarketState.Resolving));
        assertEq(m.attempts, 1);
        assertEq(uint8(m.outcome), uint8(RitualPredict.Outcome.Unresolved));

        // An HTTP 5xx is also just a failure, never a NO.
        _settleHttp(500, bytes(""), "");
        _resolve(m.scheduleId, 1);
        m = predict.getMarket(marketId);
        assertEq(m.attempts, 2);

        // A healthy read then settles the market.
        _settleOracle(3500);
        _resolve(m.scheduleId, 2);
        m = predict.getMarket(marketId);
        assertEq(uint8(m.state), uint8(RitualPredict.MarketState.Resolved));
        assertEq(uint8(m.outcome), uint8(RitualPredict.Outcome.No));
    }

    function test_Resolve_IsIdempotent() public {
        uint256 marketId = _createMarket();
        RitualPredict.Market memory m = predict.getMarket(marketId);
        _bet(alice, marketId, true, 1 ether);

        _settleOracle(4123);
        _resolve(m.scheduleId, 0);

        // A leftover execution of the same index does not touch the market.
        _resolve(m.scheduleId, 0);
        m = predict.getMarket(marketId);
        assertEq(uint8(m.state), uint8(RitualPredict.MarketState.Resolved));
        assertEq(m.attempts, 1);

        _claim(alice, marketId);
        vm.prank(alice);
        vm.expectRevert(RitualPredict.AlreadySettled.selector);
        predict.claimWinnings(marketId);
    }

    function test_Resolve_RevertsForNonScheduler() public {
        uint256 marketId = _createMarket();
        vm.prank(alice);
        vm.expectRevert(RitualPredict.OnlyScheduler.selector);
        predict.onScheduledResolve(0, marketId);
    }

    function test_Resolve_OutOfRangeIndexIgnored() public {
        uint256 marketId = _createMarket();
        RitualPredict.Market memory m = predict.getMarket(marketId);

        scheduler.execute(m.scheduleId, 99); // attempt 100 > MAX_ATTEMPTS
        m = predict.getMarket(marketId);
        assertEq(uint8(m.state), uint8(RitualPredict.MarketState.Open));
        assertEq(m.attempts, 0);
    }

    function test_Resolve_ProportionalMultiWinner() public {
        uint256 marketId = _createMarket();
        RitualPredict.Market memory m = predict.getMarket(marketId);

        _bet(alice, marketId, true, 1 ether);
        _bet(carol, marketId, true, 1 ether);
        _bet(bob, marketId, false, 3 ether);

        _settleOracle(4123);
        _resolve(m.scheduleId, 0);

        // Each YES winner gets stake * totalPool / winningPool = 1 * 5 / 2.
        uint256 beforeA = alice.balance;
        _claim(alice, marketId);
        assertEq(alice.balance - beforeA, 2.5 ether);

        uint256 beforeC = carol.balance;
        _claim(carol, marketId);
        assertEq(carol.balance - beforeC, 2.5 ether);
    }

    // ── funding ───────────────────────────────────────────────────────

    function test_FundExecution_DepositsIntoWallet() public {
        predict.fundExecution{value: 1 ether}(500_000);
        assertEq(predict.executionBalance(), 1 ether);
        assertEq(
            MockRitualWallet(RitualChain.RITUAL_WALLET).balanceOf(address(predict)),
            1 ether
        );
    }

    // ── views ─────────────────────────────────────────────────────────

    function test_GetMarkets_NewestFirst() public {
        uint256 first = _createMarket();
        uint256 second = _createMarket();
        RitualPredict.Market[] memory all = predict.getMarkets();
        assertEq(all.length, 2);
        assertEq(all[0].id, second);
        assertEq(all[1].id, first);
    }

    function test_DecodeHttpResponse_RejectsEmptyActualOutput() public view {
        // The pre-fulfillment envelope (empty actualOutput) is rejected, and the
        // rejection surfaces as a caught failure, not a revert of the caller.
        try predict.decodeHttpResponse(abi.encode(bytes(""), bytes(""))) {
            assertTrue(false, "expected decode to revert");
        } catch (bytes memory) {
            // expected
        }
    }

    // ── helpers ───────────────────────────────────────────────────────

    function _createMarket() internal returns (uint256 marketId) {
        predict.createMarket(rule);
        marketId = predict.marketCount();
    }

    function _bet(address account, uint256 marketId, bool isYes, uint256 amount) internal {
        vm.prank(account);
        predict.bet{value: amount}(marketId, isYes);
    }

    function _claim(address account, uint256 marketId) internal {
        // Read the state first — the view call would otherwise consume the prank.
        bool isInvalid =
            uint8(predict.getMarket(marketId).state) == uint8(RitualPredict.MarketState.Invalid);
        vm.prank(account);
        if (isInvalid) predict.claimRefund(marketId);
        else predict.claimWinnings(marketId);
    }

    function _settleOracle(uint256 observed) internal {
        string memory json = _priceJson(observed);
        _settleHttp(200, bytes(json), "");
        jq.setValue(JSON_PATH, json, observed);
    }

    function _settleHttp(uint16 status, bytes memory body, string memory errorMessage) internal {
        bytes memory request =
            http.encodeGetRequest(tee, predict.HTTP_TTL_BLOCKS(), ORACLE_URL);
        http.settle(request, status, body, errorMessage);
    }

    function _priceJson(uint256 observed) internal pure returns (string memory) {
        return string(abi.encodePacked("{\"price\": ", observed, "}"));
    }

    function _resolve(uint256 scheduleId, uint256 index) internal {
        vm.roll(predict.getMarket(predict.marketCount()).resolveBlock);
        scheduler.execute(scheduleId, index);
    }

    function _etch(address deployed, address target) internal returns (address) {
        vm.etch(target, deployed.code);
        return target;
    }
}