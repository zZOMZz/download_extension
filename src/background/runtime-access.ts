/** Task storage is internal to the trusted manager host, never a content-script API. */
export function isManagerRuntimeSender(sender: {
  id?: string | undefined;
  url?: string | undefined;
  frameId?: number | undefined;
  tab?: { id?: number | undefined } | undefined;
}, runtimeId: string, managerUrl: string): boolean {
  if (sender.id !== runtimeId || sender.tab?.id === undefined ||
      (sender.frameId !== undefined && sender.frameId !== 0) || !sender.url) return false;
  try {
    const actual = new URL(sender.url);
    const expected = new URL(managerUrl);
    return actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname;
  } catch { return false; }
}
