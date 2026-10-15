import { posix } from 'node:path';
import { z } from 'zod';
import { ConfigError } from '../../../core/errors/error-types.js';
import { err, ok, type Result } from '../../../core/types/result.js';
import { normalizeSignalGroupId, normalizeSignalUuid } from './signal-identities.js';

/** Exact reviewed bridge baseline; no inferred semver compatibility. */
export const SIGNAL_BRIDGE_VERSION = '0.14.9';
/** signal-cli v0.14.9: lib/src/main/java/org/asamk/signal/manager/config/ServiceConfig.java:24;
 * internal/ManagerImpl.java:947-959 promotes larger UTF-8 text to an attachment. */
export const SIGNAL_MAX_CHUNK_BYTES = 2_000;

export const SignalUuidSchema = z.string().transform((value, ctx) => {
  const result = normalizeSignalUuid(value);
  if (result.isOk()) return result.value;
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid Signal UUID' });
  return z.NEVER;
});

const GroupIdSchema = z
  .string()
  .refine((value) => normalizeSignalGroupId(value).isOk(), 'Invalid Signal group ID');
const PositiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const uuidList = z
  .array(SignalUuidSchema)
  .default([])
  .transform((values) => [...new Set(values)]);

export const SignalConfigSchema = z
  .object({
    accountMode: z.enum(['personal', 'dedicated']),
    // Filesystem ownership/mode/symlink checks belong to the connection trust boundary.
    socketPath: z
      .string()
      .refine(
        (value) => posix.isAbsolute(value) && !value.includes('\0'),
        'Invalid absolute socket path',
      ),
    account: z.string().transform((value, ctx) => {
      if (/^\+[1-9][0-9]{1,14}$/.test(value)) return value;
      const result = normalizeSignalUuid(value);
      if (result.isOk()) return result.value;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid Signal account selector' });
      return z.NEVER;
    }),
    accountUuid: SignalUuidSchema,
    deviceId: PositiveSafeInteger,
    deviceCreatedTimestamp: PositiveSafeInteger.optional(),
    allowedDmPeers: uuidList,
    allowedSenders: uuidList,
    allowedGroups: z
      .array(GroupIdSchema)
      .default([])
      .transform((values) => [...new Set(values)]),
    triggerPrefix: z
      .string()
      .refine((value) => value.trim().length > 0, 'Trigger must be nonempty')
      .default('!talon'),
    requestTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
    reconnectBaseMs: z.number().int().min(100).max(60_000).default(1_000),
    reconnectMaxMs: z.number().int().min(100).max(300_000).default(60_000),
  })
  .superRefine((value, ctx) => {
    if (!value.account.startsWith('+') && value.account !== value.accountUuid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['account'],
        message: 'ACI selector must match the pinned account',
      });
    }
    if (value.reconnectMaxMs < value.reconnectBaseMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reconnectMaxMs'],
        message: 'Reconnect maximum must not be below base',
      });
    }
    if (value.accountMode === 'personal') {
      if (value.deviceId === 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['deviceId'],
          message: 'Personal mode requires a linked device',
        });
      }
      if (value.deviceCreatedTimestamp === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['deviceCreatedTimestamp'],
          message: 'Personal mode requires device creation metadata',
        });
      }
    }
  });

export type SignalConfig = z.infer<typeof SignalConfigSchema>;

/** Do not expose Zod's received values or arbitrary remote/config keys to shared callers. */
export function parseSignalConfig(input: unknown): Result<SignalConfig, ConfigError> {
  const result = SignalConfigSchema.safeParse(input);
  return result.success ? ok(result.data) : err(new ConfigError('Invalid Signal configuration'));
}
