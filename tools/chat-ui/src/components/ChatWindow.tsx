import { useEffect, useRef } from 'react';
import type { UIMessage } from 'ai';
import { MessageBubble } from './MessageBubble';
import { Bot } from 'lucide-react';

interface ChatWindowProps {
  messages: UIMessage[];
  isLoading: boolean;
}

export function ChatWindow({ messages, isLoading }: ChatWindowProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-gray-500">
        <Bot size={48} className="text-gray-700" />
        <p className="text-sm">Start a conversation</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 flex flex-col gap-4">
      {messages.map((msg) => (
        <MessageBubble
          key={msg.id}
          role={msg.role as 'user' | 'assistant'}
          parts={msg.parts}
        />
      ))}
      {isLoading && (
        <div className="flex items-start gap-2">
          <div className="bg-gray-800 rounded-2xl rounded-bl-sm px-4 py-3 flex gap-1">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce"
                style={{ animationDelay: `${i * 150}ms` }}
              />
            ))}
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
