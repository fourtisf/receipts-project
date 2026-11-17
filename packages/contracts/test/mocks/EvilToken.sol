// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev A listed token that later misbehaves (e.g. an issuer-upgradeable stock token after a bad / malicious upgrade).
contract EvilToken is ERC20 {
    enum Mode {
        Normal,
        HugeBalance, // balanceOf returns an absurd number for everyone
        GasBomb // balanceOf burns all gas it is given (INVALID opcode)
    }

    Mode public mode;

    constructor() ERC20("Evil Stock", "EVIL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function balanceOf(address account) public view override returns (uint256) {
        if (mode == Mode.HugeBalance) return type(uint256).max / 2;
        if (mode == Mode.GasBomb) {
            assembly {
                invalid()
            }
        }
        return super.balanceOf(account);
    }
}

/// @dev Token whose decimals() can change after listing (to test the vault's own ≤ 36 check).
contract MutableDecimalsToken is ERC20 {
    uint8 public dec = 18;

    constructor() ERC20("Mutable", "MUT") {}

    function setDecimals(uint8 d) external {
        dec = d;
    }

    function decimals() public view override returns (uint8) {
        return dec;
    }
}
