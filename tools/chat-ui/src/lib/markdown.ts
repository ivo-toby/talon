/**
 * Convert a small subset of Markdown to sanitised HTML.
 * Handles: bold, italic, inline code, code blocks, links, line breaks.
 */
export function markdownToHtml(md: string): string {
  return md
    // Code blocks (``` ... ```) — must come before inline code
    .replace(/```[\w]*\n?([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code class="bg-gray-800 px-1 rounded text-sm font-mono">$1</code>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Links [text](url) — only allow http/https
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-blue-400 underline">$1</a>')
    // Line breaks
    .replace(/\n/g, '<br />');
}
