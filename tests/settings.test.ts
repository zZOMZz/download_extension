import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  NETWORK_PRESETS,
  appLanguageSchema,
  extensionSettingsSchema,
  networkSettingsSchema,
  outputFormatSchema,
  taskConcurrencySchema,
} from '../src/shared/settings';

describe('output settings', () => {
  it('supports only Simplified Chinese and English', () => {
    expect(appLanguageSchema.parse('zh-CN')).toBe('zh-CN');
    expect(appLanguageSchema.parse('en')).toBe('en');
    expect(() => appLanguageSchema.parse('ja')).toThrow();
    expect(extensionSettingsSchema.parse({ outputFormat: 'mp4' }).language).toBe('en');
  });

  it('defaults HLS downloads to MP4', () => {
    expect(DEFAULT_SETTINGS.outputFormat).toBe('mp4');
  });

  it('accepts only supported output modes', () => {
    expect(outputFormatSchema.parse('original')).toBe('original');
    expect(() => outputFormatSchema.parse('avi')).toThrow();
    expect(extensionSettingsSchema.safeParse({ outputFormat: 'mp4' }).success).toBe(true);
  });

  it('supports one to four concurrent tasks and migrates older settings', () => {
    expect(DEFAULT_SETTINGS.taskConcurrency).toBe(2);
    expect(taskConcurrencySchema.parse(1)).toBe(1);
    expect(taskConcurrencySchema.parse(4)).toBe(4);
    expect(() => taskConcurrencySchema.parse(0)).toThrow();
    expect(() => taskConcurrencySchema.parse(5)).toThrow();
    expect(extensionSettingsSchema.parse({ outputFormat: 'original' }).taskConcurrency).toBe(2);
    expect(extensionSettingsSchema.parse({ outputFormat: 'original' }).network).toEqual(NETWORK_PRESETS.resilient);
  });

  it('bounds configurable network recovery values', () => {
    expect(DEFAULT_SETTINGS.network.profile).toBe('resilient');
    expect(networkSettingsSchema.parse(NETWORK_PRESETS.balanced).maxAttempts).toBe(4);
    expect(() => networkSettingsSchema.parse({ ...NETWORK_PRESETS.resilient, maxAttempts: 13 })).toThrow();
    expect(() => networkSettingsSchema.parse({ ...NETWORK_PRESETS.resilient, idleTimeoutSeconds: 2 })).toThrow();
  });
});
