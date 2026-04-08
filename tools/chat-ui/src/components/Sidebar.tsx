import { PlusCircle, Bird } from 'lucide-react';

interface SidebarProps {
  onNewThread: () => void;
}

export function Sidebar({ onNewThread }: SidebarProps) {
  return (
    <aside className="w-16 flex flex-col items-center py-4 gap-4 border-r border-gray-800 bg-gray-950 shrink-0">
      <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-gray-800">
        <Bird size={20} className="text-blue-400" />
      </div>
      <div className="flex-1" />
      <button
        onClick={onNewThread}
        className="flex items-center justify-center w-10 h-10 rounded-xl hover:bg-gray-800 text-gray-500 hover:text-gray-300 transition-colors"
        title="New thread"
        aria-label="Start new thread"
      >
        <PlusCircle size={20} />
      </button>
    </aside>
  );
}
