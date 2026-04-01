export interface ThreadMetadata {
  providerAffinityResetAt?: number;
  [key: string]: unknown;
}

export function parseThreadMetadata(raw: string | null | undefined): ThreadMetadata {
  if (!raw || raw.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as ThreadMetadata
      : {};
  } catch {
    return {};
  }
}

export function getProviderAffinityResetAt(raw: string | null | undefined): number | undefined {
  const metadata = parseThreadMetadata(raw);
  return typeof metadata.providerAffinityResetAt === 'number'
    ? metadata.providerAffinityResetAt
    : undefined;
}

export function withProviderAffinityResetAt(
  raw: string | null | undefined,
  resetAt: number,
): string {
  const metadata = parseThreadMetadata(raw);
  metadata.providerAffinityResetAt = resetAt;
  return JSON.stringify(metadata);
}
