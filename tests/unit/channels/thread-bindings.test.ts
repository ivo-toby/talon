/**
 * Thread-scoped bindings from config (`bindings[].thread`).
 *
 * Runs reconcileThreadBindings against a real migrated database and checks
 * the result through the real ChannelRouter, so "a topic answers with its own
 * persona" is verified end to end rather than through mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import pino from 'pino';
import { reconcileThreadBindings } from '../../../src/channels/channel-setup.js';
import { ChannelRouter } from '../../../src/channels/channel-router.js';
import { BindingRepository } from '../../../src/core/database/repositories/binding-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { BindingConfigSchema } from '../../../src/core/config/config-schema.js';
import type { BindingConfig } from '../../../src/core/config/config-types.js';
import { createTestDb, uuid } from '../core/database/repositories/helpers.js';

const CHANNEL = 'TalonMain';
const GROUP = '-1004452318413';
const GROCERIES_TOPIC = `${GROUP}:42`;
const CALENDAR_TOPIC = `${GROUP}:43`;

describe('thread-scoped bindings', () => {
  let db: Database.Database;
  let channels: ChannelRepository;
  let personas: PersonaRepository;
  let bindings: BindingRepository;
  let threads: ThreadRepository;
  let router: ChannelRouter;
  let channelId: string;
  const personaIds: Record<string, string> = {};
  const logger = pino({ level: 'silent' });

  function binding(input: {
    persona: string;
    thread?: string;
    isDefault?: boolean;
    channel?: string;
  }): BindingConfig {
    return BindingConfigSchema.parse({ channel: CHANNEL, ...input });
  }

  function reconcile(list: BindingConfig[], channelNames: string[] = [CHANNEL]): void {
    reconcileThreadBindings(list, channelNames, {
      channelRepo: channels,
      personaRepo: personas,
      bindingRepo: bindings,
      threadRepo: threads,
      logger,
    });
  }

  /** The persona name the router resolves for a conversation. */
  function personaFor(externalThreadId: string): string | null {
    const thread = threads.findByExternalId(channelId, externalThreadId)._unsafeUnwrap();
    const resolved = router.resolvePersona(channelId, thread?.id ?? null)._unsafeUnwrap();
    return Object.entries(personaIds).find(([, id]) => id === resolved)?.[0] ?? null;
  }

  beforeEach(() => {
    db = createTestDb();
    channels = new ChannelRepository(db);
    personas = new PersonaRepository(db);
    bindings = new BindingRepository(db);
    threads = new ThreadRepository(db);
    router = new ChannelRouter(bindings, logger);

    channelId = uuid();
    channels.insert({
      id: channelId,
      type: 'telegram',
      name: CHANNEL,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });
    for (const name of ['assistant', 'groceries', 'calendar']) {
      personaIds[name] = uuid();
      db.prepare(
        `INSERT INTO personas (id, name, model, created_at, updated_at) VALUES (?, ?, 'm', ?, ?)`,
      ).run(personaIds[name], name, Date.now(), Date.now());
    }
    // The channel default, as registerChannels/reconcileBindings would set it.
    bindings.insert({
      id: uuid(),
      channel_id: channelId,
      thread_id: null,
      persona_id: personaIds.assistant,
      is_default: 1,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('routes each bound topic to its own persona and everything else to the default', () => {
    reconcile([
      binding({ persona: 'groceries', thread: GROCERIES_TOPIC }),
      binding({ persona: 'calendar', thread: CALENDAR_TOPIC }),
    ]);

    expect(personaFor(GROCERIES_TOPIC)).toBe('groceries');
    expect(personaFor(CALENDAR_TOPIC)).toBe('calendar');
    // General (the plain chat thread) and an unbound topic fall back.
    expect(personaFor(GROUP)).toBe('assistant');
    expect(personaFor(`${GROUP}:99`)).toBe('assistant');
  });

  it('creates the thread row for a topic that has not sent a message yet', () => {
    expect(threads.findByExternalId(channelId, GROCERIES_TOPIC)._unsafeUnwrap()).toBeNull();
    reconcile([binding({ persona: 'groceries', thread: GROCERIES_TOPIC })]);
    expect(threads.findByExternalId(channelId, GROCERIES_TOPIC)._unsafeUnwrap()).not.toBeNull();
  });

  it('marks the bindings it creates as config-owned and non-default', () => {
    reconcile([binding({ persona: 'groceries', thread: GROCERIES_TOPIC })]);
    const scoped = bindings.findThreadScopedForChannel(channelId)._unsafeUnwrap();
    expect(scoped).toHaveLength(1);
    expect(scoped[0]).toMatchObject({ source: 'config', is_default: 0 });
  });

  it('is idempotent across restarts', () => {
    const list = [binding({ persona: 'groceries', thread: GROCERIES_TOPIC })];
    reconcile(list);
    reconcile(list);
    expect(bindings.findThreadScopedForChannel(channelId)._unsafeUnwrap()).toHaveLength(1);
    expect(personaFor(GROCERIES_TOPIC)).toBe('groceries');
  });

  it('repoints a topic when the YAML names another persona', () => {
    reconcile([binding({ persona: 'groceries', thread: GROCERIES_TOPIC })]);
    reconcile([binding({ persona: 'calendar', thread: GROCERIES_TOPIC })]);
    expect(personaFor(GROCERIES_TOPIC)).toBe('calendar');
    expect(bindings.findThreadScopedForChannel(channelId)._unsafeUnwrap()).toHaveLength(1);
  });

  it('returns a topic to the default when its entry is removed from the YAML', () => {
    reconcile([
      binding({ persona: 'groceries', thread: GROCERIES_TOPIC }),
      binding({ persona: 'calendar', thread: CALENDAR_TOPIC }),
    ]);
    reconcile([binding({ persona: 'calendar', thread: CALENDAR_TOPIC })]);

    expect(personaFor(GROCERIES_TOPIC)).toBe('assistant');
    expect(personaFor(CALENDAR_TOPIC)).toBe('calendar');
  });

  it('removes the last config-owned binding when the list becomes empty', () => {
    reconcile([binding({ persona: 'groceries', thread: GROCERIES_TOPIC })]);
    reconcile([]);
    expect(bindings.findThreadScopedForChannel(channelId)._unsafeUnwrap()).toHaveLength(0);
  });

  it('never removes a binding it did not create', () => {
    const thread = threads
      .insert({ id: uuid(), channel_id: channelId, external_id: GROCERIES_TOPIC, metadata: '{}' })
      ._unsafeUnwrap();
    bindings.insert({
      id: uuid(),
      channel_id: channelId,
      thread_id: thread.id,
      persona_id: personaIds.groceries,
      is_default: 0,
    });

    reconcile([]);

    expect(personaFor(GROCERIES_TOPIC)).toBe('groceries');
    expect(bindings.findThreadScopedForChannel(channelId)._unsafeUnwrap()[0].source).toBe(
      'runtime',
    );
  });

  it('takes over a runtime binding the YAML now declares, making it removable', () => {
    const thread = threads
      .insert({ id: uuid(), channel_id: channelId, external_id: GROCERIES_TOPIC, metadata: '{}' })
      ._unsafeUnwrap();
    bindings.insert({
      id: uuid(),
      channel_id: channelId,
      thread_id: thread.id,
      persona_id: personaIds.groceries,
      is_default: 0,
    });

    reconcile([binding({ persona: 'calendar', thread: GROCERIES_TOPIC })]);
    expect(personaFor(GROCERIES_TOPIC)).toBe('calendar');
    expect(bindings.findThreadScopedForChannel(channelId)._unsafeUnwrap()[0].source).toBe('config');

    reconcile([]);
    expect(personaFor(GROCERIES_TOPIC)).toBe('assistant');
  });

  it('leaves the channel default alone', () => {
    reconcile([binding({ persona: 'groceries', thread: GROCERIES_TOPIC, isDefault: true })]);
    expect(bindings.findDefaultForChannel(channelId)._unsafeUnwrap()?.persona_id).toBe(
      personaIds.assistant,
    );
  });

  it('skips an entry with an unknown persona or channel without failing the rest', () => {
    reconcile([
      binding({ persona: 'nobody', thread: GROCERIES_TOPIC }),
      binding({ persona: 'groceries', thread: GROCERIES_TOPIC, channel: 'missing-channel' }),
      binding({ persona: 'calendar', thread: CALENDAR_TOPIC }),
    ]);
    expect(personaFor(GROCERIES_TOPIC)).toBe('assistant');
    expect(personaFor(CALENDAR_TOPIC)).toBe('calendar');
  });

  it('does not prune on channels that are not in the config', () => {
    reconcile([binding({ persona: 'groceries', thread: GROCERIES_TOPIC })]);
    reconcile([], []);
    expect(personaFor(GROCERIES_TOPIC)).toBe('groceries');
  });

  it('does nothing without a thread repository', () => {
    reconcileThreadBindings(
      [binding({ persona: 'groceries', thread: GROCERIES_TOPIC })],
      [CHANNEL],
      {
        channelRepo: channels,
        personaRepo: personas,
        bindingRepo: bindings,
        logger,
      },
    );
    expect(bindings.findThreadScopedForChannel(channelId)._unsafeUnwrap()).toHaveLength(0);
  });

  describe('config schema', () => {
    it('accepts a quoted thread id and leaves it untouched', () => {
      expect(binding({ persona: 'groceries', thread: GROCERIES_TOPIC }).thread).toBe(
        GROCERIES_TOPIC,
      );
    });

    it('coerces a bare numeric chat id to a string', () => {
      const parsed = BindingConfigSchema.parse({
        persona: 'groceries',
        channel: CHANNEL,
        thread: -1004452318413,
      });
      expect(parsed.thread).toBe(GROUP);
    });

    it('keeps thread optional and rejects an empty one', () => {
      expect(binding({ persona: 'assistant', isDefault: true }).thread).toBeUndefined();
      expect(() =>
        BindingConfigSchema.parse({ persona: 'a', channel: CHANNEL, thread: '   ' }),
      ).toThrow();
    });
  });
});
