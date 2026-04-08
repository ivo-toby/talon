import type { ArtifactChunk } from '../hooks/useArtifacts';
import { Package } from 'lucide-react';

interface ArtifactPanelProps {
  artifacts: ArtifactChunk[];
}

export function ArtifactPanel({ artifacts }: ArtifactPanelProps) {
  if (artifacts.length === 0) return null;

  return (
    <aside className="w-80 border-l border-gray-800 bg-gray-900 flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800">
        <Package size={14} className="text-gray-400" />
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          Artifacts
        </span>
        <span className="ml-auto text-xs text-gray-600">{artifacts.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        {artifacts.map((artifact, idx) => (
          <div key={idx} className="rounded-lg border border-gray-700 overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 bg-gray-800 border-b border-gray-700">
              <span className="text-xs font-mono text-blue-400">{artifact.type}</span>
            </div>
            <pre className="text-xs text-gray-300 p-3 overflow-x-auto leading-relaxed">
              {JSON.stringify(
                Object.fromEntries(Object.entries(artifact).filter(([k]) => k !== 'type')),
                null,
                2,
              )}
            </pre>
          </div>
        ))}
      </div>
    </aside>
  );
}
