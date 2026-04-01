/**
 * `talonctl reset-provider-affinity` command.
 *
 * Resets provider affinity for a specific thread without rewriting run history.
 */

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type Database from 'better-sqlite3';
import { loadConfig } from '../../core/config/config-loader.js';
import { createDatabase } from '../../core/database/connection.js';
import { ChannelRepository } from '../../core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../core/database/repositories/thread-repository.js';
import { RunRepository, type RunStatus } from '../../core/database/repositories/run-repository.js';
import { withProviderAffinityResetAt } from '../../threads/thread-metadata.js';
import { DEFAULT_CONFIG_PATH } from '../config-utils.js';

export interface ResetProviderAffinityPreview {
  channel: string;
  externalId: string;
  threadId: string;
  lastProviderName: string | null;
  lastRunStatus: RunStatus | null;
  lastActivityAt: number | null;
}

export interface ResetProviderAffinityOptions {
  channel: string;
  externalId: string;
  db: Database.Database;
  now?: () => number;
  confirm?: (preview: ResetProviderAffinityPreview) => Promise<boolean> | boolean;
}

export interface ResetProviderAffinityResult extends ResetProviderAffinityPreview {
  aborted: boolean;
  resetAt: number | null;
}

export function formatResetProviderAffinityWarning(preview: ResetProviderAffinityPreview): string {
  const lastActivity = preview.lastActivityAt === null
    ? 'none'
    : new Date(preview.lastActivityAt).toISOString();
  return [
    `Reset provider affinity for channel "${preview.channel}" thread "${preview.externalId}"?`,
    `Thread ID: ${preview.threadId}`,
    `Last provider: ${preview.lastProviderName ?? 'none'}`,
    `Last run status: ${preview.lastRunStatus ?? 'none'}`,
    `Last activity: ${lastActivity}`,
    'This keeps run history intact, but the next message on this thread will use persona/default provider selection instead of previous thread affinity.',
    `Use \`talonctl list-threads --channel ${preview.channel}\` to discover external IDs for this channel.`,
    'Continue? [y/N]',
  ].join('\n');
}

async function promptForConfirmation(preview: ResetProviderAffinityPreview): Promise<boolean> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error('Confirmation requires an interactive terminal. Re-run with --yes to bypass the prompt.');
  }

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`${formatResetProviderAffinityWarning(preview)} `);
    return /^(y|yes)$/iu.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function resetProviderAffinity(
  options: ResetProviderAffinityOptions,
): Promise<ResetProviderAffinityResult> {
  const channelRepo = new ChannelRepository(options.db);
  const channel = channelRepo.findByName(options.channel);
  if (channel.isErr()) {
    throw new Error(`Database error looking up channel: ${channel.error.message}`);
  }
  if (channel.value === null) {
    throw new Error(`Unknown channel: "${options.channel}"`);
  }

  const threadRepo = new ThreadRepository(options.db);
  const thread = threadRepo.findByExternalId(channel.value.id, options.externalId);
  if (thread.isErr()) {
    throw new Error(`Database error looking up thread: ${thread.error.message}`);
  }
  if (thread.value === null) {
    throw new Error(`Unknown thread for channel "${options.channel}" and external ID "${options.externalId}"`);
  }

  const runRepo = new RunRepository(options.db);
  const latestRun = runRepo.findLatestByThread(thread.value.id);
  if (latestRun.isErr()) {
    throw new Error(`Database error looking up latest run: ${latestRun.error.message}`);
  }

  const preview: ResetProviderAffinityPreview = {
    channel: options.channel,
    externalId: options.externalId,
    threadId: thread.value.id,
    lastProviderName: latestRun.value?.provider_name ?? null,
    lastRunStatus: latestRun.value?.status ?? null,
    lastActivityAt: latestRun.value?.created_at ?? null,
  };

  const confirmed = options.confirm ? await options.confirm(preview) : true;
  if (!confirmed) {
    return {
      ...preview,
      aborted: true,
      resetAt: null,
    };
  }

  const resetAt = options.now ? options.now() : Date.now();
  const updated = threadRepo.update(thread.value.id, {
    metadata: withProviderAffinityResetAt(thread.value.metadata, resetAt),
  });
  if (updated.isErr()) {
    throw new Error(`Failed to update thread metadata: ${updated.error.message}`);
  }

  return {
    ...preview,
    aborted: false,
    resetAt,
  };
}

export async function resetProviderAffinityCommand(options: {
  channel: string;
  externalId: string;
  configPath?: string;
  yes?: boolean;
}): Promise<void> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const configResult = loadConfig(configPath);
  if (configResult.isErr()) {
    console.error(`Error loading config: ${configResult.error.message}`);
    process.exit(1);
    return;
  }

  const dbResult = createDatabase(configResult.value.storage.path);
  if (dbResult.isErr()) {
    console.error(`Error opening database: ${dbResult.error.message}`);
    process.exit(1);
    return;
  }

  const db = dbResult.value;
  try {
    const result = await resetProviderAffinity({
      channel: options.channel,
      externalId: options.externalId,
      db,
      confirm: options.yes ? async () => true : promptForConfirmation,
    });

    if (result.aborted) {
      console.log('Aborted.');
      return;
    }

    console.log(
      `Reset provider affinity for channel "${result.channel}" thread "${result.externalId}" at ${new Date(result.resetAt!).toISOString()}.`,
    );
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}
