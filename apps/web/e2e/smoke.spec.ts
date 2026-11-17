import { expect, test, type Page } from '@playwright/test';

/**
 * Read-only smoke tests: every screen renders, nothing logs a console error, nothing scrolls sideways.
 * Data-dependent steps are skipped (not failed) when the API has no data yet.
 */

// A dropped live-update socket (API restarting / not running) is an environment issue, not a page error.
const IGNORED = [/WebSocket connection to .* failed/i];

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !IGNORED.some((r) => r.test(m.text()))) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function noHorizontalScroll(page: Page) {
  const { sw, cw } = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  expect(sw, 'page must not scroll horizontally').toBeLessThanOrEqual(cw + 1);
}

test.describe('landing', () => {
  test('renders hero, sections and footer without console errors', async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Track records you can’t fake.');
    await expect(page.getByRole('link', { name: /launch app/i }).first()).toBeVisible();
    await expect(page.locator('#features')).toContainText('Everything a strategy claims, you can check.');
    await expect(page.locator('footer')).toContainText('Not investment advice');
    await expect(page.locator('body')).not.toContainText(/demo data/i);
    await noHorizontalScroll(page);
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
  });

  test('how-it-works steps are selectable and highlight the receipt', async ({ page }) => {
    await page.goto('/');
    const execute = page.getByRole('tab', { name: /execute/i });
    await execute.click();
    await expect(execute).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#how-panel .hl')).toHaveText('2 Execute');
    await execute.press('ArrowDown');
    await expect(page.getByRole('tab', { name: /reveal/i })).toHaveAttribute('aria-selected', 'true');
  });

  test('worst-case calculator is pure client math', async ({ page }) => {
    await page.goto('/');
    const out = page.locator('output[for="cLimit cSlip"]');
    await expect(out).toContainText('≈ 9.00'); // 500 × (1.0% + 0.3% + 0.5%)
    await page.locator('#cLimit').fill('1000');
    await expect(out).toContainText('≈ 18.00');
  });
});

test.describe('docs and legal', () => {
  for (const [path, heading] of [
    ['/docs', /^How .+ works$/],
    ['/terms', /^Terms of use$/],
    ['/privacy', /^Privacy$/],
  ] as const) {
    test(`${path} renders`, async ({ page }) => {
      const errors = watchConsole(page);
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
      await expect(page.locator('footer')).toContainText('Not investment advice');
      if (path !== '/docs')
        await expect(page.getByText('not yet reviewed by a lawyer', { exact: false })).toBeVisible();
      await noHorizontalScroll(page);
      expect(errors).toEqual([]);
    });
  }
});

test.describe('app', () => {
  test('strategies list renders KPIs, filters and table', async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto('/app');
    await expect(page.getByRole('heading', { level: 1, name: 'Strategies' })).toBeVisible();
    for (const k of ['Receipts printed', 'Strategies live', 'Missed reveals', 'In user vaults'])
      await expect(page.getByText(k, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Crypto', exact: true }).click();
    await expect(page).toHaveURL(/category=crypto/);
    await expect(page.getByRole('button', { name: 'Crypto', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await noHorizontalScroll(page);
    expect(errors).toEqual([]);
  });

  test('strategy detail, receipt permalink and copy panel', async ({ page, request }) => {
    const errors = watchConsole(page);
    const res = await request.get('/api/strategies?limit=1');
    test.skip(!res.ok(), 'API not reachable');
    const body = (await res.json()) as { items: { id: number; name: string }[] };
    test.skip(body.items.length === 0, 'no strategies indexed yet');
    const s = body.items[0]!;
    await page.goto(`/app/s/${s.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(s.name);
    await expect(page.getByRole('heading', { name: 'On-chain facts' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect wallet to copy' })).toBeVisible();
    await expect(page.locator('#copyAmt')).toBeDisabled();
    await noHorizontalScroll(page);

    const slip = page.locator('.rgrid a').first();
    if ((await slip.count()) > 0) {
      await slip.click();
      await expect(page).toHaveURL(/\/receipt\/\d+$/);
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Receipt #');
      await expect(page.locator('.stamp')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Checks' })).toBeVisible();
      await noHorizontalScroll(page);
    }
    expect(errors).toEqual([]);
  });

  test('verify form validates input and checks a receipt', async ({ page, request }) => {
    const errors = watchConsole(page);
    await page.goto('/app/verify');
    await expect(page.getByText('re-checks it against Robinhood Chain', { exact: false })).toBeVisible();
    await page.locator('#verifyInput').fill('0x1234');
    await page.getByRole('button', { name: 'Check receipt' }).click();
    await expect(page.locator('.error[role="alert"]')).toContainText('incomplete');

    const latest = await request.get('/api/receipts/latest?limit=1');
    const items = latest.ok() ? ((await latest.json()) as { items: { receiptNo: number }[] }).items : [];
    if (items.length > 0) {
      await page.locator('#verifyInput').fill(String(items[0]!.receiptNo));
      await page.getByRole('button', { name: 'Check receipt' }).click();
      await expect(page.locator('.checks li')).toHaveCount(5);
      await expect(page).toHaveURL(new RegExp(`q=${items[0]!.receiptNo}`));
      // the page says which source it used: chain (verified in the browser) or API (fallback)
      await expect(page.getByTestId('checks-source')).toHaveAttribute('data-source', /^(chain|api)$/, {
        timeout: 30_000,
      });
    }
    await noHorizontalScroll(page);
    expect(errors).toEqual([]);
  });

  test('vault page shows the connect prompt and house vaults', async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto('/app/vault');
    await expect(page.getByRole('heading', { level: 1, name: 'Create your vault' })).toBeVisible();
    // with contracts configured: a connect prompt; without (local dev): an honest "not deployed" note
    await expect(
      page
        .getByRole('button', { name: 'Connect wallet to create a vault' })
        .or(page.getByText('not deployed on this network yet')),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'House vaults' })).toBeVisible();
    await noHorizontalScroll(page);
    expect(errors).toEqual([]);
  });

  test('create strategy page renders the form and the preview', async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto('/app/create');
    await expect(page.getByRole('heading', { level: 1, name: 'Create strategy' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Backtest preview' })).toBeVisible();
    await expect(page.getByLabel('Template')).toBeVisible();
    await expect(page.getByText('Sign in to run the backtest preview', { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create strategy' })).toHaveAttribute('aria-current', 'page');
    await noHorizontalScroll(page);
    expect(errors).toEqual([]);
  });

  test('unknown strategy shows the not-found page', async ({ page }) => {
    const res = await page.goto('/app/s/999999');
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Nothing printed here' })).toBeVisible();
  });
});
