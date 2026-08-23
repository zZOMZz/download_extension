import { browser } from 'wxt/browser';
import { languageFromLocale } from '~/src/shared/i18n';
import {
  DEFAULT_SETTINGS,
  appLanguageSchema,
  extensionSettingsSchema,
  type AppLanguage,
  type ExtensionSettings,
  type NetworkSettings,
  type OutputFormat,
  type TaskConcurrency,
} from '~/src/shared/settings';

const SETTINGS_KEY = 'extension-settings';

function preferredLanguage(): AppLanguage {
  return languageFromLocale(browser.i18n.getUILanguage());
}

export async function readSettings(): Promise<ExtensionSettings> {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  const raw = stored[SETTINGS_KEY];
  const candidate = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? { language: preferredLanguage(), ...raw }
    : { ...DEFAULT_SETTINGS, language: preferredLanguage() };
  const parsed = extensionSettingsSchema.safeParse(candidate);
  return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS, language: preferredLanguage() };
}

export async function setLanguage(rawLanguage: AppLanguage): Promise<ExtensionSettings> {
  const language = appLanguageSchema.parse(rawLanguage);
  const settings = { ...(await readSettings()), language };
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

export async function setOutputFormat(outputFormat: OutputFormat): Promise<ExtensionSettings> {
  const settings = { ...(await readSettings()), outputFormat };
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

export async function setTaskConcurrency(taskConcurrency: TaskConcurrency): Promise<ExtensionSettings> {
  const settings = { ...(await readSettings()), taskConcurrency };
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

export async function setNetworkSettings(network: NetworkSettings): Promise<ExtensionSettings> {
  const settings = { ...(await readSettings()), network };
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}
