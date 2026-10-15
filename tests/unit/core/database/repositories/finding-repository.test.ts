import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { FindingRepository } from '../../../../../src/core/database/repositories/finding-repository.js';
import type { CreateFindingInput } from '../../../../../src/core/database/repositories/finding-repository.js';
import { ImageRepository } from '../../../../../src/core/database/repositories/image-repository.js';
import { ThreadRepository } from '../../../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../../../src/core/database/repositories/channel-repository.js';
import { MessageRepository } from '../../../../../src/core/database/repositories/message-repository.js';
import { PersonaRepository } from '../../../../../src/core/database/repositories/persona-repository.js';
import { RunRepository } from '../../../../../src/core/database/repositories/run-repository.js';
import { BaseRepository } from '../../../../../src/core/database/repositories/base-repository.js';
import { createTestDb, uuid } from './helpers.js';

/**
 * Contract under test: the canonical Finding ledger.
 *
 * These tests exercise a real migrated SQLite database — real UNIQUE, CHECK and
 * FOREIGN KEY enforcement, real rollback — because the Finding guarantees are
 * storage guarantees. Inserts are never mocked.
 */
describe('FindingRepository', () => {
  let db: Database.Database;
  let repo: FindingRepository;
  let images: ImageRepository;
  let channelId: string;
  let threadId: string;
  let otherThreadId: string;
  let runId: string;
  let otherRunId: string;
  let imgA: string;
  let imgB: string;
  let imgOther: string;

  beforeEach(() => {
    BaseRepository.__resetMonotonicClockForTests();
    db = createTestDb();
    repo = new FindingRepository(db);
    images = new ImageRepository(db);

    const channels = new ChannelRepository(db);
    channelId = uuid();
    channels.insert({
      id: channelId,
      type: 'telegram',
      name: `ch-${uuid()}`,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });

    const threads = new ThreadRepository(db);
    threadId = uuid();
    threads.insert({ id: threadId, channel_id: channelId, external_id: `ext-${uuid()}`, metadata: '{}' });
    otherThreadId = uuid();
    threads.insert({
      id: otherThreadId,
      channel_id: channelId,
      external_id: `ext-${uuid()}`,
      metadata: '{}',
    });

    const personas = new PersonaRepository(db);
    personas.insert({
      id: uuid(),
      name: `persona-${uuid()}`,
      model: 'gpt-5.3-vision',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      mounts: '[]',
      max_concurrent: null,
    });

    const runs = new RunRepository(db);
    runId = insertRun(threadId, runs);
    otherRunId = insertRun(otherThreadId, runs);

    // Two Available Images in the owning thread, one in another thread.
    imgA = makeImage(threadId);
    imgB = makeImage(threadId);
    imgOther = makeImage(otherThreadId);
  });

  afterEach(() => {
    db.close();
  });

  function insertRun(thread: string, runs: RunRepository): string {
    const id = uuid();
    const personaRow = db.prepare('SELECT id FROM personas LIMIT 1').get() as { id: string };
    runs.insert({
      id,
      thread_id: thread,
      persona_id: personaRow.id,
      provider_name: 'openai-compatible',
      model_name: 'gpt-5.3-vision',
      reasoning_effort: null,
      sandbox_id: null,
      session_id: null,
      status: 'running',
      parent_run_id: null,
      queue_item_id: null,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0,
      error: null,
      started_at: null,
      ended_at: null,
    });
    return id;
  }

  function makeMessage(thread: string): string {
    const messages = new MessageRepository(db);
    const id = uuid();
    messages.insert({
      id,
      thread_id: thread,
      direction: 'inbound',
      content: '{"text":"look"}',
      idempotency_key: `idem-${uuid()}`,
      provider_id: null,
      run_id: null,
    });
    return id;
  }

  function makeImage(thread: string): string {
    const sourceRef = uuid();
    db.prepare(
      'INSERT INTO image_source_messages (id, channel, external_message_id, external_chat_id, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(sourceRef, 'telegram', `ext-${uuid()}`, 'chat-1', 1_700_000_000_000);
    const id = uuid();
    images
      .insert({
        id,
        messageId: makeMessage(thread),
        ordinal: 0,
        threadId: thread,
        sourceRef,
        expiresAt: 1_700_003_600_000,
        processingDeadlineAt: 1_700_000_060_000,
      })
      ._unsafeUnwrap();
    images.markAvailable(id, { mimeType: 'image/jpeg' })._unsafeUnwrap();
    return id;
  }

  function makeInput(overrides: Partial<CreateFindingInput> = {}): CreateFindingInput {
    return {
      id: uuid(),
      runId,
      threadId,
      imageIds: [imgA],
      question: 'What is on the table?',
      answer: 'A ceramic mug and an open notebook.',
      extractedText: 'CAFE OPEN 9-17',
      uncertainty: 'The last digit of the opening time is blurry.',
      modelName: 'gpt-5.3-vision',
      usage: { inputTokens: 1_200, outputTokens: 95, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ...overrides,
    };
  }

  function count(table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  }

  /** Creates a Finding straight through SQL with a fixed chronological key. */
  function insertFindingRaw(id: string, createdAt: number, imageIds: string[] = []): void {
    db.prepare(
      `INSERT INTO findings (id, run_id, thread_id, question, answer, extracted_text,
         uncertainty, model_name, usage_input_tokens, usage_output_tokens,
         usage_cache_read_tokens, usage_cache_write_tokens, created_at)
       VALUES (?, ?, ?, 'q', 'a', NULL, NULL, 'm', NULL, NULL, NULL, NULL, ?)`,
    ).run(id, runId, threadId, createdAt);
    imageIds.forEach((imageId, position) => {
      db.prepare('INSERT INTO finding_images (finding_id, image_id, position) VALUES (?, ?, ?)')
        .run(id, imageId, position);
    });
  }

  describe('create', () => {
    it('persists the exact canonical Finding with ordered associations', () => {
      const before = Date.now();
      const result = repo.create(makeInput({ imageIds: [imgB, imgA] }));

      expect(result.isOk()).toBe(true);
      const record = result._unsafeUnwrap();
      expect(record.finding.question).toBe('What is on the table?');
      expect(record.finding.answer).toBe('A ceramic mug and an open notebook.');
      expect(record.finding.extracted_text).toBe('CAFE OPEN 9-17');
      expect(record.finding.uncertainty).toBe('The last digit of the opening time is blurry.');
      expect(record.finding.model_name).toBe('gpt-5.3-vision');
      expect(record.finding.usage_input_tokens).toBe(1_200);
      expect(record.finding.usage_output_tokens).toBe(95);
      expect(record.finding.run_id).toBe(runId);
      expect(record.finding.thread_id).toBe(threadId);
      // Creation time is the repository clock, never a caller value.
      expect(record.finding.created_at).toBeGreaterThanOrEqual(before);
      // Association order matches the Inspection's own order, not id order.
      expect(record.imageIds).toEqual([imgB, imgA]);

      const read = repo.findById(record.finding.id)._unsafeUnwrap();
      expect(read).toEqual(record);
      const positions = db
        .prepare('SELECT image_id, position FROM finding_images WHERE finding_id = ? ORDER BY position ASC')
        .all(record.finding.id) as Array<{ image_id: string; position: number }>;
      expect(positions.map((p) => [p.image_id, p.position])).toEqual([
        [imgB, 0],
        [imgA, 1],
      ]);
    });

    it('keeps unreported text and usage unknown instead of inventing them', () => {
      const record = repo
        .create(
          makeInput({
            extractedText: null,
            uncertainty: undefined,
            usage: { inputTokens: 7 },
          }),
        )
        ._unsafeUnwrap();

      expect(record.finding.extracted_text).toBeNull();
      expect(record.finding.uncertainty).toBeNull();
      expect(record.finding.usage_input_tokens).toBe(7);
      expect(record.finding.usage_output_tokens).toBeNull();
      expect(record.finding.usage_cache_read_tokens).toBeNull();
      expect(record.finding.usage_cache_write_tokens).toBeNull();
    });

    it('creates no synthetic message, queue item, or tool result', () => {
      const messagesBefore = count('messages');
      const auditBefore = count('audit_log');
      repo.create(makeInput())._unsafeUnwrap();

      // A Finding is canonical Finding-ledger data, never conversation history
      // and never tool_results replay storage.
      expect(count('messages')).toBe(messagesBefore);
      expect(count('queue_items')).toBe(0);
      expect(count('tool_results')).toBe(0);
      expect(count('audit_log')).toBe(auditBefore);
    });

    it('rejects a duplicate globally unique Finding id and leaves the first intact', () => {
      const first = repo.create(makeInput({ id: 'finding-dup' }))._unsafeUnwrap();

      const dup = repo.create(
        makeInput({ id: 'finding-dup', answer: 'rewritten history', imageIds: [imgB] }),
      );
      expect(dup.isErr()).toBe(true);
      expect(String(dup._unsafeUnwrapErr().message)).toMatch(/PRIMARY KEY|UNIQUE/i);

      expect(count('findings')).toBe(1);
      expect(count('finding_images')).toBe(1);
      const stored = repo.findById('finding-dup')._unsafeUnwrap();
      expect(stored?.finding.answer).toBe(first.finding.answer);
      expect(stored?.imageIds).toEqual([imgA]);
    });

    it('rejects an unknown run and writes nothing', () => {
      const result = repo.create(makeInput({ runId: uuid() }));
      expect(result.isErr()).toBe(true);
      expect(String(result._unsafeUnwrapErr().message)).toMatch(/unknown run/i);
      expect(count('findings')).toBe(0);
      expect(count('finding_images')).toBe(0);
    });

    it('rejects a thread that disagrees with the run provenance', () => {
      const result = repo.create(makeInput({ runId, threadId: otherThreadId }));
      expect(result.isErr()).toBe(true);
      expect(String(result._unsafeUnwrapErr().message)).toMatch(/belongs to thread/i);
      expect(count('findings')).toBe(0);
    });

    it('rejects a run from another thread even when the caller names its thread', () => {
      const result = repo.create(makeInput({ runId: otherRunId, threadId: otherThreadId }));
      // Provenance alone is not ownership of the current conversation thread:
      // both ids must agree and the source Images must match too.
      expect(result.isErr()).toBe(true);
      expect(String(result._unsafeUnwrapErr().message)).toMatch(/belongs to thread|unknown image/i);
      expect(count('findings')).toBe(0);
    });

    it('rejects an unknown source Image and writes nothing', () => {
      const result = repo.create(makeInput({ imageIds: [imgA, uuid()] }));
      expect(result.isErr()).toBe(true);
      expect(String(result._unsafeUnwrapErr().message)).toMatch(/unknown image/i);
      expect(count('findings')).toBe(0);
      expect(count('finding_images')).toBe(0);
    });

    it('rejects a cross-thread source Image and writes nothing', () => {
      const result = repo.create(makeInput({ imageIds: [imgA, imgOther] }));
      expect(result.isErr()).toBe(true);
      expect(String(result._unsafeUnwrapErr().message)).toMatch(/belongs to thread/i);
      expect(count('findings')).toBe(0);
      expect(count('finding_images')).toBe(0);
    });

    it('rejects empty required text in every field', () => {
      for (const overrides of [
        { id: '' },
        { runId: '' },
        { threadId: '' },
        { question: '' },
        { answer: '' },
        { modelName: '' },
      ]) {
        const result = repo.create(makeInput(overrides));
        expect(result.isErr()).toBe(true);
        expect(String(result._unsafeUnwrapErr().message)).toMatch(/nonempty|required/i);
      }
      expect(count('findings')).toBe(0);
    });

    it('rejects an empty or duplicate source Image list', () => {
      const empty = repo.create(makeInput({ imageIds: [] }));
      expect(empty.isErr()).toBe(true);
      expect(String(empty._unsafeUnwrapErr().message)).toMatch(/at least one source image/i);

      const dup = repo.create(makeInput({ imageIds: [imgA, imgA] }));
      expect(dup.isErr()).toBe(true);
      expect(String(dup._unsafeUnwrapErr().message)).toMatch(/distinct/i);
      expect(count('findings')).toBe(0);
    });

    it('rejects empty extractedText/uncertainty strings: verbatim or absent only', () => {
      const text = repo.create(makeInput({ extractedText: '' }));
      expect(text.isErr()).toBe(true);
      expect(String(text._unsafeUnwrapErr().message)).toMatch(/extracted text must be verbatim text or absent/i);

      const unc = repo.create(makeInput({ uncertainty: '' }));
      expect(unc.isErr()).toBe(true);
      expect(String(unc._unsafeUnwrapErr().message)).toMatch(/uncertainty must be verbatim text or absent/i);
    });

    it('rejects usage that is not a non-negative integer count', () => {
      for (const usage of [
        { inputTokens: -1 },
        { outputTokens: 1.5 },
        { cacheReadTokens: Number.NaN },
      ]) {
        const result = repo.create(makeInput({ usage }));
        expect(result.isErr()).toBe(true);
        expect(String(result._unsafeUnwrapErr().message)).toMatch(/non-negative integer/i);
      }
      expect(count('findings')).toBe(0);
    });

    it('stores no binary column: the ledger holds text and numbers only', () => {
      for (const table of ['findings', 'finding_images']) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { type: string }[];
        expect(columns.length).toBeGreaterThan(0);
        for (const column of columns) {
          expect(['TEXT', 'INTEGER']).toContain(column.type);
        }
      }
    });
  });

  describe('atomicity', () => {
    it('rolls back the Finding row and earlier associations when a later association fails', () => {
      // Real mid-write failure: a temp trigger aborts the INSERT of the second
      // association after the Finding row and the first association were written.
      db.prepare(
        `CREATE TEMP TRIGGER poison_finding_images
         AFTER INSERT ON finding_images WHEN NEW.image_id = '${imgB}'
         BEGIN SELECT RAISE(ABORT, 'simulated association failure'); END`,
      ).run();

      const input = makeInput({ imageIds: [imgA, imgB] });
      const result = repo.create(input);
      expect(result.isErr()).toBe(true);
      expect(String(result._unsafeUnwrapErr().message)).toMatch(/simulated association failure/i);

      // Nothing partial survives: neither the Finding nor its first association.
      expect(count('findings')).toBe(0);
      expect(count('finding_images')).toBe(0);
      expect(repo.findById(input.id)._unsafeUnwrap()).toBeNull();
    });

    it('rolls the whole write back when a surrounding coordinator transaction throws', () => {
      const input = makeInput({ imageIds: [imgA, imgB] });
      expect(() =>
        db.transaction(() => {
          const created = repo.create(input);
          if (created.isErr()) {
            throw created.error;
          }
          throw new Error('coordinator failed after the Finding was written');
        })(),
      ).toThrow(/coordinator failed/i);

      expect(count('findings')).toBe(0);
      expect(count('finding_images')).toBe(0);
    });
  });

  describe('exact reads', () => {
    it('gets the exact canonical Finding by its globally unique id', () => {
      const created = repo.create(makeInput({ imageIds: [imgA, imgB] }))._unsafeUnwrap();

      const read = repo.findById(created.finding.id)._unsafeUnwrap();
      expect(read).not.toBeNull();
      expect(read?.finding).toEqual(created.finding);
      // Verbatim text, exact reported usage, ordered associations.
      expect(read?.finding.answer).toBe('A ceramic mug and an open notebook.');
      expect(read?.finding.usage_cache_read_tokens).toBe(0);
      expect(read?.imageIds).toEqual([imgA, imgB]);
    });

    it('returns null for an unknown Finding id', () => {
      expect(repo.findById('nope')._unsafeUnwrap()).toBeNull();
    });

    it('resolves a thread-scoped get only for the owning thread', () => {
      const created = repo.create(makeInput())._unsafeUnwrap();

      expect(repo.findByIdInThread(created.finding.id, threadId)._unsafeUnwrap()).not.toBeNull();
      expect(repo.findByIdInThread(created.finding.id, otherThreadId)._unsafeUnwrap()).toBeNull();
      expect(repo.findByIdInThread(uuid(), threadId)._unsafeUnwrap()).toBeNull();
    });
  });

  describe('findPage', () => {
    it('lists a thread newest-first by the chronological key (created DESC, id ASC)', () => {
      const first = repo.create(makeInput({ id: 'f-a' }))._unsafeUnwrap();
      const second = repo.create(makeInput({ id: 'f-b' }))._unsafeUnwrap();
      const third = repo.create(makeInput({ id: 'f-c' }))._unsafeUnwrap();
      repo.create(makeInput({ id: 'f-other', runId: otherRunId, threadId: otherThreadId, imageIds: [imgOther] }));

      const page = repo.findPage({ threadId })._unsafeUnwrap();
      // Monotonic clock: f-c was created last, so it sorts first.
      expect(page.findings.map((f) => f.finding.id)).toEqual([
        third.finding.id,
        second.finding.id,
        first.finding.id,
      ]);
      expect(page.findings.map((f) => f.finding.id)).not.toContain('f-other');
      expect(page.nextAnchor).toBeNull();
    });

    it('pages with a keyset anchor without repeats or gaps', () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        ids.push(repo.create(makeInput({ id: `page-${i}` }))._unsafeUnwrap().finding.id);
      }
      // Expected order: creation descending.
      const expected = [...ids].reverse();

      const p1 = repo.findPage({ threadId, limit: 2 })._unsafeUnwrap();
      expect(p1.findings.map((f) => f.finding.id)).toEqual(expected.slice(0, 2));
      expect(p1.nextAnchor).not.toBeNull();

      const p2 = repo.findPage({ threadId, limit: 2, before: p1.nextAnchor! })._unsafeUnwrap();
      expect(p2.findings.map((f) => f.finding.id)).toEqual(expected.slice(2, 4));
      expect(p2.nextAnchor).not.toBeNull();

      const p3 = repo.findPage({ threadId, limit: 2, before: p2.nextAnchor! })._unsafeUnwrap();
      expect(p3.findings.map((f) => f.finding.id)).toEqual(expected.slice(4));
      expect(p3.nextAnchor).toBeNull();

      const seen = [...p1.findings, ...p2.findings, ...p3.findings].map((f) => f.finding.id);
      expect(new Set(seen).size).toBe(5);
      expect(seen).toEqual(expected);
    });

    it('breaks created_at ties with id ascending and continues the keyset across ties', () => {
      // Same chronological key for all three rows: only the id tiebreak orders
      // them, and a keyset condition without the id term would skip or repeat.
      insertFindingRaw('tie-02', 1_700_000_000_000);
      insertFindingRaw('tie-01', 1_700_000_000_000);
      insertFindingRaw('tie-03', 1_700_000_000_000);

      const p1 = repo.findPage({ threadId, limit: 2 })._unsafeUnwrap();
      expect(p1.findings.map((f) => f.finding.id)).toEqual(['tie-01', 'tie-02']);
      expect(p1.nextAnchor).toEqual({ createdAt: 1_700_000_000_000, id: 'tie-02' });

      const p2 = repo.findPage({ threadId, limit: 2, before: p1.nextAnchor! })._unsafeUnwrap();
      expect(p2.findings.map((f) => f.finding.id)).toEqual(['tie-03']);
      expect(p2.nextAnchor).toBeNull();
    });

    it('filters by source Image, newest first', () => {
      repo.create(makeInput({ id: 'only-a', imageIds: [imgA] }));
      repo.create(makeInput({ id: 'both-b-a', imageIds: [imgB, imgA] }));
      repo.create(makeInput({ id: 'only-b', imageIds: [imgB] }));

      const viaA = repo.findPage({ threadId, imageId: imgA })._unsafeUnwrap();
      expect(viaA.findings.map((f) => f.finding.id)).toEqual(['both-b-a', 'only-a']);
      const viaB = repo.findPage({ threadId, imageId: imgB })._unsafeUnwrap();
      expect(viaB.findings.map((f) => f.finding.id)).toEqual(['only-b', 'both-b-a']);

      const none = repo.findPage({ threadId, imageId: uuid() })._unsafeUnwrap();
      expect(none.findings).toEqual([]);
      expect(none.nextAnchor).toBeNull();
    });

    it('rejects a non-positive or fractional limit instead of going unbounded', () => {
      for (const limit of [0, -5, 2.5]) {
        const result = repo.findPage({ threadId, limit });
        expect(result.isErr()).toBe(true);
        expect(String(result._unsafeUnwrapErr().message)).toMatch(/positive integer limit/i);
      }
    });

    it('is independent of message history, queue state, and run status', () => {
      const created = repo.create(makeInput())._unsafeUnwrap();

      // Queue churn: nothing here is keyed off queue existence.
      expect(count('queue_items')).toBe(0);
      db.prepare('DELETE FROM queue_items').run();

      // A history cutoff moving the owning message's clock does not move the
      // Finding: the query never reads `messages`.
      db.prepare('UPDATE messages SET created_at = 1_500_000_000_000').run();

      // The main run fails after the Finding was persisted.
      db.prepare("UPDATE runs SET status = 'failed', error = 'boom' WHERE id = ?").run(runId);

      const runRow = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as {
        status: string;
      };
      expect(runRow.status).toBe('failed');

      const page = repo.findPage({ threadId })._unsafeUnwrap();
      expect(page.findings.map((f) => f.finding.id)).toEqual([created.finding.id]);
      const exact = repo.findById(created.finding.id)._unsafeUnwrap();
      expect(exact?.finding.answer).toBe('A ceramic mug and an open notebook.');
    });

    it('survives Image expiry and keeps Image-filtered queries working', () => {
      const created = repo.create(makeInput({ imageIds: [imgA, imgB] }))._unsafeUnwrap();

      images.markUnavailable(imgA, 'expired')._unsafeUnwrap();
      images.markUnavailable(imgB, 'file_missing')._unsafeUnwrap();

      const filtered = repo.findPage({ threadId, imageId: imgA })._unsafeUnwrap();
      expect(filtered.findings.map((f) => f.finding.id)).toEqual([created.finding.id]);
      const exact = repo.findByIdInThread(created.finding.id, threadId)._unsafeUnwrap();
      expect(exact?.finding.extracted_text).toBe('CAFE OPEN 9-17');
      expect(exact?.imageIds).toEqual([imgA, imgB]);
    });
  });

  describe('storage invariants', () => {
    it('lets thread-level cascade removal still complete through the runs FK', () => {
      repo.create(makeInput())._unsafeUnwrap();
      expect(count('findings')).toBe(1);

      // Deleting the channel cascades threads → runs, images, findings. The
      // findings.run_id FK deliberately has no delete action; SQLite checks it
      // at end of statement, so the same cascade still completes atomically.
      new ChannelRepository(db).delete(channelId)._unsafeUnwrap();

      expect(count('findings')).toBe(0);
      expect(count('finding_images')).toBe(0);
      expect(count('runs')).toBe(0);
    });

    it('blocks a Finding with a run pointing at a different thread than declared', () => {
      // The repository refuses this at the write boundary; storage also refuses
      // to orphan: deleting the run while a Finding still references it fails.
      repo.create(makeInput())._unsafeUnwrap();
      expect(() => db.prepare('DELETE FROM runs WHERE id = ?').run(runId)).toThrow(/FOREIGN KEY/i);
      expect(count('findings')).toBe(1);
    });

    it('rejects an association pointing at an unknown Image via foreign key', () => {
      const created = repo.create(makeInput())._unsafeUnwrap();
      expect(() =>
        db
          .prepare('INSERT INTO finding_images (finding_id, image_id, position) VALUES (?, ?, 1)')
          .run(created.finding.id, uuid()),
      ).toThrow(/FOREIGN KEY/i);
      expect(count('finding_images')).toBe(1);
    });
  });
});
