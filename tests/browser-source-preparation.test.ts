import { afterEach, describe, expect, it, vi } from 'vitest';
import { AliplayerSourceService } from '../src/core/site-adapters/aliplayer/source-service';
import { observeSdkConstructor } from '../src/core/site-adapters/aliplayer/sdk';

const mediaId = 'cold-video';
const services: AliplayerSourceService[] = [];
afterEach(() => { services.splice(0).forEach(service => service.dispose()); vi.unstubAllGlobals(); });

function harness() {
  const media = { isConnected: true, paused: true, mediaKeys: null, error: null, videoWidth: 0, videoHeight: 0,
    readyState: 0, play: vi.fn(), currentTime: 0, player: undefined as any };
  vi.stubGlobal('window', {});
  vi.stubGlobal('document', { querySelectorAll: () => [media] });
  const service = new AliplayerSourceService(() => mediaId, () => 'https://example.test/video');
  services.push(service);
  const level = { details: { fragments: [{}] } };
  const hls = { media, url: 'https://media.example/stream.m3u8', startLoad: vi.fn(), loadSource: vi.fn(),
    streamController: { transmuxer: undefined as any }, levels: [level], loadLevel: -1, currentLevel: -1, firstLevel: 0 };
  const player = { tag: media, _isHls: true, _options: { source: hls.url, autoplay: false }, _hls: undefined as any,
    initPlay: vi.fn(() => { player._hls = hls; }), play: vi.fn() };
  media.player = player;
  return { service, media, player, hls };
}

describe('browser source preparation', () => {
  it('observes SDK construction without changing instance identity or static APIs', () => {
    const host: Record<string, any> = {}, instances: object[] = [];
    const restore = observeSdkConstructor(host, 'AliHls', instance => instances.push(instance));
    class Sdk { static version = 'fixture'; constructor(readonly value: number) {} }
    host.AliHls = Sdk;
    const instance = new host.AliHls(7);
    expect(instance).toBeInstanceOf(Sdk);
    expect(instance.value).toBe(7); expect(instance.constructor).toBe(Sdk);
    expect(instances).toEqual([instance]); expect(host.AliHls.version).toBe('fixture');
    restore(); expect(host.AliHls).toBe(Sdk);
  });
  it('leaves a non-configurable SDK global unchanged', () => {
    const host: Record<string, unknown> = {}, Sdk = class {};
    Object.defineProperty(host, 'AliHls', { value: Sdk, configurable: false });
    const restore = observeSdkConstructor(host, 'AliHls', () => { throw Error('must not observe'); });
    restore(); expect(host.AliHls).toBe(Sdk);
  });
  it('keeps detection passive, then prepares a lazy SDK only once without playing or seeking', async () => {
    const h = harness();
    expect(h.service.status()).toMatchObject({ state: 'waiting', reason: 'sdk-uninitialized', observedInstances: 0 });
    expect(h.player.initPlay).not.toHaveBeenCalled();
    await h.service.handle({ method: 'prepare', mediaId }, 1);
    await h.service.handle({ method: 'prepare', mediaId }, 1);
    expect(h.player.initPlay).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.hls.startLoad).toHaveBeenCalledTimes(1);
    expect(h.media.play).not.toHaveBeenCalled(); expect(h.player.play).not.toHaveBeenCalled();
    expect(h.media.currentTime).toBe(0); expect(h.media.paused).toBe(true);
  });
  it('recovers an attached SDK missed by constructor observation and waits for real readiness', async () => {
    const h = harness(); h.player._hls = h.hls;
    expect(h.service.status()).toMatchObject({ reason: 'processor-pending', attachedInstances: 1, observedInstances: 0 });
    h.hls.streamController.transmuxer = {};
    expect(h.service.status()).toMatchObject({ reason: 'metadata-pending', state: 'waiting' });
    h.media.videoWidth = 320; h.media.videoHeight = 180; h.media.readyState = 2;
    expect(h.service.status()).toMatchObject({ reason: 'ready', state: 'ready', width: 320 });
    await h.service.handle({ method: 'prepare', mediaId }, 1);
    expect(h.hls.startLoad).not.toHaveBeenCalled();
  });
  it('does not restart an actively playing source', async () => {
    const h = harness(); h.player._hls = h.hls; h.media.paused = false;
    await h.service.handle({ method: 'prepare', mediaId }, 1);
    expect(h.hls.startLoad).not.toHaveBeenCalled();
  });
  it('does not initialize native protected media or a different video', async () => {
    const h = harness();
    await expect(h.service.handle({ method: 'prepare', mediaId: 'other-video' }, 1)).rejects.toThrow('browserSourceUnavailable');
    Object.assign(h.media, { mediaKeys: {} });
    expect(await h.service.handle({ method: 'prepare', mediaId }, 1)).toMatchObject({ state: 'protected' });
    expect(h.player.initPlay).not.toHaveBeenCalled();
  });
  it('waits for an authorized source instead of invoking initialization with empty context', async () => {
    const h = harness(); h.player._options.source = '';
    await h.service.handle({ method: 'prepare', mediaId }, 1);
    expect(h.player.initPlay).not.toHaveBeenCalled();
    h.player._options.source = h.hls.url;
    await h.service.handle({ method: 'prepare', mediaId }, 1);
    expect(h.player.initPlay).toHaveBeenCalledTimes(1);
  });
});
