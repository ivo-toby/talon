/**
 * Host-side tool: skill.exec
 *
 * Receives `<skill>_exec` calls from the agent, validates them against the
 * loaded skill's sandbox profile, resolves secrets, invokes the sandbox
 * runner, and writes an audit log entry. Secret values never appear in
 * logs or audit entries — only names are recorded.
 */

import { createHash } from 'node:crypto';
import type pino from 'pino';
import type { ToolCallResult, ToolManifest } from '../tool-types.js';
import type { ToolExecutionContext } from './channel-send.js';
import type { SkillScriptRunner, SkillExecInput, SkillExecResult } from '../../skills/script-runner/runner-types.js';
import type { SecretStore } from '../../core/secrets/index.js';
import type { AuditLogger } from '../../core/logging/audit-logger.js';
import type { LoadedSkill } from '../../skills/skill-types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SkillExecArgs {
  skillName: string;
  command: string;
  timeoutSeconds?: number;
}

interface SkillExecHandlerDeps {
  runner: SkillScriptRunner;
  secretStore: SecretStore;
  auditLogger: AuditLogger;
  logger: pino.Logger;
  /** Look up a loaded skill by name for the given persona. */
  getLoadedSkill: (skillName: string, personaId: string) => LoadedSkill | undefined;
  /** Get the persona's configured repoPath. */
  getPersonaRepoPath: (personaId: string) => string | undefined;
  dataDir: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export class SkillExecHandler {
  static readonly manifest: ToolManifest = {
    name: 'skill.exec',
    description: 'Execute a command in a skill sandbox',
    capabilities: ['skill.exec'],
    executionLocation: 'host',
  };

  constructor(private readonly deps: SkillExecHandlerDeps) {}

  async execute(args: SkillExecArgs, context: ToolExecutionContext): Promise<ToolCallResult> {
    const requestId = context.requestId ?? 'unknown';

    this.deps.logger.info(
      { requestId, skillName: args.skillName, personaId: context.personaId },
      'skill.exec: executing',
    );

    // 1. Look up the skill
    const skill = this.deps.getLoadedSkill(args.skillName, context.personaId);
    if (!skill) {
      return this.errorResult(requestId, `skill "${args.skillName}" not loaded for persona`);
    }

    // 2. Check stagedSandbox
    if (!skill.stagedSandbox) {
      return this.errorResult(
        requestId,
        `skill sandbox staging failed — ${args.skillName}_exec unavailable`,
      );
    }

    // 3. Check sandbox config exists
    const profile = skill.manifest.sandbox;
    if (!profile) {
      return this.errorResult(requestId, `skill "${args.skillName}" has no sandbox configuration`);
    }

    // 4. Resolve workdir
    let repoPath: string | null = null;
    if (profile.workdir === 'repo') {
      const rp = this.deps.getPersonaRepoPath(context.personaId);
      if (!rp) {
        return this.errorResult(
          requestId,
          `persona has no repoPath configured (required by skill "${args.skillName}" workdir: repo)`,
        );
      }
      repoPath = rp;
    } else if (profile.workdir === 'skill-bundle') {
      // skill-bundle uses the skill's directory; repoPath stays null
    }
    // Absolute path → use directly (workdir is passed through profile)

    // 5. Resolve secrets
    const secretResult = this.deps.secretStore.resolve(profile.secrets, {
      personaId: context.personaId,
      skillName: args.skillName,
    });
    if (secretResult.isErr()) {
      return this.errorResult(
        requestId,
        `secret resolution failed: missing secrets [${secretResult.error.missing.join(', ')}]`,
      );
    }
    const resolvedSecrets = secretResult.value;

    // 6. Build input and execute
    const staged = skill.stagedSandbox;
    const timeout = args.timeoutSeconds ?? profile.timeoutSeconds;

    const input: SkillExecInput = {
      skillName: args.skillName,
      skillDir: skill.skillDir,
      profile,
      staged,
      command: args.command,
      timeoutSeconds: timeout,
      context: {
        threadId: context.threadId,
        personaId: context.personaId,
        requestId,
        repoPath,
      },
      resolvedSecrets,
    };

    let result: SkillExecResult;
    try {
      result = await this.deps.runner.execute(input);
    } catch (cause) {
      this.deps.logger.error(
        { requestId, err: cause },
        'skill.exec: runner threw unexpectedly',
      );
      return this.errorResult(requestId, `runner error: ${cause instanceof Error ? cause.message : String(cause)}`);
    }

    // 7. Write audit log entry
    this.deps.auditLogger.logToolExecution({
      runId: context.runId,
      threadId: context.threadId,
      personaId: context.personaId,
      action: 'skill.exec',
      tool: `${args.skillName}_exec`,
      requestId,
      details: {
        skillName: args.skillName,
        command: args.command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timeoutSeconds: timeout,
        network: profile.network,
        secretsUsed: profile.secrets,
        bins: profile.bins,
        mounts: staged.canonicalMounts.map((m) => ({ target: m.target, mode: m.mode })),
        stdoutHash: sha256(result.stdout),
        stderrHash: sha256(result.stderr),
        truncated: result.truncated,
        artifactPath: result.artifactPath,
      },
    });

    // 8. Return result
    return {
      requestId,
      tool: 'skill.exec',
      status: result.status,
      result: {
        status: result.status,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        truncated: result.truncated,
        artifactPath: result.artifactPath,
      },
    };
  }

  private errorResult(requestId: string, message: string): ToolCallResult {
    this.deps.logger.warn({ requestId }, `skill.exec: ${message}`);
    return {
      requestId,
      tool: 'skill.exec',
      status: 'error',
      error: message,
    };
  }
}
