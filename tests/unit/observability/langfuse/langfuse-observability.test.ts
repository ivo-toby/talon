import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pino from 'pino';
import { context, propagation, trace } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { LangfuseOtelSpanAttributes } from '@langfuse/tracing';

import { LangfuseObservabilityService } from '../../../../src/observability/langfuse/langfuse-observability.js';

function createSilentLogger() {
  return pino({ level: 'silent' });
}

describe('LangfuseObservabilityService', () => {
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
  });

  afterEach(() => {
    exporter.reset();
  });

  it('records observations with Langfuse observation attributes', async () => {
    const service = new LangfuseObservabilityService(
      {
        enabled: true,
        publicKey: 'pk-lf-test',
        secretKey: 'sk-lf-test',
        baseUrl: 'https://cloud.langfuse.com',
        environment: 'test',
        exportMode: 'immediate',
        flushAt: 1,
        flushIntervalSeconds: 1,
      },
      createSilentLogger(),
      {
        exporter,
        shouldExportSpan: () => true,
      },
    );

    await service.observe(
      {
        type: 'agent',
        name: 'foreground-run',
        input: { content: 'Hello agent' },
        trace: {
          name: 'foreground-run',
          sessionId: 'thread-123',
          metadata: {
            runId: 'run-123',
            persona: 'default',
          },
        },
      },
      async (observation) => {
        observation.update({
          output: { text: 'Done' },
          metadata: { provider: 'claude-code' },
        });
      },
    );

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('foreground-run');
    expect(spans[0].attributes[LangfuseOtelSpanAttributes.OBSERVATION_TYPE]).toBe('agent');

    await service.shutdown();
  });

  it('nests child observations under an explicit traceparent', async () => {
    const service = new LangfuseObservabilityService(
      {
        enabled: true,
        publicKey: 'pk-lf-test',
        secretKey: 'sk-lf-test',
        baseUrl: 'https://cloud.langfuse.com',
        environment: 'test',
        exportMode: 'immediate',
        flushAt: 1,
        flushIntervalSeconds: 1,
      },
      createSilentLogger(),
      {
        exporter,
        shouldExportSpan: () => true,
      },
    );

    let traceparent: string | null = null;
    await service.observe(
      {
        type: 'generation',
        name: 'provider-attempt',
      },
      async (observation) => {
        traceparent = observation.getTraceparent();
      },
    );

    await service.observeWithTraceparent(
      traceparent,
      {
        type: 'tool',
        name: 'channel.send',
      },
      async () => undefined,
    );

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    expect(spans[1].spanContext().traceId).toBe(spans[0].spanContext().traceId);
    expect(spans[1].parentSpanContext?.spanId).toBe(spans[0].spanContext().spanId);

    await service.shutdown();
  });

  it('supports manually started child observations under an explicit traceparent', async () => {
    const service = new LangfuseObservabilityService(
      {
        enabled: true,
        publicKey: 'pk-lf-test',
        secretKey: 'sk-lf-test',
        baseUrl: 'https://cloud.langfuse.com',
        environment: 'test',
        exportMode: 'immediate',
        flushAt: 1,
        flushIntervalSeconds: 1,
      },
      createSilentLogger(),
      {
        exporter,
        shouldExportSpan: () => true,
      },
    );

    let traceparent: string | null = null;
    await service.observe(
      {
        type: 'generation',
        name: 'provider-attempt',
      },
      async (observation) => {
        traceparent = observation.getTraceparent();
      },
    );

    const toolObservation = service.startWithTraceparent(traceparent, {
      type: 'tool',
      name: 'channel.send',
      input: { body: 'hello' },
    });
    toolObservation.update({
      output: { ok: true },
    });
    toolObservation.end();

    await new Promise((resolve) => setTimeout(resolve, 0));

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    expect(spans[1].spanContext().traceId).toBe(spans[0].spanContext().traceId);
    expect(spans[1].parentSpanContext?.spanId).toBe(spans[0].spanContext().spanId);

    await service.shutdown();
  });

  it('tears down global OpenTelemetry state on shutdown', async () => {
    const traceDisable = vi.spyOn(trace, 'disable');
    const contextDisable = vi.spyOn(context, 'disable');
    const propagationDisable = vi.spyOn(propagation, 'disable');

    const service = new LangfuseObservabilityService(
      {
        enabled: true,
        publicKey: 'pk-lf-test',
        secretKey: 'sk-lf-test',
        baseUrl: 'https://cloud.langfuse.com',
        environment: 'test',
        exportMode: 'immediate',
        flushAt: 1,
        flushIntervalSeconds: 1,
      },
      createSilentLogger(),
      {
        exporter,
        shouldExportSpan: () => true,
      },
    );

    await service.shutdown();

    expect(traceDisable).toHaveBeenCalledOnce();
    expect(contextDisable).toHaveBeenCalledOnce();
    expect(propagationDisable).toHaveBeenCalledOnce();
  });

  it('sets service.name to "talond" on the OTEL tracer provider resource', async () => {
    const service = new LangfuseObservabilityService(
      {
        enabled: true,
        publicKey: 'pk-lf-test',
        secretKey: 'sk-lf-test',
        baseUrl: 'https://cloud.langfuse.com',
        environment: 'test',
        exportMode: 'immediate',
        flushAt: 1,
        flushIntervalSeconds: 1,
      },
      createSilentLogger(),
      { exporter, shouldExportSpan: () => true },
    );

    await service.observe({ type: 'agent', name: 'test-run' }, async () => undefined);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].resource.attributes['service.name']).toBe('talond');

    await service.shutdown();
  });

  it('sets service.version from config.release on the OTEL resource', async () => {
    const service = new LangfuseObservabilityService(
      {
        enabled: true,
        publicKey: 'pk-lf-test',
        secretKey: 'sk-lf-test',
        baseUrl: 'https://cloud.langfuse.com',
        environment: 'test',
        release: '1.2.3',
        exportMode: 'immediate',
        flushAt: 1,
        flushIntervalSeconds: 1,
      },
      createSilentLogger(),
      { exporter, shouldExportSpan: () => true },
    );

    await service.observe({ type: 'agent', name: 'test-run' }, async () => undefined);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].resource.attributes['service.version']).toBe('1.2.3');

    await service.shutdown();
  });
});
