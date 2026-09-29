import { parseHlsPlaylist, type HlsMediaPlaylist } from '../../protocols/hls';
import {
  MAX_PROCESSED_SEGMENT_BYTES, MAX_SOURCE_SEGMENT_BYTES, SOURCE_CHUNK_BYTES,
  type BrowserSourceCommand, type BrowserSourcePlan, type BrowserSourcePoll, type BrowserSourceStatus, type ProcessedSegment,
} from '../../../shared/browser-source';
import { observeSdkConstructor, type AliplayerObject } from './sdk';

const IDLE_TIMEOUT_MS = 90_000;
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, index) => value === b[index]);
const hash = async (data: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data.slice().buffer)), b => b.toString(16).padStart(2, '0')).join('');
const fail = (code: string): never => { throw new Error(code); };

interface TrackOutput {
  initialization: Uint8Array;
  initializationHash: string;
  parts: Uint8Array[];
  bytes: number;
  startDTS: number; endDTS: number; startPTS: number; endPTS: number;
}
interface Lease {
  owner: number; mediaId: string; pageUrl: string; touched: number;
  controller: AbortController; hls: AliplayerObject; level: AliplayerObject;
  fragments: AliplayerObject[]; playlist: HlsMediaPlaylist;
  plan: BrowserSourcePlan; processor: AliplayerObject; nextIndex: number;
  tracks: Partial<Record<'audio' | 'video', TrackOutput>>;
  state: BrowserSourcePoll; pendingIndex?: number;
  resolveFlush?: (() => void) | undefined; rejectFlush?: ((cause: Error) => void) | undefined;
  error?: Error | undefined;
}

/** Stateful page-side source; only sanitized plans and bounded media chunks leave this object. */
export class AliplayerSourceService {
  readonly #instances = new Map<AliplayerObject, number>();
  readonly #restore: Array<() => void>;
  readonly #timer: ReturnType<typeof setInterval>;
  #lease: Lease | undefined;
  #opening = false;
  #disposed = false;
  readonly #initializedPlayers = new WeakSet<AliplayerObject>();
  readonly #preparedInstances = new WeakSet<AliplayerObject>();
  constructor(readonly mediaId: () => string | undefined, readonly currentUrl: () => string = () => location.href) {
    this.#restore = ['AliHls', 'Hls'].map(name => observeSdkConstructor(window as unknown as AliplayerObject, name, instance => {
      this.#instances.set(instance, Date.now());
      if (this.#instances.size > 16) this.#instances.delete(this.#instances.keys().next().value!);
    }));
    this.#timer = setInterval(() => {
      const lease = this.#lease;
      if (lease && (this.mediaId() !== lease.mediaId || !lease.hls.media?.isConnected || Date.now() - lease.touched > IDLE_TIMEOUT_MS)) this.#release();
    }, 1000);
  }
  #attached(): AliplayerObject[] {
    const instances = new Set(this.#instances.keys());
    // Aliplayer exposes its owner on the media element. This also recovers instances
    // created before constructor observation (for example after an extension reload).
    for (const media of document.querySelectorAll<HTMLVideoElement>('video')) {
      const hls = (media as unknown as AliplayerObject).player?._hls;
      if (hls?.media === media) instances.add(hls);
    }
    return [...instances].reverse().filter(hls => hls.media?.isConnected);
  }
  #level(hls: AliplayerObject): AliplayerObject | undefined {
    const index = [hls.streamController?.fragCurrent?.level, hls.loadLevel, hls.currentLevel, hls.firstLevel]
      .find(value => Number.isInteger(value) && value >= 0 && hls.levels?.[value]?.details?.fragments?.length);
    return index === undefined ? undefined : hls.levels[index];
  }
  #current(): AliplayerObject | undefined {
    return this.#attached().find(hls => hls.media.videoWidth > 0 && hls.streamController?.transmuxer && this.#level(hls));
  }
  status(): BrowserSourceStatus {
    const attached = this.#attached(), hls = this.#current() ?? attached[0];
    const media = (hls?.media ?? [...document.querySelectorAll<HTMLVideoElement>('video')].find(video => video.isConnected)) as HTMLVideoElement | undefined;
    const player = (media as unknown as AliplayerObject | undefined)?.player;
    const reason: NonNullable<BrowserSourceStatus['reason']> = media?.mediaKeys ? 'protected' : !media ? 'media-unavailable'
      : media.error ? 'media-error' : !hls ? (player ? 'sdk-uninitialized' : 'player-unavailable')
      : !this.#level(hls) ? 'manifest-pending' : !hls.streamController?.transmuxer ? 'processor-pending'
      : !media.videoWidth ? 'metadata-pending' : 'ready';
    return { mediaId: this.mediaId() ?? '', state: reason === 'protected' ? 'protected' : reason === 'ready' ? 'ready' : 'waiting',
      reason, observedInstances: this.#instances.size, attachedInstances: attached.length, mediaReadyState: media?.readyState ?? 0,
      width: media?.videoWidth ?? 0, height: media?.videoHeight ?? 0 };
  }
  #prepare(mediaId: string): BrowserSourceStatus {
    if (this.#disposed || this.mediaId() !== mediaId) return fail('browserSourceUnavailable');
    const status = this.status();
    if (status.state !== 'waiting' || this.#lease || this.#opening) return status;
    for (const media of document.querySelectorAll<HTMLVideoElement>('video')) {
      if (!media.isConnected || media.mediaKeys || !media.paused) continue;
      const player = (media as unknown as AliplayerObject).player;
      if (player?.tag === media && player._isHls && !player._disposed && !player._hls &&
          player._options?.autoplay === false && typeof player.initPlay === 'function' && !this.#initializedPlayers.has(player)) {
        // Initialize only an already authorized HLS source. Do not call play(),
        // change autoplay/mute, or manufacture authorization before it is ready.
        const source = player._options?.source;
        if (typeof source === 'string' && /^https?:\/\//.test(source)) {
          this.#initializedPlayers.add(player); player.initPlay(false);
        }
      }
    }
    for (const hls of this.#attached()) {
      if (hls.media.mediaKeys || !hls.media.paused || this.#preparedInstances.has(hls) ||
          (hls.media.videoWidth > 0 && hls.streamController?.transmuxer) || typeof hls.startLoad !== 'function') continue;
      const source = hls.media.player?._options?.source;
      if (!hls.url && (typeof source !== 'string' || !/^https?:\/\//.test(source) || typeof hls.loadSource !== 'function')) continue;
      this.#preparedInstances.add(hls);
      if (!hls.url) hls.loadSource(source);
      // Paused/preload-disabled players may never create a transmuxer. Loading
      // their first buffer prepares the SDK without advancing the media element.
      hls.startLoad();
    }
    return this.status();
  }
  dispose(): void { this.#disposed = true; this.#release(); clearInterval(this.#timer); for (const restore of this.#restore) restore(); }
  #release(): void {
    const lease = this.#lease; this.#lease = undefined;
    if (!lease) return;
    lease.controller.abort(); lease.rejectFlush?.(new Error('browserSourceUnavailable'));
    try { lease.processor?.destroy(); } catch { /* Release must remain idempotent. */ }
    lease.tracks = {};
  }
  #get(sessionId: string, owner: number): Lease {
    const lease = this.#lease;
    if (!lease || lease.owner !== owner || lease.plan.sessionId !== sessionId || this.#disposed ||
        this.mediaId() !== lease.mediaId || !lease.hls.media?.isConnected) return fail('browserSourceUnavailable');
    if (lease.hls.media.mediaKeys) { this.#release(); return fail('browserSourceUnsupported'); }
    lease.touched = Date.now(); return lease;
  }
  async handle(command: BrowserSourceCommand, owner: number): Promise<unknown> {
    if (command.method === 'status') return this.status();
    if (command.method === 'prepare') return this.#prepare(command.mediaId);
    if (command.method === 'open') return this.#open(command.mediaId, command.startIndex, owner);
    if (command.method === 'close') {
      if (this.#lease?.owner === owner && this.#lease.plan.sessionId === command.sessionId) this.#release();
      return null;
    }
    const lease = this.#get(command.sessionId, owner);
    switch (command.method) {
      case 'poll': return lease.state;
      case 'process': {
        if (lease.pendingIndex === command.index) return lease.state;
        if (lease.pendingIndex !== undefined || command.index !== lease.nextIndex || command.index >= lease.plan.segments.length) return fail('browserSourceChanged');
        lease.pendingIndex = command.index;
        lease.state = { state: 'requesting', networkBytes: 0 };
        void this.#process(lease, command.index).catch(cause => {
          if (this.#lease !== lease) return;
          const code = cause instanceof Error && /^browserSource[A-Za-z]+$/.test(cause.message) ? cause.message : 'browserSourceUnsupported';
          lease.state = { state: 'failed', networkBytes: lease.state.networkBytes, error: code };
        });
        return lease.state;
      }
      case 'read': {
        if (lease.state.state !== 'ready') return fail('browserSourceChanged');
        const track = lease.tracks[command.track]; if (!track) return fail('browserSourceIncomplete');
        const parts = command.part === 'initialization' ? [track.initialization] : track.parts;
        const total = command.part === 'initialization' ? track.initialization.length : track.bytes;
        if (command.offset + command.length > total || command.length > SOURCE_CHUNK_BYTES) return fail('browserSourceChanged');
        const bytes = new Uint8Array(command.length); let offset = 0, written = 0;
        for (const part of parts) {
          const from = Math.max(0, command.offset - offset), to = Math.min(part.length, command.offset + command.length - offset);
          if (to > from) { bytes.set(part.subarray(from, to), written); written += to - from; }
          offset += part.length;
        }
        let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return { base64: btoa(binary), length: written };
      }
      case 'ack':
        if (command.index === lease.nextIndex - 1 && lease.pendingIndex === undefined) return null;
        if (lease.pendingIndex !== command.index || lease.state.state !== 'ready') return fail('browserSourceChanged');
        for (const track of Object.values(lease.tracks)) { track.parts = []; track.bytes = 0; }
        delete lease.pendingIndex; lease.nextIndex++; lease.state = { state: 'idle', networkBytes: 0 }; return null;
    }
  }
  async #fetch(url: string, controller: AbortController, limit: number, progress?: (bytes: number) => void): Promise<Uint8Array> {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
    try {
      let response: Response;
      try { response = await fetch(url, { credentials: 'same-origin', signal: controller.signal }); }
      catch { return fail(controller.signal.aborted && !timedOut ? 'browserSourceUnavailable' : 'browserSourceNetwork'); }
      if (!response.ok) return fail(response.status === 401 || response.status === 403 ? 'browserSourceExpired' : 'browserSourceNetwork');
      if (Number(response.headers.get('Content-Length')) > limit) { void response.body?.cancel(); return fail('browserSourceUnsupported'); }
      const reader = response.body?.getReader(); if (!reader) return fail('browserSourceNetwork');
      const parts: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.length; if (size > limit) return fail('browserSourceUnsupported');
          parts.push(next.value); progress?.(size);
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      const result = new Uint8Array(size); let offset = 0;
      for (const part of parts) { result.set(part, offset); offset += part.length; }
      return result;
    } catch (cause) {
      if (cause instanceof Error && /^browserSource[A-Za-z]+$/.test(cause.message)) throw cause;
      return fail(controller.signal.aborted && !timedOut ? 'browserSourceUnavailable' : 'browserSourceNetwork');
    } finally { clearTimeout(timer); }
  }
  async #open(mediaId: string, startIndex: number, owner: number): Promise<BrowserSourcePlan> {
    if (this.#opening || this.#lease) return fail('browserSourceBusy');
    if (this.#disposed || !mediaId || this.mediaId() !== mediaId) return fail('browserSourceUnavailable');
    const hls = this.#current(); if (!hls || hls.media?.mediaKeys) return fail('browserSourceUnavailable');
    const stream = hls.streamController, Processor = stream.transmuxer?.constructor;
    const level = this.#level(hls), details = level?.details;
    if (!level || typeof Processor !== 'function' || !details?.fragments?.length || details.live || stream.altAudio) return fail('browserSourceUnsupported');
    this.#opening = true;
    const controller = new AbortController();
    try {
      const rawUrl = details.url || (Array.isArray(level.url) ? level.url[0] : level.url);
      const url = new URL(rawUrl);
      if (!['http:', 'https:'].includes(url.protocol)) return fail('browserSourceUnsupported');
      const playlist = parseHlsPlaylist(new TextDecoder().decode(await this.#fetch(url.href, controller, 2 * 1024 * 1024)), url.href);
      if (playlist.type !== 'media' || !playlist.endList || !playlist.segments.length || playlist.segments.some(segment => segment.discontinuity)) return fail('browserSourceUnsupported');
      const sdkFragments = details.fragments as AliplayerObject[];
      if (sdkFragments.length !== playlist.segments.length || startIndex > sdkFragments.length) return fail('browserSourceChanged');
      let time = 0;
      const segments = playlist.segments.map((segment, index) => {
        const sdk = sdkFragments[index];
        if (!sdk || typeof sdk.sn !== 'number' || sdk.gap || segment.byteRange || sdk.initSegment) return fail('browserSourceUnsupported');
        const start = time; time += segment.duration;
        return { index, id: `${sdk.cc}:${sdk.sn}`, start, duration: segment.duration };
      });
      if (this.#disposed || this.mediaId() !== mediaId || !hls.media?.isConnected) return fail('browserSourceUnavailable');
      const media = hls.media as HTMLVideoElement;
      const fingerprint = await hash(new TextEncoder().encode(JSON.stringify({ provider: 'aliplayer', mediaId,
        width: media.videoWidth, height: media.videoHeight, codecs: [level.audioCodec ?? '', level.videoCodec ?? ''],
        segments: segments.map((segment, index) => [segment.id, segment.duration, new URL(playlist.segments[index]!.uri).pathname]) })));
      const plan: BrowserSourcePlan = { sessionId: crypto.randomUUID(), fingerprint, durationSeconds: time,
        segments, width: media.videoWidth, height: media.videoHeight };
      const lease: Lease = { owner, mediaId, pageUrl: this.currentUrl(), touched: Date.now(), controller,
        hls, level, fragments: sdkFragments.slice(), playlist, plan, processor: {}, nextIndex: startIndex,
        tracks: {}, state: { state: 'idle', networkBytes: 0 } };
      const noop = () => {};
      const facade = { config: { ...hls.config, enableWorker: false, debug: false },
        logger: { log: noop, debug: noop, info: noop, warn: noop, error: noop },
        trigger: (event: string) => {
          if (event === 'hlsError') { lease.error = new Error('browserSourceIncomplete'); lease.rejectFlush?.(lease.error); }
        } };
      lease.processor = new Processor(facade, 'main', (value: AliplayerObject) => this.#consume(lease, value), () => lease.resolveFlush?.());
      this.#lease = lease; return plan;
    } catch (cause) { controller.abort(); throw cause; }
    finally { this.#opening = false; }
  }
  #consume(lease: Lease, value: AliplayerObject): void {
    if (lease.error || lease.controller.signal.aborted) return;
    try {
      const result = value.remuxResult ?? {};
      for (const kind of ['audio', 'video'] as const) {
        const initialization = result.initSegment?.tracks?.[kind]?.initSegment as Uint8Array | undefined;
        if (initialization?.length) {
          if (initialization.length > 1024 * 1024) return fail('browserSourceUnsupported');
          const old = lease.tracks[kind];
          if (old && !equal(old.initialization, initialization)) return fail('browserSourceChanged');
          if (!old) lease.tracks[kind] = { initialization: initialization.slice(), initializationHash: '', parts: [], bytes: 0,
            startDTS: Infinity, endDTS: -Infinity, startPTS: Infinity, endPTS: -Infinity };
        }
        const data = result[kind]; if (!data) continue;
        const track = lease.tracks[kind]; if (!track) return fail('browserSourceIncomplete');
        for (const part of [data.data1, data.data2] as Array<Uint8Array | undefined>) {
          if (!part?.byteLength) continue;
          const total = Object.values(lease.tracks).reduce((sum, item) => sum + item.bytes, 0) + part.byteLength;
          if (total > MAX_PROCESSED_SEGMENT_BYTES) return fail('browserSourceUnsupported');
          track.parts.push(part.slice()); track.bytes += part.length;
        }
        for (const field of ['startDTS', 'endDTS', 'startPTS', 'endPTS'] as const) {
          if (!Number.isFinite(data[field])) return fail('browserSourceIncomplete');
          track[field] = field.startsWith('start') ? Math.min(track[field], data[field]) : Math.max(track[field], data[field]);
        }
      }
    } catch (cause) {
      lease.error = cause instanceof Error ? cause : new Error('browserSourceIncomplete'); lease.rejectFlush?.(lease.error);
    }
  }
  async #process(lease: Lease, index: number): Promise<void> {
    const original = lease.fragments[index]!, segment = lease.playlist.segments[index]!, meta = lease.plan.segments[index]!;
    lease.error = undefined;
    for (const track of Object.values(lease.tracks)) {
      track.parts = []; track.bytes = 0; track.startDTS = track.startPTS = Infinity; track.endDTS = track.endPTS = -Infinity;
    }
    if (original.decryptdata?.method && original.decryptdata.method !== 'NONE' && !original.decryptdata.key) return fail('browserSourceUnsupported');
    const bytes = await this.#fetch(segment.uri, lease.controller, MAX_SOURCE_SEGMENT_BYTES, size => {
      lease.state = { state: 'downloading', networkBytes: size };
    });
    this.#get(lease.plan.sessionId, lease.owner);
    lease.state = { state: 'processing', networkBytes: bytes.length };
    const fragment = Object.assign(Object.create(Object.getPrototypeOf(original)), original, {
      _ref: null, start: meta.start, duration: meta.duration,
      stats: { ...original.stats, chunkCount: 1, parsing: { start: 0, end: 0 } },
    });
    const chunk = { level: original.level, sn: original.sn, part: -1, id: 1, size: bytes.length, partial: false,
      transmuxing: { start: 0, executeStart: 0, executeEnd: 0, end: 0 }, buffering: { audio: {}, video: {}, audiovideo: {} } };
    let timer: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve, reject) => {
      lease.resolveFlush = resolve; lease.rejectFlush = reject;
      timer = setTimeout(() => { lease.error = new Error('browserSourceIncomplete'); reject(lease.error); }, 20_000);
      try {
        lease.processor.push(bytes.buffer, undefined, lease.level.audioCodec, lease.level.videoCodec, fragment, null,
          lease.plan.durationSeconds, true, chunk, undefined);
        if (lease.error) { reject(lease.error); return; }
        lease.processor.flush(chunk);
      } catch { reject(new Error('browserSourceIncomplete')); }
    }).finally(() => { clearTimeout(timer); lease.resolveFlush = undefined; lease.rejectFlush = undefined; });
    if (lease.error) throw lease.error;
    const trackDescriptor = async (kind: 'audio' | 'video') => {
      const track = lease.tracks[kind];
      if (!track || !track.bytes || !Number.isFinite(track.startDTS) || track.endDTS <= track.startDTS) return fail('browserSourceIncomplete');
      track.initializationHash ||= await hash(track.initialization);
      return { initializationBytes: track.initialization.length, initializationHash: track.initializationHash,
        mediaBytes: track.bytes, startDTS: track.startDTS, endDTS: track.endDTS, startPTS: track.startPTS, endPTS: track.endPTS };
    };
    const result: ProcessedSegment = { index, networkBytes: bytes.length,
      tracks: { audio: await trackDescriptor('audio'), video: await trackDescriptor('video') } };
    this.#get(lease.plan.sessionId, lease.owner);
    lease.state = { state: 'ready', networkBytes: bytes.length, result };
  }
}
