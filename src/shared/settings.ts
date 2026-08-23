import { z } from 'zod';

export const appLanguageSchema = z.enum(['zh-CN', 'en']);
export type AppLanguage = z.infer<typeof appLanguageSchema>;

export const outputFormatSchema = z.enum(['mp4', 'original']);
export type OutputFormat = z.infer<typeof outputFormatSchema>;

export const taskConcurrencySchema = z.number().int().min(1).max(4);
export type TaskConcurrency = z.infer<typeof taskConcurrencySchema>;

export const networkProfileSchema = z.enum(['balanced', 'resilient', 'custom']);
export type NetworkProfile = z.infer<typeof networkProfileSchema>;

export const networkSettingsSchema = z.object({
  profile: networkProfileSchema,
  maxAttempts: z.number().int().min(1).max(12),
  firstByteTimeoutSeconds: z.number().int().min(5).max(120),
  idleTimeoutSeconds: z.number().int().min(5).max(120),
  taskRecoveryAttempts: z.number().int().min(0).max(12),
  taskRetryBaseDelaySeconds: z.number().int().min(5).max(300),
  taskRetryMaxDelaySeconds: z.number().int().min(30).max(900),
  resumePartialDownloads: z.boolean(),
});

export type NetworkSettings = z.infer<typeof networkSettingsSchema>;

export const NETWORK_PRESETS: Record<Exclude<NetworkProfile, 'custom'>, NetworkSettings> = {
  balanced: {
    profile: 'balanced',
    maxAttempts: 4,
    firstByteTimeoutSeconds: 15,
    idleTimeoutSeconds: 20,
    taskRecoveryAttempts: 2,
    taskRetryBaseDelaySeconds: 15,
    taskRetryMaxDelaySeconds: 120,
    resumePartialDownloads: true,
  },
  resilient: {
    profile: 'resilient',
    maxAttempts: 8,
    firstByteTimeoutSeconds: 30,
    idleTimeoutSeconds: 45,
    taskRecoveryAttempts: 6,
    taskRetryBaseDelaySeconds: 30,
    taskRetryMaxDelaySeconds: 300,
    resumePartialDownloads: true,
  },
};

export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = NETWORK_PRESETS.resilient;

export const extensionSettingsSchema = z.object({
  language: appLanguageSchema.default('en'),
  outputFormat: outputFormatSchema,
  taskConcurrency: taskConcurrencySchema.default(2),
  network: networkSettingsSchema.default(DEFAULT_NETWORK_SETTINGS),
});

export type ExtensionSettings = z.infer<typeof extensionSettingsSchema>;

export const DEFAULT_SETTINGS: ExtensionSettings = {
  language: 'en',
  outputFormat: 'mp4',
  taskConcurrency: 2,
  network: DEFAULT_NETWORK_SETTINGS,
};
