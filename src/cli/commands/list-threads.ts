/**
 * `talonctl list-threads` command.
 *
 * Lists persisted threads for a channel together with their latest run summary.
 */

import type Database from 'better-sqlite3';
import { loadConfig } from '../../core/config/config-loader.js';
import { createDatabase } from '../../core/database/connection.js';
import { ChannelRepository } from '../../core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../core/database/repositories/thread-repository.js';
import { RunRepository, type RunStatus } from '../../core/database/repositories/run-repository.js';
import { DEFAULT_CONFIG_PATH } from '../config-utils.js';

export interface ListThreadsOptions {
  channel: string;
  db: Database.Database;
}

export interface ThreadSummary {
  threadId: string;
  externalId: string;
  lastProviderName: string | null;
  lastRunStatus: RunStatus | null;
  lastActivityAt: number;
}

export function listThreads(options: ListThreadsOptions): ThreadSummary[] {
  const channelRepo = new ChannelRepository(options.db);
  const channel = channelRepo.findByName(options.channel);
  if (channel.isErr()) {
    throw new Error(`Database error looking up channel: ${channel.error.message}`);
  }
  if (channel.value === null) {
    throw new Error(`Unknown channel: "${options.channel}"`);
  }

  const threadRepo = new ThreadRepository(options.db);
  const threads = threadRepo.findByChannelId(channel.value.id);
  if (threads.isErr()) {
    throw new Error(`Database error listing threads for channel "${options.channel}": ${threads.error.message}`);
  }

  const runRepo = new RunRepository(options.db);
  const summaries = threads.value.map((thread) => {
    const latestRun = runRepo.findLatestByThread(thread.id, { excludeCollaboration: true });
    if (latestRun.isErr()) {
      throw new Error(`Database error looking up latest run for thread "${thread.id}": ${latestRun.error.message}`);
    }

    return {
      threadId: thread.id,
      externalId: thread.external_id,
      lastProviderName: latestRun.value?.provider_name ?? null,
      lastRunStatus: latestRun.value?.status ?? null,
      lastActivityAt: latestRun.value?.created_at ?? thread.updated_at,
    };
  });

  summaries.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return summaries;
}

export async function listThreadsCommand(options: {
  channel: string;
  configPath?: string;
}): Promise<void> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const configResult = loadConfig(configPath);
  if (configResult.isErr()) {
    console.error(`Error loading config: ${configResult.error.message}`);
    process.exit(1);
    return;
  }

  const dbResult = createDatabase(configResult.value.storage.path, { readonly: true });
  if (dbResult.isErr()) {
    console.error(`Error opening database: ${dbResult.error.message}`);
    process.exit(1);
    return;
  }

  const db = dbResult.value;
  try {
    const threads = listThreads({ channel: options.channel, db });
    if (threads.length === 0) {
      console.log(`No threads found for channel "${options.channel}".`);
      return;
    }

    const colExternalId = 28;
    const colThreadId = 36;
    const colProvider = 14;
    const colStatus = 10;

    console.log(
      `${'EXTERNAL ID'.padEnd(colExternalId)} ${'THREAD ID'.padEnd(colThreadId)} ${'PROVIDER'.padEnd(colProvider)} ${'STATUS'.padEnd(colStatus)} LAST ACTIVITY`,
    );
    console.log(
      `${'─'.repeat(colExternalId)} ${'─'.repeat(colThreadId)} ${'─'.repeat(colProvider)} ${'─'.repeat(colStatus)} ${'─'.repeat(13)}`,
    );
    for (const thread of threads) {
      console.log(
        `${thread.externalId.padEnd(colExternalId)} ${thread.threadId.padEnd(colThreadId)} ${(thread.lastProviderName ?? '-').padEnd(colProvider)} ${(thread.lastRunStatus ?? '-').padEnd(colStatus)} ${new Date(thread.lastActivityAt).toISOString()}`,
      );
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}
