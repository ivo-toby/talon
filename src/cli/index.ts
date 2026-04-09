/**
 * talonctl — Talon CLI control utility entry point.
 *
 * Provides sub-commands for managing the talond daemon:
 *   - status   Show daemon health, active containers, queue depth
 *   - migrate  Apply database migrations (standalone, no daemon needed)
 *   - backup   Backup database (standalone, no daemon needed)
 *   - reload   Hot-reload configuration (communicates with daemon)
 *   - doctor   Check system requirements and configuration (standalone)
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';

import { statusCommand } from './commands/status.js';
import { migrateCommand } from './commands/migrate.js';
import { backupCommand } from './commands/backup.js';
import { reloadCommand } from './commands/reload.js';
import { doctorCommand } from './commands/doctor.js';
import { setupCommand } from './commands/setup.js';
import { addChannelCommand } from './commands/add-channel.js';
import { addPersonaCommand } from './commands/add-persona.js';
import { addSkillCommand } from './commands/add-skill.js';
import { queuePurgeCommand } from './commands/queue-purge.js';
import { chatCommand } from './commands/chat.js';
import { listChannelsCommand } from './commands/list-channels.js';
import { listPersonasCommand } from './commands/list-personas.js';
import { listSkillsCommand } from './commands/list-skills.js';
import { listCapabilitiesCommand } from './commands/list-capabilities.js';
import { bindCommand } from './commands/bind.js';
import { unbindCommand } from './commands/unbind.js';
import { addMcpCommand } from './commands/add-mcp.js';
import { envCheckCommand } from './commands/env-check.js';
import { removeChannelCommand } from './commands/remove-channel.js';
import { removePersonaCommand } from './commands/remove-persona.js';
import { configShowCommand } from './commands/config-show.js';
import { addScheduleCommand } from './commands/add-schedule.js';
import { listSchedulesCommand } from './commands/list-schedules.js';
import { removeScheduleCommand } from './commands/remove-schedule.js';
import { runSubAgentCommand } from './commands/run-subagent.js';
import { listProvidersCommand } from './commands/list-providers.js';
import { addProviderCommand } from './commands/add-provider.js';
import { setDefaultProviderCommand } from './commands/set-default-provider.js';
import { testProviderCommand } from './commands/test-provider.js';
import { listThreadsCommand } from './commands/list-threads.js';
import { resetProviderAffinityCommand } from './commands/reset-provider-affinity.js';
import { whatsappAuthCommand } from './commands/whatsapp-auth.js';
import { setCapabilitiesCommand } from './commands/set-capabilities.js';
import { a2aListCommand, a2aSendCommand } from './commands/a2a.js';
import { installSkillCommand } from './commands/install-skill.js';

// Load .env before anything else so ${VAR} substitution works in config.
const envPath = resolve(process.env.TALOND_ENV_FILE || '.env');
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch (cause) {
    process.stderr.write(`warning: failed to parse ${envPath}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  }
}

const program = new Command();

function parseBooleanOption(value: string): boolean {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`Invalid boolean value "${value}". Use true or false.`);
}

function parseCommaSeparatedOption(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

program
  .name('talonctl')
  .description('CLI for managing the talond daemon')
  .version('0.1.0');

program
  .command('status')
  .description('Show daemon health, active containers, queue depth')
  .option('--ipc-dir <path>', 'IPC directory (overrides config default)')
  .option('--timeout <ms>', 'Response timeout in milliseconds', '5000')
  .action(async (opts: { ipcDir?: string; timeout: string }) => {
    await statusCommand({
      ipcDir: opts.ipcDir,
      timeoutMs: parseInt(opts.timeout, 10),
    });
  });

program
  .command('migrate')
  .description('Apply database migrations')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action((opts: { config: string }) => {
    migrateCommand({ configPath: opts.config });
  });

program
  .command('backup')
  .description('Backup database, config, personas, and skills')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .option('--output <path>', 'Backup output directory (overrides default)')
  .action(async (opts: { config: string; output?: string }) => {
    await backupCommand({
      configPath: opts.config,
      backupPath: opts.output,
    });
  });

program
  .command('reload')
  .description('Hot-reload configuration without restarting')
  .option('--ipc-dir <path>', 'IPC directory (overrides config default)')
  .option('--timeout <ms>', 'Response timeout in milliseconds', '5000')
  .action(async (opts: { ipcDir?: string; timeout: string }) => {
    await reloadCommand({
      ipcDir: opts.ipcDir,
      timeoutMs: parseInt(opts.timeout, 10),
    });
  });

program
  .command('doctor')
  .description('Check system requirements and configuration')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: { config: string }) => {
    await doctorCommand({ configPath: opts.config });
  });

program
  .command('setup')
  .description('First-time setup: detect environment, create directories, generate config')
  .option('--config <path>', 'Path to write talond.yaml', 'talond.yaml')
  .option('--data-dir <path>', 'Data directory path', 'data')
  .action(async (opts: { config: string; dataDir: string }) => {
    await setupCommand({
      configPath: opts.config,
      dataDir: opts.dataDir,
    });
  });

program
  .command('add-channel')
  .description('Add a channel connector to talond.yaml')
  .requiredOption('--name <name>', 'Unique channel name (e.g. my-telegram)')
  .requiredOption('--type <type>', 'Connector type (e.g. telegram, slack, discord)')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: { name: string; type: string; config: string }) => {
    await addChannelCommand({
      name: opts.name,
      type: opts.type,
      configPath: opts.config,
    });
  });

program
  .command('add-persona')
  .description('Scaffold a persona directory and add it to talond.yaml')
  .requiredOption('--name <name>', 'Persona name (e.g. assistant)')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .option('--templates-dir <path>', 'Path to templates directory', 'templates')
  .option('--model <model>', 'Model name')
  .option('--provider <provider>', 'Provider name')
  .option('--capabilities <caps>', 'Comma-separated capabilities allow list', parseCommaSeparatedOption)
  .option('--require-approval <caps>', 'Comma-separated capabilities requiring approval', parseCommaSeparatedOption)
  .option('--skills <skills>', 'Comma-separated skill names', parseCommaSeparatedOption)
  .option('--system-prompt-file <path>', 'Path to a system prompt markdown file')
  .option('--description <text>', 'Short description of what this persona does (written to system.md frontmatter)')
  .action(async (opts: {
    name: string;
    config: string;
    templatesDir: string;
    model?: string;
    provider?: string;
    description?: string;
    capabilities?: string[];
    requireApproval?: string[];
    skills?: string[];
    systemPromptFile?: string;
  }) => {
    await addPersonaCommand({
      name: opts.name,
      description: opts.description,
      configPath: opts.config,
      templatesDir: opts.templatesDir,
      model: opts.model,
      provider: opts.provider,
      capabilities: opts.capabilities,
      requireApproval: opts.requireApproval,
      skills: opts.skills,
      systemPromptFile: opts.systemPromptFile,
    });
  });

program
  .command('add-skill')
  .description('Scaffold a skill directory and add it to a persona in talond.yaml')
  .requiredOption('--name <name>', 'Skill name (e.g. web-search)')
  .requiredOption('--persona <persona>', 'Persona to attach the skill to')
  .option('--format <format>', 'Skill format: yaml or skillmd', 'yaml')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: { name: string; persona: string; format: string; config: string }) => {
    if (opts.format !== 'yaml' && opts.format !== 'skillmd') {
      console.error(`Error: invalid format "${opts.format}". Must be "yaml" or "skillmd".`);
      process.exit(1);
    }
    await addSkillCommand({
      name: opts.name,
      personaName: opts.persona,
      format: opts.format,
      configPath: opts.config,
    });
  });

program
  .command('queue-purge')
  .description('Purge queue items by status (default: pending, failed, completed)')
  .option('--ipc-dir <path>', 'IPC directory (overrides config default)')
  .option('--timeout <ms>', 'Response timeout in milliseconds', '5000')
  .option('--statuses <list>', 'Comma-separated statuses to purge (pending,failed,completed,dead_letter,claimed,processing)')
  .option('--all', 'Purge all statuses including in-flight items')
  .action(async (opts: { ipcDir?: string; timeout: string; statuses?: string; all?: boolean }) => {
    await queuePurgeCommand({
      ipcDir: opts.ipcDir,
      timeoutMs: parseInt(opts.timeout, 10),
      statuses: opts.statuses?.split(',').map((s) => s.trim()),
      all: opts.all,
    });
  });

program
  .command('chat')
  .description('Connect to a Talon persona via terminal channel')
  .option('--host <host>', 'Terminal connector host', '127.0.0.1')
  .option('--port <port>', 'Terminal connector port', '7700')
  .option('--token <token>', 'Authentication token (or set TERMINAL_TOKEN env var)')
  .option('--client-id <id>', 'Client identity for persistent threads')
  .option('--persona <name>', 'Persona to connect to (overrides channel default)')
  .option('--tls', 'Use wss:// (TLS) instead of ws://')
  .action(async (opts: { host: string; port: string; token?: string; clientId?: string; persona?: string; tls?: boolean }) => {
    const token = opts.token ?? process.env.TERMINAL_TOKEN;
    if (!token) {
      console.error('Error: --token is required (or set TERMINAL_TOKEN env var).');
      process.exit(1);
    }
    await chatCommand({
      host: opts.host,
      port: parseInt(opts.port, 10),
      token,
      clientId: opts.clientId,
      persona: opts.persona,
      tls: opts.tls,
    });
  });

// ---------------------------------------------------------------------------
// New commands (CLI-008 through CLI-017)
// ---------------------------------------------------------------------------

program
  .command('list-channels')
  .description('List all configured channels')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: { config: string }) => {
    await listChannelsCommand({ configPath: opts.config });
  });

program
  .command('list-personas')
  .description('List all configured personas')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: { config: string }) => {
    await listPersonasCommand({ configPath: opts.config });
  });

program
  .command('list-skills')
  .description('List all skills (optionally filter by persona)')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .option('--persona <name>', 'Filter skills by persona name')
  .action(async (opts: { config: string; persona?: string }) => {
    await listSkillsCommand({ configPath: opts.config, personaName: opts.persona });
  });

program
  .command('list-capabilities')
  .description('List all available capability labels for persona config')
  .action(() => {
    listCapabilitiesCommand();
  });

program
  .command('set-capabilities')
  .description('Set capability labels on a persona')
  .requiredOption('--persona <name>', 'Persona name')
  .option('--allow <labels>', 'Replace allow list (comma-separated)')
  .option('--add <labels>', 'Add to allow list (comma-separated)')
  .option('--remove <labels>', 'Remove from allow list (comma-separated)')
  .option('--require-approval <labels>', 'Replace requireApproval list (comma-separated)')
  .option('--show', 'Show current capabilities without modifying')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: {
    persona: string;
    allow?: string;
    add?: string;
    remove?: string;
    requireApproval?: string;
    show?: boolean;
    config: string;
  }) => {
    await setCapabilitiesCommand({
      persona: opts.persona,
      allow: opts.allow,
      add: opts.add,
      remove: opts.remove,
      requireApproval: opts.requireApproval,
      show: opts.show,
      configPath: opts.config,
    });
  });

program
  .command('bind')
  .description('Bind a persona to a channel')
  .requiredOption('--persona <name>', 'Persona name')
  .requiredOption('--channel <name>', 'Channel name')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: { persona: string; channel: string; config: string }) => {
    await bindCommand({ persona: opts.persona, channel: opts.channel, configPath: opts.config });
  });

program
  .command('unbind')
  .description('Remove a persona-channel binding')
  .requiredOption('--persona <name>', 'Persona name')
  .requiredOption('--channel <name>', 'Channel name')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: { persona: string; channel: string; config: string }) => {
    await unbindCommand({ persona: opts.persona, channel: opts.channel, configPath: opts.config });
  });

program
  .command('add-mcp')
  .description('Add an MCP server to a skill')
  .requiredOption('--skill <name>', 'Skill name')
  .requiredOption('--name <name>', 'MCP server name')
  .requiredOption('--transport <type>', 'Transport type (stdio, sse, http)')
  .option('--command <cmd>', 'Command to run (required for stdio)')
  .option('--args <args...>', 'Command arguments (space-separated)')
  .option('--url <url>', 'Server URL (required for sse/http)')
  .option('--env <pairs>', 'Environment variables (KEY=VAL,KEY2=VAL2)')
  .option('--skills-dir <path>', 'Skills directory', 'skills')
  .action(async (opts: { skill: string; name: string; transport: string; command?: string; args?: string[]; url?: string; env?: string; skillsDir: string }) => {
    const envPairs: Record<string, string> = {};
    if (opts.env) {
      for (const pair of opts.env.split(',')) {
        const [k, ...vParts] = pair.split('=');
        if (k) envPairs[k] = vParts.join('=');
      }
    }
    await addMcpCommand({
      skillName: opts.skill,
      name: opts.name,
      transport: opts.transport as 'stdio' | 'sse' | 'http',
      command: opts.command,
      args: opts.args,
      url: opts.url,
      env: Object.keys(envPairs).length > 0 ? envPairs : undefined,
      skillsDir: opts.skillsDir,
    });
  });

program
  .command('env-check')
  .description('Check environment variables referenced in config')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: { config: string }) => {
    await envCheckCommand({ configPath: opts.config });
  });

program
  .command('remove-channel')
  .description('Remove a channel from talond.yaml')
  .requiredOption('--name <name>', 'Channel name to remove')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: { name: string; config: string }) => {
    await removeChannelCommand({ name: opts.name, configPath: opts.config });
  });

program
  .command('remove-persona')
  .description('Remove a persona from talond.yaml')
  .requiredOption('--name <name>', 'Persona name to remove')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: { name: string; config: string }) => {
    await removePersonaCommand({ name: opts.name, configPath: opts.config });
  });

program
  .command('config-show')
  .description('Show effective config with env vars substituted (secrets masked)')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .option('--show-secrets', 'Show secret values instead of masking them')
  .action(async (opts: { config: string; showSecrets?: boolean }) => {
    await configShowCommand({ configPath: opts.config, showSecrets: opts.showSecrets });
  });

// ---------------------------------------------------------------------------
// Schedule commands (CLI-018 through CLI-020)
// ---------------------------------------------------------------------------

program
  .command('add-schedule')
  .description('Create a scheduled task for a persona')
  .requiredOption('--persona <name>', 'Persona name')
  .requiredOption('--channel <name>', 'Channel to bind the schedule thread to')
  .requiredOption('--cron <expr>', 'Cron expression (5-field)')
  .requiredOption('--label <label>', 'Human-readable label')
  .requiredOption('--prompt <prompt>', 'Prompt text for the agent')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: { persona: string; channel: string; cron: string; label: string; prompt: string; config: string }) => {
    await addScheduleCommand({
      persona: opts.persona,
      channel: opts.channel,
      cron: opts.cron,
      label: opts.label,
      prompt: opts.prompt,
      configPath: opts.config,
    });
  });

program
  .command('list-schedules')
  .description('List all scheduled tasks')
  .option('--persona <name>', 'Filter by persona name')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: { config: string; persona?: string }) => {
    await listSchedulesCommand({ configPath: opts.config, persona: opts.persona });
  });

program
  .command('remove-schedule')
  .description('Permanently delete a scheduled task')
  .argument('<schedule-id>', 'Schedule ID to remove')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (scheduleId: string, opts: { config: string }) => {
    await removeScheduleCommand({ scheduleId, configPath: opts.config });
  });

// ---------------------------------------------------------------------------
// Sub-agent commands
// ---------------------------------------------------------------------------

program
  .command('run-subagent')
  .description('Manually invoke a sub-agent for testing (no daemon required)')
  .requiredOption('--name <name>', 'Sub-agent name (e.g. "session-summarizer")')
  .requiredOption('--input <json>', 'JSON input for the sub-agent')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .option('--subagents-dir <path>', 'Sub-agents directory (overrides config default)')
  .action(async (opts: { name: string; input: string; config: string; subagentsDir?: string }) => {
    await runSubAgentCommand({
      name: opts.name,
      input: opts.input,
      configPath: opts.config,
      subagentsDir: opts.subagentsDir,
    });
  });

// ---------------------------------------------------------------------------
// Provider commands
// ---------------------------------------------------------------------------

program
  .command('list-providers')
  .description('List all configured providers from agentRunner and backgroundAgent')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: { config: string }) => {
    await listProvidersCommand({ configPath: opts.config });
  });

program
  .command('add-provider')
  .description('Add a provider to agentRunner, backgroundAgent, or both')
  .requiredOption('--name <name>', 'Provider name (e.g. gemini-cli)')
  .requiredOption('--command <cmd>', 'CLI binary path (e.g. gemini or /usr/local/bin/gemini)')
  .option('--context <ctx>', 'Context: agent-runner, background, or both', 'both')
  .option('--context-window <tokens>', 'Context window size in tokens', '200000')
  .option('--context-enabled <enabled>', 'Enable context management for agent-runner providers (true/false)')
  .option(
    '--trigger-metric <metric>',
    'Context rotation trigger metric (input_tokens, cache_read_input_tokens, cache_creation_input_tokens, or cache_total_input_tokens)',
  )
  .option('--threshold-ratio <ratio>', 'Context rotation threshold ratio 0-1 float', '0.5')
  .option('--recent-message-count <count>', 'Recent messages to preserve in fresh sessions', '10')
  .option('--summarizer <name>', 'Subagent name used for session summarization', 'session-summarizer')
  .option('--enabled', 'Enable the provider immediately (default: disabled)')
  .option('--default-model <model>', 'Set options.defaultModel (e.g. gemini-2.5-pro)')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: {
    name: string;
    command: string;
    context: string;
    contextWindow: string;
    contextEnabled?: string;
    triggerMetric?: string;
    thresholdRatio: string;
    recentMessageCount: string;
    summarizer: string;
    enabled?: boolean;
    defaultModel?: string;
    config: string;
  }) => {
    await addProviderCommand({
      name: opts.name,
      command: opts.command,
      context: opts.context as 'agent-runner' | 'background' | 'both',
      contextWindowTokens: parseInt(opts.contextWindow, 10),
      contextEnabled: opts.contextEnabled === undefined
        ? undefined
        : parseBooleanOption(opts.contextEnabled),
      triggerMetric: opts.triggerMetric as
        | 'input_tokens'
        | 'cache_read_input_tokens'
        | 'cache_creation_input_tokens'
        | 'cache_total_input_tokens'
        | undefined,
      thresholdRatio: parseFloat(opts.thresholdRatio),
      recentMessageCount: parseInt(opts.recentMessageCount, 10),
      summarizer: opts.summarizer,
      enabled: opts.enabled ?? false,
      defaultModel: opts.defaultModel,
      configPath: opts.config,
    });
  });

program
  .command('set-default-provider')
  .description('Switch the default provider for agent-runner or background context')
  .requiredOption('--name <name>', 'Provider name to set as default')
  .requiredOption('--context <ctx>', 'Context: agent-runner or background')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: { name: string; context: string; config: string }) => {
    await setDefaultProviderCommand({
      name: opts.name,
      context: opts.context as 'agent-runner' | 'background',
      configPath: opts.config,
    });
  });

program
  .command('test-provider')
  .description('Test a provider by running a version check and minimal prompt')
  .requiredOption('--name <name>', 'Provider name to test')
  .option('--context <ctx>', 'Context: agent-runner or background', 'agent-runner')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: { name: string; context: string; config: string }) => {
    await testProviderCommand({
      name: opts.name,
      context: opts.context as 'agent-runner' | 'background',
      configPath: opts.config,
    });
  });

program
  .command('list-threads')
  .description('List persisted threads for a channel, including external IDs and latest provider info')
  .requiredOption('--channel <name>', 'Channel name')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: { channel: string; config: string }) => {
    await listThreadsCommand({
      channel: opts.channel,
      configPath: opts.config,
    });
  });

program
  .command('reset-provider-affinity')
  .description('Reset provider affinity for channel threads. Use --all for all threads or --external-id for one.')
  .requiredOption('--channel <name>', 'Channel name')
  .option('--external-id <id>', 'Thread external ID. Use `talonctl list-threads --channel <name>` to discover values.')
  .option('--all', 'Reset affinity for all threads on this channel')
  .option('--yes', 'Bypass the confirmation prompt')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: { channel: string; externalId?: string; all?: boolean; yes?: boolean; config: string }) => {
    if (!opts.all && !opts.externalId) {
      console.error('Error: specify --external-id <id> or --all');
      process.exit(1);
      return;
    }
    if (opts.all && opts.externalId) {
      console.error('Error: --all and --external-id are mutually exclusive');
      process.exit(1);
      return;
    }
    await resetProviderAffinityCommand({
      channel: opts.channel,
      externalId: opts.externalId,
      all: opts.all,
      yes: opts.yes,
      configPath: opts.config,
    });
  });

// ---------------------------------------------------------------------------
// WhatsApp Baileys authentication
// ---------------------------------------------------------------------------

program
  .command('whatsapp-auth')
  .description('Authenticate a WhatsApp Baileys channel by scanning a QR code')
  .option('--auth-dir <path>', 'Directory to store auth credentials', './baileys-auth')
  .option('--timeout <seconds>', 'Seconds to wait for QR scan', '120')
  .action(async (opts: { authDir: string; timeout: string }) => {
    const DEFAULT_TIMEOUT_SECONDS = 120;
    const parsedTimeout = parseInt(opts.timeout, 10);
    const timeout =
      Number.isFinite(parsedTimeout) && parsedTimeout > 0
        ? parsedTimeout
        : (() => {
            console.error(
              `Invalid --timeout value "${opts.timeout}". Falling back to default of ${DEFAULT_TIMEOUT_SECONDS} seconds.`,
            );
            return DEFAULT_TIMEOUT_SECONDS;
          })();

    await whatsappAuthCommand({
      authDir: opts.authDir,
      timeout,
    });
  });

// ---------------------------------------------------------------------------
// Skill install command
// ---------------------------------------------------------------------------

program
  .command('install-skill')
  .description('Install an external skill from a local path or Git URL')
  .argument('<source>', 'Skill source: local path or Git URL')
  .option('--persona <name>', 'Persona to grant the skill to')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (source: string, opts: { persona?: string; config: string }) => {
    await installSkillCommand({
      source,
      persona: opts.persona,
      configPath: opts.config,
    });
  });

// ---------------------------------------------------------------------------
// A2A commands
// ---------------------------------------------------------------------------

const a2a = program
  .command('a2a')
  .description('Agent-to-agent task management (testing and monitoring)');

a2a
  .command('list')
  .description('List A2A tasks with optional filters')
  .option('--status <state>', 'Filter by task state (submitted, working, completed, failed, canceled)')
  .option('--target <persona>', 'Filter by target persona name')
  .option('--limit <n>', 'Maximum number of tasks to show', '20')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: { status?: string; target?: string; limit: string; config: string }) => {
    const limit = parseInt(opts.limit, 10);
    if (isNaN(limit) || limit < 1) {
      console.error('--limit must be a positive integer');
      process.exit(1);
    }
    await a2aListCommand({
      configPath: opts.config,
      status: opts.status,
      target: opts.target,
      limit,
    });
  });

a2a
  .command('send <target-persona> <message>')
  .description('Submit a manual A2A task to a persona (for testing)')
  .option('--source <persona>', 'Source persona name (defaults to "cli")', 'cli')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (targetPersona: string, message: string, opts: { source: string; config: string }) => {
    await a2aSendCommand({
      configPath: opts.config,
      targetPersona,
      message,
      sourcePersona: opts.source,
    });
  });

program.parse();
