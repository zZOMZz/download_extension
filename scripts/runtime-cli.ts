import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { createNodeHost } from '../src/hosts/node';
import { resetTaskState } from '../src/core/task-state';
import { outputFormatSchema } from '../src/shared/settings';
import type { DownloadTask } from '../src/shared/download-task';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      kind: { type: 'string' },
      output: { type: 'string' },
      title: { type: 'string' },
      format: { type: 'string', default: 'mp4' },
      'lock-port': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(`Usage: pnpm runtime:cli --output DIR [--url URL --kind hls|dash] [--title NAME] [--format mp4|original]\n\nWithout --url, resumes the persisted queue in DIR. Repeat a failed/cancelled URL to retry it.\nSources must be authorized direct HTTP(S) manifests; browser login/playback contexts are not inherited.\n`);
    return;
  }
  if (!values.output) throw new Error('--output DIR is required.');
  if (values.url && values.kind !== 'hls' && values.kind !== 'dash') {
    throw new Error('--kind must be hls or dash when --url is supplied.');
  }
  const outputFormat = outputFormatSchema.parse(values.format);
  const host = await createNodeHost({
    outputDirectory: values.output,
    ...(values['lock-port'] ? { lockPort: Number(values['lock-port']) } : {}),
  });
  if (values.url) {
    const url = new URL(values.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('--url must use HTTP or HTTPS.');
    const id = createHash('sha256').update(`${values.kind}\0${url.href}\0${outputFormat}`).digest('hex').slice(0, 24);
    await host.locks.runExclusive(async () => {
      const existing = (await host.store.list()).find((task) => task.id === id);
      if (existing) {
        if (existing.status === 'failed' || existing.status === 'cancelled') {
          const next = resetTaskState(existing, 'queued');
          delete next.recoveryAttempt;
          await host.store.save(next);
        }
        return;
      }
      const now = Date.now();
      const task: DownloadTask = {
        id,
        source: { id: `direct:${id}`, adapterId: 'direct', pageUrl: url.href,
          title: values.title || `download-${id}`, mediaKind: values.kind as 'hls' | 'dash' },
        outputFormat, status: 'queued', createdAt: now, updatedAt: now,
      };
      await host.store.save(task);
    });
  }
  const cancel = () => host.runtime.cancel();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const snapshot = await host.runtime.start();
    process.stdout.write(`${JSON.stringify({ outputDirectory: host.artifacts.root,
      tasks: snapshot.tasks.map(({ id, status, error }) => ({ id, status, ...(error ? { error } : {}) })) }, null, 2)}\n`);
    if (snapshot.tasks.some(({ status }) => status !== 'completed')) process.exitCode = 1;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
