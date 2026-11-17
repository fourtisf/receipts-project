import { explorerTx, type ReceiptCheck } from '@receipts/shared';
import { dateTimeUtc, nf, short } from '@/lib/format';
import { ExtLink } from '@/components/ui';

/** Prototype-style detail text: short hashes, grouped block numbers, readable UTC times. */
export function prettyDetail(detail: string): string {
  return detail
    .replace(/0x[0-9a-fA-F]{64}/g, (h) => short(h))
    .replace(/\b(block|blk) (\d{4,})/gi, (_m, w: string, n: string) => `${w} ${nf(n)}`)
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, (iso) => dateTimeUtc(iso));
}

/** The five receipt checks (commit found, reveal matches, executed after commit, price within oracle, balances). */
export function ChecksList({ checks }: { checks: ReceiptCheck[] }) {
  return (
    <ul className="checks mt-5">
      {checks.map((c) => {
        const cls = c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'na';
        return (
          <li key={c.id} className={cls}>
            <span className="ic" aria-hidden="true">
              {c.ok === true ? '✓' : c.ok === false ? '✕' : '–'}
            </span>
            <div className="min-w-0">
              <strong>
                {c.title}
                <span className="sr-only">
                  {c.ok === true ? ' (passed)' : c.ok === false ? ' (failed)' : ' (not applicable yet)'}
                </span>
              </strong>
              <span className="d" title={c.detail}>
                {prettyDetail(c.detail)}
                {c.txHash ? (
                  <>
                    {' '}
                    <ExtLink href={explorerTx(c.txHash)}>View transaction</ExtLink>
                  </>
                ) : null}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
