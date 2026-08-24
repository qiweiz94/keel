import type { KeelRule, EnforceInput } from '../types.js'
import { PersistentBudgetStore, type PersistedBudgetState } from './budget-store.js'
import { writeHaltSentinel, defaultHaltPath } from './halt-writer.js'

/**
 * One measurement of cumulative session spend, from WHATEVER host-specific
 * source produced it (a Claude Code transcript line sum — see
 * budget/claude-transcript.ts — or an OpenCode `session` table row — see
 * budget/opencode-db.ts). `BudgetTracker.record()` is deliberately
 * source-agnostic: it never reads a transcript or a database itself, only
 * this already-computed shape, which is what lets one tracker/store serve
 * both host implementations without either knowing about the other.
 */
export interface BudgetSpend {
  /** Sum of every token-cost field the source exposes (input + output + cache-creation + cache-read + thinking, where present). */
  tokens: number
  /**
   * Dollar figure, or `null` when not fully confident — see
   * `dollarsConfident`. NEVER a partial/undercounted total presented as
   * the true one.
   */
  dollars: number | null
  /**
   * True only when EVERY contributing usage line/row had a resolvable
   * price (Claude Code: every model string matched a known pricing entry;
   * OpenCode: the source's own `cost` column was present and numeric). A
   * single unrecognized model anywhere in the session makes this false
   * for the WHOLE measurement, per types.ts's `max_dollars` comment.
   */
  dollarsConfident: boolean
  /**
   * True when the source could not be read AT ALL (missing/unreadable
   * transcript, unreachable database, ...) — `tokens`/`dollars` are
   * meaningless (0/null) on this shape when this is true; `record()`
   * never lets a `true` here overwrite a PRIOR real measurement's
   * over-budget flag with a false "0 spend, under budget" reading.
   */
  unavailable: boolean
  /** Every model string encountered that had no pricing-table match (diagnostic only; empty when every model resolved or unavailable is true). */
  unrecognizedModels: string[]
}

const unavailableSpend = (): BudgetSpend => ({
  tokens: 0, dollars: null, dollarsConfident: false, unavailable: true, unrecognizedModels: [],
})

/** The verdict `checkDeny()` hands back to `pipeline.ts`'s `type: budget` PreToolUse branch — non-null means "call violation() with this message." */
export interface BudgetDenyState {
  message: string
}

/**
 * BudgetTracker — the runtime companion to `PersistentBudgetStore`,
 * mirroring `StuckTracker`'s split (in-memory-friendly wrapper class over
 * a disk-backed store) but with a narrower contract: no in-memory fast
 * path, because both of this rule's read sites (`checkDeny` on every
 * PreToolUse call, `record` after every measurement) are already O(1)
 * single-key disk reads/writes, the same cost `StuckTracker`'s persisted
 * variant already pays.
 *
 * TWO-PHASE BY CONSTRUCTION — this is the whole point of splitting
 * `checkDeny` (read-only, called from `evaluate()`) from `record`
 * (write-only, called from a Stop/PostToolUse-equivalent hook OUTSIDE
 * `evaluate()`): `checkDeny` NEVER touches a transcript or a spend
 * measurement, only the persisted flag `record` already wrote. Claude
 * Code's Stop hook is architecturally observe-only (confirmed in
 * docs/integration-guides/claude-code.md — "it records, it never
 * blocks... the turn is already complete"), so there is no tool call left
 * on that call to deny; the only race-free enforcement point is the NEXT
 * PreToolUse call, gated on state that already settled. This is the exact
 * "warn on first violation, persisted state blocks on repeat" shape every
 * other deny rule in this codebase already uses.
 */
export class BudgetTracker {
  private readonly store: PersistentBudgetStore
  private readonly haltWriter: (haltPath: string, reason: string) => void
  private readonly haltFile: string

  /**
   * `haltWriter` defaults to the real `writeHaltSentinel` (writes the
   * sentinel via a caller-supplied path — see halt-writer.ts) but is
   * INJECTABLE specifically so a test can assert the hard-stop escalation
   * decision (does this measurement cross the threshold, is the rule
   * actually enforcing) fired or didn't, WITHOUT ever writing to a real
   * home directory — this codebase's own `override-isolation-guard.ts`
   * exists because a test that forgets an equivalent stub for a DIFFERENT
   * sentinel file (overrides.json) silently corrupted the developer's real
   * `~/.keel` before; this constructor parameter is how `type: budget`'s
   * tests avoid repeating that mistake for HALTED specifically.
   *
   * `haltFile` defaults to `defaultHaltPath()` (the real
   * `~/.keel/HALTED`) but callers constructing a pipeline against an
   * isolated `KEEL_HOME`/test path MUST pass the same path
   * `PipelineConfig.haltFile`/`checkHalt()` resolve to, or a
   * hard_stop_multiplier escalation would write to the wrong sentinel —
   * see halt-writer.ts's own header comment for the full hazard.
   */
  constructor(
    store: PersistentBudgetStore = new PersistentBudgetStore(),
    haltWriter: (haltPath: string, reason: string) => void = writeHaltSentinel,
    haltFile: string = defaultHaltPath(),
  ) {
    this.store = store
    this.haltWriter = haltWriter
    this.haltFile = haltFile
  }

  private key(rule: KeelRule, input: EnforceInput): string {
    return `budget:${rule.id}:${input.session_id || 'unknown'}:${input.cwd}`
  }

  /**
   * Read-only check for the PreToolUse blocking path. Returns a deny
   * signal only when the LAST measurement confirmed the session over
   * budget — never derives that from anything read on this call.
   */
  checkDeny(rule: KeelRule, input: EnforceInput): BudgetDenyState | null {
    const state = this.store.get(this.key(rule, input))
    if (!state || !state.overBudget) return null
    const spendDesc = state.dollarsConfident && state.spendDollars !== null
      ? `${state.spendTokens.toLocaleString()} tokens (~$${state.spendDollars.toFixed(2)})`
      : `${state.spendTokens.toLocaleString()} tokens (dollar figure unavailable — see rationale)`
    const staleness = state.unavailable
      ? ' The most recent measurement attempt could not read spend data; this reflects the last CONFIRMED measurement, not a fresh read.'
      : ''
    return { message: `${rule.message} Last confirmed spend: ${spendDesc}.${staleness}` }
  }

  /**
   * Record a fresh spend measurement, called OUTSIDE evaluate() — see this
   * class's own header. Updates the persisted over-budget flag for `rule`
   * against `input`'s session/cwd.
   *
   * `spend.unavailable === true` is handled specially: this is point 5's
   * "never silently report under budget when the transcript can't be
   * read" — a failed read must NEVER reset a prior over-budget flag to
   * false (that would read as "confirmed under budget" when nothing was
   * actually confirmed), so an unavailable measurement carries the
   * PREVIOUS state's overBudget/spend fields forward unchanged and only
   * flips `unavailable: true` — a loud, inspectable degraded-state signal
   * distinct from either verdict, never a silently-passed one.
   */
  record(rule: KeelRule, input: EnforceInput, spend: BudgetSpend): void {
    if (rule.max_tokens === undefined && rule.max_dollars === undefined) return
    const key = this.key(rule, input)

    if (spend.unavailable) {
      const prior = this.store.get(key)
      this.store.set(key, {
        overBudget: prior?.overBudget ?? false,
        measuredAt: Date.now(),
        spendTokens: prior?.spendTokens ?? 0,
        spendDollars: prior?.spendDollars ?? null,
        dollarsConfident: prior?.dollarsConfident ?? false,
        unavailable: true,
        reason: prior
          ? `Spend data unreadable on this measurement attempt — carrying forward the last confirmed reading (${prior.spendTokens.toLocaleString()} tokens).`
          : 'Spend data unreadable and no prior confirmed measurement exists for this session — budget enforcement is degraded to observe-only until a read succeeds.',
      })
      return
    }

    const overByTokens = rule.max_tokens !== undefined && spend.tokens > rule.max_tokens
    const overByDollars = rule.max_dollars !== undefined && spend.dollarsConfident
      && spend.dollars !== null && spend.dollars > rule.max_dollars
    const overBudget = overByTokens || overByDollars

    const state: PersistedBudgetState = {
      overBudget,
      measuredAt: Date.now(),
      spendTokens: spend.tokens,
      spendDollars: spend.dollars,
      dollarsConfident: spend.dollarsConfident,
      unavailable: false,
      reason: overBudget
        ? `Measured spend ${spend.tokens.toLocaleString()} tokens${overByTokens ? ` exceeds max_tokens (${rule.max_tokens})` : ''}${overByTokens && overByDollars ? ' and' : ''}${overByDollars ? ` $${spend.dollars?.toFixed(2)} exceeds max_dollars (${rule.max_dollars})` : ''}.`
        : `Measured spend ${spend.tokens.toLocaleString()} tokens — within budget.`,
    }
    this.store.set(key, state)

    // Escalation terminal step (types.ts's `hard_stop_multiplier`
    // comment): only ever fires for a rule that is actually ENFORCING
    // (mode !== 'observe'). A `mode: observe` rule — what the shipped
    // default ships as — must be structurally incapable of writing the
    // HALTED sentinel: `cli/halt.ts`'s own header comment names exactly
    // this hazard ("a false positive on an unbuilt rule would latch
    // deny-everything until a human runs `keel resume`"), and an observe
    // rule is by definition unproven against real traffic.
    if (overBudget && rule.mode !== 'observe' && rule.hard_stop_multiplier !== undefined) {
      const tokenMultiple = rule.max_tokens ? spend.tokens / rule.max_tokens : 0
      const dollarMultiple = rule.max_dollars && spend.dollarsConfident && spend.dollars !== null
        ? spend.dollars / rule.max_dollars : 0
      if (tokenMultiple >= rule.hard_stop_multiplier || dollarMultiple >= rule.hard_stop_multiplier) {
        this.haltWriter(
          this.haltFile,
          `keel halted by rule "${rule.id}": spend reached ${rule.hard_stop_multiplier}x its configured budget ceiling (${spend.tokens.toLocaleString()} tokens). Run 'keel resume' after reviewing.`,
        )
      }
    }
  }
}
