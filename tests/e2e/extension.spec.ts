import { test, expect, openPopup, openManagerFromSource, outputNames, outputBytes } from './fixtures';
import { validateMediaOutput } from '../../src/core/media/output-validator';

function blob(bytes: Uint8Array): Blob {
  return new Blob([bytes.slice().buffer as ArrayBuffer]);
}

test('built extension discovers local HLS and downloads a validated MP4 through its UI', async ({ context, page, media, extensionId }, testInfo) => {
  await page.goto(`${media.origin}/source.html`);
  const popup = await openPopup(context, extensionId, page);
  const candidate = popup.locator('.candidate').filter({ hasText: 'E2E HLS sample' });
  await expect(candidate).toHaveCount(1);
  await expect(candidate).toContainText('HLS');
  const created = context.waitForEvent('page');
  await candidate.getByRole('button', { name: 'Download', exact: true }).click();
  const downloader = await created;
  await downloader.waitForURL('**/downloader.html?*');
  await downloader.getByRole('button', { name: 'Choose file & download', exact: true }).click();
  await expect(downloader.getByText('Download complete', { exact: true })).toBeVisible();
  await expect(downloader.locator('.notice.error')).toHaveCount(0);
  const names = await outputNames(downloader);
  expect(names).toEqual(['E2E HLS sample.mp4']);
  const bytes = await outputBytes(downloader, names[0]!);
  expect(await validateMediaOutput(blob(bytes), { format: 'mp4', requireVideo: true }))
    .toMatchObject({ videoTracks: 1, audioTracks: 1, fragmented: false });
  expect(media.requests).toContain('/single.ts');
  await downloader.screenshot({ path: testInfo.outputPath('single-download.png'), fullPage: true });
});

test('persistent batch UI excludes a second manager and resumes saved HLS bytes after remount', async ({ context, page, media, extensionId }, testInfo) => {
  media.holdSecondSegment();
  await page.goto(media.seriesUrl);
  const manager = await openManagerFromSource(context, extensionId, page);
  await expect(manager.locator('.episode')).toHaveCount(2);
  await manager.locator('.add-bar select').selectOption('original');
  await manager.getByRole('button', { name: 'Add selected (2)', exact: true }).click();
  await expect(manager.locator('.task')).toHaveCount(2);
  await manager.getByRole('button', { name: 'Choose output folder', exact: true }).click();
  await expect(manager.getByRole('button', { name: 'Folder: e2e-output', exact: true })).toBeVisible();
  await manager.getByRole('button', { name: 'Settings', exact: true }).click();
  await manager.getByLabel('Concurrent downloads').selectOption('1');
  await manager.getByRole('button', { name: 'Close settings', exact: true }).click();
  await manager.getByRole('button', { name: 'Start queue (2)', exact: true }).click();
  const first = manager.locator('.task').filter({ hasText: 'Episode 1' });
  await expect(first).toContainText('Resume saved at 1 / 2');
  await expect.poll(() => media.requests.filter((path) => path === '/held.ts').length).toBe(1);

  const contender = await context.newPage();
  await contender.goto(`chrome-extension://${extensionId}/manager.html`);
  await expect(contender.locator('.task')).toHaveCount(2);
  await expect(contender.getByRole('button', { name: 'Folder: e2e-output', exact: true })).toBeVisible();
  await contender.getByRole('button', { name: 'Start queue (2)', exact: true }).click();
  await expect(contender.locator('.notice.error')).toContainText('Another window is executing or changing this queue');
  await expect(first.locator('.status')).toHaveText('Downloading');
  expect(media.requests.filter((path) => path === '/first.ts')).toHaveLength(1);
  expect(media.requests.filter((path) => path === '/held.ts')).toHaveLength(1);
  await contender.close();

  await manager.getByRole('button', { name: 'Stop queue', exact: true }).click();
  await expect(first.locator('.status')).toHaveText('Cancelled');
  expect((await outputBytes(manager, 'E2E Series - Episode 1.part.ts')).length).toBe(media.tsBytes);
  const savedNames = await outputNames(manager);
  expect(savedNames).toContain('E2E Series - Episode 1.part.ts');
  await manager.close();
  media.releaseSecondSegment();

  const recovered = await context.newPage();
  await recovered.goto(`chrome-extension://${extensionId}/manager.html`);
  await expect(recovered.locator('.task')).toHaveCount(2);
  const recoveredFirst = recovered.locator('.task').filter({ hasText: 'Episode 1' });
  await expect(recoveredFirst).toContainText('Resume saved at 1 / 2');
  await recoveredFirst.getByRole('button', { name: 'Resume', exact: true }).click();
  await recovered.getByRole('button', { name: 'Start queue (2)', exact: true }).click();
  await expect(recovered.locator('.task .status-completed')).toHaveCount(2);
  expect(media.requests.filter((path) => path === '/first.ts')).toHaveLength(1);
  expect(media.requests.filter((path) => path === '/held.ts')).toHaveLength(2);
  const outputs = await outputNames(recovered);
  expect(outputs).toEqual(['E2E Series - Episode 1.ts', 'E2E Series - Episode 2.ts']);
  const bytes = await outputBytes(recovered, outputs[0]!);
  expect(bytes.length).toBe(media.tsBytes * 2);
  expect(await validateMediaOutput(blob(bytes), { format: 'ts' })).toMatchObject({ format: 'ts', size: bytes.length });
  await recovered.screenshot({ path: testInfo.outputPath('recovered-batch.png'), fullPage: true });
});

test('Bilibili PGC discovery reaches the progressive batch executor after rebasing main', async ({ context, page, media, extensionId }, testInfo) => {
  await page.goto(media.bilibiliUrl);
  const manager = await openManagerFromSource(context, extensionId, page);
  await expect(manager.locator('.episode')).toHaveCount(1);
  await expect(manager.locator('.episode')).toContainText('Progressive MP4');
  await manager.getByRole('button', { name: 'Add selected (1)', exact: true }).click();
  await manager.getByRole('button', { name: 'Choose output folder', exact: true }).click();
  await manager.getByRole('button', { name: 'Start queue (1)', exact: true }).click();
  await expect(manager.locator('.task .status')).toHaveText('Completed');
  await expect(manager.locator('.task-error')).toHaveCount(0);
  expect(media.requests).toContain('/progressive.mp4');
  const names = await outputNames(manager);
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(/\.mp4$/);
  const bytes = await outputBytes(manager, names[0]!);
  expect(bytes.length).toBe(media.mp4Bytes);
  expect(await validateMediaOutput(blob(bytes), { format: 'mp4', requireVideo: true }))
    .toMatchObject({ videoTracks: 1, audioTracks: 1 });
  await manager.screenshot({ path: testInfo.outputPath('bilibili-progressive-batch.png'), fullPage: true });
});
