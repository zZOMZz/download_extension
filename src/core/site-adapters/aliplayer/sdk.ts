/** Version-sensitive SDK objects stay inside the page adapter and never cross extension IPC. */
export type AliplayerObject = Record<string, any>;

export function observeSdkConstructor(host: AliplayerObject, name: string, onInstance: (instance: AliplayerObject) => void): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(host, name);
  if (descriptor && (!descriptor.configurable || descriptor.get || descriptor.set)) return () => {};
  let original = host[name], wrapped = original;
  const set = (value: unknown) => {
    original = value;
    if (typeof value !== 'function') { wrapped = value; return; }
    const proxy: Function = new Proxy(value, {
      construct(target, args, newTarget): object {
        const instance: AliplayerObject = Reflect.construct(target, args, newTarget === proxy ? target : newTarget);
        try { onInstance(instance); } catch { /* Observation must never break playback. */ }
        return instance;
      },
    });
    wrapped = proxy;
  };
  set(original);
  const get = () => wrapped;
  Object.defineProperty(host, name, { configurable: true, enumerable: descriptor?.enumerable ?? true, get, set });
  return () => {
    if (Object.getOwnPropertyDescriptor(host, name)?.get !== get) return;
    if (original === undefined && !descriptor) delete host[name];
    else Object.defineProperty(host, name, { configurable: true, enumerable: descriptor?.enumerable ?? true,
      writable: descriptor?.writable ?? true, value: original });
  };
}
