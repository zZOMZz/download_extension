import { test as base, chromium, expect, type Page, type BrowserContext } from '@playwright/test';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createMediaFixture, type MediaFixture } from './media-fixture';

export const test = base.extend<{ media: MediaFixture; extensionId: string }>({
  media: async ({}, use) => {
    const fixture = await createMediaFixture();
    try { await use(fixture); } finally { await fixture.close(); }
  },
  context: async ({ media }, use, testInfo) => {
    const extensionPath = resolve('.output/chrome-mv3');
    await access(join(extensionPath, 'manifest.json'));
    const profile = await mkdtemp(join(tmpdir(), 'download-extension-e2e-profile-'));
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true, locale: 'en-US',
      viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--lang=en-US'],
    });
    const diagnostics: Array<{ type: string; text: string; url?: string | undefined }> = [];
    context.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') {
        diagnostics.push({ type: message.type(), text: message.text(), url: message.location().url });
      }
    });
    context.on('weberror', (error) => diagnostics.push({
      type: 'uncaught', text: error.error().stack ?? error.error().message, url: error.page()?.url(),
    }));
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    try {
      await media.installRoutes(context);
      await context.addInitScript(() => {
        if (location.protocol !== 'chrome-extension:') return;
        // Playwright cannot accept native OS filesystem dialogs. This only supplies
        // the authorized output handle; OPFS, IndexedDB, streams and all app code are real.
        const directory = async () => (await navigator.storage.getDirectory())
          .getDirectoryHandle('e2e-output', { create: true });
        Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: directory });
        Object.defineProperty(window, 'showSaveFilePicker', { configurable: true,
          value: async (options: { suggestedName: string }) => (await directory())
            .getFileHandle(options.suggestedName, { create: true }) });
      });
      // macOS Chrome's extension i18n locale follows the application UI language,
      // independently of Playwright's page locale. Select English through the actual settings UI.
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      const settings = await context.newPage();
      await settings.goto(`chrome-extension://${new URL(worker.url()).host}/manager.html`);
      await settings.getByRole('button', { name: /^(Settings|设置)$/ }).click();
      await settings.locator('select').filter({ has: settings.locator('option[value="en"]') }).selectOption('en');
      await expect(settings.getByRole('heading', { name: 'Download queue', exact: true })).toBeVisible();
      await settings.getByRole('button', { name: 'Close settings', exact: true }).click();
      await settings.close();
      await use(context);
    } finally {
      await context.tracing.stop({ path: testInfo.outputPath('trace.zip') });
      await testInfo.attach('browser trace', { path: testInfo.outputPath('trace.zip'), contentType: 'application/zip' });
      await testInfo.attach('browser diagnostics', {
        body: JSON.stringify({ browserVersion: context.browser()?.version(), diagnostics }, null, 2),
        contentType: 'application/json',
      });
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
  },
  extensionId: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    await use(new URL(worker.url()).host);
  },
});
export { expect };

export async function openPopup(context: BrowserContext, extensionId: string, source: Page): Promise<Page> {
  const popup = await context.newPage();
  // A popup opened as a test tab must leave the actual source tab active, just as
  // the browser action popup does. The production tabs.query path remains intact.
  await source.bringToFront();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  return popup;
}

export async function openManagerFromSource(context: BrowserContext, extensionId: string, source: Page): Promise<Page> {
  const popup = await openPopup(context, extensionId, source);
  const created = context.waitForEvent('page');
  await popup.getByRole('button', { name: 'Scan & batch download', exact: true }).click();
  const manager = await created;
  await manager.waitForURL('**/manager.html?*');
  await expect(manager.getByRole('heading', { name: 'Download queue', exact: true })).toBeVisible();
  return manager;
}

export async function outputNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('e2e-output');
    const names: string[] = [];
    for await (const name of (directory as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }).keys()) names.push(name);
    return names.sort();
  });
}

export async function outputBytes(page: Page, filename: string): Promise<Uint8Array> {
  const bytes = await page.evaluate(async (name) => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('e2e-output');
    const file = await (await directory.getFileHandle(name)).getFile();
    return Array.from(new Uint8Array(await file.arrayBuffer()));
  }, filename);
  return Uint8Array.from(bytes);
}
