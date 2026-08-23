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

- Detect progressive video/audio, HLS playlists, DASH manifests, and blob media.
- Download progressive HTTP(S) media using the browser download manager.
- Parse HLS master and media playlists.
- Download HLS VOD playlists, including standard `AES-128` identity encryption.
- Choose a persistent HLS output format; MP4 is the default.
- Download MPEG-TS HLS into a resumable `.part.ts`, then losslessly remux H.264/AAC streams to a finalized, indexed MP4.
- Discover all episodes from supported series pages and add them to a persistent batch queue.
- Resolve fresh media URLs when each queued task starts and stream output to one selected directory.
- Run a persistent, configurable task pool with 1–4 concurrent downloads (default: 2).
- Show live current/average throughput, per-segment progress, processing phase, and estimated time remaining.
- Configure request attempts, first-byte/idle timeouts, task recovery rounds, and retry delays from one manager settings panel.
- Move exhausted transient failures into a persistent cooldown state, release their pool slot, refresh signed media URLs, and retry automatically.
- Persist segment-boundary checkpoints and reconcile them with the committed partial file after failures or manager restarts.
- Remember the selected output directory in IndexedDB, restore it when permission remains granted, and offer one-click reconnection otherwise.
- Adapt request concurrency per host after repeated 429, 5xx, timeout, or transport failures, including a short circuit-breaker cooldown.
- Keep bounded per-task diagnostics with structured failure categories and exportable, query-string-redacted JSON reports.
- Refuse DRM-like HLS encryption methods and unsupported live playlists.

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
task starts. The first adapter supports 2rk series detail pages.

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
only after finalization succeeds. HLS streams that already use fragmented MP4
initialization segments still use the direct, non-resumable path.

Only download content you own or have permission to save.
