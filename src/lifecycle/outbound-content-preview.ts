import { err, ok, type Result } from 'neverthrow';

import { MAX_LIFECYCLE_CONTENT_LENGTH } from './contracts/event-contract.js';

export interface LifecycleContentPreview {
  readonly content: string;
  readonly originalLength: number;
  readonly truncated: boolean;
}

export function buildLifecycleContentPreview(content: string): LifecycleContentPreview {
  if (content.length <= MAX_LIFECYCLE_CONTENT_LENGTH) {
    return { content, originalLength: content.length, truncated: false };
  }

  const marker = `\n\n[Lifecycle preview truncated: original content length ${content.length} chars]\n\n`;
  if (marker.length >= MAX_LIFECYCLE_CONTENT_LENGTH) {
    return {
      content: content.slice(0, MAX_LIFECYCLE_CONTENT_LENGTH),
      originalLength: content.length,
      truncated: true,
    };
  }

  const contentBudget = MAX_LIFECYCLE_CONTENT_LENGTH - marker.length;
  const headLength = Math.ceil(contentBudget / 2);
  const tailLength = contentBudget - headLength;
  return {
    content: `${content.slice(0, headLength)}${marker}${content.slice(content.length - tailLength)}`,
    originalLength: content.length,
    truncated: true,
  };
}

export function resolveLifecycleOutboundContent(input: {
  readonly originalContent: string;
  readonly preview: LifecycleContentPreview;
  readonly interceptedContent: string;
}): Result<string, Error> {
  if (!input.preview.truncated) {
    return ok(input.interceptedContent);
  }

  if (input.interceptedContent !== input.preview.content) {
    return err(
      new Error(
        'Lifecycle outbound content transform rejected because interceptor received a truncated preview',
      ),
    );
  }

  return ok(input.originalContent);
}
