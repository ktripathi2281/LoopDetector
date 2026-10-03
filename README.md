# Loop Detector

A Claude Code mod that notices when Claude is stuck repeating the same approach, and helps it out before it burns a pile of time and tokens.

```
╭────────────────────────────────────────────────╮
│ ⚠️ Claude may be looping                        │
│                                                │
│ Same test failure × 5                          │
│ auth.ts modified × 7                           │
│                                                │
│ Current cycle                                  │
│ edit → test → failure → edit                   │
│                                                │
│ [ Inspect ] [ Rethink ] [ Pause ] [ Continue ] │
╰────────────────────────────────────────────────╯
Loop Detector 🔴 Possible loop · auth.ts → run tests → same failure ×5 · /loops
```

Detection is deterministic: plain heuristics over the tool calls Claude makes and what they return. No model calls, no network, nothing leaves your machine, and the same history always gets the same verdict. Nothing it does stops Claude on its own: every intervention is a button you press.

## Install

```bash
claude plugin marketplace add ktripathi2281/LoopDetector
claude plugin install loop-detector@loop-detector
```

To try it without installing, load the folder for one session:

```bash
claude --plugin-dir ./loop-detector
```

Mods (plugins of function hooks) are early access. If your Claude Code build says hooks modules are not turned on, set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in your environment (or in the `env` block of `~/.claude/settings.json`).

## What you see

- **Live indicator** in the status line, always on: `🟢 Normal`, `🟡 Suspicious`, `🔴 Possible loop`.
- **Warning card** above the prompt (terminal and desktop app) when a likely loop is detected: the two facts that matter, the current cycle, and four actions. In VS Code and on mobile, where there is no band above the prompt, a toast says it instead.

| Button | What it does |
| --- | --- |
| **Inspect** (`i`) | Opens the detailed view (also `/loops`). |
| **Rethink** (`r`) | Gives Claude a summary of the loop and asks it to change approach. See [Rethink](#rethink). |
| **Pause** (`p`) | Ends Claude's current turn and offers a prompt suggestion (Tab to take it). Shown while Claude is working. |
| **Continue** (`c`) | Hides the card. The same loop stays quiet unless it gets meaningfully worse. |

No mouse? `/loops` opens the detailed view and `/loops now` does what Rethink does. Both run even while Claude is working, so they also help in terminals that don't pass clicks through, or under screen recorders that swallow clicks.

The detailed view lists the repeated cycle step by step, how often it occurred, the files involved, the repeated failure, the recent activity (each run, then its result), why it was flagged, and the seven signals behind the score.

## How it decides

Every tool call becomes a small record: what kind of action it was, its target (a file, or the command with `cd …&&`, `2>&1` and `| tail` stripped), whether it failed, the failure's fingerprint (timings, line numbers, clock times and ids blanked out), parsed test results (Jest, Vitest, pytest, Go, mocha, cargo), and a fingerprint of its output.

The engine reads the current stretch of work, everything since the last strong progress event, through seven signals, each 0-100:

| Signal | Reads |
| --- | --- |
| Action repetition | Calls that repeat earlier ones, exact duplicates, a block of 2-6 steps going round |
| Command repetition | The same command run again and again |
| File repetition | The same file modified again and again |
| Error repetition | The same error seen again and again |
| Test-result repetition | The same tests failing the same way, run after run |
| Edit → test → failure cycles | Attempts at the same check (edits, then the command) ending in a failure already seen, within a small set of files. The edits may differ: it is the approach going round, not the exact call. Edits that undo earlier edits count here too. |
| Lack of observable progress | How long since the last progress, and how many results since then failed or repeated an earlier one |

They combine into one **loop score**:

```
score = 100 × repetition × (0.25 + 0.75 × stagnation) × progress decay
stagnation = 0.55 × same result + 0.45 × no progress
```

So **repetition alone tops out at 25**, and only repetition with the same result and no observable progress climbs into the loop band.

| Score | Band |
| --- | --- |
| 0-39 | 🟢 Normal |
| 40-69 | 🟡 Suspicious |
| 70-100 | 🔴 Possible loop |

The score is an internal heuristic for ranking how loop-like the recent history looks. It is not a probability and has not been validated as one.

### Progress

Progress events lower the score. A strong one starts the stretch of work over (score back to 0); a weaker one discounts the score while it is recent.

| Progress | Strength |
| --- | --- |
| A failing command or test run now passes | strong (resets) |
| A task is marked completed (TodoWrite, TaskUpdate) | strong (resets) |
| Previously failing tests now pass, but not all | 0.7 |
| Claude starts editing a different part of the code | 0.6 |
| The error changed to one not seen before | 0.5 |
| More tests pass | 0.4 |

Flipping back to an error seen before is not progress.

Some reference points:

| Score | History |
| --- | --- |
| 86 | edit auth.ts → npm test → the same 2 tests fail, three times |
| 0 | the same, but the third run passes |
| 86 | edit auth.ts, edit authMiddleware.ts → npm test → same failure, three times |
| 10 | edit → test, a new error each time (test-driven progress) |
| 20 | seven edits to one file, no runs (writing code) |
| 61 | `git status` four times, same output |

### No spam

Every loop has an identity: its key, and a family (its failure, or its files and commands) shared by related readings. A loop warns once. It warns again only when its band rises, its repetitions double, or it goes unseen for 15 tool calls and comes back. A card that is showing follows the loop's numbers until the score falls back to normal.

## Rethink

Rethink is an intervention, not a dismiss button. It hands Claude a summary of the loop:

```
LOOP DETECTED

You have attempted the following approach 5 times:

auth.ts → npm test → same failure

Same failure:
Expected: 401, Received: 200

Files repeatedly modified:
auth.ts
authMiddleware.ts

No observable progress has occurred.

Please stop repeating the current approach and reconsider the underlying assumption. Inspect the relevant code and propose a different approach before making another change.
```

What pressing it does depends on the **Rethink behavior** setting:

| Setting | Rethink |
| --- | --- |
| `warn`, **Only warn** (default) | Puts the summary in your prompt box. Claude keeps going; nothing is sent until you press Enter. |
| `confirm`, **Pause and ask for confirmation** | Ends Claude's current turn, then shows the summary with **Send to Claude**, **Edit first** and **Cancel**. |
| `inject`, **Inject rethink prompt** | Ends Claude's current turn and sends the summary at once. |

`warn` is the default because it is the safest: nothing reaches Claude without you. `/loops rethink confirm` (or `warn`, `inject`) switches it for the current session.

How it works: the pause is `$.turn.abort`, which stops the turn and its running tools, and the summary is sent with `$.prompt.submit`, which starts Claude's next turn as soon as the session is idle. Claude reads it framed as a message from the Loop Detector plugin, and the transcript shows it, so nothing is hidden or attributed to you.

## Configuration

Set these in Claude Code's config menu or under `pluginConfigs.loop-detector` in your settings.

| Option | Default | Meaning |
| --- | --- | --- |
| `warnAt` | `loop` | The band that shows the warning card: `suspicious` (40+) or `loop` (70+) |
| `rethink` | `warn` | Rethink behavior: `warn`, `confirm` or `inject` |
| `commandRepeats` | `4` | Runs of one command at which command repetition reads full strength |
| `fileEdits` | `5` | Edits to one file at which file repetition reads full strength |
| `failureRepeats` | `3` | Sightings of one error at which error repetition reads full strength |
| `cycleRepeats` | `2` | Repeats of a cycle, after its first time, at which the cycle signals read full strength |

## Limitations

- The Mods API is early access and may change between Claude Code releases.
- The warning card appears in the terminal and the desktop app. VS Code and mobile get the toast, the status line and the detailed view.
- **Pause** and **Rethink** end the current turn; there is no suspend-and-resume. Rethink does not add its summary to the turn that was running: it ends that turn and the summary starts the next one. (The API can append a hidden note to a running turn, `$.session.append`, but that would not stop the loop's current step, so Rethink does not use it.)
- Only the main conversation's turn can be ended. Subagents' tool calls are not tracked yet.
- Failures and test results are read from the tool's text output with regular expressions, not from structured reports, and long outputs may already be truncated.
- Only Edit, Write, MultiEdit and NotebookEdit count as file edits; a `sed -i` or a script that rewrites a file does not.
- "A different part of the code" means a file in a directory not touched before in the recent history: a rough proxy for a subsystem.
- History is per session: it survives reloads of the mod, not `/clear` or resuming.

## Development

```
loop-detector/
  .claude-plugin/plugin.json   manifest and settings
  hooks/hooks.json             names the hooks module
  hooks/register.tsx           hooks: observes tool calls; draws the card, the indicator and the views; /loops; Rethink
  hooks/observe.ts             one tool call → one record: target, failure, test results, output fingerprint
  hooks/assess.ts              the loop score: seven signals, progress events, the explanation
  hooks/warn.ts                when to warn, once per loop
  hooks/present.ts             the words the UI shows, and the rethink prompt
  types/index.d.ts             shared types and the state contract
  tests/                       run by `claude plugin test`; history.ts builds synthetic tool-call sequences
```

```bash
claude plugin validate ./loop-detector
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test ./loop-detector
```

Claude Code writes the API declarations into `loop-detector/.claude-plugin/types/` (git-ignored) whenever it loads the mod from disk, and `loop-detector/tsconfig.json` extends them, so after one load `npx -p typescript tsc -p loop-detector` type-checks the mod and its tests.

## License

MIT
