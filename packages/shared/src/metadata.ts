import { keccak256 } from 'viem';

/** Deterministic JSON (sorted keys, no whitespace) so the metadata hash is reproducible by anyone. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** keccak256(utf8(canonicalJson(doc))) — the id in metadataURI `${base}/metadata/<hash>`. */
export function metadataHash(doc: unknown): `0x${string}` {
  return keccak256(new TextEncoder().encode(canonicalJson(doc)));
}

/** Extracts the content hash from a metadataURI produced by the API, or null for foreign URIs. */
export function metadataHashFromUri(uri: string): `0x${string}` | null {
  const m = /\/metadata\/(0x[0-9a-fA-F]{64})$/.exec(uri);
  return m ? (m[1]!.toLowerCase() as `0x${string}`) : null;
}

/** URL-safe slug from a strategy name, suffixed with the on-chain id to stay unique. */
export function slugify(name: string, id: number): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base ? `${base}-${id}` : `strategy-${id}`;
}
