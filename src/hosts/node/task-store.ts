import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { downloadTaskSchema, type DownloadTask } from '../../shared/download-task';

/** Atomic snapshots for one host; ExecutionLocks must cover read/modify/write operations. */
export class NodeTaskStore {
  readonly path: string;
  #pending: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = resolve(path);
  }

  async #read(): Promise<DownloadTask[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
      throw error;
    }
    // Corruption must remain visible; returning an empty queue would silently destroy tasks.
    return downloadTaskSchema.array().parse(JSON.parse(text));
  }

  async #write(tasks: DownloadTask[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.pending`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(JSON.stringify(tasks, null, 2));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(operation, operation);
    this.#pending = result.then(() => {}, () => {});
    return result;
  }

  async list(): Promise<DownloadTask[]> {
    await this.#pending;
    return this.#read();
  }

  save(task: DownloadTask): Promise<DownloadTask> {
    return this.#enqueue(async () => {
      const valid = downloadTaskSchema.parse(task);
      const tasks = await this.#read();
      const index = tasks.findIndex(({ id }) => id === valid.id);
      if (index < 0) tasks.push(valid);
      else tasks[index] = valid;
      await this.#write(tasks);
      return valid;
    });
  }

  remove(taskId: string): Promise<void> {
    return this.#enqueue(async () => {
      await this.#write((await this.#read()).filter(({ id }) => id !== taskId));
    });
  }
}
