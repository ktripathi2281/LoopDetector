export type ActionKind = 'edit' | 'run' | 'read' | 'task' | 'other'

/** What a test run reported, when its output could be read. */
export type TestResult = {
  failed: number
  passed: number
  /** Names of the failing tests, sorted; empty when the runner's output names none. */
  names: string[]
}

/** One observed tool call of the main loop, reduced to what the heuristics compare. */
export type LoopAction = {
  /** Increases by one per recorded call; never reused within a session. */
  seq: number
  tool: string
  kind: ActionKind
  /** Normalized file path or command: what "the same" means for this action. */
  target: string
  /** Short display form of `target` (a basename, a truncated command). */
  label: string
  /** `kind:target`, the identity repeats and cycles are counted on (ignores an edit's content). */
  sig: string
  /** Hash of the whole input: two calls with the same `call` are exact duplicates. */
  call: string
  /** The directory of the file an edit or read touched: its subsystem. */
  area?: string
  isTest: boolean
  isError: boolean
  /** Normalized failure fingerprint, when the result looked like a failure. */
  failure?: string
  /** The most telling line of that failure, for display. */
  failureHeadline?: string
  /** Parsed test counts and failing test names, for a test run. */
  tests?: TestResult
  /** Hash of the normalized result, for every call but an edit: "same result". */
  outputHash?: string
  /** Hash of an edit's before/after (`old>new`) or a write's content (`w:hash`): spots undo. */
  change?: string
  /** For a task tool: tasks marked completed (TodoWrite: all of them; TaskUpdate: 0 or 1). */
  tasksDone?: number
}

export type SignalId =
  | 'action-repetition'
  | 'command-repetition'
  | 'file-repetition'
  | 'error-repetition'
  | 'test-result-repetition'
  | 'attempt-cycle'
  | 'no-progress'

/** One signal's reading: 0-100 strength and what it saw, in words. */
export type SignalReading = {
  id: SignalId
  label: string
  value: number
  detail: string
}

export type ProgressKind =
  | 'command-succeeded'
  | 'tests-pass'
  | 'tests-fixed'
  | 'new-tests-pass'
  | 'error-changed'
  | 'task-completed'
  | 'moved-on'

/** Something that showed the work moving: a fix, a new error, a finished task. */
export type ProgressEvent = {
  seq: number
  kind: ProgressKind
  /** 1 resets the loop score; less discounts it while recent. */
  strength: number
  detail: string
}

/** The score's band: 0-39 normal, 40-69 suspicious, 70-100 a likely loop. */
export type Band = 'normal' | 'suspicious' | 'loop'

export type Tally = { label: string; count: number }

/** The loop being repeated, step by step: `Modify auth.ts`, `Run npm test`, `Receive same failure`. */
export type LoopCycle = {
  steps: string[]
  /** The same steps by kind: `edit`, `test`, `failure`. */
  kinds: string[]
  occurrences: number
}

/**
 * The engine's verdict on the recent history. `score` is an internal heuristic
 * (0-100), not a probability: repetition alone stays low; repetition with the
 * same result and no observable progress climbs.
 */
export type LoopAssessment = {
  score: number
  band: Band
  /** Identity of the loop, so the same loop warns once. */
  key: string
  /** Identity shared by related readings of one loop (its failure, else its key). */
  family: string
  /** One line: `auth.ts → run tests → same failure`; empty while nothing repeats. */
  pattern: string
  /** The same with real commands, for Claude to read: `auth.ts → npm test → same failure`. */
  approach: string
  cycle: LoopCycle | null
  repetitions: number
  /** All seven signals, always in the same order. */
  signals: SignalReading[]
  /** The three factors the score multiplies, 0-100 each. */
  factors: { repetition: number; sameResult: number; noProgress: number }
  /** The multiplier recent progress applied (1 when none). */
  decay: number
  progress: ProgressEvent[]
  /** The seq after which the current stretch of work began (the last strong progress). */
  episodeStart: number
  /** Files modified at least twice since then, most modified first. */
  files: Tally[]
  commands: Tally[]
  errors: Tally[]
  /** The most repeated failure; `isTest` when a test run produced it. */
  failure?: { headline: string; count: number; isTest: boolean }
  tests?: { failed: number; names: string[]; runs: number }
  /** Why this was flagged, strongest first. */
  reasons: string[]
}

export type Confidence = 'low' | 'medium' | 'high'

export type LoopAlert = {
  assessment: LoopAssessment
  shownAtSeq: number
  isAcknowledged: boolean
}

export type Suppression = {
  key: string
  family: string
  band: Band
  repetitions: number
  lastSeenSeq: number
}

export type MonitorState = {
  alert: LoopAlert | null
  suppressions: Suppression[]
}

/** A rethink prompt waiting for the person's OK, and whether Rethink paused Claude for it. */
export type PendingRethink = {
  message: string
  wasPaused: boolean
}

/** What Rethink does when pressed: draft it, ask first, or send it at once. */
export type RethinkMode = 'warn' | 'confirm' | 'inject'

declare module 'claude-code' {
  interface PluginState {
    'loop-detector': {
      actions: LoopAction[]
      monitor: MonitorState
      turnId: string | null
      rethink: PendingRethink | null
      /** `/loops rethink <mode>` for this session; null follows the setting. */
      rethinkMode: RethinkMode | null
    }
  }
}
