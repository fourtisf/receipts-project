# Security

Contracts: `packages/contracts/src` — `SignalRegistry`, `ReceiptsVault`, `VaultFactory` (Solidity 0.8.26, via-IR,
OpenZeppelin 5.4). No proxies, no upgradeability, no admin power over existing vaults or user funds.

**Status: not externally audited.** The beta daily cap (`MAX_DAILY_LIMIT_USD` = $2,000 per vault, immutable in the
factory) stays until an external audit by a recognised firm and a public bug bounty. Raising it means deploying a new
factory.

Report vulnerabilities privately to the maintainers (security contact to be published with the launch). Please do not
open public issues for security bugs.

---

## 1. Threat model

| Actor | Can | Cannot |
|---|---|---|
| Vault owner | everything on their vault; withdraw any token at any time | change the factory token / feed / pool list; raise the daily limit above the beta cap |
| Executor (operator) key | call `executeSignal` on vaults where it is the operator, once per live commit, within limits | withdraw, transfer, approve, change limits, pick a pool, set its own minimum below the oracle minimum, trade a token the owner disabled, trade token↔token |
| Strategy signer key | commit hashes for its strategy; reveal | touch any vault |
| Strategy creator | rotate signer, deactivate, lower (never raise) the creator share | raise the share; affect vaults' funds except receiving fees on real profit above the high-water mark |
| Factory admin | rotate default operator / treasury **for new vaults only**; two-step admin transfer | change any existing vault; change the token list, feeds, pools or caps |
| Anyone | `reveal` with the preimage, `markMissed` after the deadline, `checkBreaker`, `settleFees` (weekly) | anything else |

### The executor key is assumed stolen one day

With only the executor key, an attacker can still only:
- swap between USDG and one enabled token, in the factory-pinned pool,
- once per live public commit of the strategy the vault follows, in a later L2 block,
- with output ≥ Chainlink price × (1 − `maxSlippageBps`), output always landing in the vault,
- for at most `dailyLimitUsd` of oracle value per 24 h window (≤ $2,000 in beta),
- and buys are capped by the owner's `allocationUsd`.

**Worst case per vault per day = `dailyLimit × (maxSlippage + pool fee + oracle lag)`.**

| Settings | Worst case / day |
|---|---|
| $2,000 limit, 1% slippage, 0.3% pool fee, ~0.5% oracle deviation lag | $2,000 × 1.8% = **$36** |
| $2,000 limit, 5% slippage (max), 1% fee tier, 0.5% lag | $2,000 × 6.5% = **$130** |

Because windows are fixed (not rolling), up to 2× the daily limit can be swapped across a window boundary, so the
worst case within any rolling 24 h is twice the figure above. The UI calculator shows the owner's own numbers.

If the signer key is stolen too, the attacker can create commits at will, but every bound above still holds. The owner
can stop everything instantly with `setPaused(true)` or `setOperator(address(0))`, and withdraw at any time.

---

## 2. Invariants and how they are tested

All invariants from `specs/CONTRACTS.md §5` have tests (`packages/contracts/test`):

| # | Invariant | Tests |
|---|---|---|
| 1 | Reveal only with the exact preimage, before the deadline | `SignalRegistry.t.sol` (`test_reveal_*`, `testFuzz_reveal_onlyExactPreimage`), `RegistryInvariant` |
| 2 | Revealed / Missed terminal, `missedCount` monotonic, sequential nonces, commits never deleted | `test_reveal_terminal`, `test_markMissed`, `testFuzz_noncesSequential`, `RegistryInvariant.sweep` |
| 3 | `isExecutable` false in the commit's L2 block, after reveal, after deadline, for Missed | `test_isExecutable_*`, `test_l2Block_*`, `RegistryInvariant` |
| 4 | Tokens leave only via `withdraw` or `settleFees` | `invariant_tokensOnlyLeaveViaWithdrawOrFees`, `test_withdraw_*`, `test_fees_*` |
| 5 | Operator can only call `executeSignal`; output lands in the vault | `test_onlyOwner_everything`, `attackOwnerFunctions` handler, `SendElsewhere` router |
| 6 | Only live commits of `followingId`, later L2 block, once per nonce | `test_execute_commitRules`, `test_execute_otherStrategyCommitRejected`, handler |
| 7 | Output ≥ oracle × (1 − slippage) whatever the router reports | `test_execute_cheatingRouters` (under-deliver, fake report, send elsewhere, over-pull), handler |
| 8 | Value per window ≤ `dailyLimitUsd` ≤ `maxDailyLimitUsd` | `test_execute_dailyLimit`, `invariant_dailyCap`, handler |
| 9 | Non-base exposure ≤ `allocationUsd` after buys | `test_execute_allocationCap`, handler |
| 10 | Fees ≤ (navStrict − hwm) × share; zero at a loss; USDG only; creator + treasury only; weekly unless owner-triggered | `test_fees_*`, `testFuzz_fees_bounded`, handler (`settleFees`, `withdraw`, `follow`) |
| 11 | Observed drawdown breach ⇒ paused | `test_breaker_*`, `test_checkBreaker`, handler |
| 12 | `withdraw` works paused, revoked, with stale / broken feeds | `test_withdraw_alwaysWorks`, `test_withdraw_worksWhenBalanceOfOfOtherTokenReverts`, `test_withdraw_feeTransferFailureIsSkipped`, handler (flags any revert) |
| 13 | Router approval 0 after every swap | `test_execute_allowanceResetWhenRouterPullsLess`, `invariant_noLingeringApproval` |
| 14 | Admin actions never change an existing vault | `test_adminActions_newVaultsOnly`, handler `adminRotate` |

Fork tests (`test/fork/RobinhoodFork.t.sol`) run the full commit → execute → reveal → sell cycle through the real
Uniswap V3 pools and Chainlink feeds for WETH, cbBTC, NVDA and SPY, check every config address on-chain, and simulate a
weekend-stale stock feed.

Coverage (legacy pipeline, `forge coverage`): **99.6 % lines, 98.0 % statements, 88.4 % branches, 100 % functions**
on `src/` (124 tests + 7 fork tests).

### Gas (optimized build, `test/Gas.t.sol`)

| Call | Gas |
|---|---|
| `executeSignal`, 13 tokens listed, enabled and held (every NAV loop prices all 13) | ~650,000 |
| `createVault` with 13 tokens | ~3,410,000 |
| `withdraw` (fee-settlement attempt + mark scaling), 13 tokens | ~567,000 |

Robinhood Chain (Arbitrum Orbit) block gas limit is 32M; NAV loops only price tokens with a non-zero balance.

---

## 3. Design notes that matter for security

- **L2 block.** `L2Block.current()` always calls ArbSys `arbBlockNumber()` at `address(100)` (no `extcodesize` gate —
  NOUNY review L-3) with a 30k gas stipend, falling back to `block.number` only if the call fails or returns 0. On
  anvil the placeholder `0xfe` code burns just the stipend.
- **Oracles.** Answers ≤ 0, future-dated and stale rounds are rejected. Strict staleness (per token, from config) for
  swaps, fee settlement and `follow`; lenient (`max(maxStaleness, 7 days)`) for the breaker and mark scaling. Feed
  `decimals()` is read live (not cached) so an aggregator change cannot silently misprice.
- **Withdraw never depends on oracles or on any listed token behaving.** Fee settlement inside `withdraw` is a
  `try this.settleFeesForWithdraw()` self-call (only callable by the vault). NAV reads never revert: feeds and
  `balanceOf` are low-level, gas-capped static calls (200k / 100k gas), and every value / sum is overflow-checked
  (`Math.tryMul`, values capped at 2^128 ≈ $3.4e20) — an absurd balance or price is treated as a bad read. Token
  decimals > 36 are rejected when a vault is created. If NAV cannot be computed the marks are frozen instead of
  reverting.
- **Effects before interactions.** `withdraw` predicts `navAfter` from the withdrawn token's value and updates marks
  before the transfer. Fee settlement updates marks before paying.
- **Reentrancy.** Every state-changing external vault function is `nonReentrant` (owner setters included), so the
  router — or a malicious token — cannot re-enter anything.
- **Dust.** `executeSignal` reverts if the oracle minimum output rounds to zero (found by the invariant suite).
- **Token switch.** While following, a held token cannot be disabled (`TokenHeld`); the owner withdraws it instead,
  which settles the creator fee first. Enabling a held token adds its value to the marks like a deposit. When not
  following, disabling / enabling scales / raises the marks like a withdrawal / deposit (only the owner's own breaker
  reference is affected; `follow` re-sets the high-water mark).
- **Strategy switches cannot erase fees.** `follow` (switch) and `unfollow` revert with `FeeUnpaid` when a fee is due
  but the vault holds too little USDG; `settleFees` / `withdraw` defer instead (`FeeDeferred`).
- **Creator share.** Fees use `min(snapshot, current share)`; creators can only lower the share.
- **Factory paging.** `vaults(start, count)` is overflow-safe for any `count` (found by a unit test).

---

## 4. Independent review

A second, independent adversarial review (fresh context, code + spec only, every finding proven with a Foundry
test) found **no way for a stolen operator and/or signer key to exceed the bound or move tokens out of a vault**
(a dedicated test burns the whole daily budget in round trips against a router that delivers exactly the oracle
minimum: loss = daily limit × slippage). Its findings and what was done:

| # | Severity | Finding | Status |
|---|---|---|---|
| F-1 | High | A listed token returning an absurd `balanceOf` (or decimals ≥ 78) made the NAV sum overflow, so `withdraw` and every escape hatch reverted | **Fixed**: overflow-checked NAV, values capped, low-level feed reads, decimals ≤ 36 at vault creation (`ReviewRegression.t.sol` F-1 tests) |
| F-2 | Medium | Disable/enable round trips of a held token shrank the accrued profit (owner dodges fees) or could overcharge after a loss | **Fixed**: cannot disable a held token while following (`TokenHeld`); withdraw settles fees first |
| F-3 | Low | `unfollow` / `follow` while a fee was deferred erased the accrued fee | **Fixed**: they revert `FeeUnpaid` instead |
| F-4 | Low | Anyone can donate 1 wei of a listed token whose feed is dead (> 7 days stale) and block trading until the owner removes it | **Documented** (§5); recovery tested: owner withdraws the dust, `resetMarks`, trading resumes |
| F-5 | Low | A gas-burning `balanceOf` could make `withdraw` run out of gas while following | **Fixed**: gas caps on token and feed calls (`test_F5_…` withdraws with 3M gas) |
| F-6 | Low/Info | `withdraw(USDG, fullBalance)` reverts when a fee is due (paid from USDG first) | **Documented**; the UI subtracts the pending fee for "withdraw max" |
| F-7 | Low/Info | If USDG freezes the creator or treasury, `follow` / `unfollow` revert while profit is pending | **Documented**; withdraw still works |

## 5. Slither

`slither packages/contracts --config-file packages/contracts/slither.config.json` (also in CI, failing on medium+).
Result: **0 high, 0 medium.** Remaining findings and why they are acceptable:

| Detector | Where | Why it is fine |
|---|---|---|
| `reentrancy-balance` (high), `unused-return` (medium) — suppressed inline | `ReceiptsVault._swap` | Balance-before/after around the router call is the protection: the router's reported amount is ignored on purpose and the real delta must be ≥ the oracle minimum. Re-entry is impossible (all state-changing functions are `nonReentrant`); a router sending *extra* tokens only benefits the vault. |
| `reentrancy-no-eth` (medium) — suppressed inline | `withdraw` (after the fee self-call), `executeSignal` (peak / pause after the swap) | The self-call targets the vault itself; external re-entry is blocked by `nonReentrant` on every state-changing function. Post-swap state must be computed from post-swap balances. |
| `unused-return` (medium) — suppressed inline | `latestRoundData` | `roundId`, `startedAt`, `answeredInRound` are not needed (answeredInRound is deprecated by Chainlink); answer and updatedAt are checked. |
| `calls-loop` (low) | NAV loops, constructor | Loops over the fixed factory list (≤ 20 trusted tokens / Chainlink feeds). Each call is wrapped so a failure cannot brick withdraw. |
| `timestamp` (low) | windows, deadlines, staleness | Intended. Sequencer timestamp drift is seconds; windows are hours / days. |
| `missing-zero-check` (low) | `setOperator`, `setDefaultOperator`, factory constructor, `transferAdmin` | `address(0)` is meaningful: revoke the bot / new vaults without a bot / cancel a pending admin transfer. |
| `shadowing-local` (low) | spec interfaces | Parameter names come from the frozen interfaces in `specs/contracts`. |
| `reentrancy-benign` (low), `low-level-calls`, `assembly`, `naming-convention`, `cyclomatic-complexity` (info) | various | Low-level `staticcall`s are the non-reverting `balanceOf` / ArbSys reads; the assembly is a memory-safe array length trim in `allowedTokens()`; `MAX_DAILY_LIMIT_USD` naming is fixed by the interface. |

---

## 6. Known limitations

- **Fixed 24 h windows**: up to 2× the daily limit can be swapped around a window boundary.
- **Oracle deviation lag**: Chainlink updates on deviation (~0.5%) or heartbeat; fills are bounded against a price that
  can lag the market by that much.
- **No sequencer-uptime feed** on Robinhood Chain; staleness checks are the only protection after sequencer downtime.
- **Signal vs execution mismatch is detected off-chain.** The contracts cannot see the hidden signal at execution time;
  the indexer compares every execution with the revealed signal (pair, direction, size) and flags mismatches publicly
  on the receipt and via alerts.
- **Fees can be forgone**: if a withdraw happens while feeds are stale or marks are frozen, or the vault holds no USDG
  when settling (`FeeDeferred`), the creator may miss fees for that period. `resetMarks` after a freeze drops fees
  accrued before the freeze.
- **Direct transfers count as profit**: tokens sent to the vault without `deposit` raise NAV but not the marks, so they
  are charged the creator fee at the next settlement. Owners should always use `deposit` (the UI does).
- **Strict prices for `follow` / `unfollow`**: they revert (`PricesStale`) while any held token's feed is stale (e.g.
  stock tokens on weekends). The owner can still pause, revoke the bot and withdraw.
- **Vault ownership is not transferable**: a lost owner key means locked funds.
- **Dust of a dead-feed token blocks trading** (review F-4): if a listed feed stops updating for more than 7 days,
  anyone can send 1 wei of that token to a vault and every `executeSignal` reverts until the owner withdraws the dust
  (always possible) and calls `resetMarks` (fees accrued before the freeze are forgone). The token list is fixed, so a
  deprecated feed means deploying a new factory.
- **Fee payments are push transfers in USDG**: if the creator or treasury address is frozen by the USDG issuer,
  `follow` / `unfollow` revert while profit is pending (withdraw still works; pause / revoke the bot meanwhile).
- **"Withdraw max" of USDG** must leave room for a pending creator fee (paid from USDG first inside `withdraw`).
- **Stock feeds and the oracle-lag term**: stock feeds are 24/5 with a 25 h staleness limit. If a feed misses updates
  over a market gap, the oracle price can lag the pool by the gap, so the worst case for stock tokens can exceed the
  ~0.5% lag assumed in §1 (e.g. a 10% overnight gap → up to $2,000 × ~11% per vault per day at the beta cap).
- **Stock tokens** pause on weekends (feeds stale → swaps revert by design) and are not available to US persons.
- **Shallow pools** ($20k–$400k): keep trade sizes small; the oracle minimum protects price but large trades will
  simply revert.
- **External dependencies**: Uniswap V3 SwapRouter02, Chainlink feeds and token contracts (USDG is a Paxos-issued
  token with freeze capability; Robinhood Stock Tokens are issuer-controlled) are trusted and fixed at factory deploy.
