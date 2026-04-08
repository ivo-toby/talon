function optionalEnv(key: string, fallback: string): string {
  return (import.meta.env[key] as string | undefined) ?? fallback;
}

export const config = {
  talonUrl: optionalEnv('VITE_TALON_URL', 'http://localhost:4100'),
  agentId: optionalEnv('VITE_AGENT_ID', 'default'),
  get streamUrl(): string {
    return `${this.talonUrl}/agents/${this.agentId}/stream`;
  },
  threadStorageKey: `talon-thread-${optionalEnv('VITE_AGENT_ID', 'default')}`,
} as const;
