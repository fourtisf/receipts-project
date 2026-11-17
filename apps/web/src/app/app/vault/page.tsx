import type { Metadata } from 'next';
import Link from 'next/link';
import { chainConfigSchema, houseVaultListSchema, robinhoodConfig, TOKENS } from '@receipts/shared';
import { apiTry } from '@/lib/api.server';
import { APP_NAME } from '@/lib/env';
import { amount } from '@/lib/format';
import { shortAddr } from '@/lib/address';
import { strategyHref } from '@/lib/receipt';
import { AppPage } from '@/components/app/AppPage';
import { VaultView } from '@/components/app/VaultView';
import { ExtLink } from '@/components/ui';

export const metadata: Metadata = { title: 'Vault' };

export default async function VaultPage() {
  const [cfg, house] = await Promise.all([
    apiTry('/config/chain', chainConfigSchema, 300),
    apiTry('/vaults/house', houseVaultListSchema, 30),
  ]);
  const explorer = cfg.ok ? cfg.data.explorer : robinhoodConfig.explorer;
  const assets = (
    cfg.ok ? cfg.data.tokens.filter((t) => t.kind !== 'base') : TOKENS.filter((t) => t.kind !== 'base')
  ).map((t) => t.symbol);

  return (
    <AppPage crumbs={[{ label: 'Vault' }]}>
      <VaultView
        explorer={explorer}
        maxDailyLimitUsd={cfg.ok ? cfg.data.maxDailyLimitUsd : null}
        assets={assets}
      />

      <h2 className="mb-1 mt-10 text-[19px] font-bold tracking-[-0.02em]">House vaults</h2>
      <p className="mb-3.5 text-[14.5px] text-muted">
        Public vaults that {APP_NAME} runs with real funds. Anyone can inspect them on Blockscout.
      </p>
      {house.ok && house.data.items.length > 0 ? (
        <div className="tablecard">
          <table className="table stack">
            <thead>
              <tr>
                <th scope="col">Strategy</th>
                <th scope="col" className="num">
                  Value (USD)
                </th>
                <th scope="col" className="num">
                  Vault
                </th>
              </tr>
            </thead>
            <tbody>
              {house.data.items.map((v) => (
                <tr key={v.address}>
                  <td className="lead">
                    {v.strategyId ? (
                      <Link className="sname" href={strategyHref(v.strategyId)}>
                        {v.strategyName ?? `Strategy #${v.strategyId}`}
                      </Link>
                    ) : (
                      <span className="sname">Not copying a strategy</span>
                    )}
                  </td>
                  <td data-l="Value (USD)" className="num">
                    {amount(v.navUsd)}
                  </td>
                  <td data-l="Vault" className="num">
                    <ExtLink href={v.explorerUrl}>{shortAddr(v.address)}</ExtLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty !mt-0">
          {house.ok
            ? 'No house vaults yet. They appear here as soon as they are created on-chain.'
            : `House vaults could not be loaded: ${house.error.message}`}
        </div>
      )}
    </AppPage>
  );
}
