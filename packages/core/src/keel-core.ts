// keel-core — Single entry point for the plugin bundle.
// Bundled into keel-core.mjs for in-process enforcement in OpenCode plugin.
// Exports everything the v2 plugin needs to run in-process.

export { EnforcementPipeline } from './enforce/pipeline.js'
export type { PipelineConfig, PipelineTier } from './enforce/pipeline.js'
export { ActionCache, ContentTracker } from './enforce/cache.js'
export { SequenceDetector } from './enforce/sequencer.js'
export { FlowTracker } from './enforce/flow-tracker.js'
export { AuditLog } from './enforce/audit.js'
export { Suggester } from './enforce/suggester.js'
export {
  parseRulesFile,
  parseRulesContent,
  loadRuleHierarchy,
  mergeRules,
  detectConflicts,
  hashRulesFile,
} from './enforce/rule-parser.js'
export type { ParsedRules, RuleHierarchy, RuleConflict } from './enforce/rule-parser.js'
export { ContextManager } from './enforce/context-manager.js'
export { StateManager } from './enforce/state-manager.js'
export type {
  KeelConfig, KeelRule, EnforceInput, EnforceResult,
  EnforcementAction, ProtectionLevel, RuleContext, RuleType,
  AuditEntry, Suggestion, ProjectInsights,
  SequenceStep, FixTransform, CacheConfig,
} from './types.js'
