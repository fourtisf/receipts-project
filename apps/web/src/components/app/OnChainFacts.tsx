import { Fragment, type ReactNode } from 'react';
import { explorerAddress, tokenBySymbol, type StrategyDetail } from '@receipts/shared';
import { APP_NAME } from '@/lib/env';
import { duration, nf, short } from '@/lib/format';
import { shortAddr } from '@/lib/address';
import { sharePct } from '@/lib/strategy';
import { ExtLink } from '@/components/ui';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <span>{label}</span>
      <span>{children}</span>
    </div>
  );
}

const mono = 'src font-mono text-[13px]';

/** Key facts of a strategy as registered on-chain; every value links to its source on Blockscout. */
export function OnChainFacts({ s }: { s: StrategyDetail }) {
  const regTx = s.registered.explorerUrl;
  return (
    <div className="card">
      <h2 className="mb-3.5">On-chain facts</h2>
      <div className="kv">
        <Row label="Assets it can trade">
          {s.assets.map((sym, i) => {
            const t = tokenBySymbol(sym);
            return (
              <Fragment key={sym}>
                {i > 0 ? ', ' : null}
                {t ? <ExtLink href={explorerAddress(t.address)}>{sym}</ExtLink> : sym}
              </Fragment>
            );
          })}
        </Row>
        {s.kind === 'AI' && s.modelId ? (
          <Row label="Model committed">
            <ExtLink href={regTx}>{s.modelId}</ExtLink>
          </Row>
        ) : null}
        {s.modelHash ? (
          <Row label="Model hash">
            <ExtLink href={regTx} className={mono}>
              {short(s.modelHash)}
            </ExtLink>
          </Row>
        ) : null}
        <Row label="Creator earns">
          <ExtLink href={regTx}>{sharePct(s.creatorShareBps)} above your high</ExtLink>
        </Row>
        <Row label="Fee if you lose">None</Row>
        <Row label="Reveal window">
          <ExtLink href={regTx}>{duration(s.revealWindowSec)}</ExtLink>
        </Row>
        <Row label="Registered">
          <ExtLink href={regTx} className={mono}>
            blk {nf(s.registered.blockNumber)}
          </ExtLink>
        </Row>
        <Row label="Creator">
          {s.kind === 'HOUSE' ? (
            <ExtLink href={explorerAddress(s.creator)}>{APP_NAME} house</ExtLink>
          ) : (
            <ExtLink href={explorerAddress(s.creator)} className={mono}>
              {shortAddr(s.creator)}
            </ExtLink>
          )}
        </Row>
        <Row label="Signer">
          <ExtLink href={explorerAddress(s.signer)} className={mono}>
            {shortAddr(s.signer)}
          </ExtLink>
        </Row>
        {s.registry ? (
          <Row label="Signal contract">
            <ExtLink href={explorerAddress(s.registry)} className={mono}>
              {shortAddr(s.registry)}
            </ExtLink>
          </Row>
        ) : null}
        {s.houseVault ? (
          <Row label="House vault">
            <ExtLink href={explorerAddress(s.houseVault)} className={mono}>
              {shortAddr(s.houseVault)}
            </ExtLink>
          </Row>
        ) : null}
      </div>
    </div>
  );
}
