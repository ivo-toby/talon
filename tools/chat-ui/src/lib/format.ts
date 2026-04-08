/**
 * Format a Unix timestamp (ms) as a short time string: "14:32".
 */
export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Truncate a string to maxLen characters, appending ellipsis if truncated.
 */
export function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? `${str.slice(0, maxLen)}…` : str;
}
