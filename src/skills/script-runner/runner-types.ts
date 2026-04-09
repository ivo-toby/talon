import type { SkillSandboxProfile } from '../skill-sandbox-schema.js';
import type { StagedSkillSandbox } from '../skill-sandbox-staging.js';

export type RunnerBackend = 'bubblewrap' | 'apple-container';

export interface SkillExecInput {
  skillName: string;
  skillDir: string;
  profile: SkillSandboxProfile;
  staged: StagedSkillSandbox;
  command: string;
  timeoutSeconds?: number;
  context: {
    threadId: string;
    personaId: string;
    requestId: string;
    repoPath: string | null;
  };
  resolvedSecrets: Record<string, string>;
}

export interface SkillExecResult {
  status: 'success' | 'error' | 'timeout';
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  artifactPath: string | null;
}

export interface SkillScriptRunner {
  readonly backend: RunnerBackend;
  execute(input: SkillExecInput): Promise<SkillExecResult>;
}

export class RunnerExecutionError extends Error {
  constructor(
    public readonly backend: RunnerBackend,
    public readonly reason: string,
    public readonly cause?: unknown,
  ) {
    super(`Script runner (${backend}): ${reason}`);
    this.name = 'RunnerExecutionError';
  }
}
