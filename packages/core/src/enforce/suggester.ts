import type { AuditEntry, Suggestion, ProjectInsights, KeelRule, ProtectionLevel } from '../types.js'

/**
 * Learning layer — analyzes audit trail data and generates
 * suggestions for rule improvements. NEVER modifies rules directly.
 */
export class Suggester {
  /**
   * Analyze sessions and generate improvement suggestions.
   */
  analyze(entries: AuditEntry[], activeRules: KeelRule[], level: ProtectionLevel): ProjectInsights {
    const sessions = new Set(entries.map(e => e.session_id))
    const totalToolCalls = entries.length
    const denies = entries.filter(e => e.action === 'deny')
    const warns = entries.filter(e => e.action === 'warn')
    const falsePositives = entries.filter(e => e.action === 'deny' && (e.message || '').includes('--once'))

    // Find most-fired rules
    const ruleFireCount = new Map<string, number>()
    for (const e of denies) {
      if (e.rule_id) {
        ruleFireCount.set(e.rule_id, (ruleFireCount.get(e.rule_id) || 0) + 1)
      }
    }
    const mostFired = Array.from(ruleFireCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([rule_id, count]) => ({ rule_id, count }))

    // Find overridden rules (deny followed by user override)
    const overrideCount = new Map<string, number>()
    for (const e of entries) {
      if (e.rule_id && (e.message || '').includes('--once') && e.action === 'allow') {
        overrideCount.set(e.rule_id, (overrideCount.get(e.rule_id) || 0) + 1)
      }
    }
    const mostIgnored = Array.from(overrideCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([rule_id, count]) => ({ rule_id, count }))

    // Violation hotspots by token range
    const hotspotRanges = ['0-4K', '4K-8K', '8K-16K', '16K-32K', '32K-64K', '64K+']
    const violationsByTokens = new Map<string, number>()
    for (const e of denies) {
      const tokens = e.context_tokens ?? 0
      let range = '64K+'
      if (tokens < 4000) range = '0-4K'
      else if (tokens < 8000) range = '4K-8K'
      else if (tokens < 16000) range = '8K-16K'
      else if (tokens < 32000) range = '16K-32K'
      else if (tokens < 64000) range = '32K-64K'
      violationsByTokens.set(range, (violationsByTokens.get(range) || 0) + 1)
    }
    const violationHotspots = Array.from(violationsByTokens.entries())
      .sort((a, b) => hotspotRanges.indexOf(a[0]) - hotspotRanges.indexOf(b[0]))
      .map(([token_range, count]) => ({ token_range, count }))

    // Generate suggestions
    const suggestions: Suggestion[] = []
    const sessionsAnalyzed = sessions.size

    // Suggest downgrading rules with high override rates
    for (const [ruleId, count] of overrideCount) {
      const totalDenies = ruleFireCount.get(ruleId) || 1
      const ratio = count / totalDenies
      if (ratio > 0.5 && totalDenies >= 3) {
        suggestions.push({
          type: 'modify_rule',
          rule_id: ruleId,
          current_value: 'deny',
          suggested_value: 'warn',
          reason: `Rule "${ruleId}" is overridden ${count}/${totalDenies} times (${Math.round(ratio * 100)}%). Consider downgrading from deny → warn.`,
          confidence: ratio > 0.8 ? 'high' : 'medium',
          evidence: {
            sessions_observed: sessionsAnalyzed,
            violations_count: totalDenies,
            false_positive_count: count,
            override_count: count,
          },
        })
      }
    }

    // Suggest adding exceptions for rules with false positives
    for (const e of denies) {
      if ((e.message || '').includes('npm install') && e.rule_id === 'no-external-network') {
        suggestions.push({
          type: 'add_exception',
          rule_id: e.rule_id,
          suggested_value: 'Add registry.npmjs.org to except list',
          reason: 'Network rule blocks npm install. Add registry.npmjs.org to except list to allow package downloads.',
          confidence: 'high',
          evidence: {
            sessions_observed: sessionsAnalyzed,
            violations_count: denies.filter(d => d.rule_id === e.rule_id).length,
            false_positive_count: 0,
            override_count: 0,
          },
        })
        break
      }
    }

    // Suggest cache tuning
    const cacheHits = entries.filter(e => e.cache_hit).length
    const cacheEfficiency = totalToolCalls > 0 ? cacheHits / totalToolCalls : 0
    if (cacheEfficiency < 0.5 && totalToolCalls > 100) {
      suggestions.push({
        type: 'cache_tune',
        reason: `Cache hit rate is ${Math.round(cacheEfficiency * 100)}%. Consider enabling persistent cache or increasing cache size.`,
        confidence: 'medium',
        evidence: {
          sessions_observed: sessionsAnalyzed,
          violations_count: 0,
          false_positive_count: 0,
          override_count: 0,
        },
      })
    }

    // Suggest level adjustment
    if (level === 'protect') {
      const protectOnlyViolations = entries.filter(e => e.level === 'protect' && e.action === 'deny')
      if (protectOnlyViolations.length === 0 && sessionsAnalyzed >= 3) {
        suggestions.push({
          type: 'adjust_level',
          current_value: 'protect',
          suggested_value: 'balanced',
          reason: 'No violations caught in protect mode that balanced wouldn\'t catch. Consider downgrading to balanced for better performance.',
          confidence: 'medium',
          evidence: {
            sessions_observed: sessionsAnalyzed,
            violations_count: 0,
            false_positive_count: 0,
            override_count: 0,
          },
        })
      }
    }

    // Suggest new rules based on common action patterns
    const toolFrequency = new Map<string, number>()
    for (const e of entries) {
      const toolName = e.tool || e.tool_name || 'unknown'
      toolFrequency.set(toolName, (toolFrequency.get(toolName) || 0) + 1)
    }
    const activeToolCalls = totalToolCalls
    if (activeToolCalls > 50) {
      const topTool = Array.from(toolFrequency.entries()).sort((a, b) => b[1] - a[1])[0]
      if (topTool && topTool[1] > activeToolCalls * 0.3) {
        // A tool is used very frequently — suggest a rate limit
        const existingRateRules = activeRules.filter(r => r.type === 'rate' && r.match === topTool[0])
        if (existingRateRules.length === 0) {
          suggestions.push({
            type: 'add_rule',
            suggested_value: `Add rate limit for "${topTool[0]}" (used ${topTool[1]} times)`,
            reason: `"${topTool[0]}" is the most frequently called tool (${topTool[1]} calls). Consider adding a rate limit to prevent runaway behavior.`,
            confidence: 'low',
            evidence: {
              sessions_observed: sessionsAnalyzed,
              violations_count: 0,
              false_positive_count: 0,
              override_count: 0,
            },
          })
        }
      }
    }

    return {
      sessions_analyzed: sessionsAnalyzed,
      total_tool_calls: totalToolCalls,
      total_denies: denies.length,
      total_warns: warns.length,
      false_positives_reported: falsePositives.length,
      most_fired_rules: mostFired,
      most_ignored_rules: mostIgnored,
      suggested_rules: suggestions,
      cache_efficiency: cacheEfficiency,
      violation_hotspots: violationHotspots,
    }
  }
}
