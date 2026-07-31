/**
 * Re-export shim — imports the engine from core source.
 * The build script copies core/src into this directory first,
 * so tsc finds policy-engine.ts locally.
 */
export {
  PolicyEngine,
  DEFAULT_POLICY,
  DEFAULT_POLICY_YAML,
  SECRET_ENV_PATTERNS,
} from './core/policy-engine.js'
