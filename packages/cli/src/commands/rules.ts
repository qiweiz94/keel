import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import chalk from 'chalk'
import { homedir } from 'node:os'
import { HARNESS_RULES_YAML } from './harness-rules.js'

type DetectionLane = 'enforce' | 'alert' | 'hunt'

const LANE_PRIORITY: Record<DetectionLane, number> = { enforce: 0, alert: 1, hunt: 2 }
const SEVERITY_MAP: Record<string, 'block' | 'warn' | 'prompt'> = { critical: 'block', high: 'block', medium: 'warn', low: 'warn' }

interface ATRCategory {
  title: string; id: string; description: string; severity: string; lane: string
  detection: { selection: Array<{ type?: string; pattern?: string; field?: string }> }
}

function mapATRToRule(atr: ATRCategory): Record<string, unknown> | null {
  const action = SEVERITY_MAP[atr.severity] || 'warn'
  const regexPatterns: string[] = []
  for (const sel of atr.detection.selection) {
    if (sel.pattern) regexPatterns.push(sel.pattern)
  }
  const cmdPatterns = regexPatterns.map(p => ({ regex: p }))
  return {
    name: atr.title.slice(0, 60),
    action,
    message: 'ATR: ' + (atr.description.slice(0, 120) || atr.title),
    lane: atr.severity === 'critical' ? 'enforce' : atr.severity === 'high' ? 'alert' : 'hunt',
    patterns: cmdPatterns,
  }
}

const ATR_CATEGORIES: ATRCategory[] = [
  { title: 'Prompt Injection Detection', id: 'ATR-PI-001', description: 'Detects attempted prompt injection — hidden instructions overriding safety guidelines', severity: 'critical', lane: 'enforce', detection: { selection: [{ type: 'regex', pattern: 'ignore.*(?:previous|all|above)\\s+instructions' }, { type: 'regex', pattern: '(?:forget|ignore|disregard).*(?:rules|instructions|constraints)' }] } },
  { title: 'Authority Override Attempt', id: 'ATR-PI-002', description: 'Detects attempts to override system authority', severity: 'high', lane: 'enforce', detection: { selection: [{ type: 'regex', pattern: 'you are (?:now|from now on).*(?:admin|root|superuser)' }] } },
  { title: 'System Prompt Extraction', id: 'ATR-PI-003', description: 'Detects attempts to extract the system prompt', severity: 'high', lane: 'enforce', detection: { selection: [{ type: 'regex', pattern: '(?:print|output|show|reveal|display).*(?:system|initial|original).*(?:prompt|instruction|message)' }] } },
  { title: 'Tool Poisoning Detection', id: 'ATR-TP-001', description: 'Detects tool poisoning via hidden instructions in tool descriptions', severity: 'critical', lane: 'enforce', detection: { selection: [{ type: 'regex', pattern: 'when\\s+you\\s+(?:see|read|find)' }, { type: 'regex', pattern: 'secretly|silently|without\\s+telling' }] } },
  { title: 'Tool Shadowing Detection', id: 'ATR-TP-002', description: 'Detects when tool descriptions mimic other tools', severity: 'high', lane: 'alert', detection: { selection: [{ type: 'regex', pattern: 'same as|identical to|like the.*tool' }] } },
  { title: 'Credential Exfiltration', id: 'ATR-CE-001', description: 'Prevents AI agents from exfiltrating credentials', severity: 'critical', lane: 'enforce', detection: { selection: [{ type: 'regex', field: 'command', pattern: 'curl.*--data.*(?:password|api_key|secret)' }] } },
  { title: 'Data Exfiltration via Network', id: 'ATR-CE-002', description: 'Detects sending data to external endpoints', severity: 'high', lane: 'alert', detection: { selection: [{ type: 'regex', field: 'command', pattern: 'curl.*\\b(?:POST|PUT|PATCH)\\b.*(?:http|https)' }] } },
  { title: 'Unsafe Code Execution', id: 'ATR-UCE-001', description: 'Blocks download and execution of untrusted code', severity: 'high', lane: 'enforce', detection: { selection: [{ type: 'regex', field: 'command', pattern: 'curl.*\\|.*(?:bash|sh|sudo)' }] } },
  { title: 'Remote Script Download', id: 'ATR-UCE-002', description: 'Detects downloading scripts from remote sources', severity: 'medium', lane: 'alert', detection: { selection: [{ type: 'regex', field: 'command', pattern: 'curl.*-o.*\\.(?:py|sh|pl|rb|js)' }] } },
  { title: 'Privilege Escalation', id: 'ATR-PE-001', description: 'Detects privilege escalation attempts', severity: 'high', lane: 'enforce', detection: { selection: [{ type: 'regex', field: 'command', pattern: 'sudo\\s+chmod\\s+777' }, { type: 'regex', field: 'command', pattern: 'sudo\\s+chown' }] } },
  { title: 'SUID Binary Creation', id: 'ATR-PE-002', description: 'Detects creation of SUID binaries', severity: 'high', lane: 'enforce', detection: { selection: [{ type: 'regex', field: 'command', pattern: 'chmod\\s+[46]?[46]55' }] } },
  { title: 'Excessive Autonomy', id: 'ATR-EA-001', description: 'Detects agents operating outside authorized scope', severity: 'medium', lane: 'alert', detection: { selection: [{ type: 'regex', field: 'command', pattern: 'git\\s+push\\s+--force' }, { type: 'regex', field: 'command', pattern: 'npm\\s+publish' }] } },
  { title: 'Infrastructure Modification', id: 'ATR-EA-002', description: 'Detects modification of cloud/infrastructure resources', severity: 'medium', lane: 'alert', detection: { selection: [{ type: 'regex', field: 'command', pattern: 'terraform\\s+(apply|destroy)' }, { type: 'regex', field: 'command', pattern: 'aws\\s+(?:s3|ec2|iam|lambda)\\s+(?:rm|delete|update)' }] } },
  { title: 'Agent Manipulation', id: 'ATR-AM-001', description: 'Detects social engineering against the agent', severity: 'high', lane: 'alert', detection: { selection: [{ type: 'regex', pattern: 'this is (?:a test|just a test|for research)' }, { type: 'regex', pattern: 'you must (?:do this|help me|comply).*(?:for|because|since)' }] } },
  { title: 'Urgency Manipulation', id: 'ATR-AM-002', description: 'Detects urgency framing to bypass safety review', severity: 'medium', lane: 'hunt', detection: { selection: [{ type: 'regex', pattern: '(?:urgent|immediately|asap|critical).*(?:do|run|execute|delete)' }] } },
  { title: 'Model Abuse via Resource Exhaustion', id: 'ATR-MA-001', description: 'Detects attempts to exhaust model resources', severity: 'medium', lane: 'hunt', detection: { selection: [{ type: 'regex', pattern: 'repeat.*(?:this|above|below).*100' }] } },
  { title: 'Model Security', id: 'ATR-MS-001', description: 'Detects attempts to read or modify model configuration files', severity: 'high', lane: 'enforce', detection: { selection: [{ type: 'regex', field: 'command', pattern: 'cat.*model.*config|cat.*\\.gguf' }] } },
  { title: 'Data Poisoning Attempt', id: 'ATR-DP-001', description: 'Detects attempts to inject malicious data into training', severity: 'critical', lane: 'enforce', detection: { selection: [{ type: 'regex', pattern: 'poison|backdoor|trigger.*(?:data|sample|input)' }] } },
  { title: 'Fine-Tuning Manipulation', id: 'ATR-DP-002', description: 'Detects unauthorized fine-tuning pipeline changes', severity: 'high', lane: 'alert', detection: { selection: [{ type: 'regex', field: 'command', pattern: '.*(?:finetune|training).*--(?:override|force|unsafe)' }] } },
]

/**
 * `keel rules harness` — emit the problem-solving rules for pasting.
 *
 * A default install writes only destructive-command guards, so the
 * `stuck` / `research` / `diagnosis` types that exist to stop an agent
 * circling are never actually enabled. This prints them, and first
 * reports what they would have caught in the local trace history — the
 * point being to show evidence rather than ask for trust.
 */
async function printHarnessRules() {
  console.log(chalk.bold.cyan('\n  ⚓ keel problem-solving rules\n'))

  // Evidence first: what does the existing history actually look like?
  try {
    const { loadTraceEntries, buildReport } = await import('./retrospective.js')
    const report = buildReport(loadTraceEntries(join(homedir(), '.keel', 'traces')))
    const stuck = report.sessions.filter(s => s.stuck_loops > 0)
    if (report.sessions.length) {
      console.log(chalk.dim(`  In your last ${report.sessions.length} sessions:`))
      const loops = report.sessions.reduce((total, s) => total + s.stuck_loops, 0)
      console.log(`    ${chalk.white(String(loops))} repeat loop(s) across ${chalk.white(String(stuck.length))} session(s)`)
      const noResearch = report.sessions.filter(s => s.research_before_solve === false).length
      if (noResearch) console.log(`    ${chalk.white(String(noResearch))} session(s) edited source before any research call`)
      console.log(chalk.dim('    (these rules would have observed exactly those)'))
      console.log()
    }
  } catch { /* evidence is a bonus; never block the paste on it */ }

  console.log(chalk.dim('  Paste into the rules: list of ~/.keel/rules.yaml — keel cannot'))
  console.log(chalk.dim('  edit that file for you, by design.\n'))
  console.log(HARNESS_RULES_YAML)
  console.log(chalk.yellow('  All three are mode: observe — they record, they do not interrupt.'))
  console.log(chalk.dim('  Check what they caught with `keel retrospective`, then change'))
  console.log(chalk.dim('  mode to warn or block once you trust the hit rate.\n'))
}

export async function rulesCommand(
  source: string | undefined,
  options: { output?: string; lane?: string }
) {
  if (!source) {
    console.log(chalk.cyan('\nkeel rules:\n'))
    console.log('  harness        The problem-solving rules: stop circling, research first, root cause')
    console.log('  atr            Import rules from Agent Threat Rules (ATR) format')
    console.log('  Options:')
    console.log('    --output <dir>    Output directory')
    console.log('    --lane <mode>     Detection lane: enforce, alert, or hunt (default: hunt)')
    console.log('  Usage: keel rules harness')
    console.log('         keel rules atr --lane enforce\n')
    return
  }

  if (source === 'harness') {
    await printHarnessRules()
    return
  }

  if (source === 'atr') {
    const activeLane = (options.lane || 'hunt') as DetectionLane
    if (!['enforce', 'alert', 'hunt'].includes(activeLane)) {
      console.log(chalk.red('Invalid lane: ' + activeLane + '. Must be enforce, alert, or hunt.'))
      return
    }

    const activePrio = LANE_PRIORITY[activeLane]
    const filtered = ATR_CATEGORIES.filter(c => LANE_PRIORITY[c.lane as DetectionLane] <= activePrio)
    const rules = filtered.map(mapATRToRule).filter(Boolean) as Record<string, unknown>[]
    const commandRules = rules.filter(r => r.patterns && Array.isArray(r.patterns))

    let yaml = '# keel policy generated from ATR (Agent Threat Rules)\n'
    yaml += '# Source: https://github.com/Agent-Threat-Rule/agent-threat-rules\n'
    yaml += '# Lane: ' + activeLane + ' (' + filtered.length + ' of ' + ATR_CATEGORIES.length + ' categories)\n\n'
    yaml += 'version: "1.0"\nname: "atr-imported-rules"\nsettings:\n  default_action: warn\n  audit_log: true\n\ncommand_rules:\n'

    for (const r of commandRules) {
      yaml += '  - name: "' + r.name + '"\n'
      yaml += '    lane: ' + (r.lane || 'hunt') + '\n'
      yaml += '    patterns:\n'
      for (const p of (r.patterns as Array<{ regex: string }>)) {
        yaml += "      - regex: '" + p.regex.replace(/'/g, "'\\''") + "'\n"
      }
      yaml += '    action: ' + r.action + '\n'
      yaml += '    message: "' + r.message + '"\n\n'
    }

    yaml += '# Detection lanes: enforce (block, ~0.24% FP), alert (notify), hunt (advisory, ~9% FP)\n'
    yaml += '# Current lane: ' + activeLane + '\n'

    if (options.output) {
      const outputPath = options.output
      if (!existsSync(outputPath)) mkdirSync(outputPath, { recursive: true })
      writeFileSync(join(outputPath, 'atr-rules.yaml'), yaml, 'utf-8')
      console.log(chalk.green('Wrote ' + rules.length + ' ATR rules to ' + join(outputPath, 'atr-rules.yaml')))
    } else {
      console.log(yaml)
    }
    return
  }

  console.log(chalk.red('Unknown rules source: ' + source))
  console.log('Usage: keel rules atr [--lane enforce|alert|hunt]')
}
