// Type declarations for @get-keel/opencode-plugin.
// The runtime implementation is built verbatim from
// packages/cli/templates/keel-enforce.js (the canonical plugin source).

export type PluginInput = {
  client: unknown
  project: unknown
  directory?: string
  worktree?: string
  serverUrl?: URL
  $?: unknown
}

export type PluginOptions = Record<string, unknown>

export type ToolExecuteBeforeInput = {
  tool: string
  sessionID: string
  callID: string
}

export type ToolExecuteBeforeOutput = {
  args: Record<string, unknown>
}

export type SystemTransformInput = {
  sessionID?: string
  model: unknown
}

export type SystemTransformOutput = {
  system: string[]
}

export type SessionCompactingInput = {
  sessionID: string
}

export type SessionCompactingOutput = {
  context: string[]
  prompt?: string
}

export type KeelHooks = {
  'tool.execute.before'?: (
    input: ToolExecuteBeforeInput,
    output: ToolExecuteBeforeOutput,
  ) => Promise<void>
  'experimental.chat.system.transform'?: (
    input: SystemTransformInput,
    output: SystemTransformOutput,
  ) => Promise<void>
  'experimental.session.compacting'?: (
    input: SessionCompactingInput,
    output: SessionCompactingOutput,
  ) => Promise<void>
}

export type KeelPlugin = {
  id: string
  server: (input: PluginInput, options?: PluginOptions) => Promise<KeelHooks>
}

declare const plugin: KeelPlugin
export default plugin
