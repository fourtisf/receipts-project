import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for salts and signals at rest (SecretSalt). Key: SALT_ENCRYPTION_KEY, 32 bytes hex.
 * Format: base64(iv[12] | tag[16] | ciphertext). Never log plaintext before reveal.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(hexKey: string | undefined) {
    const k = (hexKey ?? '').replace(/^0x/, '');
    if (!/^[0-9a-fA-F]{64}$/.test(k)) {
      throw new Error(
        'SALT_ENCRYPTION_KEY must be 32 bytes of hex (64 hex chars). Generate one with: openssl rand -hex 32',
      );
    }
    this.key = Buffer.from(k, 'hex');
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }

  decrypt(blob: string): string {
    const raw = Buffer.from(blob, 'base64');
    const d = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  }
}

export function randomSalt(): `0x${string}` {
  return `0x${randomBytes(32).toString('hex')}`;
}
