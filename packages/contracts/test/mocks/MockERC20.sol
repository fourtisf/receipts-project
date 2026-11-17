// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test token with configurable decimals, a freeze list (USDG-style blacklist) and a balanceOf kill switch.
contract MockERC20 is ERC20 {
    uint8 private immutable _dec;
    mapping(address => bool) public frozen;
    bool public balanceOfReverts;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _dec = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFrozen(address who, bool f) external {
        frozen[who] = f;
    }

    function setBalanceOfReverts(bool r) external {
        balanceOfReverts = r;
    }

    function balanceOf(address account) public view override returns (uint256) {
        require(!balanceOfReverts, "balanceOf disabled");
        return super.balanceOf(account);
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!frozen[from] && !frozen[to], "frozen");
        super._update(from, to, value);
    }
}
