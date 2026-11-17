// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapRouter02} from "../../src/interfaces/IExternal.sol";
import {MockFeed} from "./MockFeed.sol";
import {MockERC20} from "./MockERC20.sol";

interface IVaultLike {
    function withdraw(address token, uint256 amount, address to) external;
    function executeSignal(uint64 nonce, address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        external
        returns (uint256);
    function settleFees() external;
    function checkBreaker() external returns (bool);
}

/// @dev Uniswap-like router priced off mock feeds. `mode` simulates honest and malicious routers.
contract MockRouter is ISwapRouter02 {
    enum Mode {
        Honest, // fills at oracle price minus `feeBps + slipBps`, enforces amountOutMinimum like Uniswap
        UnderDeliver, // sends `underDeliverBps` of the fair amount, ignores the minimum, reports the minimum
        FakeReport, // sends nothing, reports a huge amount
        OverPull, // tries to pull more than amountIn
        Reenter, // tries to re-enter the vault during the swap
        SendElsewhere, // sends the output to another address
        KeepAllowance // pulls less than amountIn (leaves allowance) — vault must reset it to 0
    }

    Mode public mode;
    uint256 public feeBps = 30;
    uint256 public slipBps;
    uint256 public underDeliverBps = 5000;
    address public elsewhere = address(0xBEEF);
    bytes public lastReentryError;
    bool public reentrySucceeded;

    mapping(address => MockFeed) public feedOf;
    mapping(address => uint24) public tierOf;
    uint24 public lastFee;

    function setFeed(address token, MockFeed feed) external {
        feedOf[token] = feed;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function setFeeBps(uint256 b) external {
        feeBps = b;
    }

    function setSlipBps(uint256 b) external {
        slipBps = b;
    }

    function setUnderDeliverBps(uint256 b) external {
        underDeliverBps = b;
    }

    function fairOut(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        (, int256 pin,,,) = feedOf[tokenIn].latestRoundData();
        (, int256 pout,,,) = feedOf[tokenOut].latestRoundData();
        uint256 din = MockERC20(tokenIn).decimals();
        uint256 dout = MockERC20(tokenOut).decimals();
        uint256 fdIn = feedOf[tokenIn].decimals();
        uint256 fdOut = feedOf[tokenOut].decimals();
        // value = amountIn * pin / 10^(din + fdIn); out = value * 10^(dout + fdOut) / pout
        uint256 num = amountIn * uint256(pin) * (10 ** (dout + fdOut));
        uint256 den = uint256(pout) * (10 ** (din + fdIn));
        return num / den;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut) {
        lastFee = p.fee;
        uint256 fair = fairOut(p.tokenIn, p.tokenOut, p.amountIn);
        uint256 out = (fair * (10_000 - feeBps - slipBps)) / 10_000;

        if (mode == Mode.OverPull) {
            IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn + 1);
        } else if (mode == Mode.KeepAllowance) {
            IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn / 2);
        } else {
            IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        }

        if (mode == Mode.Reenter) {
            _tryReenter(msg.sender, p);
        }

        if (mode == Mode.UnderDeliver) {
            uint256 sent = (fair * underDeliverBps) / 10_000;
            MockERC20(p.tokenOut).mint(p.recipient, sent);
            return p.amountOutMinimum; // lies
        }
        if (mode == Mode.FakeReport) {
            return type(uint256).max; // lies, sends nothing
        }
        if (mode == Mode.SendElsewhere) {
            MockERC20(p.tokenOut).mint(elsewhere, out);
            return out;
        }
        require(out >= p.amountOutMinimum, "Too little received");
        MockERC20(p.tokenOut).mint(p.recipient, out);
        return out;
    }

    function _tryReenter(address vault, ExactInputSingleParams calldata p) internal {
        (bool ok1, bytes memory e1) = vault.call(abi.encodeCall(IVaultLike.withdraw, (p.tokenIn, 1, address(this))));
        (bool ok2,) = vault.call(abi.encodeCall(IVaultLike.executeSignal, (0, p.tokenIn, p.tokenOut, 1, 0)));
        (bool ok3,) = vault.call(abi.encodeCall(IVaultLike.settleFees, ()));
        (bool ok4,) = vault.call(abi.encodeCall(IVaultLike.checkBreaker, ()));
        reentrySucceeded = ok1 || ok2 || ok3 || ok4;
        lastReentryError = e1;
    }
}
