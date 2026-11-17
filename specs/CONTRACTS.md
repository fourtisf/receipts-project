# Contracts specification

Solidity **0.8.26**, `viaIR`, optimizer on, EVM `cancun`. OpenZeppelin Contracts 5.x (`SafeERC20`, `ReentrancyGuard`). Foundry for build, tests and deploy. No proxies, no upgradeability.

Interfaces to implement exactly: `specs/contracts/ISignalRegistry.sol`, `IReceiptsVault.sol`, `IVaultFactory.sol`.

Base code: `reference/nouny-agent/AgentVault.sol` and `AgentVaultFactory.sol` (MIT, © 2026 NOUNY). Fork them, keep the MIT notice at the top of every forked file, and list them in `THIRD_PARTY_NOTICES.md`.

---

## 1. Robinhood Chain specifics

- Chain ID 4663, Arbitrum-based L2. `block.number` is the L1 block. Use the **L2 block** from the ArbSys precompile at `address(100)`, `arbBlockNumber()`. Always call it, do not gate the call on `extcodesize` (ArbSys holds placeholder code `0xfe`; NOUNY's review finding L-3 was exactly this bug). Fall back to `block.number` only if the call fails or returns no data.
- No Chainlink sequencer-uptime feed exists here. Rely on staleness checks.
- Swaps go through Uniswap V3 **SwapRouter02** `exactInputSingle` (address in `config/robinhood.json`). Every non-base token trades in one pinned pool vs USDG at the fee tier in config.

---

## 2. `SignalRegistry`

Purpose: strategies, commits, reveals, missed reveals. Immutable record.

### Data
```solidity
enum Status { None, Committed, Revealed, Missed }

struct Strategy {
    address creator;          // set at register, never changes
    address signer;           // may commit; creator can rotate
    uint16  creatorShareBps;  // ≤ MAX_CREATOR_SHARE_BPS (3000); can only be LOWERED later
    uint32  revealWindow;     // seconds, [MIN_REVEAL_WINDOW 10 min, MAX_REVEAL_WINDOW 24 h], fixed
    bool    active;           // inactive strategies cannot commit
    bytes32 modelHash;        // keccak256(model id) for AI strategies, 0 otherwise
    uint64  commitCount;      // next nonce
    uint64  revealCount;
    uint64  missedCount;      // monotonic, never decreases
    string  metadataURI;      // name, template, params (JSON on IPFS or our API)
}

struct Commit {
    bytes32 hash;
    uint64  committedAt;      // block.timestamp
    uint64  committedL2Block; // ArbSys L2 block
    uint64  revealDeadline;   // committedAt + revealWindow
    Status  status;
}

struct Signal {
    address tokenIn;
    address tokenOut;
    uint16  sizeBps;          // share of the vault allocation moved by this signal (1..10000)
    bytes32 promptHash;       // AI strategies: keccak256(full prompt + inputs). 0 otherwise
}
```
Strategy IDs start at 1. `commits[strategyId][nonce]`.

### Hash
```
hash = keccak256(abi.encode(block.chainid, address(this), strategyId, nonce, signal, salt))
```
`nonce` = `strategy.commitCount` at commit time (only the signer can commit, so the signer always knows its next nonce). `salt` = 32 random bytes. Expose `hashSignal(strategyId, nonce, signal, salt)` as a view so the frontend and worker use the exact same function.

### Functions
| Function | Who | Rules |
|---|---|---|
| `registerStrategy(signer, creatorShareBps, revealWindow, modelHash, metadataURI) → id` | anyone (becomes creator) | bounds checked; `active = true` |
| `setSigner(id, signer)` | creator | non-zero |
| `setActive(id, bool)` | creator | |
| `setMetadataURI(id, uri)` | creator | |
| `lowerCreatorShare(id, newBps)` | creator | `newBps < current` only |
| `commit(id, hash) → nonce` | signer | strategy active; stores Commit; `commitCount++` |
| `reveal(id, nonce, signal, salt)` | anyone with the preimage | status Committed; `block.timestamp ≤ revealDeadline`; hash matches; → Revealed; `revealCount++` |
| `markMissed(id, nonce)` | anyone | status Committed and `block.timestamp > revealDeadline`; → Missed; `missedCount++` |
| `isExecutable(id, nonce) → bool` | view | status Committed AND `block.timestamp ≤ revealDeadline` AND current L2 block **>** `committedL2Block` |

Revealed and Missed are terminal. Commits are never deleted. Revealing closes execution for that nonce (vaults check `isExecutable`), which enforces the order commit → execute → reveal.

### Events
`StrategyRegistered(id, creator, signer, creatorShareBps, revealWindow, modelHash, metadataURI)`, `SignerChanged`, `ActiveChanged`, `MetadataChanged`, `CreatorShareLowered`, `Committed(id, nonce, hash, revealDeadline, l2Block)`, `Revealed(id, nonce, tokenIn, tokenOut, sizeBps, promptHash, salt)`, `Missed(id, nonce)`.

---

## 3. `ReceiptsVault` (fork of AgentVault)

One per user, created by `VaultFactory`.

### 3.1 Immutables
`owner`, `factory`, `registry`, `router`, `base` (USDG), `treasury`, `protocolCutBps` (≤ 3000, share of the creator fee kept by protocol), `maxDailyLimitUsd` (beta cap from factory).

### 3.2 State
`operator`, `paused`, `maxSlippageBps` (≤ 500), `dailyLimitUsd` (≤ `maxDailyLimitUsd`), `drawdownBps` ([500, 5000]), `windowStart`, `usedInWindowUsd`, `followingId`, `creatorShareSnapshot` (bps, read from registry at `follow`), `allocationUsd` (cap on non-base exposure, 18 decimals), `peakNav`, `hwmNav`, `lastFeeSettle`, `marksFrozen`, token configs (from factory list; owner can only enable/disable listed tokens), `executed[keccak256(strategyId, nonce)]`.

### 3.3 Owner functions
| Function | Rules |
|---|---|
| `deposit(amount)` | pulls USDG via `transferFrom`; `peakNav += value`, `hwmNav += value` (value from base feed, lenient). Direct transfers also work but don't raise marks (that only makes fees and the breaker more lenient for the owner). |
| `withdraw(token, amount, to)` | **must never revert because of oracles, pause or operator state.** Tries fee settlement first via `try this.settleFeesForWithdraw()` style self-call; on failure skips fees. Scales `peakNav` and `hwmNav` by `navAfter / navBefore` using lenient NAV obtained through a `try` external self-view; if lenient NAV fails, sets `marksFrozen = true` and emits `MarksFrozen`. |
| `follow(strategyId, allocationUsd)` | strategy active; if currently following, settle fees first (strict; revert `PricesStale` if not possible, owner can retry or withdraw); snapshot `creatorShareSnapshot`; set `hwmNav = navStrict()`; `lastFeeSettle = now`. |
| `unfollow()` | settle fees (strict, revert if stale); `followingId = 0`. |
| `setAllocation(allocationUsd)` | any value |
| `setLimits(maxSlippageBps, dailyLimitUsd, drawdownBps)` | bounds above |
| `setPaused(bool)` | |
| `setOperator(address)` | `address(0)` revokes the bot completely |
| `setTokenEnabled(token, bool)` | only tokens in the factory list |
| `resetPeak()` | `peakNav = navLenient()` (owner chooses to re-arm the breaker after a trip) |
| `resetMarks()` | only when `marksFrozen`: `peakNav = hwmNav = navStrict()`, clear flag (creator loses fees accrued before the freeze; documented) |

### 3.4 Pricing
- `navStrict()`: sum over enabled tokens with balance > 0 of `balance × price`, each feed must be fresher than that token's `maxStaleness` (config). Used for swap pricing, fee settlement, `follow`.
- `navLenient()`: same, staleness limit `LENIENT_STALENESS = 7 days`. Used for breaker and mark scaling.
- Both reject answers ≤ 0 and `updatedAt > block.timestamp`.

### 3.5 `executeSignal(nonce, tokenIn, tokenOut, amountIn, minOutFromOperator) → amountOut`
Order of checks:
1. `msg.sender == operator && operator != 0`; not paused; `followingId != 0`.
2. **Breaker pre-check:** `nav = navLenient()`; if `nav × 10000 < peakNav × (10000 − drawdownBps)` → set `paused = true`, emit `BreakerTripped(nav, peakNav)`, **return 0 without swapping** (do not revert, the pause must persist).
3. `registry.isExecutable(followingId, nonce)`; `!executed[key]` then mark executed (one execution per signal per vault: churn needs new public commits).
4. Both tokens enabled; exactly one side is `base` (NOUNY I-1: no token-to-token routes); pool fee tier = pinned tier of the non-base token.
5. Strict prices; `valueUsd`; consume daily window (fixed 24 h window, as NOUNY).
6. Oracle min-out = expected × (1 − maxSlippageBps); use the stricter of that and `minOutFromOperator`.
7. Swap via router, recipient = vault; `forceApprove` exact then reset to 0; measure balance delta, require ≥ minOut.
8. If `tokenOut != base`: require `exposureUsd() ≤ allocationUsd` (exposure = navLenient − base value).
9. Post-trade: `peakNav = max(peakNav, navLenient())`; if breach → `paused = true`, emit `BreakerTripped`.
10. Emit `Executed(followingId, nonce, tokenIn, tokenOut, amountIn, amountOut, valueUsd, minOut)`.

`checkBreaker()` — anyone may call to trip the breaker on price moves without trades.

### 3.6 Fees — `settleFees()`
- Callable by anyone when `followingId != 0`, `!marksFrozen`, and `block.timestamp ≥ lastFeeSettle + 7 days`; also called internally by `follow` / `unfollow` / `withdraw` (best effort on withdraw).
- `nav = navStrict()`. If `nav ≤ hwmNav` → only `lastFeeSettle = now`.
- `profit = nav − hwmNav`; `creatorFee = profit × creatorShareSnapshot / 10000`; `protocolFee = creatorFee × protocolCutBps / 10000`; creator receives `creatorFee − protocolFee`.
- Paid **only in base (USDG)**, converted at the strict USDG price, **only to `registry.creatorOf(followingId)` and `treasury`**. If USDG balance is insufficient: pay nothing, emit `FeeDeferred(profit, needed, balance)`, leave marks unchanged.
- After payment: `hwmNav = nav − feeValue`, `peakNav = peakNav − feeValue` (floor 0), `lastFeeSettle = now`. Emit `FeesSettled(strategyId, profit, creatorAmount, protocolAmount, nav, hwmNav)`.

### 3.7 Events
`Deposited`, `Withdrawn`, `Followed(strategyId, allocationUsd, creatorShareSnapshot)`, `Unfollowed`, `AllocationChanged`, `LimitsChanged`, `PausedChanged`, `OperatorChanged`, `TokenEnabled`, `Executed`, `BreakerTripped`, `PeakReset`, `MarksFrozen`, `MarksReset`, `FeesSettled`, `FeeDeferred`.

---

## 4. `VaultFactory` (fork of AgentVaultFactory)

- Constructor: `router, registry, base, treasury, protocolCutBps, maxDailyLimitUsd, defaultOperator, tokens[], feeds[], staleness[], feeTiers[]`. Token list ≤ 20, fixed forever.
- `createVault(maxSlippageBps, dailyLimitUsd, drawdownBps) → vault`, one per wallet; `vaultOf(owner)`; `vaultCount()`; `vaults(start, count)` paging (used by the worker).
- Admin (two-step transfer): `setDefaultOperator(op)` and `setTreasury(t)` — both affect **new vaults only**.
- `MAX_DAILY_LIMIT_USD` immutable (beta $2,000 = `2000e18`).

---

## 5. Invariants (each needs a test)

Registry
1. A commit becomes Revealed only with the exact preimage, before its deadline.
2. Revealed and Missed are terminal; `missedCount` never decreases; nonces are sequential per strategy; commits are never deleted.
3. `isExecutable` is false in the commit's own L2 block, after reveal, after deadline, and for Missed.

Vault
4. Tokens leave the vault only via `withdraw` (owner) or `settleFees` (USDG to creator + treasury, bounded by invariant 10).
5. The operator can call nothing except `executeSignal`; swap output always lands in the vault.
6. `executeSignal` succeeds only for a live commit of `followingId`, in a later L2 block than the commit, once per (strategy, nonce).
7. Every successful swap delivers ≥ oracle expected × (1 − maxSlippageBps), whatever the router reports.
8. Oracle value swapped per 24 h window ≤ `dailyLimitUsd` ≤ `maxDailyLimitUsd`.
9. After any buy, non-base exposure ≤ `allocationUsd`.
10. Fees per settlement ≤ (navStrict − hwmNav) × creatorShareSnapshot / 10000; zero when nav ≤ hwm; only USDG; only creator and treasury; at most once per 7 days unless triggered by owner actions.
11. If a drawdown breach is observed by `executeSignal` or `checkBreaker`, the vault ends up paused.
12. `withdraw` by the owner succeeds while paused, with operator revoked, with stale or broken feeds.
13. Router approval is 0 after every swap.

Factory
14. Admin actions never change an existing vault.

---

## 6. Tests

- **Unit:** every function, every revert path.
- **Fuzz:** amounts, prices, staleness, slippage, limits, time jumps.
- **Invariant (Foundry handler):** random sequences of owner / operator / attacker / time / oracle actions with mock router (including a cheating router that under-delivers and one that reports a fake amount) — assert §5 after each step.
- **Fork (`--fork-url` Robinhood Chain):** real Uniswap V3 pools and Chainlink feeds for WETH, cbBTC, NVDA, SPY; full commit → execute → reveal; weekend-stale stock feed behaviour (warp time).
- **Gas snapshot** for `executeSignal` with 13 tokens enabled (NAV loops): must stay well under block gas; document the number.
- Run Slither and fix or explain every medium+ finding in `SECURITY.md`.

## 7. Known limitations to document in `SECURITY.md`
Fixed 24 h windows (up to 2× daily limit around a boundary); oracle deviation lag (~0.5%); no sequencer-uptime feed; execution-vs-signal mismatch is detected off-chain after reveal (contracts can't see the hidden signal) and flagged publicly; fees forgone if a withdraw happens while feeds are stale or marks are frozen; vault ownership not transferable (lost key = locked funds); stock tokens pause on weekends and are unavailable to US persons; shallow pools ($20k–$400k) → keep trade sizes small.
