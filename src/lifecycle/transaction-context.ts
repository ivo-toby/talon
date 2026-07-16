/** Opaque capability passed only to a LifecycleEventBus transaction callback. */

/**
 * This class deliberately exposes no lifecycle methods. LifecycleEventBus keeps
 * the authentic context state in a module-private WeakMap, so lookalikes,
 * proxies, and shadowed properties cannot grant transaction authority.
 */
export class TransactionContext {}
