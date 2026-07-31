import type { ProtectionLevel } from '../types.js'

/**
 * Monitors token usage and triggers rule re-injection
 * at strategic thresholds to combat "lost in the middle."
 */
export class ContextManager {
  private tokenCount: number = 0
  private nextThreshold: number
  private thresholds: number[]
  private afterCompaction: boolean = false

  constructor(level?: ProtectionLevel) {
    // More frequent re-injection at higher protection levels
    switch (level) {
      case 'protect':
        this.thresholds = [4000, 8000, 16000, 32000]
        break
      case 'balanced':
        this.thresholds = [8000, 16000, 32000]
        break
      case 'sprint':
        this.thresholds = [16000, 32000]
        break
      default:
        this.thresholds = [8000, 16000, 32000]
    }
    this.nextThreshold = this.thresholds[0]
  }

  /**
   * Report current token usage. Returns true if re-injection is needed.
   */
  reportTokens(count: number): boolean {
    this.tokenCount = count
    if (this.afterCompaction) {
      this.afterCompaction = false
      this.nextThreshold = this.thresholds[0]
      return true
    }
    if (this.tokenCount >= this.nextThreshold) {
      // Advance to next threshold (exponential backoff)
      const idx = this.thresholds.indexOf(this.nextThreshold)
      this.nextThreshold = idx < this.thresholds.length - 1
        ? this.thresholds[idx + 1]
        : Infinity
      return true  // re-injection needed
    }
    return false
  }

  /**
   * Signal that compaction occurred — force re-injection on next report.
   */
  signalCompaction(): void {
    this.afterCompaction = true
  }

  /**
   * Get rules markdown with only the rules relevant to current protection level.
   */
  filterRulesMarkdown(markdown: string, level: ProtectionLevel): string {
    if (!markdown) return ''

    // For sprint mode, only include critical rules (those with level: sprint or no level restriction)
    // For now, return the full markdown — the filtering happens elsewhere
    return markdown
  }

  getTokenCount(): number {
    return this.tokenCount
  }

  getNextThreshold(): number {
    return this.nextThreshold
  }
}
