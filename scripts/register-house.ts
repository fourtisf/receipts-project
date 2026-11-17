/**
 * Registers the launch house strategies (WORKER.md "House strategies at launch") on the deployed SignalRegistry and
 * stores their content-addressed metadata.
 *
 *   pnpm tsx scripts/register-house.ts            # dry run: prints metadata, hashes and the calls it would send
 *   pnpm tsx scripts/register-house.ts --broadcast
 *
 * Env (root .env): DATABASE_URL, RPC_URL, REGISTRY_ADDRESS, APP_DOMAIN, HOUSE_CREATOR_PRIVATE_KEY (the creator wallet;
 * must also be listed in HOUSE_CREATORS for the HOUSE label), SIGNER_PRIVATE_KEYS (first key = house signer),
 * AI_MODEL (News Desk commits keccak256(AI_MODEL) as modelHash).
 * Broadcasting sends real transactions — run it only after the mainnet deploy, with the owner's go-ahead.
 */
import { config as loadDotenv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PrismaClient } from '@prisma/client';
import {
  canonicalJson,
  metadataHash,
  modelHashOf,
  robinhoodChain,
  ZERO_HASH,
} from '../packages/shared/src/index.js';
import { signalRegistryAbi } from '../packages/shared/src/abi/index.js';
import { templateById, validateParams } from '../packages/strategies/src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadDotenv({ path: resolve(root, '.env') });
const broadcast = process.argv.includes('--broadcast');

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required (root .env)`);
  return v;
};

const PROMPT =
  'You manage a long-only position in {assets} against USDG. Read the headlines and hourly prices. Answer strictly as JSON {"action":"buy|sell|hold","asset":"SYMBOL","sizeBps":0-10000,"reason":"..."}. Prefer "hold" unless the news is material.';

async function main() {
  const rpc = need('RPC_URL');
  const registry = need('REGISTRY_ADDRESS') as Address;
  const domain = need('APP_DOMAIN');
  const creatorPk = process.env.HOUSE_CREATOR_PRIVATE_KEY as Hex | undefined;
  const signerPk = (process.env.SIGNER_PRIVATE_KEYS ?? '').split(',')[0]?.trim() as Hex | undefined;
  if (!signerPk) throw new Error('SIGNER_PRIVATE_KEYS is required (the house signer is the first key)');
  const signer = privateKeyToAccount(signerPk).address;
  const aiModel = process.env.AI_MODEL ?? '';

  const house = [
    {
      name: 'Mag7 Rebalance',
      description:
        'Holds AAPL, MSFT, NVDA, GOOGL, AMZN, META and TSLA tokens in equal weight and rebalances on Mondays at the US open when any weight drifts more than 2%.',
      template: 'rebalance',
      assets: ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA'],
      params: { schedule: 'weekly', drift: 2 },
      share: 1000,
      modelId: null as string | null,
    },
    {
      name: 'SPY / QQQ Rotation',
      description:
        'Holds whichever of SPY and QQQ has the stronger 20-day trend, checked every Friday close.',
      template: 'rotation',
      assets: ['SPY', 'QQQ'],
      params: { lookback: 20, schedule: 'weekly' },
      share: 1000,
      modelId: null,
    },
    {
      name: 'News Desk',
      description:
        'A language model reads NVDA, TSLA and COIN headlines and prices every hour in market hours. Each signal commits the model and a hash of the exact prompt and inputs, published at reveal.',
      template: 'ai_news',
      assets: ['NVDA', 'TSLA', 'COIN'],
      params: { model: aiModel || 'set AI_MODEL', promptTemplate: PROMPT, size: 50 },
      share: 2000,
      modelId: aiModel || null,
    },
  ];

  const prisma = new PrismaClient();
  const pub = createPublicClient({ chain: robinhoodChain(rpc), transport: http(rpc) });
  const wallet = creatorPk
    ? createWalletClient({
        chain: robinhoodChain(rpc),
        transport: http(rpc),
        account: privateKeyToAccount(creatorPk),
      })
    : null;

  for (const h of house) {
    const t = templateById(h.template)!;
    const v = validateParams(t, h.params, h.assets);
    if (!v.ok) throw new Error(`${h.name}: ${v.errors.join(' ')}`);
    if (h.template === 'ai_news' && !aiModel)
      throw new Error('AI_MODEL must be set to register News Desk (its hash is committed on-chain).');
    const meta = {
      schema: 'receipts.strategy/1',
      name: h.name,
      description: h.description,
      template: h.template,
      params: v.params,
      assets: h.assets,
      kind: 'HOUSE',
      modelId: h.modelId,
    };
    const hash = metadataHash(meta);
    const uri = `https://${domain}/api/metadata/${hash}`;
    const modelHash = h.modelId ? modelHashOf(h.modelId) : ZERO_HASH;
    console.log(
      `\n${h.name}\n  metadataURI ${uri}\n  signer ${signer}  share ${h.share} bps  revealWindow 3600 s  modelHash ${modelHash}`,
    );
    if (!broadcast) continue;
    if (!wallet) throw new Error('HOUSE_CREATOR_PRIVATE_KEY is required with --broadcast');
    await prisma.metadataDoc.upsert({
      where: { hash },
      create: {
        hash,
        json: JSON.parse(canonicalJson(meta)),
        creatorAddr: wallet.account.address.toLowerCase(),
      },
      update: {},
    });
    const tx = await wallet.writeContract({
      address: registry,
      abi: signalRegistryAbi,
      functionName: 'registerStrategy',
      args: [signer, h.share, 3600, modelHash, uri],
      chain: wallet.chain,
      account: wallet.account,
    });
    const r = await pub.waitForTransactionReceipt({ hash: tx });
    console.log(`  registered in tx ${tx} (block ${r.blockNumber}, ${r.status})`);
  }
  await prisma.$disconnect();
  if (!broadcast) console.log('\nDry run only. Re-run with --broadcast to send the transactions.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
