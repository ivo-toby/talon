/**
 * `talonctl install-skill` command.
 *
 * Installs an external skill into Talon from a local path or Git URL.
 * Performs mandatory sandbox review before installation.
 *
 * Flow:
 *   1. Fetch source to staging directory (copy or git clone)
 *   2. Locate skill root (SKILL.md or skill.yaml)
 *   3. Parse and validate the skill manifest
 *   4. Sandbox review (mandatory) — Case A/B/C
 *   5. Copy approved skill to {dataDir}/skills/<name>/
 *   6. Stage .bin/ directory if sandbox present
 *   7. Grant capability to persona(s)
 *   8. Validate full config
 *   9. Write config and clean staging
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin as stdinStream, stdout as stdoutStream } from 'node:process';

import matter from 'gray-matter';
import yaml from 'js-yaml';

import {
  DEFAULT_CONFIG_PATH,
  validateName,
  readConfig,
  writeConfigAtomic,
  type YamlDocument,
} from '../config-utils.js';
import { scanSkillBody, type ScanResult } from './install-skill-scanner.js';
import { SkillMdFrontmatterSchema, SkillManifestSchema } from '../../skills/skill-schema.js';
import { stageSkillSandbox } from '../../skills/skill-sandbox-staging.js';
import type { SkillSandboxProfile } from '../../skills/skill-sandbox-schema.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SourceType = 'local' | 'git' | 'registry';

export interface ParsedSource {
  type: SourceType;
  path?: string;
  url?: string;
  ref?: string;
}

export interface InstallSkillOptions {
  source: string;
  persona?: string;
  configPath?: string;
  /** Override for testing — skips interactive prompts */
  _confirm?: (message: string) => Promise<boolean>;
  /** Override for testing — provides persona selection */
  _selectPersona?: (personas: string[]) => Promise<string[]>;
  /** Override for testing — provides edit response */
  _editResponse?: (message: string) => Promise<'y' | 'n' | 'e'>;
  /** Override for testing — provides editor content */
  _editorContent?: (yamlContent: string) => Promise<string>;
}

export interface InstallSkillResult {
  name: string;
  installedPath: string;
  personas: string[];
  hasSandbox: boolean;
}

// ---------------------------------------------------------------------------
// Source parsing
// ---------------------------------------------------------------------------

const GIT_URL_RE = /^https?:\/\/.+\.git(#.+)?$|^git@.+:.+\.git(#.+)?$|^https?:\/\/github\.com\/.+\/.+(#.+)?$/;

/**
 * Determines whether a source string is a local path, git URL, or registry shorthand.
 */
export function parseSource(source: string): ParsedSource {
  // Git URL: starts with https:// and looks like a repo, or git@...
  if (GIT_URL_RE.test(source)) {
    const [url, ref] = source.split('#');
    return { type: 'git', url, ref };
  }

  // Local path: starts with /, ./, ../
  if (source.startsWith('/') || source.startsWith('./') || source.startsWith('../')) {
    return { type: 'local', path: path.resolve(source) };
  }

  // Could also be an absolute path on Windows or a bare directory name
  if (existsSync(source)) {
    return { type: 'local', path: path.resolve(source) };
  }

  // Otherwise treat as registry shorthand (unsupported in v1)
  return { type: 'registry' };
}

// ---------------------------------------------------------------------------
// Staging helpers
// ---------------------------------------------------------------------------

async function fetchToStaging(parsed: ParsedSource): Promise<string> {
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'talon-skill-'));

  if (parsed.type === 'local') {
    if (!parsed.path) {
      await fs.rm(stagingDir, { recursive: true, force: true });
      throw new Error('Local source path is missing');
    }
    if (!existsSync(parsed.path)) {
      await fs.rm(stagingDir, { recursive: true, force: true });
      throw new Error(`Source path does not exist: ${parsed.path}`);
    }
    try {
      await copyRecursive(parsed.path, stagingDir);
    } catch (cause) {
      await fs.rm(stagingDir, { recursive: true, force: true });
      throw cause;
    }
    return stagingDir;
  }

  if (parsed.type === 'git') {
    if (!parsed.url) throw new Error('Git URL is missing');
    // Validate URL to prevent command injection
    if (parsed.url.includes("'") || parsed.url.includes('"') || parsed.url.includes(';') || parsed.url.includes('|') || parsed.url.includes('&')) {
      await fs.rm(stagingDir, { recursive: true, force: true });
      throw new Error(`Git URL contains unsafe characters: ${parsed.url}`);
    }
    try {
      const args = ['clone', '--depth', '1'];
      if (parsed.ref) {
        args.push('--branch', parsed.ref);
      }
      args.push(parsed.url, stagingDir);
      await execFileAsync('git', args, { timeout: 60_000 });
    } catch (cause) {
      await fs.rm(stagingDir, { recursive: true, force: true });
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Git clone failed: ${msg}`);
    }
    return stagingDir;
  }

  await fs.rm(stagingDir, { recursive: true, force: true });
  throw new Error('Registry shorthand is not supported yet. Use a local path or Git URL.');
}

async function copyRecursive(src: string, dest: string, rootSrc?: string): Promise<void> {
  const sourceRoot = rootSrc ?? src;
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Reject symlinks to prevent path traversal from untrusted sources
    if (entry.isSymbolicLink()) {
      const realTarget = await fs.realpath(srcPath);
      const realSourceRoot = await fs.realpath(sourceRoot);
      if (!realTarget.startsWith(realSourceRoot + path.sep) && realTarget !== realSourceRoot) {
        throw new Error(
          `Symlink "${srcPath}" points outside source tree (target: "${realTarget}"). Refusing to copy.`,
        );
      }
      // Safe symlink within tree — copy the target content
      const stat = await fs.stat(srcPath);
      if (stat.isDirectory()) {
        await fs.mkdir(destPath, { recursive: true });
        await copyRecursive(srcPath, destPath, sourceRoot);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    } else if (entry.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      await copyRecursive(srcPath, destPath, sourceRoot);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Skill root location
// ---------------------------------------------------------------------------

/**
 * Finds the directory containing SKILL.md or skill.yaml.
 * Checks root first, then one level deep.
 */
export async function locateSkillRoot(stagingDir: string): Promise<{ root: string; format: 'skillmd' | 'yaml' }> {
  // Check root
  if (existsSync(path.join(stagingDir, 'SKILL.md'))) {
    return { root: stagingDir, format: 'skillmd' };
  }
  if (existsSync(path.join(stagingDir, 'skill.yaml'))) {
    return { root: stagingDir, format: 'yaml' };
  }

  // Check one level deep
  const entries = await fs.readdir(stagingDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const subDir = path.join(stagingDir, entry.name);
    if (existsSync(path.join(subDir, 'SKILL.md'))) {
      return { root: subDir, format: 'skillmd' };
    }
    if (existsSync(path.join(subDir, 'skill.yaml'))) {
      return { root: subDir, format: 'yaml' };
    }
  }

  throw new Error(
    'Could not find SKILL.md or skill.yaml in the source (checked root and one level deep).',
  );
}

// ---------------------------------------------------------------------------
// Skill parsing
// ---------------------------------------------------------------------------

interface ParsedSkill {
  name: string;
  version: string;
  description: string;
  format: 'skillmd' | 'yaml';
  sandbox?: SkillSandboxProfile;
  body: string;
  rawFrontmatter: Record<string, unknown>;
  requiredCapabilities: string[];
}

export async function parseSkill(skillRoot: string, format: 'skillmd' | 'yaml'): Promise<ParsedSkill> {
  if (format === 'skillmd') {
    const content = await fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf-8');
    const parsed = matter(content);
    const result = SkillMdFrontmatterSchema.safeParse(parsed.data);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      throw new Error(`SKILL.md frontmatter validation failed: ${issues}`);
    }
    return {
      name: result.data.name,
      version: result.data.version,
      description: result.data.description,
      format: 'skillmd',
      sandbox: result.data.sandbox,
      body: parsed.content.trim(),
      rawFrontmatter: parsed.data as Record<string, unknown>,
      requiredCapabilities: result.data.requiredCapabilities,
    };
  }

  // yaml format
  const content = await fs.readFile(path.join(skillRoot, 'skill.yaml'), 'utf-8');
  const raw = yaml.load(content) as Record<string, unknown>;
  const result = SkillManifestSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`skill.yaml validation failed: ${issues}`);
  }
  return {
    name: result.data.name,
    version: result.data.version,
    description: result.data.description,
    format: 'yaml',
    sandbox: result.data.sandbox,
    body: '',
    rawFrontmatter: raw,
    requiredCapabilities: result.data.requiredCapabilities,
  };
}

// ---------------------------------------------------------------------------
// Sandbox review
// ---------------------------------------------------------------------------

const BASE_BINS = ['bash', 'sh', 'ls', 'cat'];

function formatSandboxBlock(sandbox: SkillSandboxProfile): string {
  const lines: string[] = ['sandbox:'];
  lines.push(`  workdir: ${sandbox.workdir}`);
  lines.push(`  network: ${sandbox.network}`);
  if (sandbox.bins.length > 0) {
    lines.push(`  bins: [${sandbox.bins.join(', ')}]`);
  }
  if (sandbox.secrets.length > 0) {
    lines.push(`  secrets: [${sandbox.secrets.join(', ')}]`);
  }
  if (Object.keys(sandbox.env).length > 0) {
    lines.push('  env:');
    for (const [k, v] of Object.entries(sandbox.env)) {
      lines.push(`    ${k}: ${v}`);
    }
  }
  if (sandbox.mounts.length > 0) {
    lines.push('  mounts:');
    for (const m of sandbox.mounts) {
      lines.push(`    - source: ${m.source}`);
      lines.push(`      target: ${m.target}`);
      lines.push(`      mode: ${m.mode}`);
    }
  }
  lines.push(`  shell: ${sandbox.shell}`);
  lines.push(`  timeoutSeconds: ${sandbox.timeoutSeconds}`);
  lines.push('  resourceLimits:');
  lines.push(`    memoryMb: ${sandbox.resourceLimits.memoryMb}`);
  lines.push(`    cpus: ${sandbox.resourceLimits.cpus}`);
  lines.push(`    pidsLimit: ${sandbox.resourceLimits.pidsLimit}`);
  return lines.join('\n');
}

function summarizeSandbox(sandbox: SkillSandboxProfile): string {
  const parts: string[] = [];
  parts.push(`  workdir: ${sandbox.workdir}`);
  parts.push(`  network: ${sandbox.network}`);
  parts.push(`  bins: ${sandbox.bins.join(', ')}`);
  if (sandbox.secrets.length > 0) {
    parts.push(`  secrets: ${sandbox.secrets.join(', ')}`);
  }
  // Flag absolute-path mounts outside ${skill.dir}
  for (const m of sandbox.mounts) {
    if (!m.source.startsWith('${skill.dir}')) {
      parts.push(`  WARNING: mount "${m.source}" -> "${m.target}" is outside skill bundle`);
    }
  }
  return parts.join('\n');
}

/**
 * Build a proposed sandbox block from scan results.
 */
export function proposeSandboxBlock(scan: ScanResult): SkillSandboxProfile {
  const bins = new Set<string>(BASE_BINS);
  for (const b of scan.bins) {
    bins.add(b);
  }

  return {
    workdir: 'repo',
    network: scan.urls.size > 0 ? 'on' : 'off',
    secrets: Array.from(scan.envs),
    env: {},
    bins: Array.from(bins),
    mounts: [],
    shell: '/bin/bash',
    image: 'talon-skill-runtime:latest',
    timeoutSeconds: 60,
    resourceLimits: { memoryMb: 1024, cpus: 1, pidsLimit: 256 },
  };
}

/**
 * Returns true if the markdown body contains executable code fences.
 */
function hasExecutableCodeFences(body: string): boolean {
  const pattern = /```(bash|sh|shell|zsh|node|javascript|python|py)\n/;
  return pattern.test(body);
}

// ---------------------------------------------------------------------------
// Readline helpers
// ---------------------------------------------------------------------------

async function promptYesNo(
  message: string,
  overrideFn?: (msg: string) => Promise<boolean>,
): Promise<boolean> {
  if (overrideFn) return overrideFn(message);

  if (!stdinStream.isTTY) {
    throw new Error('Interactive confirmation required but stdin is not a TTY.');
  }
  const rl = createInterface({ input: stdinStream, output: stdoutStream });
  try {
    const answer = await rl.question(`${message} `);
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

async function promptYesNoEdit(
  message: string,
  overrideFn?: (msg: string) => Promise<'y' | 'n' | 'e'>,
): Promise<'y' | 'n' | 'e'> {
  if (overrideFn) return overrideFn(message);

  if (!stdinStream.isTTY) {
    throw new Error('Interactive confirmation required but stdin is not a TTY.');
  }
  const rl = createInterface({ input: stdinStream, output: stdoutStream });
  try {
    const answer = await rl.question(`${message} `);
    const trimmed = answer.trim().toLowerCase();
    if (trimmed === 'y') return 'y';
    if (trimmed === 'e') return 'e';
    return 'n';
  } finally {
    rl.close();
  }
}

async function promptSelectPersonas(
  personas: string[],
  overrideFn?: (list: string[]) => Promise<string[]>,
): Promise<string[]> {
  if (overrideFn) return overrideFn(personas);

  if (!stdinStream.isTTY) {
    throw new Error('Interactive persona selection required but stdin is not a TTY.');
  }
  const rl = createInterface({ input: stdinStream, output: stdoutStream });
  try {
    stdoutStream.write('Available personas:\n');
    personas.forEach((p, i) => stdoutStream.write(`  ${i + 1}. ${p}\n`));
    const answer = await rl.question('Enter persona number(s) separated by commas: ');
    const indices = answer
      .split(',')
      .map((s) => parseInt(s.trim(), 10) - 1)
      .filter((i) => i >= 0 && i < personas.length);
    if (indices.length === 0) {
      throw new Error('No valid persona selected.');
    }
    return indices.map((i) => personas[i]);
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Frontmatter write-back
// ---------------------------------------------------------------------------

/**
 * Writes a sandbox block into the SKILL.md frontmatter.
 */
async function writeSandboxToSkillMd(
  skillRoot: string,
  sandbox: SkillSandboxProfile,
  skillName: string,
): Promise<void> {
  const skillMdPath = path.join(skillRoot, 'SKILL.md');
  const content = await fs.readFile(skillMdPath, 'utf-8');
  const parsed = matter(content);

  // Set the sandbox block in the frontmatter — never write `undefined` values
  // because gray-matter's YAML serializer rejects them.
  const sandboxData: Record<string, unknown> = {
    workdir: sandbox.workdir,
    network: sandbox.network,
    bins: sandbox.bins,
    shell: sandbox.shell,
    timeoutSeconds: sandbox.timeoutSeconds,
    resourceLimits: sandbox.resourceLimits,
  };
  if (sandbox.secrets.length > 0) sandboxData.secrets = sandbox.secrets;
  if (Object.keys(sandbox.env).length > 0) sandboxData.env = sandbox.env;
  if (sandbox.mounts.length > 0) sandboxData.mounts = sandbox.mounts;
  (parsed.data as Record<string, unknown>).sandbox = sandboxData;

  // Ensure requiredCapabilities includes skill.exec:<name>
  const reqCap = `skill.exec:${skillName}`;
  const caps = (parsed.data as Record<string, unknown>).requiredCapabilities as string[] | undefined;
  if (!caps) {
    (parsed.data as Record<string, unknown>).requiredCapabilities = [reqCap];
  } else if (!caps.includes(reqCap)) {
    caps.push(reqCap);
  }

  // Reconstruct the file
  const newContent = matter.stringify(parsed.content, parsed.data as Record<string, unknown>);
  await fs.writeFile(skillMdPath, newContent, 'utf-8');
}

// ---------------------------------------------------------------------------
// Config modification
// ---------------------------------------------------------------------------

function addSkillToPersona(
  doc: YamlDocument,
  personaName: string,
  skillName: string,
  hasSandbox: boolean,
): void {
  if (!Array.isArray(doc.personas)) {
    throw new Error('No personas found in config.');
  }

  const persona = doc.personas.find((p) => p.name === personaName);
  if (!persona) {
    throw new Error(`Persona "${personaName}" not found in config.`);
  }

  // Add to skills array
  if (!Array.isArray(persona.skills)) {
    persona.skills = [];
  }
  if (!persona.skills.includes(skillName)) {
    persona.skills.push(skillName);
  }

  // Add capability if sandbox is present
  if (hasSandbox) {
    if (!persona.capabilities) {
      persona.capabilities = { allow: [], requireApproval: [] };
    }
    const caps = persona.capabilities as { allow?: string[]; requireApproval?: string[] };
    if (!Array.isArray(caps.allow)) {
      caps.allow = [];
    }
    const capLabel = `skill.exec:${skillName}`;
    if (!caps.allow.includes(capLabel)) {
      caps.allow.push(capLabel);
    }
  }
}

// ---------------------------------------------------------------------------
// Core logic (importable + testable)
// ---------------------------------------------------------------------------

/**
 * Installs a skill from the given source.
 *
 * Contains the full install flow. Interactive prompts can be overridden
 * via options for testing.
 */
export async function installSkill(options: InstallSkillOptions): Promise<InstallSkillResult> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  let stagingDir: string | null = null;

  try {
    // 1. Parse source
    const parsed = parseSource(options.source);
    if (parsed.type === 'registry') {
      throw new Error('Registry shorthand is not supported yet. Use a local path or Git URL.');
    }

    // 2. Fetch to staging
    stdoutStream.write(`Fetching skill from ${options.source}...\n`);
    stagingDir = await fetchToStaging(parsed);

    // 3. Locate skill root
    const { root: skillRoot, format } = await locateSkillRoot(stagingDir);

    // 4. Parse skill
    const skill = await parseSkill(skillRoot, format);
    stdoutStream.write(`Found skill: ${skill.name} (v${skill.version}) — ${skill.description}\n`);

    // Validate name
    const nameError = validateName(skill.name, 'Skill');
    if (nameError) throw new Error(nameError);

    // 5. Sandbox review
    let acceptedSandbox: SkillSandboxProfile | undefined = skill.sandbox;

    if (skill.sandbox) {
      // Case A: sandbox block present
      stdoutStream.write('\n--- Sandbox Profile ---\n');
      stdoutStream.write(formatSandboxBlock(skill.sandbox) + '\n');
      stdoutStream.write('\n--- Summary ---\n');
      stdoutStream.write(summarizeSandbox(skill.sandbox) + '\n\n');

      const accepted = await promptYesNo(
        'This skill declares the sandbox profile above. Accept? [y/N]',
        options._confirm,
      );
      if (!accepted) {
        throw new Error('Sandbox profile rejected. Installation aborted.');
      }
    } else if (format === 'skillmd' && hasExecutableCodeFences(skill.body)) {
      // Case B: no sandbox, but executable code fences found
      stdoutStream.write('\nNo sandbox block found, but executable code fences detected.\n');
      stdoutStream.write('Scanning skill body for binaries, env vars, and URLs...\n\n');

      const scan = scanSkillBody(skill.body);

      stdoutStream.write('Detected:\n');
      if (scan.bins.size > 0) stdoutStream.write(`  Binaries: ${Array.from(scan.bins).join(', ')}\n`);
      if (scan.envs.size > 0) stdoutStream.write(`  Env vars: ${Array.from(scan.envs).join(', ')}\n`);
      if (scan.urls.size > 0) stdoutStream.write(`  URLs: ${Array.from(scan.urls).join(', ')}\n`);

      const proposed = proposeSandboxBlock(scan);

      stdoutStream.write('\n--- Proposed Sandbox Block ---\n');
      stdoutStream.write(formatSandboxBlock(proposed) + '\n\n');

      const response = await promptYesNoEdit(
        'Accept this sandbox profile? [y/N/e(dit)]',
        options._editResponse,
      );

      if (response === 'n') {
        throw new Error('Sandbox profile rejected. Installation aborted.');
      }

      if (response === 'e') {
        // Simple edit: dump YAML and ask for paste-back
        const yamlBlock = yaml.dump({
          sandbox: {
            workdir: proposed.workdir,
            network: proposed.network,
            bins: proposed.bins,
            secrets: proposed.secrets,
            shell: proposed.shell,
            timeoutSeconds: proposed.timeoutSeconds,
          },
        }, { lineWidth: 120 });

        stdoutStream.write('\nEdit the sandbox block below and paste it back (v1 limitation):\n');
        stdoutStream.write(yamlBlock + '\n');

        if (options._editorContent) {
          const edited = await options._editorContent(yamlBlock);
          try {
            const parsedEdited = yaml.load(edited) as { sandbox?: unknown };
            if (parsedEdited?.sandbox) {
              const { SkillSandboxProfileSchema } = await import('../../skills/skill-sandbox-schema.js');
              const validated = SkillSandboxProfileSchema.safeParse(parsedEdited.sandbox);
              if (validated.success) {
                acceptedSandbox = validated.data;
              } else {
                throw new Error(`Edited sandbox block is invalid: ${validated.error.message}`);
              }
            }
          } catch (e) {
            if (e instanceof Error && e.message.startsWith('Edited sandbox')) throw e;
            throw new Error(`Failed to parse edited sandbox block: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else {
          // In non-test mode, just accept the proposed block (no real editor in v1)
          acceptedSandbox = proposed;
        }
      } else {
        // 'y' — accept proposed
        acceptedSandbox = proposed;
      }

      // Write sandbox block into SKILL.md
      if (acceptedSandbox && format === 'skillmd') {
        await writeSandboxToSkillMd(skillRoot, acceptedSandbox, skill.name);
      }
    } else {
      // Case C: no sandbox, no executable code fences
      stdoutStream.write('\nThis is a prompt-only skill (no executable scripts detected). No sandbox needed.\n');
    }

    // 6. Read config to find dataDir
    const doc = await readConfig(configPath);
    const dataDir = (doc as Record<string, unknown>).dataDir as string | undefined ?? 'data';

    // 7. Copy to {dataDir}/skills/<name>/
    const installDir = path.join(dataDir, 'skills', skill.name);
    await fs.mkdir(installDir, { recursive: true });
    // Clear existing contents
    const existingEntries = await fs.readdir(installDir);
    for (const entry of existingEntries) {
      if (entry === '.bin') continue; // preserve .bin dir, will be regenerated
      await fs.rm(path.join(installDir, entry), { recursive: true, force: true });
    }
    await copyRecursive(skillRoot, installDir);
    stdoutStream.write(`Installed skill to: ${installDir}\n`);

    // 8. Stage .bin/ directory if sandbox present
    if (acceptedSandbox) {
      const stagingResult = await stageSkillSandbox(
        acceptedSandbox,
        installDir,
        dataDir,
        skill.name,
      );
      if (stagingResult.isErr()) {
        stdoutStream.write(`Warning: sandbox staging failed: ${stagingResult.error.message}\n`);
        stdoutStream.write('The skill was installed but sandbox execution may not work until bins are available.\n');
      } else {
        stdoutStream.write(`Staged sandbox .bin/ directory with ${Object.keys(stagingResult.value.resolvedBins).length} binaries.\n`);
      }
    }

    // 9. Grant capability to persona(s)
    let selectedPersonas: string[] = [];
    const hasSandbox = acceptedSandbox !== undefined;

    if (options.persona) {
      selectedPersonas = [options.persona];
    } else if (Array.isArray(doc.personas) && doc.personas.length > 0) {
      const personaNames = doc.personas.map((p) => p.name);
      if (hasSandbox) {
        stdoutStream.write('\nThis skill has a sandbox profile. Select persona(s) to grant skill.exec capability:\n');
        selectedPersonas = await promptSelectPersonas(personaNames, options._selectPersona);
      } else {
        stdoutStream.write('\nSelect persona(s) to add this skill to:\n');
        selectedPersonas = await promptSelectPersonas(personaNames, options._selectPersona);
      }
    } else {
      stdoutStream.write('Warning: no personas found in config. Skill installed but not assigned to any persona.\n');
    }

    // Modify config
    for (const personaName of selectedPersonas) {
      addSkillToPersona(doc, personaName, skill.name, hasSandbox);
    }

    // 10. Validate full config — validate the in-memory document, not the on-disk file
    const { loadConfigFromString } = await import('../../core/config/config-loader.js');
    const pendingYaml = yaml.dump(doc, { lineWidth: 120, quotingType: '"', forceQuotes: false });
    const configResult = loadConfigFromString(pendingYaml);
    if (configResult.isErr()) {
      stdoutStream.write(`Warning: config validation produced errors (may be expected if env vars are not set): ${configResult.error.message}\n`);
    }

    // 11. Write config and clean staging
    await writeConfigAtomic(configPath, doc);

    stdoutStream.write('\n--- Installation Complete ---\n');
    stdoutStream.write(`Skill: ${skill.name}\n`);
    stdoutStream.write(`Path: ${installDir}\n`);
    if (selectedPersonas.length > 0) {
      stdoutStream.write(`Persona(s): ${selectedPersonas.join(', ')}\n`);
    }
    if (hasSandbox) {
      stdoutStream.write(`Capability: skill.exec:${skill.name}\n`);
    }

    return {
      name: skill.name,
      installedPath: installDir,
      personas: selectedPersonas,
      hasSandbox,
    };
  } finally {
    // Clean up staging directory
    if (stagingDir) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {
        // best effort cleanup
      });
    }
  }
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

/**
 * CLI entrypoint for `talonctl install-skill`.
 */
export async function installSkillCommand(options: InstallSkillOptions): Promise<void> {
  try {
    await installSkill(options);
  } catch (error) {
    process.stderr.write(`Error: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
