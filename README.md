# Open Media Downloader

A local-first browser extension for discovering and downloading media that the
current browser session is authorized to access. DRM-protected media is outside
the project scope.

## Development

```bash
pnpm install
pnpm dev
```

Load the generated Chromium extension from `.output/chrome-mv3-dev` when WXT
does not launch a browser automatically.

```bash
pnpm typecheck
pnpm test:run
pnpm build
```

## Current scope

- Detect progressive video/audio, HLS playlists, DASH manifests, site-exposed DASH metadata, and blob media.
- Download progressive HTTP(S) media using the browser download manager.
- Parse HLS master and media playlists.
- Download HLS VOD playlists, including standard `AES-128` identity encryption.
- Resolve external HLS audio renditions and merge separate audio/video playlists into one MP4.
- Download static, non-DRM DASH MP4 tracks described by `SegmentTemplate`, `SegmentList`, or single-file `SegmentBase`/SIDX, then losslessly merge separate video and audio into one indexed MP4.
- Detect Bilibili's page-embedded `window.__playinfo__` DASH metadata through an isolated site adapter.
- Discover Bilibili multi-P videos and UGC collections, flatten every page into a queued DASH task, and resolve signed tracks on demand.
- Choose a persistent HLS output format; MP4 is the default.
- Download MPEG-TS HLS into a resumable `.part.ts`, then losslessly remux H.264/AAC streams to a finalized, indexed MP4.
- Discover all episodes from supported series pages and add them to a persistent batch queue.
- Resolve fresh media URLs when each queued task starts and stream output to one selected directory.
- Run a persistent, configurable task pool with 1–4 concurrent downloads (default: 2).
- Show live current/average throughput, per-segment progress, processing phase, and estimated time remaining.
- Configure request attempts, first-byte/idle timeouts, task recovery rounds, and retry delays from one manager settings panel.
- Move exhausted transient failures into a persistent cooldown state, release their pool slot, refresh signed media URLs, and retry automatically.
- Persist segment-boundary checkpoints and reconcile them with the committed partial file after failures or manager restarts.
- Resume DASH video and audio tracks independently from committed fragment boundaries before losslessly merging them into MP4.
- Refresh expired DASH CDN URLs after 401/403 responses, verify track identity, and continue from the committed fragment boundary.
- Remember the selected output directory in IndexedDB, restore it when permission remains granted, and offer one-click reconnection otherwise.
- Adapt request concurrency per host after repeated 429, 5xx, timeout, or transport failures, including a short circuit-breaker cooldown.
- Show HLS/DASH and effective output badges in the queue, including independent DASH video/audio checkpoint progress.
- Keep bounded per-task diagnostics with structured failure categories, selected DASH track metadata, URL-refresh events, and exportable query-string-redacted JSON reports.
- Validate committed MP4/TS output structure before marking a task complete, including MP4 media tracks and duration.
- Refuse DRM-like HLS encryption methods and unsupported live playlists.
- Refuse DRM-protected, live, and multi-period DASH manifests instead of producing partial output.

## Protocol task executors

The manager owns queue scheduling, task recovery, diagnostics, and final output
validation. Protocol-specific download and checkpoint behavior lives behind the
executor registry in `src/browser/task-executors/`. An executor must claim one
media kind, while site-specific detection, discovery, and request compatibility
remain in their adapter layers. The registry rejects duplicate claims so adding
a protocol cannot silently replace an existing implementation.

## DASH and detection adapters

The DASH protocol layer lives in `src/core/protocols/dash.ts`, while byte-range
index resolution and downloads live in `src/core/mp4/sidx.ts` and
`src/core/dash/`. It does not contain site hostnames or page-specific fields.

Sites that expose playable media without requesting an MPD can add a detection
adapter under `src/core/detection/adapters/`. The Bilibili adapter is the first
example: it matches only Bilibili video/play pages and converts embedded
`__playinfo__` tracks into the same generic DASH model, including ordered CDN
fallback URLs. Its request adapter installs a session-only header rule scoped
to the active downloader or manager tab and Bilibili API/CDN domains; closing
that tab removes the rule. Exact-range responses are required for single-file DASH so a server
that ignores `Range` cannot make the extension buffer the entire source file in
memory.

## HLS site adapters

The generic HLS downloader only implements protocol-level behavior. Site-specific
compatibility lives in `src/core/hls/adapters/` behind the `HlsSiteAdapter`
interface and is selected by the registry.

When adding an adapter:

1. Give it an exact host/resource match and keep all site logic in its own file.
2. Register it in `adapters/registry.ts`.
3. Add isolation tests proving that nearby hosts and paths do not match.
4. Keep standard 16-byte AES-128 keys on the generic path; adapters are only a
   fallback for non-standard responses.

The registry rejects overlapping matches instead of silently choosing one.

## Site discovery adapters

Collection and episode discovery is separate from HLS protocol compatibility.
Discovery adapters live in `src/core/discovery/adapters/`; each one discovers
items from the current page and resolves a fresh media URL only when its queued
task starts. The 2rk adapter reads episode links from a detail page. The
Bilibili adapter reads the official video-detail response, expands multi-P and
UGC collection pages, then resolves each queued `bvid`/`cid` through the play
endpoint immediately before download. Site JSON and request-header behavior
remain in Bilibili-specific adapter modules.

Batch tasks are stored in `browser.storage.local` and are independent of the
source tab after they are added. The manager uses a bounded task pool and
requires a directory handle so large outputs are streamed to disk instead of
accumulated in memory. Each individual HLS task still downloads its segments in
playlist order.

Resumable MPEG-TS downloads keep media bytes in the selected output directory;
only compact checkpoint metadata is stored with the task. After reopening the
manager, the remembered directory is restored automatically when permission is
still granted; otherwise reconnect it with one click and use Resume. MP4 output temporarily
needs space for both the `.part.ts` and final `.mp4`; the partial file is removed
only after the final file passes integrity validation. HLS streams that already use fragmented MP4
initialization segments still use the direct, non-resumable path.

External HLS audio is resolved from the selected variant's `AUDIO` rendition
group. MPEG-TS or packed-AAC tracks share the resumable raw-partial path;
fragmented MP4 tracks are flattened directly into one indexed MP4. Mixed
MPEG-TS and fragmented-MP4 track pairs are rejected explicitly.

Queued DASH downloads use checkpoint version 2 and keep independent
`.video.part.m4s` and `.audio.part.m4s` files. Each track records its
initialization boundary and completed fragment offsets, so a retry skips bytes
that were already committed. The two partials are deleted only after the merged
MP4 passes structural validation; legacy HLS version 1 checkpoints remain
readable without migration.

If every URL for a DASH resource returns 401/403, the executor asks the source
discovery adapter for fresh media metadata. Host and signed-query changes are
accepted only when track IDs, codecs, resource paths, byte ranges, and fragment
counts still match the checkpoint. An incompatible refresh keeps both partials
and requires an explicit restart instead of combining different tracks.

Only download content you own or have permission to save.
