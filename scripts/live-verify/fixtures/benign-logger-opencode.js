// Benign, keel-independent OpenCode plugin for the Wave-1 live-verify
// benign probe. Mimics the exact hook registration shape OpenCode's real
// keel plugin uses (packages/opencode-plugin/src/plugin.ts: default export
// with `server: async (pluginInput) => ({...hooks})`) but does nothing
// except append one line per tool call to a log file, then always allows.
//
// Purpose: prove OpenCode invokes `tool.execute.before` in headless
// (`opencode run`) mode BEFORE trusting keel's own enforcement logic —
// if this doesn't fire, a keel block failure would be indistinguishable
// from "the host never called the hook at all".
import { appendFileSync } from 'node:fs'

const LOG_PATH = process.env.KEEL_LIVEVERIFY_BENIGN_LOG
if (!LOG_PATH) {
  throw new Error('benign-logger-opencode: KEEL_LIVEVERIFY_BENIGN_LOG not set')
}

export default {
  id: 'liveverify-benign-logger',
  server: async () => ({
    'tool.execute.before': async (input) => {
      try {
        appendFileSync(LOG_PATH, `${JSON.stringify({ tool: input?.tool, ts: Date.now() })}\n`)
      } catch {
        // never let logging itself break the call
      }
    },
  }),
}
