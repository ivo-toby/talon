import { err, ok, type Result } from 'neverthrow';

import { LifecycleError } from '../core/errors/error-types.js';
import type {
  LifecycleBudgetContract,
  LifecycleConfig,
  LifecycleFailurePolicyContract,
  LifecycleFilterContract,
  LifecycleHandlerContract,
  LifecycleHandlerIdentityContract,
  LifecycleInterceptorContract,
  LifecycleItemOrigin,
  LifecycleItemType,
  LifecycleMessageSource,
  LifecycleScheduleSource,
  LifecycleSignalContract,
  LifecycleEventContract,
  PersonaLifecycleConfig,
  PersonaLifecycleSubscription,
} from './contracts/index.js';

export interface LifecycleRegistryPersonaInput {
  name: string;
  lifecycle?: PersonaLifecycleConfig;
}

export interface LifecycleRegistryChannelInput {
  name: string;
}

export interface LifecycleRegistryInput {
  lifecycle?: LifecycleConfig;
  channels?: LifecycleRegistryChannelInput[];
  personas: LifecycleRegistryPersonaInput[];
}

export interface LifecycleValidationIssue {
  path: PropertyKey[];
  message: string;
}

export interface ResolvedLifecycleHandler {
  persona: string;
  priority: number;
  handler: LifecycleHandlerContract;
  identity: LifecycleHandlerIdentityContract;
  subscription: PersonaLifecycleSubscription['subscription'];
  budget?: LifecycleBudgetContract;
  failurePolicy: LifecycleFailurePolicyContract;
}

export interface LifecycleEventResolutionQuery {
  persona: string;
  eventType: string;
  itemOrigin?: LifecycleItemOrigin;
  itemType?: LifecycleItemType;
  channel?: string;
  messageSource?: LifecycleMessageSource;
  scheduleSource?: LifecycleScheduleSource;
}

export interface LifecycleSignalResolutionQuery {
  persona: string;
  signalType: string;
  itemOrigin?: LifecycleEventResolutionQuery['itemOrigin'];
  itemType?: LifecycleEventResolutionQuery['itemType'];
  channel?: string;
  messageSource?: LifecycleMessageSource;
  scheduleSource?: LifecycleEventResolutionQuery['scheduleSource'];
}

export interface LifecycleInterceptorResolutionQuery {
  persona: string;
  hook: LifecycleInterceptorContract['hook'];
  itemOrigin?: LifecycleEventResolutionQuery['itemOrigin'];
  itemType?: LifecycleEventResolutionQuery['itemType'];
  channel?: string;
  messageSource?: LifecycleMessageSource;
  scheduleSource?: LifecycleEventResolutionQuery['scheduleSource'];
}

function compareResolvedHandlers(
  left: ResolvedLifecycleHandler,
  right: ResolvedLifecycleHandler,
): number {
  if (left.priority !== right.priority) {
    return right.priority - left.priority;
  }

  return left.handler.id.localeCompare(right.handler.id);
}

function defaultFailurePolicyForMode(
  mode: LifecycleHandlerContract['mode'],
): LifecycleFailurePolicyContract {
  return {
    version: 'v1',
    mode: mode === 'interceptor' ? 'fail_closed' : 'dead_letter',
  };
}

function toHandlerIdentity(handler: LifecycleHandlerContract): LifecycleHandlerIdentityContract {
  return {
    version: 'v1',
    handlerId: handler.id,
    runtimeKind: handler.runtime.kind,
    implementationRef: handler.runtime.ref,
    implementationVersion: handler.runtime.implementationVersion,
  };
}

function matchesFilter(
  filter: LifecycleFilterContract | undefined,
  query: {
    persona: string;
    itemOrigin?: LifecycleEventResolutionQuery['itemOrigin'];
    itemType?: LifecycleEventResolutionQuery['itemType'];
    channel?: string;
    messageSource?: LifecycleMessageSource;
    scheduleSource?: LifecycleEventResolutionQuery['scheduleSource'];
  },
): boolean {
  if (!filter) {
    return true;
  }

  if (filter.personas && !filter.personas.includes(query.persona)) {
    return false;
  }
  if (filter.itemOrigins && (!query.itemOrigin || !filter.itemOrigins.includes(query.itemOrigin))) {
    return false;
  }
  if (filter.itemTypes && (!query.itemType || !filter.itemTypes.includes(query.itemType))) {
    return false;
  }
  if (filter.channels && (!query.channel || !filter.channels.includes(query.channel))) {
    return false;
  }
  if (
    filter.messageSources &&
    (!query.messageSource || !filter.messageSources.includes(query.messageSource))
  ) {
    return false;
  }
  if (
    filter.scheduleSources &&
    (!query.scheduleSource || !filter.scheduleSources.includes(query.scheduleSource))
  ) {
    return false;
  }

  return true;
}

function isFailurePolicyCompatible(
  mode: LifecycleHandlerContract['mode'],
  failurePolicy: LifecycleFailurePolicyContract,
): boolean {
  if (failurePolicy.mode === 'fail_open') {
    return false;
  }

  if (mode === 'interceptor') {
    return failurePolicy.mode === 'fail_closed';
  }

  return failurePolicy.mode === 'dead_letter' || failurePolicy.mode === 'preserve_session';
}

function appendFailurePolicyIssues(
  mode: LifecycleHandlerContract['mode'],
  failurePolicy: LifecycleFailurePolicyContract | undefined,
  path: PropertyKey[],
  issues: LifecycleValidationIssue[],
): void {
  if (!failurePolicy) {
    return;
  }

  if (failurePolicy.mode === 'fail_open') {
    issues.push({
      path,
      message: 'fail_open is not allowed for lifecycle handlers in v1',
    });
    return;
  }

  if (!isFailurePolicyCompatible(mode, failurePolicy)) {
    issues.push({
      path,
      message:
        mode === 'interceptor'
          ? 'interceptor handlers must use fail_closed failure policies'
          : `${mode} handlers must use dead_letter or preserve_session failure policies`,
    });
  }
}

export function collectLifecycleValidationIssues(
  input: LifecycleRegistryInput,
): LifecycleValidationIssue[] {
  const issues: LifecycleValidationIssue[] = [];
  const handlerIndexes = new Map<string, number>();
  const handlers = input.lifecycle?.handlers ?? [];
  const knownPersonas = new Set(input.personas.map((persona) => persona.name));
  const knownChannels = input.channels ? new Set(input.channels.map((channel) => channel.name)) : null;

  for (const [index, handler] of handlers.entries()) {
    const duplicateIndex = handlerIndexes.get(handler.id);
    if (duplicateIndex !== undefined) {
      issues.push({
        path: ['lifecycle', 'handlers', index, 'id'],
        message: `duplicate lifecycle handler id "${handler.id}"`,
      });
      continue;
    }

    handlerIndexes.set(handler.id, index);

    if (handler.mode === 'interceptor' && handler.runtime.kind !== 'native') {
      issues.push({
        path: ['lifecycle', 'handlers', index, 'runtime', 'kind'],
        message: 'interceptor handlers must be native in v1',
      });
    }

    appendFailurePolicyIssues(
      handler.mode,
      handler.failurePolicy,
      ['lifecycle', 'handlers', index, 'failurePolicy'],
      issues,
    );
  }

  for (const [personaIndex, persona] of input.personas.entries()) {
    const seenHandlers = new Set<string>();
    const subscriptions = persona.lifecycle?.subscriptions ?? [];

    for (const [subscriptionIndex, attachment] of subscriptions.entries()) {
      if (seenHandlers.has(attachment.handler)) {
        issues.push({
          path: ['personas', personaIndex, 'lifecycle', 'subscriptions', subscriptionIndex, 'handler'],
          message: `persona "${persona.name}" attaches lifecycle handler "${attachment.handler}" more than once`,
        });
      } else {
        seenHandlers.add(attachment.handler);
      }

      const handlerIndex = handlerIndexes.get(attachment.handler);
      if (handlerIndex === undefined) {
        issues.push({
          path: ['personas', personaIndex, 'lifecycle', 'subscriptions', subscriptionIndex, 'handler'],
          message:
            `persona "${persona.name}" references unknown lifecycle handler ` +
            `"${attachment.handler}"`,
        });
        continue;
      }

      const handler = handlers[handlerIndex];
      if (handler.mode !== attachment.subscription.kind) {
        issues.push({
          path: ['personas', personaIndex, 'lifecycle', 'subscriptions', subscriptionIndex, 'subscription', 'kind'],
          message:
            `handler "${handler.id}" has mode "${handler.mode}" but subscription kind is ` +
            `"${attachment.subscription.kind}"`,
        });
      }

      if (attachment.subscription.filter?.personas) {
        for (const [filterIndex, personaName] of attachment.subscription.filter.personas.entries()) {
          if (!knownPersonas.has(personaName)) {
            issues.push({
              path: [
                'personas',
                personaIndex,
                'lifecycle',
                'subscriptions',
                subscriptionIndex,
                'subscription',
                'filter',
                'personas',
                filterIndex,
              ],
              message: `lifecycle filter references unknown persona "${personaName}"`,
            });
          } else if (personaName !== persona.name) {
            issues.push({
              path: [
                'personas',
                personaIndex,
                'lifecycle',
                'subscriptions',
                subscriptionIndex,
                'subscription',
                'filter',
                'personas',
                filterIndex,
              ],
              message:
                `lifecycle filter persona "${personaName}" does not match the attached ` +
                `persona "${persona.name}"`,
            });
          }
        }
      }

      if (knownChannels && attachment.subscription.filter?.channels) {
        for (const [filterIndex, channelName] of attachment.subscription.filter.channels.entries()) {
          if (!knownChannels.has(channelName)) {
            issues.push({
              path: [
                'personas',
                personaIndex,
                'lifecycle',
                'subscriptions',
                subscriptionIndex,
                'subscription',
                'filter',
                'channels',
                filterIndex,
              ],
              message: `lifecycle filter references unknown channel "${channelName}"`,
            });
          }
        }
      }

      const effectivePolicy =
        attachment.failurePolicy ??
        handler.failurePolicy ??
        defaultFailurePolicyForMode(handler.mode);

      appendFailurePolicyIssues(
        handler.mode,
        effectivePolicy,
        [
          'personas',
          personaIndex,
          'lifecycle',
          'subscriptions',
          subscriptionIndex,
          attachment.failurePolicy ? 'failurePolicy' : 'subscription',
        ],
        issues,
      );
    }
  }

  return issues;
}

function formatValidationIssues(issues: LifecycleValidationIssue[]): string {
  return issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}

export class LifecycleHandlerRegistry {
  private readonly handlersById = new Map<string, LifecycleHandlerContract>();
  private readonly personaHandlers = new Map<string, ResolvedLifecycleHandler[]>();
  private readonly enabled: boolean;

  constructor(input: LifecycleRegistryInput) {
    const sortedHandlers = [...(input.lifecycle?.handlers ?? [])].sort((left, right) =>
      left.id.localeCompare(right.id),
    );

    for (const handler of sortedHandlers) {
      this.handlersById.set(handler.id, handler);
    }

    this.enabled = input.lifecycle?.enabled ?? false;

    for (const persona of input.personas) {
      const resolvedHandlers = (persona.lifecycle?.subscriptions ?? [])
        .map((attachment) => {
          const handler = this.handlersById.get(attachment.handler);
          if (!handler) {
            throw new LifecycleError(
              `Lifecycle registry constructed with missing handler "${attachment.handler}"`,
            );
          }

          return {
            persona: persona.name,
            priority: attachment.priority,
            handler,
            identity: toHandlerIdentity(handler),
            subscription: attachment.subscription,
            budget: attachment.budget ?? handler.budget,
            failurePolicy:
              attachment.failurePolicy ??
              handler.failurePolicy ??
              defaultFailurePolicyForMode(handler.mode),
          } satisfies ResolvedLifecycleHandler;
        })
        .sort(compareResolvedHandlers);

      this.personaHandlers.set(persona.name, resolvedHandlers);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  listHandlers(): LifecycleHandlerContract[] {
    return [...this.handlersById.values()];
  }

  getHandler(handlerId: string): LifecycleHandlerContract | undefined {
    return this.handlersById.get(handlerId);
  }

  listPersonaHandlers(persona: string): ResolvedLifecycleHandler[] {
    return [...(this.personaHandlers.get(persona) ?? [])];
  }

  resolveEventHandlers(query: LifecycleEventResolutionQuery): ResolvedLifecycleHandler[] {
    if (!this.enabled) {
      return [];
    }

    const resolvedHandlers = this.personaHandlers.get(query.persona) ?? [];

    return resolvedHandlers.filter((handler) => {
      if (handler.subscription.kind !== 'event') {
        return false;
      }

      const matchesEvent = handler.subscription.events.some(
        (event: LifecycleEventContract) => event.type === query.eventType,
      );

      return (
        matchesEvent &&
        matchesFilter(handler.subscription.filter, {
          persona: query.persona,
          itemOrigin: query.itemOrigin,
          itemType: query.itemType,
          channel: query.channel,
          messageSource: query.messageSource,
          scheduleSource: query.scheduleSource,
        })
      );
    });
  }

  resolveSignalHandlers(query: LifecycleSignalResolutionQuery): ResolvedLifecycleHandler[] {
    if (!this.enabled) {
      return [];
    }

    const resolvedHandlers = this.personaHandlers.get(query.persona) ?? [];

    return resolvedHandlers.filter((handler) => {
      if (handler.subscription.kind !== 'signal') {
        return false;
      }

      const matchesSignal = handler.subscription.signals.some(
        (signal: LifecycleSignalContract) => signal.type === query.signalType,
      );

      return (
        matchesSignal &&
        matchesFilter(handler.subscription.filter, {
          persona: query.persona,
          itemOrigin: query.itemOrigin,
          itemType: query.itemType,
          channel: query.channel,
          messageSource: query.messageSource,
          scheduleSource: query.scheduleSource,
        })
      );
    });
  }

  resolveInterceptorHandlers(query: LifecycleInterceptorResolutionQuery): ResolvedLifecycleHandler[] {
    if (!this.enabled) {
      return [];
    }

    const resolvedHandlers = this.personaHandlers.get(query.persona) ?? [];

    return resolvedHandlers.filter((handler) => {
      if (handler.subscription.kind !== 'interceptor') {
        return false;
      }

      const matchesHook = handler.subscription.interceptors.some(
        (interceptor: LifecycleInterceptorContract) => interceptor.hook === query.hook,
      );

      return (
        matchesHook &&
        matchesFilter(handler.subscription.filter, {
          persona: query.persona,
          itemOrigin: query.itemOrigin,
          itemType: query.itemType,
          channel: query.channel,
          messageSource: query.messageSource,
          scheduleSource: query.scheduleSource,
        })
      );
    });
  }
}

export function createLifecycleHandlerRegistry(
  input: LifecycleRegistryInput,
): Result<LifecycleHandlerRegistry, LifecycleError> {
  const issues = collectLifecycleValidationIssues(input);
  if (issues.length > 0) {
    return err(new LifecycleError(formatValidationIssues(issues)));
  }

  return ok(new LifecycleHandlerRegistry(input));
}
