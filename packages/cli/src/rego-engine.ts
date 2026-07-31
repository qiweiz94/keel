/**
 * Optional Rego/WASM policy evaluation engine.
 *
 * Allows policies to be written in OPA Rego language and compiled to WebAssembly
 * for deterministic, sandboxed evaluation (zero token consumption, sub-millisecond).
 *
 * Heavily inspired by Cupcake (github.com/eqtylab/cupcake) which pioneered
 * Rego/WASM for AI coding agent enforcement.
 *
 * Usage:
 *   1. Write a .rego policy file
 *   2. Compile it:  opa build -t wasm -e policy/allow policy.rego
 *   3. Evaluate:     keel policy eval --wasm policy.wasm
 *
 * Dependencies:
 *   - @open-policy-agent/opa-wasm (for WASM evaluation in Node.js)
 *   - opa CLI (for compiling .rego → .wasm, optional at runtime)
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import chalk from 'chalk'

export interface RegoPolicyResult {
  allow: boolean
  deny: boolean
  block: boolean
  warn: boolean
  signals?: Record<string, unknown>
  errors?: string[]
}

export class RegoEngine {
  private wasmModule: WebAssembly.Module | null = null
  private wasmPath: string | null = null
  private policyData: Record<string, unknown> = {}
  private entrypoint: number = 0

  /**
   * Compile a .rego file to .wasm using the OPA CLI.
   * Requires `opa` binary installed on the system.
   */
  compileRego(regoPath: string, outputDir: string): string {
    const outputFile = join(outputDir, 'policy.tar.gz')
    try {
      execSync(`opa build -t wasm -O 2 ${regoPath} -o ${outputFile}`, { stdio: 'pipe' })
      // Extract .wasm from the bundle
      const wasmFile = join(outputDir, 'policy.wasm')
      execSync(`tar -xzf ${outputFile} -C ${outputDir} policy.wasm 2>/dev/null || cp ${outputFile} ${wasmFile}`, { stdio: 'pipe' })
      return wasmFile
    } catch (err) {
      throw new Error('Failed to compile Rego policy. Ensure `opa` CLI is installed: https://openpolicyagent.org/docs/latest/#running-opa\n' + err)
    }
  }

  /**
   * Load a compiled WASM policy file
   */
  async loadWasm(path: string): Promise<void> {
    if (!existsSync(path)) {
      throw new Error('WASM file not found: ' + path)
    }
    this.wasmPath = path
    const wasmBuffer = readFileSync(path)
    this.wasmModule = await WebAssembly.compile(wasmBuffer)
  }

  /**
   * Load JSON data for policy evaluation context
   */
  loadData(dataPath: string): void {
    if (existsSync(dataPath)) {
      this.policyData = JSON.parse(readFileSync(dataPath, 'utf-8'))
    }
  }

  /**
   * Evaluate an action against the loaded Rego policy.
   * Uses actual OPA WASM evaluation via @open-policy-agent/opa-wasm.
   */
  async evaluate(input: Record<string, unknown>): Promise<RegoPolicyResult> {
    if (!this.wasmModule) {
      return { allow: false, deny: true, block: true, warn: false, errors: ['No WASM policy loaded'] }
    }

    try {
      const result = await this.evaluateWasm(input)
      return result
    } catch (err) {
      return {
        allow: false,
        deny: true,
        block: true,
        warn: false,
        errors: ['Rego evaluation error: ' + err],
      }
    }
  }

  /**
   * Evaluate using the real OPA WASM ABI via @open-policy-agent/opa-wasm.
   */
  private async evaluateWasm(input: Record<string, unknown>): Promise<RegoPolicyResult> {
    // Dynamically import opa-wasm (avoids hard dependency)
    let opaWasm: any
    try {
      opaWasm = await import('@open-policy-agent/opa-wasm')
    } catch {
      return { allow: false, deny: true, block: true, warn: false, errors: ['@open-policy-agent/opa-wasm not installed'] }
    }

    // Load the policy from the compiled WASM buffer
    const wasmBuffer = readFileSync(this.wasmPath!)
    const policy = await opaWasm.loadPolicy(wasmBuffer)

    // Set data if available
    if (Object.keys(this.policyData).length > 0) {
      policy.setData(this.policyData)
    }

    // Evaluate the input against the policy
    const result = policy.evaluate(input)

    // Parse the result — OPA returns an array of result sets
    // Each result has expressions with values
    const output: RegoPolicyResult = {
      allow: true,
      deny: false,
      block: false,
      warn: false,
    }

    if (Array.isArray(result) && result.length > 0) {
      for (const resultSet of result) {
        if (resultSet.result) {
          const val = resultSet.result
          if (val.deny === true || val.block === true) {
            output.allow = false
            output.deny = val.deny === true
            output.block = val.block === true
          }
          if (val.warn === true) {
            output.warn = true
          }
        }
      }
    }

    return output
  }

  /**
   * Check if the OPA CLI is available for policy compilation
   */
  static isOpaInstalled(): boolean {
    try {
      execSync('opa version', { stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  }
}

export async function policyBuildCommand(regoFile: string, options: { output?: string }) {
  if (!RegoEngine.isOpaInstalled()) {
    console.log(chalk.red('OPA CLI not found. Install from: https://openpolicyagent.org/docs/latest/#running-opa'))
    return
  }

  const outputDir = options.output || '.'
  const engine = new RegoEngine()
  try {
    const wasmPath = engine.compileRego(regoFile, outputDir)
    console.log(chalk.green('Compiled ' + regoFile + ' → ' + wasmPath))
  } catch (err) {
    console.log(chalk.red(String(err)))
  }
}

export async function policyEvalCommand(wasmFile: string, options: { input?: string }) {
  const engine = new RegoEngine()
  try {
    await engine.loadWasm(wasmFile)
  } catch (err) {
    console.log(chalk.red(String(err)))
    return
  }

  const input = options.input ? JSON.parse(readFileSync(options.input, 'utf-8')) : { tool_name: 'bash', command: 'rm -rf /' }
  const result = await engine.evaluate(input)
  console.log(JSON.stringify(result, null, 2))
}

export async function policyInitCommand() {
  const exampleRego = `package keel_policy

# Default: allow all actions
default allow := true
default deny := false
default block := false

# Block destructive commands
deny if {
    cmd := input.command
    startswith(cmd, "rm -rf /")
}
block if {
    cmd := input.command
    startswith(cmd, "rm -rf /")
}

# Block git hook bypass
deny if {
    cmd := input.command
    contains(cmd, "--no-verify")
}

# Warn on sudo usage
warn if {
    cmd := input.command
    contains(cmd, "sudo ")
}
`

  writeFileSync('policy.rego', exampleRego, 'utf-8')
  console.log(chalk.green('Created policy.rego'))
  console.log(chalk.cyan('Compile with: opa build -t wasm -e keel_policy/allow policy.rego'))
  console.log(chalk.cyan('Or use: keel policy build policy.rego'))
}
