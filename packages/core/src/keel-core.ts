// keel-core — Single entry point for the plugin bundle.
// Bundled into keel-core.mjs for in-process enforcement in OpenCode plugin.
// Exports everything the v2 plugin needs to run in-process.

export { EnforcementPipeline } from './enforce/pipeline.js'
export type { PipelineConfig, PipelineTier } from './enforce/pipeline.js'
export { ActionCache, ContentTracker } from './enforce/cache.js'
export { SequenceDetector } from './enforce/sequencer.js'
export { FlowTracker } from './enforce/flow-tracker.js'
export { StuckTracker } from './enforce/stuck-tracker.js'
export { ResearchTracker } from './enforce/research-tracker.js'
export { ProblemLedger, problemKey } from './enforce/problem-ledger.js'
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
