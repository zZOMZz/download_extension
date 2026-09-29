export const KOALA_ORIGIN = 'https://app.koala-oss.club';
const VIDEO_PATH = /^\/videos\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

export function koalaVideoId(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    return url.origin === KOALA_ORIGIN && !url.username && !url.password
      ? VIDEO_PATH.exec(url.pathname)?.[1]?.toLowerCase() : undefined;
  } catch { return undefined; }
}
export function koalaVideoUrl(id: string): string { return `${KOALA_ORIGIN}/videos/${id}`; }
export function isKoalaDiscoveryPage(url: URL): boolean {
  return url.origin === KOALA_ORIGIN && (url.pathname === '/' || Boolean(koalaVideoId(url.href)));
}
