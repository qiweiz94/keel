"""keel — Hermes Agent plugin.

A thin client. All policy lives in the keel daemon (`keel daemon`), so this
file never decides what a rule means — it asks, then translates the verdict
into what Hermes understands.

Why a daemon rather than an embedded engine: keel's rule engine is
TypeScript. Reimplementing it in Python would give you two engines that
drift, and the drift would be silent. One engine, thin clients.

Hooks used:
  pre_tool_call  -> POST /v1/check       (the enforcement point)
  post_tool_call -> POST /v1/outcome     (exit codes feed the stuck detector)
  pre_llm_call   -> GET  /v1/requirements (standing protocols, injected)

INSTALL: keel install --hermes
"""

import json
import os
import re
import urllib.error
import urllib.request

DAEMON_PORT = int(os.environ.get("KEEL_DAEMON_PORT", "31990"))
DAEMON_HOST = "127.0.0.1"
TIMEOUT_SECONDS = float(os.environ.get("KEEL_TIMEOUT_SECONDS", "5"))
TOKEN_PATH = os.path.expanduser("~/.keel/daemon-token")

# Hermes caps injected context at 10,000 characters per hook.
MAX_CONTEXT_CHARS = 10_000

# ── Verdict mapping ───────────────────────────────────────────────────
# Hermes pre_tool_call accepts {"action": "block"|"approve"} or None.
# It cannot rewrite arguments, so keel's `fix` action has no equivalent:
# mapping it to "block" would be wrong (the rule wanted a rewrite, not a
# stop) and mapping it to "approve" would nag. It stays advisory, and the
# installer says so rather than letting it look enforced.
_BLOCK = {"deny", "block"}
_APPROVE = {"prompt", "research", "redirect"}
# Surfaced to the human, never interrupting the agent. `fix` is here
# because Hermes cannot rewrite arguments: silently allowing it would
# make a fix rule look enforced when nothing was rewritten.
_ADVISORY = {"warn", "report", "fix"}


def _token():
    try:
        with open(TOKEN_PATH, "r", encoding="utf-8") as handle:
            return handle.read().strip()
    except OSError:
        return None


def _post(path, payload):
    """Return the parsed daemon response, or None if it cannot be reached."""
    token = _token()
    if not token:
        return None
    request = urllib.request.Request(
        f"http://{DAEMON_HOST}:{DAEMON_PORT}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return None


# ── Circuit breaker ───────────────────────────────────────────────────
# Hermes fails open: a hook that raises is logged and skipped. keel fails
# closed. A thin client cannot bundle the engine, so when the daemon is
# unreachable neither extreme is right:
#
#   fail open silently -> enforcement disappears while the user believes
#       they are protected. That is the whole complaint behind OpenClaw
#       issue #20914, which was closed as stale without a fix.
#   fail closed on everything -> the first time the daemon is not running,
#       every tool call is blocked and the plugin gets uninstalled.
#
# So: block only what is catastrophic and irreversible, allow the rest,
# and say loudly that enforcement is degraded. This list is a last-resort
# backstop, NOT a second rule engine — keep it short and obvious.
OFFLINE_DENY = [
    (r"\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR])\s+(/|~|\$HOME)(\s|/|$)",
     "recursive delete of a root or home path"),
    (r"\bgit\s+push\b.*\s(--force|-f)\b.*\b(main|master|prod|production)\b",
     "force-push to a protected branch"),
    (r"\bDROP\s+(DATABASE|TABLE)\b", "destructive SQL"),
    (r"\bTRUNCATE\s+TABLE\b", "destructive SQL"),
    (r":\(\)\{\s*:\|:&\s*\};:", "fork bomb"),
    (r"\bmkfs(\.\w+)?\b", "filesystem format"),
    (r"\bdd\s+.*\bof=/dev/(disk|sd|nvme)", "raw write to a block device"),
]

_DEGRADED_NOTICE = (
    "[keel] DEGRADED — the keel daemon is unreachable, so rules are NOT being "
    "enforced. Only catastrophic operations are blocked. Start it with `keel daemon`."
)


def _offline_verdict(command):
    for pattern, why in OFFLINE_DENY:
        if re.search(pattern, command, re.IGNORECASE):
            return {
                "action": "block",
                "message": f"[keel] Blocked while offline: {why}. {_DEGRADED_NOTICE}",
            }
    return None


def _command_of(args):
    if not isinstance(args, dict):
        return ""
    for key in ("command", "cmd"):
        value = args.get(key)
        if isinstance(value, str):
            return value
    return ""


def translate(result, emit=None):
    """Map a keel EnforceResult onto a Hermes pre_tool_call verdict.

    `emit` receives advisory text that must reach the human but must NOT
    interrupt the agent. This matters more than it looks: keel's ladder is
    warn-once-then-block, so the FIRST violation of every deny rule comes
    back as `warn`. Returning None for it and printing nothing made that
    first violation completely silent on Hermes — the user would see
    nothing, then a hard block on the repeat, with no warning in between.
    Stopping bad behaviour is only half the job; saying so is the other.
    """
    if not isinstance(result, dict):
        return None
    action = result.get("action")
    message = result.get("message") or ""
    rule = result.get("rule_id")
    label = f"[keel{':' + rule if rule else ''}] {message}".strip()
    if action in _BLOCK:
        return {"action": "block", "message": label}
    if action in _APPROVE:
        return {"action": "approve", "message": label}
    if action in _ADVISORY and message:
        (emit or _emit)(label)
    # allow / warn / report / fix / mask -> never interrupt.
    return None


def _emit(text):
    print(text, flush=True)


def pre_tool_call(tool_name=None, args=None, task_id=None, **_kwargs):
    payload = {
        "tool": tool_name or "unknown",
        "args": args if isinstance(args, dict) else {},
        "cwd": os.getcwd(),
        "session_id": str(task_id or "hermes"),
        "agent": "hermes-plugin",
        "subagent_of": None,
    }
    result = _post("/v1/check", payload)
    if result is None:
        # Daemon unreachable — circuit breaker.
        print(_DEGRADED_NOTICE, flush=True)
        return _offline_verdict(_command_of(payload["args"]))
    return translate(result)


def post_tool_call(tool_name=None, args=None, result=None, task_id=None, duration_ms=None, **_kwargs):
    # Hermes gives no exit code, only the result payload. Derive a coarse
    # one so the stuck detector has something real: absent this, every
    # attempt looks successful and loops are invisible.
    exit_code = None
    if isinstance(result, str):
        exit_code = 1 if re.search(r"\b(error|failed|exception|traceback)\b", result, re.IGNORECASE) else 0
    _post("/v1/outcome", {
        "tool": tool_name or "unknown",
        "args": args if isinstance(args, dict) else {},
        "cwd": os.getcwd(),
        "session_id": str(task_id or "hermes"),
        "agent": "hermes-plugin",
        "exit": exit_code,
        "duration_ms": duration_ms,
    })
    return None


def pre_llm_call(session_id=None, **_kwargs):
    """Inject keel's standing requirements, truncated to Hermes' cap."""
    token = _token()
    if not token:
        return None
    request = urllib.request.Request(
        f"http://{DAEMON_HOST}:{DAEMON_PORT}/v1/requirements?cwd={urllib.request.quote(os.getcwd())}",
        headers={"Authorization": f"Bearer {token}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            text = response.read().decode("utf-8").strip()
    except (urllib.error.URLError, OSError, TimeoutError):
        return None
    if not text:
        return None
    return {"context": text[:MAX_CONTEXT_CHARS]}


def register(ctx):
    ctx.register_hook("pre_tool_call", pre_tool_call)
    ctx.register_hook("post_tool_call", post_tool_call)
    ctx.register_hook("pre_llm_call", pre_llm_call)
