'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { MouseEvent } from 'react';
import type { StrategyListItem } from '@receipts/shared';
import { nf, pct, pctPlain, tone } from '@/lib/format';
import { creatorLabel } from '@/lib/strategy';
import { strategyHref } from '@/lib/receipt';
import { RevealPill, StrategyTags } from '@/components/ui';

/** Strategies table; stacks into labelled cards below 800px (prototype behaviour). */
export function StrategiesTable({ items, emptyText }: { items: StrategyListItem[]; emptyText: string }) {
  const router = useRouter();
  const open = (e: MouseEvent<HTMLTableRowElement>, href: string) => {
    if ((e.target as HTMLElement).closest('a')) return; // the name link navigates by itself
    router.push(href);
  };

  return (
    <div className="tablecard">
      <table className="table stack">
        <thead>
          <tr>
            <th scope="col">Strategy</th>
            <th scope="col">Market</th>
            <th scope="col" className="num">
              30 days
            </th>
            <th scope="col" className="num">
              vs holding
            </th>
            <th scope="col" className="num">
              Max drawdown
            </th>
            <th scope="col" className="num">
              Receipts
            </th>
            <th scope="col">Reveals</th>
            <th scope="col" className="num">
              Vaults
            </th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colSpan={8} className="muted !whitespace-normal">
                {emptyText}
              </td>
            </tr>
          ) : (
            items.map((s) => {
              const href = strategyHref(s.id);
              return (
                <tr key={s.id} className="click" onClick={(e) => open(e, href)}>
                  <td className="lead">
                    <div className="sname">
                      <Link href={href} className="rounded-[4px]">
                        {s.name}
                      </Link>
                      <StrategyTags house={s.house} kind={s.kind} />
                    </div>
                    <div className="sby">
                      {s.templateName}, by {creatorLabel(s)}
                    </div>
                  </td>
                  <td data-l="Market">{s.market}</td>
                  <td data-l="30 days" className={`num ${tone(s.ret30d)}`}>
                    {pct(s.ret30d)}
                  </td>
                  <td data-l="vs holding" className={`num ${tone(s.vsHold)}`}>
                    {pct(s.vsHold)}
                  </td>
                  <td data-l="Max drawdown" className="num">
                    {pctPlain(s.maxDrawdown30d)}
                  </td>
                  <td data-l="Receipts" className="num">
                    {nf(s.receipts)}
                  </td>
                  <td data-l="Reveals">
                    <RevealPill missed={s.missed} receipts={s.receipts} />
                  </td>
                  <td data-l="Vaults" className="num">
                    {nf(s.followers)}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
