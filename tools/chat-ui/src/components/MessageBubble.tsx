import { markdownToHtml } from '../lib/markdown';
import { formatTime } from '../lib/format';

interface MessageBubbleProps {
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
}

export function MessageBubble({ role, content, createdAt }: MessageBubbleProps) {
  const isUser = role === 'user';

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
      <span className="text-xs text-gray-500 px-1">{formatTime(createdAt.getTime())}</span>
    </div>
  );
}
