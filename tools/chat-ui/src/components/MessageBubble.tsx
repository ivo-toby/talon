import { markdownToHtml } from '../lib/markdown';

interface MessageBubbleProps {
  role: 'user' | 'assistant';
  parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
}

function extractText(parts: MessageBubbleProps['parts']): string {
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('');
}

export function MessageBubble({ role, parts }: MessageBubbleProps) {
  const isUser = role === 'user';
  const content = extractText(parts);

  return (
    <div className={`flex flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}>
      <div
        className={`max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
          isUser
            ? 'bg-blue-600 text-white rounded-br-sm'
            : 'bg-gray-800 text-gray-100 rounded-bl-sm'
        }`}
      >
        {isUser ? (
          <span>{content}</span>
        ) : (
          <span
            dangerouslySetInnerHTML={{ __html: markdownToHtml(content) }}
            className="prose-sm"
          />
        )}
      </div>
    </div>
  );
}
