# nightshift

**A guardrail policy engine for AI coding agents.** Auto-approve what is
provably harmless, hard-block what is dangerous, and ask a human about
everything else — so an agent can work unattended (overnight, in CI, on long
tasks) without you disabling its safety system.

*Leer en español: [README.es.md](README.es.md)*

## The problem

Every agentic coding tool forces the same bad choice:

- **Babysit it** — approve `ls`, `grep`, `find | sort` by hand, dozens of
  times per session; or
- **Disable safety entirely** — bypass/yolo/full-auto modes that will happily
  run `rm -rf`, push to your remotes, or read your credentials.

The gap is worst with **compound commands**: agents love chaining
(`cd src && grep -rn TODO . | sort`), and most permission systems evaluate
allow-rules in a way that a chain never fully matches — so even "approved"
commands keep prompting. No set of static rules fixes this, because rules
match strings while safety is a property of **every segment of the chain**.

## How it works

nightshift is a tiny decision engine (`policy.js`, pure Node, zero
dependencies) that adapters plug into an agent's tool-interception hook.
For every shell command the agent wants to run:

| The command… | Decision |
|---|---|
| matches a destructive/exfiltration/escalation pattern anywhere (`rm -rf`, `git push`, `--force`, `publish`, registry/service edits, `shutdown`, credential files, `--yolo`/skip-permissions flags…) | **deny** — hard block |
| touches sensitive paths (`.env`, `.ssh`, `.aws`) or uses constructs a splitter can't reason about (`$( )`, backticks, heredocs, `>>`) | **defer** — fall through to the agent's normal permission flow |
| splits on `&&` `\|\|` `;` `\|` `&` into segments where **every** first token is read-only/safe (`ls`, `find`, `grep`, `sort`, `git status/diff/log`, `git add/commit`, `npm run/test`, read-only PowerShell cmdlets…) | **allow** — runs silently |
| anything else (`npx`, `docker`, `curl`, unknown tools) | **defer** |

**Fail-safe by construction:** parse errors, unknown constructs, and adapter
crashes all *defer* — nightshift can fail closed, never open. Deferring (not
force-prompting) also means your existing per-agent allow-rules keep working
untouched.

```
your agent (any)          nightshift
┌───────────────┐         ┌──────────────────────┐
│ wants to run: │ ──────► │ adapters/<agent>.js  │  protocol translation only
│ cd x && rm -rf│         │        │             │
└───────────────┘         │   policy.js          │  the actual brain
                          │   allow/deny/defer   │
                          └──────────────────────┘
```

## Supported agents

| Agent | Adapter | Status |
|---|---|---|
| Claude Code | [`adapters/claude-code.js`](adapters/claude-code.js) | ✅ stable, installer included |
| Others (Codex CLI, Gemini CLI, OpenCode, Cline…) | — | PRs welcome: implement `agent hook → policy.decide(command) → agent response` |

The core is agent-agnostic; an adapter is typically <50 lines of protocol
translation. If your agent exposes any pre-execution hook that can approve,
block, or fall through, it can host nightshift.

## Install (Claude Code adapter)

Requires Node ≥ 18. Works on native Windows (zero dependencies — no `jq`, no
`bash`), macOS, and Linux.

```
node install.js
```

The installer is **idempotent** (safe to re-run), backs up your settings file,
merges rather than overwrites (your existing allow-rules survive), installs a
hard **deny floor** of ~47 permission rules underneath the engine, and
smoke-tests itself. Then restart your agent session and verify:

1. `/hooks` → shows a PreToolUse entry pointing at `…/nightshift/claude-code.js`
2. Ask for something needing a compound read-only command → no prompt
3. Ask for `git push` → auto-blocked

Uninstall with `node uninstall.js` (keeps the deny floor on purpose; remove it
manually if you really want it gone).

## Unattended runbook

- Run **interactively** in the target repo. Unknown commands **pause at a
  prompt until you're back** — they never execute unsupervised.
- Disable machine sleep for overnight runs.
- Don't run it in folders holding secrets or personal documents; a permission
  layer is not an OS sandbox. For the strongest isolation, run the agent
  inside a container or VM.
- Watch your usage: unsupervised agents can burn a lot of tokens.

## Opinionated defaults

- **`git push` is never auto-run and is denied by default** — review in the
  morning, push yourself. To change: remove the `git push` patterns from
  `DANGER` in `policy.js` and from `DENY_FLOOR` in `install.js`.
- **Self-protection:** once installed, the agent cannot edit its own settings
  file or the nightshift hook — an agent that can rewrite its own permission
  system has no permission system.
- `npx`, `docker`, and inline eval (`python -c`, `node -e`) are never
  auto-approved.
- Escalation flags of *any* agent (`--dangerously-skip-permissions`, `--yolo`,
  `--full-auto`) are denied — an agent must not be able to launch a less
  restricted copy of itself.

## Limitations

- The engine is a **heuristic, not a shell parser**. Obfuscated commands fall
  through to *defer* (a prompt), not to *allow* — but review the `DANGER` list
  against your own threat model.
- Single `>` redirects inside otherwise read-only chains are allowed, so a
  safe chain can overwrite a project file (equivalent risk to auto-accepted
  file edits).
- A permission layer complements — never replaces — OS-level sandboxing.

## Tests

```
node test.js    # 26 behavioral cases (engine + adapter protocol), run in CI on Windows + Linux
```

## License

MIT
