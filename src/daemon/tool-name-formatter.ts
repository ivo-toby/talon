/**
 * Formats MCP and native tool names into human-readable strings with emoji.
 *
 * MCP tool names follow the pattern `mcp__server-name__tool_name`.
 * Native tool names are plain identifiers like `memory_access`.
 */

interface KnownServer {
  /** Substrings to match against the raw server name (case-insensitive). */
  patterns: string[];
  emoji: string;
  /** Friendly display name for the server. */
  name: string;
}

const KNOWN_SERVERS: KnownServer[] = [
  { patterns: ['google-calendar', 'google_calendar'], emoji: '📅', name: 'Google Calendar' },
  { patterns: ['gmail'], emoji: '📧', name: 'Gmail' },
  { patterns: ['brave-search', 'brave_search'], emoji: '🌐', name: 'Brave Search' },
  { patterns: ['notes-search', 'notes_search'], emoji: '🔍', name: 'Notes Search' },
  { patterns: ['filesystem'], emoji: '📁', name: 'Filesystem' },
  { patterns: ['github'], emoji: '🐙', name: 'GitHub' },
  { patterns: ['slack'], emoji: '💬', name: 'Slack' },
  { patterns: ['atlassian', 'jira', 'confluence'], emoji: '🗂️', name: 'Atlassian' },
  { patterns: ['memory'], emoji: '💾', name: 'Memory' },
  { patterns: ['background'], emoji: '🤖', name: 'Background' },
];

const NATIVE_TOOL_EMOJI: Record<string, string> = {
  memory_access: '💾',
  background_agent: '🤖',
  channel_send: '💬',
};

/**
 * Finds the known-server entry whose pattern appears as a substring of the raw
 * server name (case-insensitive).  Returns `undefined` if no match is found.
 */
function findKnownServer(rawServerName: string): KnownServer | undefined {
  const lower = rawServerName.toLowerCase();
  for (const server of KNOWN_SERVERS) {
    if (server.patterns.some((p) => lower.includes(p))) {
      return server;
    }
  }
  return undefined;
}

/**
 * Returns the deduplication word list for a matched known server.
 * Derived from the first matching pattern (e.g. `brave-search` → `['brave','search']`).
 */
function getServerWords(matchedServer: KnownServer, rawServerName: string): string[] {
  const lower = rawServerName.toLowerCase();
  const matchedPattern = matchedServer.patterns.find((p) => lower.includes(p));
  if (!matchedPattern) return [];
  return matchedPattern.split(/[-_]/).filter(Boolean);
}

/**
 * Splits a tool name into words, handling both underscore-separated and
 * camelCase conventions.
 */
function splitToolName(toolName: string): string[] {
  if (toolName.includes('_')) {
    return toolName.split('_').filter(Boolean);
  }
  // camelCase split: `createJiraIssue` → `['create', 'Jira', 'Issue']`
  return toolName.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ').filter(Boolean);
}

/**
 * Strips leading tool words that are redundant given the server name.
 * A tool word is redundant if it exactly matches a server word (case-insensitive)
 * or if it starts with the combined initials of the server words (abbreviation
 * detection, only when there are 2+ server words).
 */
function stripLeadingDuplicates(toolWords: string[], serverWords: string[]): string[] {
  if (serverWords.length === 0) return toolWords;

  const serverLower = serverWords.map((w) => w.toLowerCase());
  const initials = serverLower.map((w) => w[0] ?? '').join('');
  const result = [...toolWords];

  while (result.length > 1) {
    const word = (result[0] ?? '').toLowerCase();
    const exactMatch = serverLower.includes(word);
    const abbreviation = initials.length >= 2 && word.startsWith(initials);
    if (exactMatch || abbreviation) {
      result.shift();
    } else {
      break;
    }
  }

  return result;
}

/**
 * Converts a raw server name (e.g. `custom-server`) to a title-cased display
 * string (e.g. `Custom Server`).
 */
function humanizeServerName(serverName: string): string {
  return serverName
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Converts a native tool name (e.g. `some_unknown_tool`) to a title-cased
 * display string (e.g. `Some Unknown Tool`).
 */
function humanizeNativeName(toolName: string): string {
  return toolName
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Formats a tool name into a human-readable string suitable for display in a
 * channel message.
 *
 * - MCP tools (`mcp__server__tool`): `emoji Using Server Name: tool description`
 * - Native tools (`tool_name`): `emoji Using Tool Name`
 */
export function formatToolCall(toolName: string): string {
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    const serverName = parts[1] ?? '';
    const rawToolName = parts.slice(2).join('__');

    const knownServer = findKnownServer(serverName);

    let emoji: string;
    let humanServerName: string;
    let serverWords: string[];

    if (knownServer) {
      emoji = knownServer.emoji;
      humanServerName = knownServer.name;
      serverWords = getServerWords(knownServer, serverName);
    } else {
      emoji = '🔧';
      humanServerName = humanizeServerName(serverName);
      serverWords = [];
    }

    const toolWords = splitToolName(rawToolName);
    const dedupedWords = stripLeadingDuplicates(toolWords, serverWords);
    const humanToolName = dedupedWords.join(' ');

    return `${emoji} Using ${humanServerName}: ${humanToolName}`;
  }

  // Native tool
  const emoji = NATIVE_TOOL_EMOJI[toolName] ?? '🔧';
  const humanName = humanizeNativeName(toolName);
  return `${emoji} Using ${humanName}`;
}
