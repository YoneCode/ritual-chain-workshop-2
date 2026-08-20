// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RitualChain} from "../ritual/RitualChain.sol";

/**
 * Test-only stand-ins for the Ritual Chain system contracts and precompiles.
 *
 * Each mock is deployed and then its runtime code is etched onto the canonical
 * address from contracts/ritual/RitualChain.sol (vm.etch in Solidity tests,
 * `setCode` in the TypeScript tests). Storage therefore lives at the canonical
 * address, exactly like real chain state — but constructor-initialised storage is
 * NOT copied, so nothing here may depend on it.
 *
 * The HTTP mock emulates the short-running async contract: until a settlement is
 * registered for a request, it answers with an empty `actualOutput` envelope — the
 * pre-fulfillment simulation — which RitualPredict.decodeHttpResponse treats as a
 * failure. Once `settle()` has been called for that request it returns the settled
 * response instead.
 */
contract MockScheduler {
    // Pre-incremented rather than initialised to 1, because etching copies runtime
    // code only: constructor-set storage would be lost and ids would start at 0,
    // which is indistinguishable from "no schedule booked".
    uint256 public nextCallId;
    mapping(address => bool) public approved;

    struct Call {
        bytes data;
        uint32 gas;
        uint32 startBlock;
        uint32 numCalls;
        uint32 frequency;
        uint32 ttl;
        uint256 maxFeePerGas;
        uint256 maxPriorityFeePerGas;
        uint256 value;
        address payer;
        uint8 state; // 0 SCHEDULED, 1 EXECUTING, 2 COMPLETED, 3 CANCELLED
        uint32 executed;
    }

    mapping(uint256 => Call) public calls;

    event CallScheduled(
        uint256 indexed callId,
        address indexed payer,
        uint32 startBlock,
        uint32 numCalls,
        uint32 frequency
    );
    event CallCancelled(uint256 indexed callId);

    function approveScheduler(address schedulerContract) external {
        approved[schedulerContract] = true;
    }

    function schedule(
        bytes calldata data,
        uint32 gas,
        uint32 startBlock,
        uint32 numCalls,
        uint32 frequency,
        uint32 ttl,
        uint256 maxFeePerGas,
        uint256 maxPriorityFeePerGas,
        uint256 value,
        address payer
    ) external returns (uint256 callId) {
        callId = ++nextCallId;
        calls[callId] = Call(
            data,
            gas,
            startBlock,
            numCalls,
            frequency,
            ttl,
            maxFeePerGas,
            maxPriorityFeePerGas,
            value,
            payer,
            0,
            0
        );
        emit CallScheduled(callId, payer, startBlock, numCalls, frequency);
    }

    function cancel(uint256 callId) external {
        require(calls[callId].payer != address(0), "unknown call");
        calls[callId].state = 3;
        emit CallCancelled(callId);
    }

    function getCallState(uint256 callId) external view returns (uint8) {
        return calls[callId].state;
    }

    /// Test helper: fire one execution the way the real block builder does. The
    /// scheduled calldata is replayed with `executionIndex` injected into bytes 4-35,
    /// and the callback runs with msg.sender == this (canonical) address.
    function execute(uint256 callId, uint256 executionIndex) external {
        Call storage c = calls[callId];
        require(c.payer != address(0), "unknown call");

        c.state = 1; // EXECUTING
        _call(c.payer, c.value, _withExecutionIndex(c.data, executionIndex));

        c.executed++;
        // The callback may have cancelled the schedule itself (successful resolve);
        // don't clobber that terminal state.
        if (c.state != 3) c.state = c.executed >= c.numCalls ? 2 : 0;
    }

    function _call(address target, uint256 value, bytes memory data) internal {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) assembly {
            revert(add(ret, 0x20), mload(ret))
        }
    }

    /// The Scheduler writes the real executionIndex into calldata bytes 4-35; this
    /// reproduces that on the already-encoded data so the injected calldata stays
    /// byte-exact. Assembly-free to keep the EVM stack shallow on older pipelines.
    function _withExecutionIndex(
        bytes memory data,
        uint256 executionIndex
    ) internal pure returns (bytes memory) {
        bytes memory injected = new bytes(data.length);
        bytes memory index = abi.encode(executionIndex);
        for (uint256 i = 0; i < 4; i++) injected[i] = data[i];
        for (uint256 i = 0; i < 32; i++) injected[4 + i] = index[i];
        for (uint256 i = 36; i < data.length; i++) injected[i] = data[i];
        return injected;
    }
}

contract MockRitualWallet {
    struct Account {
        uint256 balance;
        uint256 lockUntil;
    }

    mapping(address => Account) private _accounts;

    event Deposit(address indexed account, uint256 amount, uint256 lockUntil);

    function deposit(uint256 lockDuration) external payable {
        require(msg.value > 0, "zero deposit");
        Account storage a = _accounts[msg.sender];
        a.balance += msg.value;
        a.lockUntil = block.number + lockDuration;
        emit Deposit(msg.sender, msg.value, a.lockUntil);
    }

    function balanceOf(address account) external view returns (uint256) {
        return _accounts[account].balance;
    }

    function lockUntil(address account) external view returns (uint256) {
        return _accounts[account].lockUntil;
    }
}

contract MockTEEServiceRegistry {
    address[] private _executors;

    event ExecutorRegistered(address indexed executor);

    function registerExecutor(address executor) external {
        for (uint256 i = 0; i < _executors.length; i++) {
            require(_executors[i] != executor, "already registered");
        }
        _executors.push(executor);
        emit ExecutorRegistered(executor);
    }

    function pickServiceByCapability(
        uint8,
        bool,
        uint256 seed,
        uint256 maxProbes
    ) external view returns (address, bool) {
        uint256 n = _executors.length;
        if (n == 0 || maxProbes == 0) return (address(0), false);
        uint256 probes = maxProbes < n ? maxProbes : n;
        uint256 start = seed % n;
        for (uint256 i = 0; i < probes; i++) {
            address e = _executors[(start + i) % n];
            if (e != address(0)) return (e, true);
        }
        return (address(0), false);
    }

    function getIndexedServiceCountByCapability(uint8) external view returns (uint256) {
        return _executors.length;
    }
}

contract MockHttpPrecompile {
    struct Settled {
        bool active;
        uint16 status;
        bytes body;
        string errorMessage;
    }

    // Keyed on the full request calldata the contract sends, which keeps this mock
    // free of ABI-decoding the 13-field request (that decode overflowed the legacy
    // solc pipeline's stack). `encodeGetRequest` reproduces that calldata exactly.
    mapping(bytes32 => Settled) private _settled;

    event RequestSeen(bytes32 indexed requestHash);

    /// Reproduce RitualPredict's HTTPCallRequest encoding for a GET so tests can
    /// settle the identical request bytes the contract will send.
    function encodeGetRequest(
        address executor,
        uint256 ttl,
        string calldata url
    ) external pure returns (bytes memory request) {
        request = abi.encode(
            executor,
            new bytes[](0), // encryptedSecrets
            ttl,
            new bytes[](0), // secretSignatures
            bytes(""), // userPublicKey
            url,
            uint8(RitualChain.HTTP_GET),
            new string[](0), // headerKeys
            new string[](0), // headerValues
            bytes(""), // body — GET
            uint256(0), // dkmsKeyIndex
            uint8(0), // dkmsKeyFormat
            false // piiEnabled
        );
    }

    function settle(
        bytes calldata request,
        uint16 status,
        bytes calldata body,
        string calldata errorMessage
    ) external {
        _settled[keccak256(request)] = Settled({
            active: true,
            status: status,
            body: body,
            errorMessage: errorMessage
        });
    }

    function isSettled(bytes calldata request) external view returns (bool) {
        return _settled[keccak256(request)].active;
    }

    /// ABI-compatible with the real precompile: the short-running async envelope
    /// `(bytes simmedInput, bytes actualOutput)`. Empty actualOutput until settled —
    /// that is the pre-fulfillment simulation RitualPredict rejects.
    fallback(bytes calldata input) external returns (bytes memory output) {
        bytes32 hash = keccak256(input);
        emit RequestSeen(hash);

        Settled storage s = _settled[hash];
        if (!s.active) {
            return abi.encode(bytes(""), bytes(""));
        }

        bytes memory actualOutput = abi.encode(
            s.status,
            new string[](0),
            new string[](0),
            s.body,
            s.errorMessage
        );
        return abi.encode(bytes(""), actualOutput);
    }
}

contract MockJQPrecompile {
    mapping(bytes32 => bool) private _known;
    mapping(bytes32 => uint256) private _value;

    function setValue(string calldata query, string calldata json, uint256 value) external {
        bytes32 h = keccak256(abi.encodePacked(query, json));
        _known[h] = true;
        _value[h] = value;
    }

    /// Output is ABI-decoded by RitualPredict._jqUint as a uint256; an unknown
    /// (query, json) returns 0-length bytes, which the contract treats as a failed
    /// extraction.
    fallback(bytes calldata input) external returns (bytes memory output) {
        // Called via staticcall by RitualPredict._jqUint. The fallback only reads
        // storage, so executing under STATIC context is fine; it just cannot be
        // declared `view` (Solidity disallows fallbacks that are view).
        (string memory query, string memory json, ) = abi.decode(input, (string, string, uint8));
        bytes32 h = keccak256(abi.encodePacked(query, json));
        if (_known[h]) return abi.encode(_value[h]);
        return bytes("");
    }
}