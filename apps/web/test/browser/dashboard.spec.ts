import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Multi-page dashboard: hash routes (`#/cluster`, `#/jobs`, …) with the Demo controls drawer (`#presenter`) on every page.
 * `?presenter=1` goes before the hash: `/?presenter=1#/cluster`.
 */
async function expectAccessibleAndContained(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(accessibility.violations).toEqual([]);
}

const go = (page: Page, route: string) => page.getByRole('navigation', { name: 'Dashboard pages' }).getByRole('link', { name: route }).click();

test('shell: five pages via the sidebar, deep links, legacy anchors and the browser back button', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/#/workflows');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Workflows');
  await expect(page).toHaveTitle('DataCenterOS · Workflows');
  await expect(page.getByRole('navigation', { name: 'Dashboard pages' }).getByRole('link', { name: 'Workflows' })).toHaveAttribute('aria-current', 'page');
  await go(page, 'Training jobs');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Training jobs');
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Workflows');
  // Legacy single-page anchors redirect to their page and the address bar shows the canonical deep link.
  await page.goto('/#scoreboard');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Benchmarks');
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/benchmarks');
  await expect(page.getByTestId('sim-clock')).not.toHaveText('—');
  await expect(page.getByText('SIMULATED', { exact: true })).toBeVisible();
  // The drawer is closed by default and the top-bar button opens it on any page.
  await expect(page.locator('#presenter')).not.toHaveAttribute('open', '');
  await page.getByRole('button', { name: 'Demo controls' }).click();
  await expect(page.locator('#presenter')).toHaveAttribute('open', '');
  await expectAccessibleAndContained(page);
  expect(errors).toEqual([]);
});

test('fixture: cluster, XID 79 rollback, reset, and the two-workflow scripted example', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?presenter=1#/cluster'); await page.getByLabel('Run view').selectOption('demo');
  await expect(page.getByRole('button', { name: /Rack \d/ })).toHaveCount(8);
  await expect(page.locator('[data-gpu]')).toHaveCount(8);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const clock = await page.getByTestId('sim-clock').innerText(); await page.waitForTimeout(1100); expect(await page.getByTestId('sim-clock').innerText()).toBe(clock);
  await page.getByRole('button', { name: /Rack 4/ }).click();
  await page.locator('[data-gpu="gpu-r4-n1-2"]').click();
  // The detailed fault form lives under "Advanced" in the Demo controls drawer.
  await page.locator('#presenter .demo-advanced > summary').click();
  await expect(page.getByLabel('Simulated GPU')).toHaveValue('gpu-r4-n1-2');
  await page.getByLabel('Simulated GPU').selectOption('gpu-r3-n1-0');
  await page.getByRole('button', { name: /Rack 3/ }).click();
  await page.getByRole('button', { name: 'Fail gpu-r3-n1-0 (Xid 79)' }).click();
  await expect(page.locator('[data-gpu="gpu-r3-n1-0"]')).toHaveAttribute('aria-label', /XID 79/);
  await go(page, 'Training jobs');
  await expect(page.locator('#jobs')).toContainText('work units lost');
  await page.getByRole('button', { name: 'Reset run', exact: true }).click(); await page.getByRole('button', { name: 'Confirm reset', exact: true }).click();
  await go(page, 'Cluster overview');
  await expect(page.locator('[data-gpu="gpu-r3-n1-0"]')).toHaveAttribute('aria-label', /ready/);

  // Only the two required fault controls are offered (scope §3).
  await expect(page.getByRole('button', { name: /XID 48/i })).toHaveCount(0);

  await page.getByLabel('Run view').selectOption('recovery');
  await go(page, 'Recovery activity');
  await expect(page.locator('#activity .incident')).toHaveCount(2);
  // The full event log lives on the Workflows page (Event log tab): newest 6 events until "Show all"; every event stays counted in the footer.
  await go(page, 'Workflows');
  await page.getByRole('tab', { name: 'Event log' }).click();
  const log = page.locator('#event-log');
  await expect(log.locator('.feed-event')).toHaveCount(6);
  await expect(log).toContainText('Showing 6 of 23');
  await log.getByRole('button', { name: 'Show all (23)' }).click();
  await expect(log.locator('.feed-event')).toHaveCount(23);
  await log.getByRole('button', { name: /^Nemotron/ }).click();
  await expect(log.locator('.feed-event')).toHaveCount(5);
  await log.getByRole('button', { name: /^All/ }).click();
  await log.getByRole('button', { name: 'Show all (23)' }).click();
  const exclude = log.locator('.tool-call', { hasText: 'list_placement_candidates' }).first();
  await exclude.locator('summary').click(); await expect(exclude).toContainText('Example: exclude');
  await page.getByRole('tab', { name: 'Workflows' }).click();
  await expect(page.locator('#workflows .wf-card')).toHaveCount(2);
  await expect(page.locator('#workflows')).toContainText('wf-example-cooling');
  await expect(page.locator('#workflows')).toContainText('wf-example-xid');
  await expect(page.locator('#ledger')).toContainText('BLOCKED');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expectAccessibleAndContained(page);
  await page.screenshot({ path: `.impeccable/review/${testInfo.project.name}.png`, fullPage: true, animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('local physics: pump degradation heats loop A, XID 79 fails a job, and the r6 probe is BLOCKED', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?presenter=1#/cluster');
  await expect(page.locator('#presenter')).toHaveAttribute('open', '');
  await expect(page.locator('#presenter > summary')).toContainText('Demo controls');
  await page.getByRole('button', { name: /Pump B Cools racks/ }).click();
  await page.locator('#presenter .demo-advanced > summary').click();
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

  // Step 3: with no persisted plan in local physics, the target is the GPU selected in the Advanced form.
  await page.getByRole('button', { name: /Rack 3,/ }).click();
  await page.getByLabel('Simulated GPU').selectOption('gpu-r3-n1-0');
  await expect(page.locator('#presenter .demo-target')).toContainText('gpu-r3-n1-0');
  await page.getByRole('button', { name: 'Fail a GPU (XID 79)' }).click();
  await page.getByRole('button', { name: 'Advance 30 sim-s' }).click();
  await expect(page.locator('[data-gpu="gpu-r3-n1-0"]')).toHaveAttribute('aria-label', /XID 79/);
  await go(page, 'Training jobs');
  await expect(page.locator('#jobs')).toContainText('failed');
  await expect(page.locator('[data-job-timeline="job-a"]')).toContainText('Rolled back to checkpoint');
  // The in-browser deterministic planner (not Nemotron) cordons the GPU and moves job-a from its checkpoint; the real
  // physics restarts it over 120 sim-s as we advance, and the card's step timeline follows it.
  await page.getByRole('button', { name: 'Run recovery (in-browser planner)' }).click();
  await expect(page.locator('.demo-recovery-log')).toContainText('migrate_restart job-a');
  await page.getByRole('button', { name: 'Advance 30 sim-s' }).click();
  await expect(page.locator('[data-job-timeline="job-a"]')).toContainText('Restarting');
  await expect(page.locator('[data-job-timeline="job-a"] .jobcard-chip.is-to')).toHaveText('R1+R2');
  await go(page, 'Cluster overview');
  await expect(page.locator('[data-move-arc="job-a"] text')).toContainText('job-a → R1+R2 · from checkpoint ckpt-job-a-1');
  await expect(page.locator('[data-move-role="is-move-dest"]')).toHaveCount(16);
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Advance 30 sim-s' }).click();
  await go(page, 'Training jobs');
  await expect(page.locator('[data-job-timeline="job-a"]')).toContainText(/Resumed from checkpoint ckpt-job-a-1 .* · lost [\d,]+ wu/);
  // The drawer travels with the page; the blocked probe is in the workflows ledger.
  await go(page, 'Workflows');
  await expect(page.locator('#ledger')).toContainText('BLOCKED');

  await page.getByRole('button', { name: 'Reset run', exact: true }).click(); await page.getByRole('button', { name: 'Confirm reset', exact: true }).click();
  await expect(page.locator('#ledger')).not.toContainText('BLOCKED');
  await go(page, 'Cluster overview');
  await expect(page.locator('[data-gpu="gpu-r3-n1-0"]')).toHaveAttribute('aria-label', /ready/);
  await expectAccessibleAndContained(page);
  await page.screenshot({ path: `.impeccable/review/local-${testInfo.project.name}.png`, fullPage: true, animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('benchmarks: deterministic rehearsal batch is labelled by provenance, never as Nemotron performance', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/#/benchmarks');
  const board = page.locator('#scoreboard');
  await expect(board.getByRole('heading', { name: 'No matched evaluation runs yet' })).toBeVisible();
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

test('real GPU tile sits on the cluster overview with its honesty labels; the retired #/real-gpu link redirects there', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/#/real-gpu');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Cluster overview');
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/cluster');
  await expect(page.getByRole('navigation', { name: 'Dashboard pages' }).getByRole('link', { name: 'Real GPU' })).toHaveCount(0);
  const tile = page.locator('.real-gpu');
  await expect(tile).toBeVisible();
  await expect(tile).toContainText('collector offline');
  await expect(tile).toContainText('observation only');
  // The tile sits directly above the safety tile in the right column.
  const side = page.locator('.cluster-side');
  await expect(side.locator('.real-gpu')).toBeVisible();
  await expect(side.locator('.cluster-impact-side .stat')).toContainText(/unsafe moves? blocked/);
  await page.locator('.real-gpu-how > summary').click();
  await expect(page.locator('.real-gpu-legend')).toContainText('REPLAY');
  await expectAccessibleAndContained(page);
  expect(errors).toEqual([]);
});
