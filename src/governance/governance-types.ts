/**
 * Shared types for the runtime governance subsystem.
 */

export type GovernanceViolationType = 'rate_limit' | 'spending_cap' | 'loop_detection';
export type GovernanceActionTaken = 'allowed' | 'warned' | 'blocked';

export interface GovernanceCheckResult {
  allowed: boolean;
  violation?: GovernanceViolationType;
  detail?: Record<string, unknown>;
}

export interface BudgetStatus {
  withinBudget: boolean;
  percentUsed: number;
  warningTriggered: boolean;
  tokensUsed: number;
  cap: number;
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export type GovernanceError = {
  reason: GovernanceViolationType;
  message: string;
};
