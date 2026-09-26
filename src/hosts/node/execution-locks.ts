import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { RuntimeError } from '../../runtime/errors';

/** Kernel-owned local lock: process death releases it without deleting another owner's lockfile. */
export class NodeExecutionLocks {
  readonly port: number;

  constructor(scope: string, port?: number) {
    this.port = port ?? 20_000 + createHash('sha256').update(scope).digest().readUInt32BE(0) % 40_000;
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65_535) {
      throw new Error('The execution lock port must be an integer between 1 and 65535.');
    }
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) => {
        reject(error.code === 'EADDRINUSE' ? new RuntimeError('runtimeBusy') : error);
      });
      server.listen({ host: '127.0.0.1', port: this.port, exclusive: true }, resolve);
    });
    try {
      return await operation();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
}
