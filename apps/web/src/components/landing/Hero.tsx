import Link from 'next/link';
import { CHAIN_ID, type ReceiptSummary, type StrategyListItem } from '@receipts/shared';
import { APP_NAME } from '@/lib/env';
import { amount, pct, tone } from '@/lib/format';
import { ArrowRight, LockIcon, LogoMark, RevealPill, StrategyTags } from '@/components/ui';
import { CompactSlip, EmptySlip } from '@/components/receipt/ReceiptSlip';

export function Hero({
  live,
  strategies,
  latest,
  tvlUsd,
  now,
}: {
  live: boolean;
  strategies: StrategyListItem[] | null;
  latest: ReceiptSummary | null;
  tvlUsd: string | null;
  now: number;
}) {
  return (
    <section className="wrap pt-[88px] text-center max-[800px]:pt-14">
      <div className="badge mb-7">
        <i />
        {live ? 'Live on Robinhood Chain' : 'Built on Robinhood Chain'}
        <span className="k">chain {CHAIN_ID}</span>
      </div>
      <h1 className="mx-auto mb-6 max-w-[13ch] text-[clamp(46px,7vw,86px)] font-bold leading-[1.02] tracking-[-0.045em]">
        Track records you can’t fake.
      </h1>
      <p className="mx-auto mb-[34px] max-w-[35em] text-[clamp(17px,1.5vw,19.5px)] leading-[1.6] text-muted">
        Copy trading strategies whose every trade is written on-chain before it happens. Your money stays in a
        vault that only your wallet can withdraw from.
      </p>
      <div className="flex flex-wrap justify-center gap-2.5">
        <Link className="btn btn-dark btn-lg" href="/app">
          Launch app
          <ArrowRight />
        </Link>
        <a className="btn btn-lg" href="#how">
          See how it works
        </a>
      </div>
      <p className="mt-4 text-[13.5px] text-faint">No sign-up. Connect a wallet and sign a message.</p>

      <ProductPreview strategies={strategies} latest={latest} tvlUsd={tvlUsd} now={now} />
    </section>
  );
}

function ProductPreview({
  strategies,
  latest,
  tvlUsd,
  now,
}: {
  strategies: StrategyListItem[] | null;
  latest: ReceiptSummary | null;
  tvlUsd: string | null;
  now: number;
}) {
  return (
    <div
      className="preview relative mx-auto mt-[72px] max-w-[1080px] px-5 max-[800px]:mt-12 max-[800px]:px-0"
      aria-hidden="true"
    >
      <div className="rise relative z-[1] overflow-hidden rounded-frame border border-line bg-white text-left shadow-lg">
        <div className="flex h-11 items-center gap-[7px] border-b border-line-2 bg-bg-2 px-4">
          <i className="h-[11px] w-[11px] rounded-full bg-[#E4E4E7]" />
          <i className="h-[11px] w-[11px] rounded-full bg-[#E4E4E7]" />
          <i className="h-[11px] w-[11px] rounded-full bg-[#E4E4E7]" />
          <span className="mx-auto rounded-[7px] border border-line-2 bg-white px-3.5 py-[3px] font-mono text-[12.5px] text-faint">
            {APP_NAME} / Strategies
          </span>
        </div>
        <div className="grid min-h-[420px] grid-cols-[190px_1fr] max-[800px]:grid-cols-1">
          <div className="border-r border-line-2 bg-[#FCFCFC] px-3 py-[18px] max-[800px]:hidden">
            <div className="logo mx-2 mb-[18px] text-[15px]">
              <LogoMark width={18} lines={false} />
              {APP_NAME}
            </div>
            <div className="flex items-center gap-[9px] rounded-lg bg-bg-3 px-2.5 py-2 text-[13.5px] font-medium text-ink">
              ▤ Strategies
            </div>
            <div className="flex items-center gap-[9px] rounded-lg px-2.5 py-2 text-[13.5px] font-medium text-muted">
              ◫ Vault
            </div>
            <div className="flex items-center gap-[9px] rounded-lg px-2.5 py-2 text-[13.5px] font-medium text-muted">
              ✓ Check a receipt
            </div>
          </div>
          <div className="px-6 py-[22px]">
            <div className="mb-1 text-[20px] font-bold tracking-[-0.02em]">Strategies</div>
            <p className="mb-4 text-[13px] text-muted">Returns come only from revealed receipts.</p>
            <table className="ftable">
              <thead>
                <tr>
                  <th>Strategy</th>
                  <th className="hide-m">Market</th>
                  <th className="n">30 days</th>
                  <th className="n hide-m">vs hold</th>
                  <th>Reveals</th>
                </tr>
              </thead>
              <tbody>
                {strategies && strategies.length > 0 ? (
                  strategies.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <b className="font-semibold">{s.name}</b>
                        <StrategyTags house={s.house} kind={s.kind} />
                      </td>
                      <td className="hide-m muted">{s.market}</td>
                      <td className={`n ${tone(s.ret30d)}`}>{pct(s.ret30d)}</td>
                      <td className={`n hide-m ${tone(s.vsHold)}`}>{pct(s.vsHold)}</td>
                      <td>
                        <RevealPill missed={s.missed} receipts={s.receipts} />
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="muted">
                      {strategies
                        ? 'No strategies yet. The first one appears here as soon as it is registered on-chain.'
                        : 'Live strategies are unavailable right now.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="rise absolute bottom-14 left-[-10px] z-[2] w-[250px] [animation-delay:.4s] max-[1060px]:hidden">
        <div className="vcard">
          <div className="flex justify-between text-[12.5px] text-muted">
            <span>In user vaults</span>
            <span>USD</span>
          </div>
          <div className="mb-2.5 mt-1 font-mono text-[24px] font-medium tracking-[-0.02em]">
            {tvlUsd === null ? '—' : amount(tvlUsd)}
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-green-bg px-[9px] py-1.5 text-[12.5px] font-semibold text-green-dark">
            <LockIcon />
            Only your wallet can withdraw
          </div>
        </div>
      </div>
      <div className="rise absolute bottom-[-92px] right-[-28px] z-[2] w-[262px] [animation-delay:.25s] max-[800px]:relative max-[800px]:bottom-auto max-[800px]:right-auto max-[800px]:mx-auto max-[800px]:mt-[-30px] max-[800px]:w-auto max-[800px]:max-w-[300px]">
        {latest ? <CompactSlip r={latest} now={now} /> : <EmptySlip compact />}
      </div>
    </div>
  );
}
