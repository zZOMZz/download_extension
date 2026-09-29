import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { test, expect, openPopup, openManagerFromSource, outputNames, outputBytes } from './fixtures';
import { installKoalaFixture, koalaFixtureUrl } from './koala-fixture';
import { validateMediaOutput } from '../../src/core/media/output-validator';

test('Koala cold source initializes on download without starting playback', async ({ context, page, extensionId }, testInfo) => {
  const fixture = await installKoalaFixture(context, { coldStart: true });
  try {
    // No user play: one SDK is stopped before processing, the other is created lazily.
    await page.goto(koalaFixtureUrl());
    await expect(page.locator('video')).toHaveAttribute('data-play-events', '0');
    expect(await page.locator('video').evaluate(video => (video as HTMLVideoElement).videoWidth)).toBe(0);
    const popup = await openPopup(context, extensionId, page);
    await expect(popup.getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
    const created = context.waitForEvent('page');
    await popup.getByRole('button', { name: 'Download', exact: true }).click();
    const manager = await created;
    await manager.getByRole('button', { name: 'Choose output folder', exact: true }).click();
    await manager.getByRole('button', { name: 'Start queue (1)', exact: true }).click();
    await expect(manager.locator('.task .status')).toHaveText('Completed', { timeout: 45_000 });
    await expect(page.locator('video')).toHaveAttribute('data-play-events', '0');
    expect(await page.locator('video').evaluate(video => ({ paused: (video as HTMLVideoElement).paused, time: (video as HTMLVideoElement).currentTime })))
      .toEqual({ paused: true, time: 0 });
    const bytes = await outputBytes(manager, 'Koala video 1.mp4');
    await writeFile(testInfo.outputPath('cold-source.mp4'), bytes);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-xerror', '-err_detect', 'explode', '-i', testInfo.outputPath('cold-source.mp4'), '-f', 'null', '-']);
    await manager.close(); await popup.close();
    await page.goto('https://app.koala-oss.club/');
    const batch = await openManagerFromSource(context, extensionId, page);
    await batch.getByRole('button', { name: 'Add selected (2)', exact: true }).click();
    await batch.getByRole('button', { name: 'Start queue (1)', exact: true }).click();
    await expect(batch.locator('.status-completed')).toHaveCount(2, { timeout: 45_000 });
    const lazy = await outputBytes(batch, 'Koala video 2.mp4');
    expect(await validateMediaOutput(new Blob([lazy.slice().buffer as ArrayBuffer]), { format: 'mp4', expectedDurationSeconds: 16 }))
      .toMatchObject({ videoTracks: 1, audioTracks: 1 });
  } finally { await fixture.close(); }
});

test('Koala single video uses the original popup, queue, SDK bridge and validated MP4 output', async ({ context, page, extensionId }, testInfo) => {
  const fixture = await installKoalaFixture(context);
  try {
    await page.goto(koalaFixtureUrl());
    await expect.poll(() => page.locator('video').evaluate(video => (video as HTMLVideoElement).videoWidth)).toBe(320);
    const popup = await openPopup(context, extensionId, page);
    await expect(popup.locator('.candidate')).toHaveCount(1);
    await expect(popup.locator('.candidate')).toContainText('Koala video 1');
    const created = context.waitForEvent('page');
    await popup.getByRole('button', { name: 'Download', exact: true }).click();
    const manager = await created;
    await expect(manager.locator('.task')).toHaveCount(1);
    const sourceStatus = await manager.evaluate(async sourceUrl => {
      const api = (globalThis as unknown as { chrome: typeof import('wxt/browser').browser }).chrome;
      const [source] = await api.tabs.query({ url: sourceUrl });
      const direct = await api.tabs.sendMessage(source!.id!, { type: 'browser-source:rpc', owner: 1, command: { method: 'status' } }, { frameId: 0 });
      if (direct?.ok) throw new Error('Content bridge accepted a forged owner outside the broker.');
      return api.runtime.sendMessage({ type: 'browser-source:relay', sourceTabId: source!.id!, command: { method: 'status' } });
    }, koalaFixtureUrl());
    await testInfo.attach('source status', { body: JSON.stringify(sourceStatus), contentType: 'application/json' });
    expect(sourceStatus).toMatchObject({ ok: true, value: { state: 'ready' } });
    await manager.getByRole('button', { name: 'Choose output folder', exact: true }).click();
    await manager.getByRole('button', { name: 'Start queue (1)', exact: true }).click();
    await expect(manager.locator('.task .status')).toHaveText('Completed', { timeout: 45_000 });
    expect(await outputNames(manager)).toEqual(['Koala video 1.mp4']);
    const bytes = await outputBytes(manager, 'Koala video 1.mp4');
    expect(await validateMediaOutput(new Blob([bytes.slice().buffer as ArrayBuffer]), { format: 'mp4', requireVideo: true, expectedDurationSeconds: 16 }))
      .toMatchObject({ videoTracks: 1, audioTracks: 1, fragmented: false });
    const output = testInfo.outputPath('koala-complete.mp4'); await writeFile(output, bytes);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-xerror', '-err_detect', 'explode', '-i', output, '-f', 'null', '-']);
    await manager.screenshot({ path: testInfo.outputPath('koala-single.png'), fullPage: true });
  } finally { await fixture.close(); }
});

test('Koala source closure preserves committed tracks and resumes through a fresh page', async ({ context, page, extensionId }, testInfo) => {
  const fixture = await installKoalaFixture(context); fixture.holdFifthSegment();
  try {
    await page.goto(koalaFixtureUrl());
    const manager = await openManagerFromSource(context, extensionId, page);
    await manager.getByRole('button', { name: 'Add selected (1)', exact: true }).click();
    await manager.getByRole('button', { name: 'Choose output folder', exact: true }).click();
    await manager.getByRole('button', { name: 'Start queue (1)', exact: true }).click();
    await expect(manager.locator('.checkpoint-detail')).toContainText('4 / 8', { timeout: 30_000 });
    await page.close();
    await expect(manager.locator('.task .status')).toHaveText('Waiting for source page', { timeout: 15_000 });
    await expect(manager.getByRole('link', { name: 'Open source page', exact: true })).toBeVisible();
    expect(await outputNames(manager)).toEqual(['Koala video 1.audio.source.part.m4s', 'Koala video 1.video.source.part.m4s']);
    fixture.release();
    await manager.getByRole('button', { name: 'Resume', exact: true }).click();
    await manager.getByRole('button', { name: 'Start queue (1)', exact: true }).click();
    await expect(manager.locator('.task .status')).toHaveText('Completed', { timeout: 45_000 });
    const bytes = await outputBytes(manager, 'Koala video 1.mp4');
    expect(await validateMediaOutput(new Blob([bytes.slice().buffer as ArrayBuffer]), { format: 'mp4', expectedDurationSeconds: 16 }))
      .toMatchObject({ videoTracks: 1, audioTracks: 1 });
    expect(context.pages().filter(page => page.url().startsWith('https://app.koala-oss.club/videos/'))).toHaveLength(0);
    await manager.screenshot({ path: testInfo.outputPath('koala-resumed.png'), fullPage: true });
  } finally { await fixture.close(); }
});

test('Koala homepage batch prepares separate inline and worker SDK sessions', async ({ context, page, extensionId }, testInfo) => {
  const fixture = await installKoalaFixture(context);
  try {
    await page.goto('https://app.koala-oss.club/');
    const manager = await openManagerFromSource(context, extensionId, page);
    await expect(manager.locator('.episode')).toHaveCount(2);
    await manager.getByRole('button', { name: 'Add selected (2)', exact: true }).click();
    await manager.getByRole('button', { name: 'Choose output folder', exact: true }).click();
    await manager.getByRole('button', { name: 'Start queue (2)', exact: true }).click();
    await expect(manager.locator('.status-completed')).toHaveCount(2, { timeout: 45_000 });
    expect(await outputNames(manager)).toEqual(['Koala video 1.mp4', 'Koala video 2.mp4']);
    for (const filename of await outputNames(manager)) {
      const bytes = await outputBytes(manager, filename);
      expect(await validateMediaOutput(new Blob([bytes.slice().buffer as ArrayBuffer]), { format: 'mp4', expectedDurationSeconds: 16 }))
        .toMatchObject({ audioTracks: 1, videoTracks: 1 });
    }
    await manager.screenshot({ path: testInfo.outputPath('koala-batch.png'), fullPage: true });
  } finally { await fixture.close(); }
});
