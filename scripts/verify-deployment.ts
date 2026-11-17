/**
 * Anyone can compare the deployed bytecode with this repository (HANDOFF §11).
 *
 *   cd packages/contracts && forge build && cd ../..
 *   RPC_URL=https://... pnpm verify-deployment                       # uses packages/contracts/deployments/4663.json
 *   RPC_URL=... pnpm verify-deployment --vault 0xVault...              # also checks a user vault
 *
 * Immutable values (constructor-set addresses, caps) are masked using the compiler's immutableReferences; everything
 * else — every opcode of the logic — must match byte for byte. foundry.toml sets bytecode_hash = "none", so builds are
 * reproducible from source.
 */
import { config as loadDotenv } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, type Address } from 'viem';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadDotenv({ path: resolve(root, '.env') });
const rpc = process.env.RPC_URL ?? 'https://robinhood.drpc.org';
const client = createPublicClient({ transport: http(rpc, { retryCount: 4 }) });

interface Artifact {
  deployedBytecode: {
    object: string;
    immutableReferences?: Record<string, { start: number; length: number }[]>;
  };
}

function artifact(file: string, name: string): Artifact {
  const p = resolve(root, `packages/contracts/out/${file}/${name}.json`);
  if (!existsSync(p)) throw new Error(`Missing ${p}. Run \`forge build\` in packages/contracts first.`);
  return JSON.parse(readFileSync(p, 'utf8')) as Artifact;
}

function mask(hex: string, refs: Artifact['deployedBytecode']['immutableReferences']): string {
  const bytes = Buffer.from(hex.replace(/^0x/, ''), 'hex');
  for (const list of Object.values(refs ?? {}))
    for (const r of list) bytes.fill(0, r.start, r.start + r.length);
  return bytes.toString('hex');
}

async function check(label: string, address: Address, art: Artifact): Promise<boolean> {
  const onchain = await client.getCode({ address });
  if (!onchain || onchain === '0x') {
    console.log(`✗ ${label} ${address}: no code at this address`);
    return false;
  }
  const a = mask(onchain, art.deployedBytecode.immutableReferences);
  const b = mask(art.deployedBytecode.object, art.deployedBytecode.immutableReferences);
  const same = a === b;
  console.log(
    `${same ? '✓' : '✗'} ${label} ${address}: ${same ? 'bytecode matches the repo' : `MISMATCH (on-chain ${a.length / 2} bytes, repo ${b.length / 2} bytes)`}`,
  );
  return same;
}

async function main() {
  const chainId = await client.getChainId();
  const depFile = resolve(
    root,
    `packages/contracts/deployments/${process.env.DEPLOYMENT_NAME ?? chainId}.json`,
  );
  const dep = existsSync(depFile)
    ? (JSON.parse(readFileSync(depFile, 'utf8')) as { registry: Address; factory: Address })
    : null;
  const registry = (process.env.REGISTRY_ADDRESS ?? dep?.registry) as Address | undefined;
  const factory = (process.env.FACTORY_ADDRESS ?? dep?.factory) as Address | undefined;
  if (!registry || !factory)
    throw new Error(`No addresses: set REGISTRY_ADDRESS / FACTORY_ADDRESS or provide ${depFile}`);
  console.log(`chain ${chainId}, RPC ${rpc.replace(/\/\/([^/]+)\/.+/, '//$1/…')}`);
  const results = [
    await check('SignalRegistry', registry, artifact('SignalRegistry.sol', 'SignalRegistry')),
    await check('VaultFactory  ', factory, artifact('VaultFactory.sol', 'VaultFactory')),
  ];
  const vi = process.argv.indexOf('--vault');
  if (vi > 0 && process.argv[vi + 1])
    results.push(
      await check(
        'ReceiptsVault ',
        process.argv[vi + 1] as Address,
        artifact('ReceiptsVault.sol', 'ReceiptsVault'),
      ),
    );
  process.exit(results.every(Boolean) ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
