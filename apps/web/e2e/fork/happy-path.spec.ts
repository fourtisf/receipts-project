import { expect, test, type Page } from '@playwright/test';
import { createPublicClient, http, parseUnits, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { erc20Abi, receiptsVaultAbi, vaultFactoryAbi } from '@receipts/shared/abi';

/**
 * M4 acceptance on the anvil fork, from a fresh wallet:
 * connect → sign in → create vault → deposit → follow a strategy → pause → revoke bot → withdraw while paused + revoked.
 * Every transaction is sent by the page through an injected EIP-1193 wallet that forwards to anvil (unlocked dev key).
 */
const RPC = process.env.E2E_RPC_URL ?? 'http://127.0.0.1:8546';
const KEY = (process.env.E2E_WALLET_KEY ?? '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba') as `0x${string}`;
const FACTORY = process.env.E2E_FACTORY as Address;
const USDG = (process.env.E2E_USDG ?? '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168') as Address;
const STRATEGY_ID = Number(process.env.E2E_STRATEGY_ID ?? 1);
const WALLET = privateKeyToAccount(KEY).address;
const ZERO = '0x0000000000000000000000000000000000000000';

const pub = createPublicClient({ transport: http(RPC) });

/** A minimal injected wallet: no accounts until the site asks (fresh, not pre-authorized). */
function walletScript(rpc: string, account: string) {
  return `(() => {
    // like a real wallet, remember that this site was authorized (survives reloads)
    let authorized = localStorage.getItem('e2e-wallet-authorized') === '1';
    const authorize = (v) => { authorized = v; localStorage.setItem('e2e-wallet-authorized', v ? '1' : '0'); };
    const listeners = {};
    const emit = (e, v) => (listeners[e] || []).forEach((f) => f(v));
    async function rpcCall(method, params) {
      const r = await fetch(${JSON.stringify(rpc)}, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params: params || [] }),
      });
      const j = await r.json();
      if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; }
      return j.result;
    }
    window.ethereum = {
      isMetaMask: false,
      async request({ method, params }) {
        switch (method) {
          case 'eth_requestAccounts': authorize(true); emit('accountsChanged', [${JSON.stringify(account)}]); return [${JSON.stringify(account)}];
          case 'eth_accounts': return authorized ? [${JSON.stringify(account)}] : [];
          case 'wallet_requestPermissions': authorize(true); return [{ parentCapability: 'eth_accounts' }];
          case 'wallet_getPermissions': return authorized ? [{ parentCapability: 'eth_accounts' }] : [];
          case 'wallet_revokePermissions': authorize(false); return null;
          case 'wallet_switchEthereumChain':
          case 'wallet_addEthereumChain': return null;
          default: return rpcCall(method, params);
        }
      },
      on(e, f) { (listeners[e] ||= []).push(f); },
      removeListener(e, f) { listeners[e] = (listeners[e] || []).filter((x) => x !== f); },
    };
  })();`;
}

async function vaultOf(): Promise<Address> {
  return pub.readContract({ address: FACTORY, abi: vaultFactoryAbi, functionName: 'vaultOf', args: [WALLET] });
}

async function expectToast(page: Page, text: RegExp) {
  await expect(page.locator('.toast.show')).toContainText(text, { timeout: 90_000 });
}

test('fresh wallet: create vault, deposit, copy, pause, revoke, withdraw while paused and revoked', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(walletScript(RPC, WALLET));
  expect(await vaultOf()).toBe(ZERO); // fresh wallet

  // connect + sign in (SIWE: a signed message, no gas)
  await page.goto('/app/vault');
  await expect(page.getByRole('heading', { level: 1, name: 'Create your vault', exact: true })).toBeVisible();
  await page.locator('header').getByRole('button', { name: 'Connect wallet' }).click();
  await page.locator('[data-testid^="rk-wallet-option"]').first().click();
  await page.getByRole('button', { name: /sign message/i }).click();
  await expectToast(page, /Signed in\. No transaction, no gas\./);
  await expect(page.locator('header').getByRole('button', { name: /Wallet 0x/i })).toBeVisible();

  // create vault (createVault + one setTokenEnabled(false) per unchecked asset)
  await page.getByRole('button', { name: 'Create vault', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your vault', exact: true })).toBeVisible({ timeout: 180_000 });
  const vault = await vaultOf();
  expect(vault).not.toBe(ZERO);
  await expectToast(page, /Vault ready/);

  // deposit 100 USDG (approve + deposit)
  await page.getByLabel('Amount in USDG').fill('100');
  await page.getByRole('button', { name: 'Deposit', exact: true }).click();
  await expectToast(page, /Deposited 100 USDG/);
  expect(await pub.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [vault] })).toBe(
    parseUnits('100', 6),
  );

  // copy the strategy from its page
  await page.goto(`/app/s/${STRATEGY_ID}`);
  await page.locator('#copyAmt').fill('60');
  await page.getByRole('button', { name: /^Copy / }).click();
  await expectToast(page, /Copying .* with up to 60\.00 USD/);
  await expect(page.getByText('You are copying this strategy')).toBeVisible();
  expect(await pub.readContract({ address: vault, abi: receiptsVaultAbi, functionName: 'followingId' })).toBe(
    BigInt(STRATEGY_ID),
  );

  // pause, then revoke the bot
  await page.goto('/app/vault');
  await page.getByRole('button', { name: 'Pause trading' }).click();
  await expect(page.getByTestId('vault-status')).toHaveText('Paused', { timeout: 90_000 });
  await page.getByRole('button', { name: 'Revoke bot access' }).click();
  await expect(page.getByTestId('vault-status')).toHaveText('Bot access revoked', { timeout: 90_000 });
  expect(await pub.readContract({ address: vault, abi: receiptsVaultAbi, functionName: 'paused' })).toBe(true);
  expect(await pub.readContract({ address: vault, abi: receiptsVaultAbi, functionName: 'operator' })).toBe(ZERO);

  // withdraw works while paused and with the operator revoked
  const before = await pub.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [WALLET] });
  await page.getByLabel('Amount in USDG').fill('40');
  await page.getByRole('button', { name: 'Withdraw', exact: true }).first().click();
  await expectToast(page, /Withdrew 40 USDG to your wallet/);
  const after = await pub.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [WALLET] });
  expect(after - before).toBe(parseUnits('40', 6));
  expect(await pub.readContract({ address: vault, abi: receiptsVaultAbi, functionName: 'paused' })).toBe(true);
  expect(await pub.readContract({ address: vault, abi: receiptsVaultAbi, functionName: 'operator' })).toBe(ZERO);

  expect(errors).toEqual([]);
});
