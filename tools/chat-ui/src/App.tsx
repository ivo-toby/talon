import { useChat } from '@ai-sdk/react';
import { config } from './config';
import { useThreadId } from './hooks/useThreadId';
import { useArtifacts } from './hooks/useArtifacts';
import { ChatWindow } from './components/ChatWindow';
import { InputBar } from './components/InputBar';
import { ArtifactPanel } from './components/ArtifactPanel';
import { StatusBar } from './components/StatusBar';
import { Sidebar } from './components/Sidebar';

export function App() {
  const { threadId, resetThread } = useThreadId(config.threadStorageKey);

  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    status,
    data,
    error,
    setMessages,
  } = useChat({
    api: config.streamUrl,
    id: threadId,
    onError: (err) => {
      console.error('Chat error:', err);
    },
  });

  const artifacts = useArtifacts((data ?? []) as object[]);

  function handleNewThread() {
    setMessages([]);
    resetThread();
  }

  function handleInputBarChange(value: string) {
    handleInputChange({ target: { value } } as React.ChangeEvent<HTMLInputElement>);
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
            <ChatWindow messages={messages} isLoading={status === 'submitted' || status === 'streaming'} />
            {error && (
              <div className="px-4 py-2 text-xs text-red-400 bg-red-950 border-t border-red-900">
                Error: {error.message}
              </div>
            )}
            <InputBar
              input={input}
              isLoading={status === 'submitted' || status === 'streaming'}
              onChange={handleInputBarChange}
              onSubmit={handleSubmit}
            />
          </div>

          <ArtifactPanel artifacts={artifacts} />
        </div>
      </div>
    </div>
  );
}
