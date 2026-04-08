import { useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { config } from './config';
import { useThreadId } from './hooks/useThreadId';
import { ChatWindow } from './components/ChatWindow';
import { InputBar } from './components/InputBar';
import { StatusBar } from './components/StatusBar';
import { Sidebar } from './components/Sidebar';

export function App() {
  const { threadId, resetThread } = useThreadId(config.threadStorageKey);
  const [input, setInput] = useState('');

  const {
    messages,
    sendMessage,
    status,
    error,
    setMessages,
  } = useChat({
    id: threadId,
    transport: new DefaultChatTransport({ api: config.streamUrl }),
    onError: (err) => {
      console.error('Chat error:', err);
    },
  });

  const isLoading = status === 'submitted' || status === 'streaming';

  function handleNewThread() {
    setMessages([]);
    resetThread();
  }

  async function handleSubmit() {
    const text = input.trim();
    if (!text || isLoading) return;
    setInput('');
    await sendMessage({ text });
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-gray-950 text-gray-100">
      <Sidebar onNewThread={handleNewThread} />

      <div className="flex flex-col flex-1 min-w-0">
        <StatusBar
          threadId={threadId}
          isConnected={!error}
          agentId={config.agentId}
        />

        <div className="flex flex-1 min-h-0">
          <div className="flex flex-col flex-1 min-w-0">
            <ChatWindow messages={messages} isLoading={isLoading} />
            {error && (
              <div className="px-4 py-2 text-xs text-red-400 bg-red-950 border-t border-red-900">
                Error: {error.message}
              </div>
            )}
            <InputBar
              input={input}
              isLoading={isLoading}
              onChange={setInput}
              onSubmit={handleSubmit}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
