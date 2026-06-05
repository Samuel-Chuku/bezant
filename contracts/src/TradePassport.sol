// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IPassport} from "./interfaces/IPassport.sol";

/// @notice Minimal credit passport. Completed trades floor the buyer's required
/// deposit through owner-tunable tiers — the passport is executable policy, not a
/// display widget. `recordTrade` is restricted to authorized writers (the escrow).
contract TradePassport is IPassport {
    address public owner;
    mapping(address => bool) public isWriter;

    mapping(address => uint32) public completed; // successful trades as buyer
    mapping(address => uint32) public failed;

    /// depositBps by completed-trade count; index >= length uses the last tier.
    /// Conservative progressive-trust curve — collateral only earns down over a
    /// long track record, with widening gaps; the 40% floor needs 30 clean trades.
    ///   0-2 -> 100%, 3-5 -> 90%, 6-10 -> 80%, 11-16 -> 70%, 17-22 -> 60%,
    ///   23-29 -> 50%, 30+ -> 40%.
    uint16[] public tiers;

    event WriterSet(address indexed writer, bool allowed);
    event TradeRecorded(address indexed buyer, address indexed seller, bool success);

    error NotOwner();
    error NotWriter();

    constructor() {
        owner = msg.sender;
        _pushN(10000, 3); // 0-2   100%
        _pushN(9000, 3); //  3-5    90%
        _pushN(8000, 5); //  6-10   80%
        _pushN(7000, 6); //  11-16  70%
        _pushN(6000, 6); //  17-22  60%
        _pushN(5000, 7); //  23-29  50%
        tiers.push(4000); // 30+    40% floor
    }

    function _pushN(uint16 v, uint256 n) private {
        for (uint256 i; i < n; ++i) tiers.push(v);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function setWriter(address w, bool ok) external onlyOwner {
        isWriter[w] = ok;
        emit WriterSet(w, ok);
    }

    function setTiers(uint16[] calldata t) external onlyOwner {
        delete tiers;
        for (uint256 i; i < t.length; ++i) tiers.push(t[i]);
    }

    function depositBps(address buyer) external view returns (uint16) {
        uint256 c = completed[buyer];
        uint256 n = tiers.length;
        return c >= n ? tiers[n - 1] : tiers[c];
    }

    function tier(address account) external view returns (uint8) {
        uint256 c = completed[account];
        return c > type(uint8).max ? type(uint8).max : uint8(c);
    }

    function recordTrade(address buyer, address seller, bool success) external {
        if (!isWriter[msg.sender]) revert NotWriter();
        if (success) completed[buyer] += 1;
        else failed[buyer] += 1;
        emit TradeRecorded(buyer, seller, success);
    }
}
