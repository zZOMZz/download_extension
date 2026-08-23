export function formatBytes(value?: number): string | null {
  if (value === undefined) return null;
  if (value === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** unitIndex;
  return `${amount.toFixed(amount >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatByteRate(value?: number): string | null {
  const bytes = formatBytes(value);
  return bytes ? `${bytes}/s` : null;
}

export function formatDuration(value?: number): string | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  const seconds = Math.max(0, Math.ceil(value));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function displayUrl(rawUrl: string): string {
  if (rawUrl.startsWith('blob:')) return 'Page-generated media (blob URL)';

  try {
    const url = new URL(rawUrl);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return rawUrl;
  }
}

export function safeFilename(value: string, fallback = 'video'): string {
  const sanitized = value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return sanitized.slice(0, 120) || fallback;
}
