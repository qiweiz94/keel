import type { KeelRule, EnforceInput } from '../types.js'

interface ActionRecord {
  tool: string
  args: Record<string, unknown>
  timestamp: number
}

/**
 * Sliding window sequence detector.
 *
 * Tracks recent actions and checks if any forbidden sequence is completed.
 * "After reading .env, don't call external API within 30 seconds"
 */
export class SequenceDetector {
  private history: ActionRecord[] = []
  private windowMs: number

  constructor(windowMs = 60000) {
    this.windowMs = windowMs
  }

  setWindow(windowMs: number): void {
    this.windowMs = Math.max(this.windowMs, windowMs)
    this.prune()
  }

  /**
   * Record an action for sequence tracking.
   */
  record(input: EnforceInput): void {
    this.history.push({
      tool: input.tool,
      args: input.args,
      timestamp: Date.now(),
    })
    this.prune()
  }

  /**
   * Check if the current action completes a forbidden sequence.
   * Returns a message if violated, null if OK.
   */
  check(input: EnforceInput, rule: KeelRule): string | null {
    if (!rule.steps || rule.steps.length < 2) return null

    this.prune()
    const windowSec = rule.sequence_window_seconds || 60
    const cutoff = Date.now() - windowSec * 1000

    // Get recent history within window
    const recent = this.history.filter(r => r.timestamp >= cutoff)

    // Check if the sequence matches
    // The last step should match the current action
    const lastStep = rule.steps[rule.steps.length - 1]
    if (!this.matchesTool(lastStep, input.tool, input.args)) return null

    // The preceding steps should match recent history in order
    const precedingSteps = rule.steps.slice(0, -1)

    // Walk backward through history matching steps
    let historyIdx = recent.length - 1
    for (let stepIdx = precedingSteps.length - 1; stepIdx >= 0; stepIdx--) {
      const step = precedingSteps[stepIdx]
      // Find a matching action going backward
      let found = false
      while (historyIdx >= 0) {
        const record = recent[historyIdx]
        historyIdx--
        if (this.matchesTool(step, record.tool, record.args)) {
          found = true
          break
        }
      }
      if (!found) return null
    }

    // All steps matched in order
    const stepNames = rule.steps.map(s => s.tool).join(' → ')
    return `Sequence detected: ${stepNames} (rule: ${rule.id})`
  }

  private matchesTool(step: { tool: string; path?: string; pattern?: string }, tool: string, args: Record<string, unknown>): boolean {
    if (step.tool.toLowerCase() !== tool.toLowerCase()) return false
    if (step.path) {
      const argPath = String(args.path || args.filePath || args.file || args.dest || '')
      if (!argPath.includes(step.path)) return false
    }
    if (step.pattern) {
      const argStr = JSON.stringify(args)
      if (!argStr.match(new RegExp(step.pattern, 'i'))) return false
    }
    return true
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs
    this.history = this.history.filter(r => r.timestamp >= cutoff)
  }

  clear(): void {
    this.history = []
  }
}
