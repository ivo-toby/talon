import { z } from 'zod';

import {
  LifecycleRuntimeIdSchema,
  isBoundedWellFormedUtf8,
} from '../contracts/common.js';

export const CONTEXT_OBSERVER_INPUT_CONTRACT = 'talon.context.observer.input.v1';
export const CONTEXT_OBSERVER_OUTPUT_CONTRACT = 'talon.context.observer.v1';
export const CONTEXT_REDUCER_INPUT_CONTRACT = 'talon.context.reducer.input.v1';
export const CONTEXT_REDUCER_OUTPUT_CONTRACT = 'talon.context.reducer.v1';

const MAX_CONTEXT_TEXT_CHARS = 100_000;
const MAX_CONTEXT_FIELD_CHARS = 16_384;
const MAX_CONTEXT_MEMORY_UPDATES = 64;
const MAX_CONTEXT_OBSERVATIONS = 256;
const MAX_CONTEXT_TIMESTAMP_FIELD_CHARS = 64;
const CONTEXT_OBSERVATION_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CONTEXT_OBSERVATION_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function isWellFormedContextString(value: string, maxCodeUnits: number): boolean {
  return value.indexOf('\0') === -1 && isBoundedWellFormedUtf8(value, maxCodeUnits, maxCodeUnits * 4);
}

function isValidIsoDateOnly(value: string): boolean {
  if (!CONTEXT_OBSERVATION_DATE_PATTERN.test(value)) return false;
  const [yearPart, monthPart, dayPart] = value.split('-');
  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

const ContextTextSchema = z
  .string()
  .min(1)
  .max(MAX_CONTEXT_FIELD_CHARS)
  .refine((value) => isWellFormedContextString(value, MAX_CONTEXT_FIELD_CHARS), {
      message: 'context contract strings must be well-formed Unicode without NUL characters',
  });

const ContextHintTextSchema = z
  .string()
  .max(MAX_CONTEXT_FIELD_CHARS)
  .refine((value) => isWellFormedContextString(value, MAX_CONTEXT_FIELD_CHARS), {
    message: 'context contract hint strings must be well-formed Unicode without NUL characters',
  });

const ContextTranscriptSchema = z
  .string()
  .min(1)
  .max(MAX_CONTEXT_TEXT_CHARS)
  .refine((value) => isWellFormedContextString(value, MAX_CONTEXT_TEXT_CHARS), {
    message: 'context contract transcripts must be well-formed Unicode without NUL characters',
  });

const ContextObservationDateSchema = z
  .string()
  .min(1)
  .max(MAX_CONTEXT_TIMESTAMP_FIELD_CHARS)
  .refine((value) => isWellFormedContextString(value, MAX_CONTEXT_TIMESTAMP_FIELD_CHARS), {
    message: 'context observation dates must be well-formed Unicode without NUL characters',
  })
  .refine(isValidIsoDateOnly, {
    message: 'context observation dates must be valid YYYY-MM-DD dates',
  });

const ContextObservationTimeSchema = z
  .string()
  .min(1)
  .max(MAX_CONTEXT_TIMESTAMP_FIELD_CHARS)
  .refine((value) => isWellFormedContextString(value, MAX_CONTEXT_TIMESTAMP_FIELD_CHARS), {
    message: 'context observation times must be well-formed Unicode without NUL characters',
  })
  .refine((value) => CONTEXT_OBSERVATION_TIME_PATTERN.test(value), {
    message: 'context observation times must use 24-hour HH:MM format',
  });

export const ContextObserverInputSchema = z
  .object({
    transcript: ContextTranscriptSchema,
  })
  .strict();

export const ContextReducerInputSchema = z
  .object({
    observationLog: ContextTranscriptSchema,
  })
  .strict();

export const ContextObservationPrioritySchema = z.enum(['high', 'medium', 'low']);

export const ContextObservationSchema = z
  .object({
    date: ContextObservationDateSchema,
    time: ContextObservationTimeSchema,
    priority: ContextObservationPrioritySchema,
    text: ContextTextSchema,
  })
  .strict();

export const ContextMemoryUpdateSchema = z
  .object({
    key: LifecycleRuntimeIdSchema,
    value: ContextTextSchema,
    mode: z.enum(['append', 'replace']),
  })
  .strict();

const ContextObserverOutputBaseSchema = z
  .object({
    observations: z.array(ContextObservationSchema).min(1).max(MAX_CONTEXT_OBSERVATIONS),
    taskComplete: z.boolean().default(true),
    currentTask: ContextHintTextSchema.optional(),
    suggestedContinuation: ContextHintTextSchema.optional(),
    memoryUpdates: z.array(ContextMemoryUpdateSchema).max(MAX_CONTEXT_MEMORY_UPDATES).default([]),
  })
  .strict();

export const ContextObserverOutputSchema = ContextObserverOutputBaseSchema.transform((value) => {
  const taskComplete = value.taskComplete !== false;
  return Object.freeze({
    contract: CONTEXT_OBSERVER_OUTPUT_CONTRACT,
    observations: Object.freeze(value.observations.map((observation) => Object.freeze({ ...observation }))),
    taskComplete,
    ...(taskComplete || !value.currentTask ? {} : { currentTask: value.currentTask }),
    ...(taskComplete || !value.suggestedContinuation
      ? {}
      : { suggestedContinuation: value.suggestedContinuation }),
    memoryUpdates: Object.freeze(value.memoryUpdates.map((update) => Object.freeze({ ...update }))),
  });
});

const ContextReducerOutputBaseSchema = z
  .object({
    consolidatedLog: ContextTranscriptSchema,
  })
  .strict();

export const ContextReducerOutputSchema = ContextReducerOutputBaseSchema.transform((value) =>
  Object.freeze({
    contract: CONTEXT_REDUCER_OUTPUT_CONTRACT,
    consolidatedLog: value.consolidatedLog,
  }),
);

export type ContextObserverInput = z.infer<typeof ContextObserverInputSchema>;
export type ContextReducerInput = z.infer<typeof ContextReducerInputSchema>;
export type ContextObservation = z.infer<typeof ContextObservationSchema>;
export type ContextMemoryUpdate = z.infer<typeof ContextMemoryUpdateSchema>;
export type ContextObserverOutput = z.output<typeof ContextObserverOutputSchema>;
export type ContextReducerOutput = z.output<typeof ContextReducerOutputSchema>;
