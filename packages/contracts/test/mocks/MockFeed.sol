// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Chainlink-style feed with settable answer / timestamp / decimals and failure modes.
contract MockFeed {
    uint8 private _decimals;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId = 1;
    bool public reverts;
    bool public decimalsReverts;
    string public description = "MOCK / USD";

    constructor(uint8 decimals_, int256 answer_) {
        _decimals = decimals_;
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function set(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
        roundId++;
    }

    function setAnswer(int256 answer_) external {
        answer = answer_;
        updatedAt = block.timestamp;
        roundId++;
    }

    function setUpdatedAt(uint256 t) external {
        updatedAt = t;
    }

    function setDecimals(uint8 d) external {
        _decimals = d;
    }

    function setReverts(bool r) external {
        reverts = r;
    }

    function setDecimalsReverts(bool r) external {
        decimalsReverts = r;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!reverts, "feed down");
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }

    function decimals() external view returns (uint8) {
        require(!decimalsReverts, "decimals down");
        return _decimals;
    }
}
