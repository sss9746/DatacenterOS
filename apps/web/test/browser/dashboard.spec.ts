import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function expectAccessibleAndContained(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(accessibility.violations).toEqual([]);
}

test('fixture: cluster, XID 79 rollback, reset, and the two-workflow scripted example', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?presenter=1'); await page.getByLabel('Run view').selectOption('demo');
  await expect(page.getByRole('button', { name: /Rack \d/ })).toHaveCount(8);
  await expect(page.locator('[data-gpu]')).toHaveCount(8);
  await expect(page.getByRole('heading', { name: 'No matched evaluation runs yet' })).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const clock = await page.getByTestId('sim-clock').innerText(); await page.waitForTimeout(1100); expect(await page.getByTestId('sim-clock').innerText()).toBe(clock);
  await page.getByRole('button', { name: /Rack 4/ }).click();
  await page.locator('[data-gpu="gpu-r4-n1-2"]').click();
  await expect(page.getByLabel('Simulated GPU')).toHaveValue('gpu-r4-n1-2');
  // The detailed fault form lives under "Advanced" in the Demo controls bar.
  await page.locator('#presenter .demo-advanced > summary').click();
  await page.getByLabel('Simulated GPU').selectOption('gpu-r3-n1-0');
  await page.getByRole('button', { name: /Rack 3/ }).click();
  await page.getByRole('button', { name: 'Fail gpu-r3-n1-0 (Xid 79)' }).click();
  await expect(page.locator('[data-gpu="gpu-r3-n1-0"]')).toHaveAttribute('aria-label', /XID 79/);
  await expect(page.locator('#jobs')).toContainText('work units lost');
  await page.getByRole('button', { name: 'Reset run', exact: true }).click(); await page.getByRole('button', { name: 'Confirm reset', exact: true }).click();
  await expect(page.locator('[data-gpu="gpu-r3-n1-0"]')).toHaveAttribute('aria-label', /ready/);

  // Only the two required fault controls are offered (scope §3).
  await expect(page.getByRole('button', { name: /XID 48/i })).toHaveCount(0);

  await page.getByLabel('Run view').selectOption('recovery');
  await expect(page.locator('.incident')).toHaveCount(2);
  await expect(page.locator('.wf-card')).toHaveCount(2);
  await expect(page.locator('#workflows')).toContainText('wf-example-cooling');
  await expect(page.locator('#workflows')).toContainText('wf-example-xid');
  // The feed shows the newest 6 events until "Show all"; every event stays counted in the footer.
  await expect(page.locator('.feed-event')).toHaveCount(6);
  await expect(page.locator('#activity')).toContainText('Showing 6 of 17');
  await page.getByRole('button', { name: 'Show all (17)' }).click();
  await expect(page.locator('.feed-event')).toHaveCount(17);
  await expect(page.locator('.feed-event.actor-nemotron')).toHaveCount(4);
  await page.getByRole('button', { name: /^Nemotron/ }).click();
  await expect(page.locator('.feed-event')).toHaveCount(4);
  await expect(page.locator('#activity')).toContainText('13 hidden by filter');
  await page.getByRole('button', { name: /^All/ }).click();
  await page.getByRole('button', { name: 'Show all (17)' }).click();
  const exclude = page.locator('.tool-call', { hasText: 'list_placement_candidates' }).first();
  await exclude.locator('summary').click(); await expect(exclude).toContainText('Example: exclude');
  await expect(page.locator('#ledger')).toContainText('BLOCKED');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expectAccessibleAndContained(page);
  await page.screenshot({ path: `.impeccable/review/${testInfo.project.name}.png`, fullPage: true, animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('local physics: pump degradation heats loop A, XID 79 fails a job, and the r6 probe is BLOCKED', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?presenter=1');
  await expect(page.locator('#presenter')).toHaveAttribute('open', '');
  await expect(page.locator('#presenter > summary')).toContainText('Demo controls');
  await page.getByRole('button', { name: /Pump B Cools racks/ }).click();
  await expect(page.locator('select[id$="-pump"]')).toHaveValue('pump-b');
  await page.getByRole('button', { name: /Pump A Cools racks/ }).click();
  await expect(page.locator('select[id$="-pump"]')).toHaveValue('pump-a');
  const before = await page.getByRole('button', { name: /Rack 3,/ }).innerText();
  // Step 1: the same pump-a 60% degradation the Advanced form's "Degrade pump-a by 60%" submits.
  await page.getByRole('button', { name: 'Break cooling pump A' }).click();
  await page.getByRole('button', { name: 'Advance 30 sim-s' }).click();
  await expect(page.getByRole('button', { name: /Rack 3,/ })).not.toHaveText(before);

  // Step 2: the r6 safety probe; the verdict renders inline under the button.
  await page.getByRole('button', { name: 'Try unsafe move to hot rack 6' }).click();
  const probe = page.locator('.presenter-probe');
  await expect(probe).toContainText('BLOCKED');
  await expect(probe).toContainText('DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT');
  await expect(page.locator('#ledger')).toContainText('BLOCKED');

  // Step 3: with no persisted plan in local physics, the target is the GPU selected in the Advanced form.
  await page.getByRole('button', { name: /Rack 3,/ }).click();
  await page.locator('#presenter .demo-advanced > summary').click();
  await page.getByLabel('Simulated GPU').selectOption('gpu-r3-n1-0');
  await expect(page.locator('#presenter .demo-target')).toContainText('gpu-r3-n1-0');
  await page.getByRole('button', { name: 'Fail a GPU (XID 79)' }).click();
  await page.getByRole('button', { name: 'Advance 30 sim-s' }).click();
  await expect(page.locator('[data-gpu="gpu-r3-n1-0"]')).toHaveAttribute('aria-label', /XID 79/);
  await expect(page.locator('#jobs')).toContainText('failed');

  await page.getByRole('button', { name: 'Reset run', exact: true }).click(); await page.getByRole('button', { name: 'Confirm reset', exact: true }).click();
  await expect(page.locator('[data-gpu="gpu-r3-n1-0"]')).toHaveAttribute('aria-label', /ready/);
  await expect(page.locator('#ledger')).not.toContainText('BLOCKED');
  await expectAccessibleAndContained(page);
  await page.screenshot({ path: `.impeccable/review/local-${testInfo.project.name}.png`, fullPage: true, animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('scoreboard: deterministic rehearsal batch is labelled by provenance, never as Nemotron performance', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const board = page.locator('#scoreboard');
  await expect(board).toContainText('No matched evaluation runs yet');
  await board.getByRole('button', { name: 'Load deterministic rehearsal batch (mock only)' }).click();
  await expect(board).toContainText('rehearsal-fixed12-nollm');
  await expect(board).toContainText('Deterministic planner');
  await expect(board).toContainText('cannot substantiate a Nemotron performance claim');
  await expect(board).toContainText('finite-horizon work deficit');
  await expect(board).not.toContainText('$');
  await expect(board).not.toContainText(/GPU-hours/i);
  await board.scrollIntoViewIfNeeded();
  await expectAccessibleAndContained(page);
  await board.screenshot({ path: `.impeccable/review/scoreboard-${testInfo.project.name}.png`, animations: 'disabled' });
  expect(errors).toEqual([]);
});
