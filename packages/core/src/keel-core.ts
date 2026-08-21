// keel-core — Single entry point for the plugin bundle.
// Bundled into keel-core.mjs for in-process enforcement in OpenCode plugin.
// Exports everything the v2 plugin needs to run in-process.

export { resolveHome } from './home.js'
export { EnforcementPipeline } from './enforce/pipeline.js'
export type { PipelineConfig, PipelineTier } from './enforce/pipeline.js'
export { ActionCache, ContentTracker } from './enforce/cache.js'
export { SequenceDetector } from './enforce/sequencer.js'
export { FlowTracker } from './enforce/flow-tracker.js'
export { PersistentFlowStore, FLOW_TAG_TTL_MS, type PersistedFlowTag } from './enforce/flow-store.js'
export { StuckTracker } from './enforce/stuck-tracker.js'
export { PersistentStuckStore, STUCK_STATE_MAX_WINDOW_MS, type PersistedStuckState } from './enforce/stuck-store.js'
export { OscillationTracker, type OscillationEscalation } from './enforce/oscillation-tracker.js'
export { PersistentOscillationStore, OSCILLATION_STATE_MAX_WINDOW_MS, type PersistedOscillationState, type OscillationEntry } from './enforce/oscillation-store.js'
export { SessionTracker } from './enforce/session-tracker.js'
export type { SessionDimension, SessionEscalationStep, SessionTripEscalation } from './enforce/session-tracker.js'
export { PersistentSessionStore, SESSION_STATE_MAX_AGE_MS, type PersistedSessionState } from './enforce/session-store.js'
export { writeHaltSentinel, defaultHaltPath } from './enforce/halt-writer.js'
export { BudgetTracker, type BudgetSpend, type BudgetDenyState } from './enforce/budget-tracker.js'
export { PersistentBudgetStore, BUDGET_STATE_MAX_AGE_MS, type PersistedBudgetState } from './enforce/budget-store.js'
export { measureOpenCodeSpend } from './enforce/budget/opencode-db.js'
export { ResearchTracker } from './enforce/research-tracker.js'
export { ProblemLedger, problemKey } from './enforce/problem-ledger.js'
export { detectClaim, extractCommandMessages } from './enforce/claim.js'
export type { ClaimMatch } from './enforce/claim.js'
export { commandFingerprint, nearIdentical } from './enforce/command-fingerprint.js'
export { AuditLog } from './enforce/audit.js'
export { Suggester } from './enforce/suggester.js'
export { createReceipt } from './receipts.js'
export { verifyFileSyntax, isVerifiableFile } from './file-verify.js'
export {
  parseRulesFile,
  parseRulesContent,
  loadRuleHierarchy,
  mergeRules,
  detectConflicts,
  validateRules,
  hashRulesFile,
} from './enforce/rule-parser.js'
export { FileRuleOverrideStore } from './enforce/overrides.js'
export { projectAuditArgs, sanitizeAuditValue, sanitizeReasoning } from './enforce/audit-redaction.js'
export type { ParsedRules, RuleHierarchy, RuleConflict } from './enforce/rule-parser.js'
export { ContextManager } from './enforce/context-manager.js'
export { StateManager } from './enforce/state-manager.js'
export type {
  KeelConfig, KeelRule, EnforceInput, EnforceResult,
  EnforcementAction, ProtectionLevel, RuleContext, RuleType,
  AuditEntry, Suggestion, ProjectInsights,
  SequenceStep, FixTransform, CacheConfig,
} from './types.js'
