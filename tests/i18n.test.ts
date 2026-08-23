import { describe, expect, it } from 'vitest';
import { createTranslator, languageFromLocale, LANGUAGE_OPTIONS } from '../src/shared/i18n';

describe('i18n', () => {
  it('exposes exactly Simplified Chinese and English', () => {
    expect(LANGUAGE_OPTIONS).toEqual([
      { value: 'zh-CN', label: '简体中文' },
      { value: 'en', label: 'English' },
    ]);
  });

  it('translates and interpolates messages', () => {
    expect(createTranslator('en')('startQueue', { count: 3 })).toBe('Start queue (3)');
    expect(createTranslator('zh-CN')('startQueue', { count: 3 })).toBe('开始队列（3）');
  });

  it('uses Chinese for Chinese browser locales and English otherwise', () => {
    expect(languageFromLocale('zh-CN')).toBe('zh-CN');
    expect(languageFromLocale('zh-TW')).toBe('zh-CN');
    expect(languageFromLocale('en-US')).toBe('en');
  });
});
