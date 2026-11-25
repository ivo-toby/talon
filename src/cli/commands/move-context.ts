/**
 * `talonctl move-context` — move or copy a conversation's memory and history
 * to another conversation, e.g. from a main chat into a Telegram topic.
 *
 * Works directly on the database, like `reset-provider-affinity`: the daemon
 * may keep running, and the next message on each affected conversation starts
 * a fresh session that reads the migrated context.
 */

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig } from '../../core/config/config-loader.js';
import { createDatabase } from '../../core/database/connection.js';
import {
  moveThreadContext,
  type MoveThreadContextResult,
  type ThreadContextMovePlan,
} from '../../threads/thread-context-move.js';
import { DEFAULT_CONFIG_PATH } from '../config-utils.js';

export interface MoveContextCommandOptions {
  channel: string;
  from: string;
  to: string;
  /** Target channel when it differs from `channel`. */
  toChannel?: string;
  /** Leave the source untouched instead of emptying it. */
  copy?: boolean;
  /** Carry memory items and notebook files only, not the message history. */
  memoryOnly?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  configPath?: string;
}

/** Human-readable preview shown before the confirmation prompt and for --dry-run. */
export function formatMoveContextPlan(
  plan: ThreadContextMovePlan,
  options: Pick<MoveContextCommandOptions, 'channel' | 'toChannel' | 'from' | 'to' | 'memoryOnly'>,
): string {
  const verb = plan.mode === 'move' ? 'Move' : 'Copy';
  const byType = Object.entries(plan.source.memoryItemsByType)
    .map(([type, n]) => `${n} ${type}`)
    .join(', ');
  const lines = [
    `${verb} context from "${options.from}" (${options.channel}) to "${options.to}" (${options.toChannel ?? options.channel})`,
    `  Memory items:   ${plan.source.memoryItems}${byType ? ` (${byType})` : ''}`,
    options.memoryOnly
      ? '  Messages:       not included (--memory-only)'
      : `  Messages:       ${plan.source.messages}`,
    `  Notebook files: ${plan.source.notebookFiles}`,
  ];
  if (plan.mode === 'move' && plan.source.imageMessages > 0) {
    lines.push(
      `  ${plan.source.imageMessages} message(s) with images stay in the source: images belong to the conversation they were sent in.`,
    );
  }
  if (plan.target.threadId === null) {
    lines.push('  The target conversation has no history yet; it will be created.');
  } else if (plan.target.memoryItems > 0 || plan.target.messages > 0) {
    lines.push(
      `  WARNING: the target already has ${plan.target.memoryItems} memory item(s) and ${plan.target.messages} message(s). The two histories will be merged by time.`,
    );
  }
  lines.push(
    plan.mode === 'move'
      ? '  The source conversation starts fresh afterwards: it loses this memory and history.'
      : '  The source conversation is left unchanged.',
  );
  return lines.join('\n');
}

/** Human-readable outcome of a completed move or copy. */
export function formatMoveContextResult(result: MoveThreadContextResult): string {
  const done = result.plan.mode === 'move' ? 'Moved' : 'Copied';
  const lines = [
    `${done} ${result.memoryItems} memory item(s), ${result.messages} message(s) and ${result.notebookFiles} notebook file(s).`,
  ];
  if (result.targetThreadCreated) {
    lines.push('Created the target conversation.');
  }
  if (result.memoryAlreadyInTarget > 0) {
    lines.push(
      `${result.memoryAlreadyInTarget} memory item(s) were already in the target and were removed from the source.`,
    );
  }
  if (result.memoryConflicts > 0) {
    lines.push(
      `${result.memoryConflicts} memory item(s) were skipped: the target already has an item with the same ID but different content.`,
    );
  }
  if (result.messagesKeptForImages > 0) {
    lines.push(`${result.messagesKeptForImages} message(s) with images stayed in the source.`);
  }
  if (result.notebookConflicts > 0) {
    lines.push(
      `${result.notebookConflicts} notebook file(s) were skipped: the target already has a different file with the same name.`,
    );
  }
  lines.push(
    'The next message in the target conversation starts a fresh session that reads this context. No restart is needed.',
  );
  return lines.join('\n');
}

async function confirm(question: string): Promise<boolean> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      'Confirmation requires an interactive terminal. Re-run with --yes to bypass the prompt.',
    );
  }
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`${question}\nContinue? [y/N] `);
    return /^(y|yes)$/iu.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function moveContextCommand(options: MoveContextCommandOptions): Promise<void> {
  const configResult = loadConfig(options.configPath ?? DEFAULT_CONFIG_PATH);
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

  const request = {
    db,
    from: { channel: options.channel, externalId: options.from },
    to: { channel: options.toChannel ?? options.channel, externalId: options.to },
    mode: options.copy ? ('copy' as const) : ('move' as const),
    includeMessages: options.memoryOnly !== true,
    dataDir: configResult.value.dataDir,
  };

  try {
    const preview = moveThreadContext({ ...request, dryRun: true });
    if (preview.isErr()) {
      throw preview.error;
    }
    const planText = formatMoveContextPlan(preview.value.plan, options);
    if (options.dryRun) {
      console.log(`${planText}\nDry run: nothing was changed.`);
      return;
    }
    if (!options.yes && !(await confirm(planText))) {
      console.log('Aborted. Nothing was changed.');
      return;
    }
    if (options.yes) {
      console.log(planText);
    }

    const result = moveThreadContext(request);
    if (result.isErr()) {
      throw result.error;
    }
    console.log(formatMoveContextResult(result.value));
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
