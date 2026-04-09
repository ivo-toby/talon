/**
 * Reusable output capture with length-capped buffers and artifact spill.
 *
 * Used by BubblewrapRunner and AppleContainerRunner to capture stdout/stderr
 * from sandboxed processes without unbounded memory growth.
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CaptureResult {
  content: string;
  truncated: boolean;
  artifactPath: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum artifact file size: 10 MB. Beyond this we drop data to prevent OOM. */
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// OutputCapture
// ---------------------------------------------------------------------------

export class OutputCapture {
  private readonly chunks: Buffer[] = [];
  private collectedBytes = 0;
  private overflowed = false;
  private artifactStream: WriteStream | null = null;
  private artifactReady: Promise<void> | null = null;
  private artifactBytes = 0;
  private artifactError = false;
  private finalized = false;
  private cachedResult: CaptureResult | null = null;

  constructor(
    private readonly maxBytes: number,
    private readonly artifactDir: string,
    private readonly artifactPrefix: string,
  ) {}

  /**
   * Feed a chunk from the child process stream.
   * Data up to `maxBytes` is kept in memory; anything beyond that
   * is written to an artifact file on disk (capped at 10 MB).
   */
  onData(chunk: Buffer): void {
    if (this.finalized) return;

    if (!this.overflowed) {
      const remaining = this.maxBytes - this.collectedBytes;
      if (chunk.length <= remaining) {
        this.chunks.push(chunk);
        this.collectedBytes += chunk.length;
        return;
      }

      // Partial fit -- split
      if (remaining > 0) {
        this.chunks.push(chunk.subarray(0, remaining));
        this.collectedBytes += remaining;
      }

      this.overflowed = true;
      this.openArtifact();

      // Write the in-memory portion to artifact so it contains full output,
      // then write the overflow portion of this chunk.
      for (const buffered of this.chunks) {
        this.writeToArtifact(buffered);
      }
      this.writeToArtifact(chunk.subarray(remaining));
    } else {
      // Already overflowed -- stream to artifact (with cap)
      this.writeToArtifact(chunk);
    }
  }

  /**
   * Finalize capture: flush the artifact file (if any) and return the result.
   * Calling finalize() multiple times is safe and returns the same result.
   */
  async finalize(): Promise<CaptureResult> {
    if (this.cachedResult) return this.cachedResult;
    this.finalized = true;

    if (this.artifactStream) {
      await new Promise<void>((resolve) => {
        this.artifactStream!.end(() => {
          resolve();
        });
      });
    }

    const content = Buffer.concat(this.chunks).toString('utf-8');

    this.cachedResult = {
      content,
      truncated: this.overflowed,
      artifactPath: this.overflowed ? this.artifactPath() : null,
    };

    return this.cachedResult;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private artifactPath(): string {
    return `${this.artifactDir}/${this.artifactPrefix}`;
  }

  /**
   * Write a chunk to the artifact file, respecting the artifact size cap.
   * Silently drops data if the stream has errored or the cap is exceeded.
   */
  private writeToArtifact(chunk: Buffer): void {
    if (this.artifactError || !this.artifactStream) return;
    if (this.artifactBytes >= MAX_ARTIFACT_BYTES) return;

    const allowable = MAX_ARTIFACT_BYTES - this.artifactBytes;
    const toWrite = chunk.length <= allowable ? chunk : chunk.subarray(0, allowable);
    this.artifactBytes += toWrite.length;
    this.artifactStream.write(toWrite);
  }

  private openArtifact(): void {
    const path = this.artifactPath();
    // Ensure directory exists (best-effort)
    this.artifactReady = mkdir(dirname(path), { recursive: true }).then(
      () => undefined,
      () => undefined,
    );
    this.artifactStream = createWriteStream(path, { flags: 'w' });
    // Absorb stream errors to prevent unhandled exceptions
    this.artifactStream.on('error', () => {
      this.artifactError = true;
    });
  }
}
