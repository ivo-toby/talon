/**
 * Shared governance type aliases re-exported for external consumers.
 * Core types (GovernanceError, BudgetStatus, ToolCallRecord) live in governance-service.ts.
 */

export type GovernanceViolationType = 'rate_limit' | 'spending_cap' | 'loop_detection';
export type GovernanceActionTaken = 'blocked' | 'warned';
