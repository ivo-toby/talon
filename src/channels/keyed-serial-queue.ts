/**
 * Runs async tasks one at a time per key, in submission order.
 *
 * Connectors whose platform delivers messages concurrently (Baileys fires
 * `messages.upsert` handlers without awaiting them; WhatsApp Business webhooks
 * arrive as independent HTTP requests) use this keyed by chat, so a text sent
 * right after a photo is not handed to the pipeline while the photo is still
 * downloading or normalizing. Different keys still run concurrently.
 *
 * A failed task never blocks the tasks queued behind it.
 */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Queue `task` behind every earlier task for `key` and return its result. */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    // The stored tail must never reject, or a later `then` would see it.
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }

  /** Number of keys with queued or running work (for tests/diagnostics). */
  get activeKeys(): number {
    return this.tails.size;
  }
}
