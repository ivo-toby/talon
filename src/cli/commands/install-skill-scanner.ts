/**
 * Fenced code block scanner for `talonctl install-skill`.
 *
 * Scans a SKILL.md body for executable fenced code blocks and extracts
 * referenced binaries, environment variables, and URLs. Used to propose
 * a sandbox profile when the skill lacks a `sandbox:` block.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScanResult {
  /** Binary names found as first token of command lines */
  bins: Set<string>;
  /** Environment variable names referenced */
  envs: Set<string>;
  /** URLs found in the code */
  urls: Set<string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh']);
const JS_LANGS = new Set(['node', 'javascript']);
const PYTHON_LANGS = new Set(['python', 'py']);

const SUPPORTED_LANGS = new Set([...SHELL_LANGS, ...JS_LANGS, ...PYTHON_LANGS]);

/** Shell built-in vars excluded from env extraction */
const BUILTIN_VARS = new Set([
  'HOME',
  'PATH',
  'PWD',
  'USER',
  'SHELL',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '?',
  '#',
  '$',
]);

/** Wrapper commands — extract both the wrapper and the next token */
const WRAPPERS = new Set(['sudo', 'npx', 'bunx', 'pnpx']);

// ---------------------------------------------------------------------------
// Fence extraction
// ---------------------------------------------------------------------------

interface FencedBlock {
  lang: string;
  content: string;
}

function extractFences(markdown: string): FencedBlock[] {
  const pattern = /```(bash|sh|shell|zsh|node|javascript|python|py)\n([\s\S]*?)```/g;
  const blocks: FencedBlock[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    blocks.push({ lang: match[1], content: match[2] });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// URL extraction (shared across all languages)
// ---------------------------------------------------------------------------

function extractUrls(content: string, urls: Set<string>): void {
  const urlPattern = /https?:\/\/[^\s"')\]]+/g;
  let match: RegExpExecArray | null;
  while ((match = urlPattern.exec(content)) !== null) {
    urls.add(match[0]);
  }
}

// ---------------------------------------------------------------------------
// Shell family scanning
// ---------------------------------------------------------------------------

function scanShell(content: string, result: ScanResult): void {
  // Env vars: $FOO, ${FOO}, $FOO_BAR
  const envPattern = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;
  let match: RegExpExecArray | null;
  while ((match = envPattern.exec(content)) !== null) {
    const name = match[1];
    if (!BUILTIN_VARS.has(name)) {
      result.envs.add(name);
    }
  }

  // Also capture the LHS of `export FOO=...` lines as env vars
  const exportPattern = /^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=/gm;
  while ((match = exportPattern.exec(content)) !== null) {
    result.envs.add(match[1]);
  }

  // Bins: process each line
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // Split on pipes and logical operators to get individual commands
    const segments = line.split(/\s*(?:\||\|\||&&)\s*/);
    for (const segment of segments) {
      extractBinsFromSegment(segment.trim(), result.bins);
    }
  }

  extractUrls(content, result.urls);
}

function extractBinsFromSegment(segment: string, bins: Set<string>): void {
  if (!segment) return;

  // Skip pure variable assignments (FOO=bar with no command after)
  // But handle `export FOO=...` — export is the bin
  const tokens = segment.split(/\s+/);
  if (tokens.length === 0) return;

  const idx = 0;
  const first = tokens[idx];

  // Skip if it's a bare variable assignment (no command)
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first) && !first.startsWith('export')) {
    return;
  }

  // Handle `export` with assignment — `export FOO=bar` is not a bin call,
  // but `export` keyword followed by a var assignment means skip
  if (first === 'export') {
    // `export FOO=bar` → skip as bin, but if `export` is followed by a
    // non-assignment, treat it as a command. For simplicity, always skip
    // export as a bin since it's a shell builtin.
    return;
  }

  bins.add(first);

  // Handle wrappers: also add the next token
  if (WRAPPERS.has(first) && tokens.length > idx + 1) {
    // Skip flags (tokens starting with -)
    for (let i = idx + 1; i < tokens.length; i++) {
      if (!tokens[i].startsWith('-')) {
        bins.add(tokens[i]);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// JavaScript family scanning
// ---------------------------------------------------------------------------

function scanJavaScript(content: string, result: ScanResult): void {
  // Env vars: process.env.FOO, process.env['FOO'], process.env["FOO"]
  const dotPattern = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
  const bracketPattern = /process\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g;

  let match: RegExpExecArray | null;
  while ((match = dotPattern.exec(content)) !== null) {
    result.envs.add(match[1]);
  }
  while ((match = bracketPattern.exec(content)) !== null) {
    result.envs.add(match[1]);
  }

  extractUrls(content, result.urls);
}

// ---------------------------------------------------------------------------
// Python family scanning
// ---------------------------------------------------------------------------

function scanPython(content: string, result: ScanResult): void {
  // os.environ['FOO'], os.environ["FOO"]
  const environBracket = /os\.environ\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g;
  // os.environ.get('FOO'), os.environ.get("FOO")
  const environGet = /os\.environ\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g;
  // os.getenv('FOO'), os.getenv("FOO")
  const getenv = /os\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g;

  let match: RegExpExecArray | null;
  while ((match = environBracket.exec(content)) !== null) {
    result.envs.add(match[1]);
  }
  while ((match = environGet.exec(content)) !== null) {
    result.envs.add(match[1]);
  }
  while ((match = getenv.exec(content)) !== null) {
    result.envs.add(match[1]);
  }

  extractUrls(content, result.urls);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan a SKILL.md body (markdown) for executable fenced code blocks
 * and extract referenced binaries, env vars, and URLs.
 *
 * Supported fence languages: bash, sh, shell, zsh, node, javascript, python, py
 */
export function scanSkillBody(markdown: string): ScanResult {
  const result: ScanResult = {
    bins: new Set(),
    envs: new Set(),
    urls: new Set(),
  };

  const blocks = extractFences(markdown);

  for (const block of blocks) {
    if (!SUPPORTED_LANGS.has(block.lang)) continue;

    if (SHELL_LANGS.has(block.lang)) {
      scanShell(block.content, result);
    } else if (JS_LANGS.has(block.lang)) {
      scanJavaScript(block.content, result);
    } else if (PYTHON_LANGS.has(block.lang)) {
      scanPython(block.content, result);
    }
  }

  return result;
}
