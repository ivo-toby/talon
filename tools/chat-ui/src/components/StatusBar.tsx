import { Wifi, WifiOff } from 'lucide-react';
import { truncate } from '../lib/format';

interface StatusBarProps {
  threadId: string;
  isConnected: boolean;
  agentId: string;
}

export function StatusBar({ threadId, isConnected, agentId }: StatusBarProps) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-gray-900 border-b border-gray-800 text-xs text-gray-500">
      <span className="flex items-center gap-1">
        {isConnected ? (
          <Wifi size={12} className="text-green-500" />
        ) : (
          <WifiOff size={12} className="text-gray-600" />
        )}
        <span className={isConnected ? 'text-green-400' : 'text-gray-600'}>
          {isConnected ? 'Connected' : 'Disconnected'}
        </span>
      </span>
      <span className="text-gray-700">·</span>
      <span>agent: <span className="text-blue-400 font-mono">{agentId}</span></span>
      <span className="text-gray-700">·</span>
      <span>thread: <span className="font-mono text-gray-400">{truncate(threadId, 8)}</span></span>
    </div>
  );
}
