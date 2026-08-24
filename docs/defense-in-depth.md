# Defense in depth: keel plus a real isolation boundary

This document exists because "install keel and you're covered" is not a claim keel
makes, or should let a reader infer. Keel is one layer — in-process tool-call
interception — in a security stack, not a complete solution on its own. This page is
about how to combine it with the layer it is missing.

## The gap, stated plainly

keel evaluates a tool call from inside the agent's own process, before the call
executes. That is real enforcement against a careless or drifting agent: rules the
agent cannot read away, gates it cannot silently step around. It is not enforcement
against a *hostile* agent process. Two places already say this without hedging, and
this page doesn't relitigate them, only builds on them:

- [ROADMAP.md](../ROADMAP.md)'s non-goals: **"Sandboxing. keel gates tool calls; it is
  not a container or a syscall filter."** keel has never claimed to be one, and nothing
  here proposes changing that.
- [SECURITY.md](../SECURITY.md)'s closing limit: **"The agent's own process is the
  boundary. In-process enforcement can be bypassed if the agent process itself is
  compromised."**

If an attacker gets arbitrary code execution inside the same process keel's hook runs
in — a supply-chain-compromised dependency, a successfully-executed prompt injection
that reaches a raw shell, a malicious MCP server — keel's rules stop applying,
because the thing evaluating them is the thing that's been compromised. `agentsh`
(kernel-level: seccomp/eBPF/Landlock) or a container/microVM boundary survive that in
a way in-process interception structurally cannot — see the "Enforcement that survives
a compromised agent process" row in [docs/comparison.md](comparison.md#choosing).

None of that makes keel's layer useless. It makes it *one* layer, sized correctly: fast
to install, no infrastructure required, real enforcement against the failure mode that
actually happens most often (an agent that isn't fighting you, just drifting). Pair it
with an isolation boundary for the failure mode it can't reach.

## A layered pattern

Not a prescription — a starting shape to adapt, weighted toward how much a compromised
agent process can cost at each stage:

| Environment | Layer(s) | Why |
|---|---|---|
| **Local dev** | keel alone | Fast iteration matters most here; the blast radius of a dev machine running an untrusted repo is real but bounded, and a container adds friction on every edit-run cycle. |
| **Staging / CI** | keel + a container boundary (Docker, gVisor, Firecracker) | Untrusted branches, third-party PRs, and generated code run here. A container boundary means a compromised agent process is contained to a disposable sandbox, not staging infrastructure. keel still gates the *ordinary* mistake inside that sandbox — a stray `rm -rf`, a force-push, a secret read — instead of relying on the container alone to notice. |
| **Production / agent-driven ops** | keel + container/microVM isolation + credential scoping | Highest stakes: real credentials, real infrastructure. Isolation contains a compromised process; a scoping proxy or short-lived, narrowly-permissioned credentials (rather than the agent holding a long-lived admin key) limits what a contained-but-still-running process can reach even before it's caught; keel gates the tool-call layer on top of both. |

The reasoning for stacking rather than picking one: each layer covers a gap the others
leave open. keel gates *what a well-behaved-but-careless agent tries to do* and produces
an audit trail; a container/microVM gates *what a compromised process can actually
reach*; credential scoping limits *what a reached-but-uncaught process can do with what
it has*. None of the three substitutes for either of the others.

## A minimal example: keel inside a container boundary

This shows the *shape* of stacking the two layers — install keel inside the same image
that runs the agent, so tool-call rules are enforced regardless of what's inside the
container, while the container itself is the boundary that contains a compromised
process. Adjust the base image and the `keel install` flag for whichever host you
actually run (`--claude-code`, `--opencode`, `--codex`, …; `keel install --help` lists
all of them):

```dockerfile
FROM node:22-slim

# Whatever coding-agent CLI you're running goes here — this line is a
# placeholder; keel does not ship or require any particular agent.
# RUN npm install -g <your-agent-cli>

# keel itself: same install path as bare-metal, just run at image build time
# instead of interactively.
RUN npm install -g @get-keel/cli

WORKDIR /workspace
COPY . .

# Wire project-scoped hooks into the checked-out repo at build time, so
# every container started from this image already has enforcement active —
# no install step left to skip at container start.
RUN keel install --claude-code

# Run the agent as an unprivileged user inside the container. keel's rules
# still apply to what THIS process does; the container boundary is what
# limits what happens if this process is the one that gets compromised.
USER node
CMD ["your-agent-entrypoint"]
```

This is deliberately small. It does not configure gVisor/Firecracker/seccomp profiles,
credential scoping, or network egress rules — those are the container-runtime half of
the stack, genuinely orthogonal to keel, and outside what this doc can responsibly
prescribe without knowing your infrastructure. `docker run --security-opt` flags,
gVisor's `runsc` runtime, or a Firecracker microVM all compose with the image above
without changing anything about how keel is installed inside it.

## What this does and doesn't buy you

- **Does:** contains the blast radius of a compromised agent process to the
  container/microVM boundary, while keel still catches the ordinary mistake — the one
  that doesn't require compromise at all — before it happens.
- **Doesn't:** make keel a sandbox, retroactively. keel's rules still evaluate
  in-process; a sufficiently compromised process inside the container can still defeat
  keel's checks the same way it could bare-metal. The container is what stops that
  compromised process from reaching anything outside itself — keel was never the layer
  meant to do that, and this page doesn't ask it to.
- **Doesn't:** solve prompt injection. Nothing in this stack — keel, the container, or
  credential scoping — inspects untrusted content for injected instructions before the
  agent acts on it. That is a different, still-open problem; see
  [docs/exfil.md](exfil.md)'s own "leg 1 is unsolved" section for the fuller version of
  this same honesty.
