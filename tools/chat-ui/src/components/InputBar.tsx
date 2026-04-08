import { type FormEvent, type KeyboardEvent, useRef } from 'react';
import { Send } from 'lucide-react';

interface InputBarProps {
  input: string;
  isLoading: boolean;
  onChange: (value: string) => void;
  onSubmit: (e: FormEvent) => void;
}

export function InputBar({ input, isLoading, onChange, onSubmit }: InputBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (input.trim() && !isLoading) {
        onSubmit(e as unknown as FormEvent);
      }
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex items-end gap-3 px-4 py-4 border-t border-gray-800 bg-gray-950"
    >
      <textarea
        ref={textareaRef}
        rows={1}
        value={input}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Message Talon... (Enter to send, Shift+Enter for newline)"
        disabled={isLoading}
        className="flex-1 resize-none bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500 disabled:opacity-50 max-h-40 overflow-y-auto"
        style={{ fieldSizing: 'content' } as React.CSSProperties}
      />
      <button
        type="submit"
        disabled={isLoading || !input.trim()}
        className="flex items-center justify-center w-10 h-10 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-600 text-white rounded-xl transition-colors shrink-0"
        aria-label="Send message"
      >
        <Send size={16} />
      </button>
    </form>
  );
}
