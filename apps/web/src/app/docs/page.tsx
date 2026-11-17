import type { Metadata } from 'next';
import Link from 'next/link';
import { chainConfigSchema, explorerAddress } from '@receipts/shared';
import { apiTry } from '@/lib/api.server';
import { APP_NAME, LINKS } from '@/lib/env';
import { amount } from '@/lib/format';
import { checksum } from '@/lib/address';
import { DocShell } from '@/components/landing/DocShell';

export const metadata: Metadata = {
  title: 'How it works',
  description: 'How commit-reveal receipts work, the vault threat model, worst-case math and fees.',
};
export const revalidate = 300;

const SECTIONS = [
  ['receipts', 'How a receipt works'],
  ['vault', 'Your vault'],
  ['threat-model', 'Threat model'],
  ['worst-case', 'Worst-case math'],
  ['fees', 'Fees'],
  ['verify', 'Check it yourself'],
  ['limits', 'Known limitations'],
] as const;

export default async function DocsPage() {
  const chain = await apiTry('/config/chain', chainConfigSchema, 300);
  const cap = chain.ok && chain.data.maxDailyLimitUsd ? amount(chain.data.maxDailyLimitUsd, 0) : '2,000';
  const registry = chain.ok ? chain.data.registry : null;
  const factory = chain.ok ? chain.data.factory : null;

  return (
    <DocShell>
      <article className="doc">
        <p className="eyebrow">Docs</p>
        <h1>How {APP_NAME} works</h1>
        <p className="lede">
          Every trade decision is committed on Robinhood Chain before it executes and revealed after. Your
          money stays in a vault contract that only your wallet can withdraw from. This page explains the
          mechanism, the limits and the fees, and how to check all of it yourself.
        </p>
        <nav className="toc" aria-label="On this page">
          <strong className="font-semibold text-ink">On this page</strong>
          <ol>
            {SECTIONS.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`}>{label}</a>
              </li>
            ))}
          </ol>
        </nav>

        <h2 id="receipts">How a receipt works</h2>
        <p>Each trade decision of a strategy becomes one public receipt, built from three transactions:</p>
        <ol>
          <li>
            <strong>Commit.</strong> The strategy’s signer posts a fingerprint of its next signal to the{' '}
            <code>SignalRegistry</code>. Nobody can read the signal from it, including us:
            <pre>hash = keccak256(abi.encode(chainId, registry, strategyId, nonce, signal, salt))</pre>
            The signal is the token pair, the size (share of each vault’s allocation) and, for AI strategies,
            a hash of the exact prompt. The salt is 32 random bytes. Nonces count up per strategy, so commits
            cannot be skipped or reordered.
          </li>
          <li>
            <strong>Execute.</strong> In a <em>later</em> L2 block, the executor swaps inside each following
            vault, through the pinned Uniswap pool, within that vault’s limits. The vault refuses a signal
            that is not a live commit of the strategy it follows.
          </li>
          <li>
            <strong>Reveal.</strong> Before the reveal deadline (10 minutes to 24 hours, fixed per strategy),
            anyone with the signal and salt calls <code>reveal</code>. The contract recomputes the hash and
            only accepts an exact match. Revealing closes execution for that nonce, which enforces the order
            commit → execute → reveal.
          </li>
        </ol>
        <p>
          If a commit is not revealed in time, anyone can call <code>markMissed</code>. The strategy’s missed
          counter only goes up, and every receipt stays on the record: winners cannot be added later and
          losers cannot be deleted. The indexer compares every execution with the revealed signal (pair,
          direction, size) and flags a mismatch publicly on the receipt.
        </p>
        <p>
          AI strategies also commit a hash of the model id when they register, and a hash of the full prompt
          and inputs with every signal. The prompt is published at reveal, so anyone can check that neither
          changed. Rule-based strategies are never labelled AI.
        </p>

        <h2 id="vault">Your vault</h2>
        <ul>
          <li>
            One vault per wallet, created by the <code>VaultFactory</code>. You own it; ownership cannot be
            transferred.
          </li>
          <li>
            <strong>Only your wallet can withdraw</strong>, any token, at any time. Withdraw never depends on
            prices, pause or the bot, and it works from Blockscout if this website is offline.
          </li>
          <li>
            The executor (bot) can only call <code>executeSignal</code>: one swap between USDG and one token
            you allowed, once per live public commit, in the factory-pinned pool.
          </li>
          <li>
            <strong>Daily limit</strong> (at most {cap} USDG per vault in the beta): the oracle value the bot
            may trade per 24-hour window. <strong>Max slippage</strong> (at most 5%): fills worse than the
            Chainlink price minus this revert. <strong>Allocation</strong>: caps how much the strategy may
            hold outside USDG.
          </li>
          <li>
            <strong>Drawdown breaker</strong> (5–50%): trading pauses by itself when the vault falls that far
            from its peak. You re-arm it with <em>Reset peak</em>.
          </li>
          <li>
            <strong>Pause</strong> stops trading; <strong>Revoke bot access</strong> (
            <code>setOperator(0)</code>) removes it completely. Both are one transaction and you can undo
            them.
          </li>
        </ul>

        <h2 id="threat-model">Threat model</h2>
        <p>The contracts have no proxies, no upgrades and no admin power over existing vaults or funds.</p>
        <table>
          <thead>
            <tr>
              <th scope="col">Who</th>
              <th scope="col">Can</th>
              <th scope="col">Cannot</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Vault owner</td>
              <td>Everything on their vault; withdraw any token at any time</td>
              <td>Change the factory’s token, feed or pool list; raise the daily limit above the beta cap</td>
            </tr>
            <tr>
              <td>Executor (bot) key</td>
              <td>
                Call executeSignal on vaults where it is the operator, once per live commit, within limits
              </td>
              <td>
                Withdraw, transfer, approve, change limits, pick a pool, trade a token you disabled, trade
                token↔token
              </td>
            </tr>
            <tr>
              <td>Strategy signer key</td>
              <td>Commit and reveal for its strategy</td>
              <td>Touch any vault</td>
            </tr>
            <tr>
              <td>Strategy creator</td>
              <td>Rotate the signer, deactivate, lower the creator share</td>
              <td>Raise the share; affect funds except fees on real profit above the high-water mark</td>
            </tr>
            <tr>
              <td>Factory admin</td>
              <td>Change the default bot and treasury for new vaults only</td>
              <td>Change any existing vault, the token list, feeds, pools or caps</td>
            </tr>
          </tbody>
        </table>
        <p>
          We assume the executor key will be stolen one day. Even then it can only make bounded swaps that
          land back in your vault, which is what the worst-case math below measures. The contracts are{' '}
          <strong>not externally audited yet</strong>; the beta daily cap stays until an audit by a recognised
          firm and a public bug bounty.
        </p>

        <h2 id="worst-case">Worst-case math</h2>
        <p>If the executor key were stolen, the most it could cost one vault per day is:</p>
        <pre>dailyLimit × (maxSlippage + pool fee + oracle lag)</pre>
        <p>
          Oracle lag is about 0.5%: Chainlink updates on deviation, so a price can trail the market by that
          much. Pool fees are the pinned Uniswap tiers (0.01%–0.3%). Examples:
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">Settings</th>
              <th scope="col">Worst case / day</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>2,000 USDG limit, 1% slippage, 0.3% pool fee, 0.5% lag</td>
              <td>2,000 × 1.8% = 36 USDG</td>
            </tr>
            <tr>
              <td>500 USDG limit, 1% slippage, 0.3% pool fee, 0.5% lag</td>
              <td>500 × 1.8% = 9 USDG</td>
            </tr>
          </tbody>
        </table>
        <p>
          Windows are fixed 24-hour periods, so up to twice the daily limit can trade across a window
          boundary. You stop everything instantly with Pause or Revoke bot access, and you can always
          withdraw. The <Link href="/app/vault">vault page</Link> shows this figure for your own limits.
        </p>

        <h2 id="fees">Fees</h2>
        <ul>
          <li>No fee on deposits, withdrawals or swaps beyond gas and the Uniswap pool fee.</li>
          <li>
            Creators earn a share (at most 30%, set when the strategy is registered, can only be lowered) of
            profit above your vault’s high-water mark. If your vault is below its previous high, nobody gets
            paid.
          </li>
          <li>
            {APP_NAME} keeps a fixed part of that creator fee (set per factory, at most 30% of it). Fees are
            paid only in USDG, only to the strategy creator and the treasury, at most weekly or when you
            change strategy or withdraw.
          </li>
          <li>
            The share used is the lower of the share when you started copying and the current one. Tokens sent
            to the vault without Deposit count as profit, so always use Deposit.
          </li>
        </ul>

        <h2 id="verify">Check it yourself</h2>
        <ul>
          <li>
            <Link href="/app/verify">Check a receipt</Link>: your browser reads the commit and the reveal from
            Robinhood Chain, recomputes the hash, and checks every execution. The page says whether it
            verified from the chain or fell back to our API.
          </li>
          <li>Every number in the app links to its transaction or contract on Blockscout.</li>
          {registry ? (
            <li>
              SignalRegistry:{' '}
              <a href={explorerAddress(registry)} target="_blank" rel="noopener noreferrer">
                <code>{checksum(registry)}</code>
              </a>
            </li>
          ) : null}
          {factory ? (
            <li>
              VaultFactory:{' '}
              <a href={explorerAddress(factory)} target="_blank" rel="noopener noreferrer">
                <code>{checksum(factory)}</code>
              </a>
            </li>
          ) : null}
          <li>
            The contracts, worker and indexer are open source
            {LINKS.github ? (
              <>
                {' '}
                (<a href={LINKS.github}>GitHub</a>)
              </>
            ) : null}
            ; <code>scripts/verify-deployment.ts</code> compares the deployed bytecode with the repository.
          </li>
        </ul>

        <h2 id="limits">Known limitations</h2>
        <ul>
          <li>
            Chainlink stock-token feeds pause on weekends; trades in stock tokens revert while a feed is stale
            (withdraw still works).
          </li>
          <li>Robinhood Stock Tokens are not available to US persons.</li>
          <li>Pools are shallow; large trades simply revert because of the oracle minimum.</li>
          <li>
            There is no sequencer-uptime feed on Robinhood Chain; staleness checks are the protection after
            downtime.
          </li>
          <li>
            Follow and Stop copying need fresh prices for every held token; pause, revoke and withdraw never
            do.
          </li>
          <li>A lost owner key means locked funds: vault ownership is not transferable.</li>
          <li>
            USDG (Paxos) and the stock tokens are issuer-controlled tokens that can be frozen by their
            issuers.
          </li>
        </ul>
        <p className="text-[14px] text-muted">
          Not investment advice. Past results, backtests included, do not predict future returns.
        </p>
      </article>
    </DocShell>
  );
}
