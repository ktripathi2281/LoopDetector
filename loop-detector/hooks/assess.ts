// The loop score. Seven signals read the current stretch of work (everything
// since the last strong progress event) and the score multiplies three
// factors built from them:
//
//   score = 100 × repetition × (0.25 + 0.75 × stagnation) × progress decay
//   stagnation = 0.55 × same result + 0.45 × no progress
//
// so repetition alone tops out at 25 (normal), and only repetition with the
// same result and no observable progress reaches the loop band. The score is
// an internal heuristic, not a probability. Pure: no `$`, no I/O.

import type {
  Band,
  LoopAction,
  LoopAssessment,
  LoopCycle,
  ProgressEvent,
  SignalId,
  SignalReading,
  Tally,
} from '../types'
import { hash } from './observe'

export type Thresholds = {
  /** Runs of one command at which command repetition reads full strength. */
  commandRepeats: number
  /** Edits to one file at which file repetition reads full strength. */
  fileEdits: number
  /** Sightings of one error at which error repetition reads full strength. */
  failureRepeats: number
  /** Repeats (after the first time) at which a cycle reads full strength. */
  cycleRepeats: number
}

export const DEFAULTS: Thresholds = {
  commandRepeats: 4,
  fileEdits: 5,
  failureRepeats: 3,
  cycleRepeats: 2,
}

/** Actions the engine looks back over. */
export const WINDOW = 40
/** Actions kept in state; the pane lists the newest of them. */
export const KEEP = 60
/** Weak progress this many actions back or fewer still discounts the score. */
const RECENT_PROGRESS = 8
/** Attempts that stay within this many files count as one approach going round. */
const SMALL_FILE_SET = 4
const MAX_CYCLE = 6

export const SIGNAL_LABELS: Record<SignalId, string> = {
  'action-repetition': 'Action repetition',
  'command-repetition': 'Command repetition',
  'file-repetition': 'File repetition',
  'error-repetition': 'Error repetition',
  'test-result-repetition': 'Test-result repetition',
  'attempt-cycle': 'Edit → test → failure cycles',
  'no-progress': 'Lack of observable progress',
}

export const bandOf = (score: number): Band => (score >= 70 ? 'loop' : score >= 40 ? 'suspicious' : 'normal')

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x))
/** 0 at or below `lo`, 1 at or above `hi`, linear between. */
const ramp = (x: number, lo: number, hi: number): number => (hi <= lo ? (x >= hi ? 1 : 0) : clamp01((x - lo) / (hi - lo)))
const pct = (x: number): number => Math.round(clamp01(x) * 100)
const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)

export const isFailing = (a: LoopAction): boolean => a.isError || a.failure !== undefined

const runLabel = (a: LoopAction): string => (a.isTest ? 'run tests' : `run \`${a.label}\``)

const stepOf = (a: LoopAction): { short: string; step: string; kind: string } => {
  switch (a.kind) {
    case 'edit':
      return { short: a.label, step: `Modify ${a.label}`, kind: 'edit' }
    case 'run':
      return { short: runLabel(a), step: `Run ${a.label}`, kind: a.isTest ? 'test' : 'run' }
    case 'read':
      return { short: `read ${a.label}`, step: `Read ${a.label}`, kind: 'read' }
    default:
      return { short: a.label, step: a.label, kind: a.tool.toLowerCase() }
  }
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [item])
    else group.push(item)
  }
  return groups
}

/** The largest group; ties go to the group seen first. */
function topGroup<T>(groups: Map<string, T[]>): { key: string; items: T[] } | undefined {
  let best: { key: string; items: T[] } | undefined
  for (const [key, items] of groups) if (best === undefined || items.length > best.items.length) best = { key, items }
  return best
}

/** Labels of the files among `edits`, most modified first, then in order of first edit. */
function filesByCount(edits: readonly LoopAction[]): string[] {
  return [...groupBy(edits, a => a.target).values()]
    .sort((a, b) => b.length - a.length)
    .map(group => group[0]?.label ?? '')
    .filter(label => label.length > 0)
}

/** What repeats among `actions` (two or more times), most repeated first. */
function tallies(
  actions: readonly LoopAction[],
  keyOf: (a: LoopAction) => string | undefined,
  labelOf: (a: LoopAction) => string = a => a.label,
): Tally[] {
  const groups = groupBy(
    actions.filter(a => keyOf(a) !== undefined),
    a => keyOf(a) ?? '',
  )
  return [...groups.values()]
    .flatMap(group => {
      const last = group.at(-1)
      return last !== undefined && group.length >= 2 ? [{ label: labelOf(last), count: group.length }] : []
    })
    .sort((a, b) => b.count - a.count)
}

// ---------------------------------------------------------------------------
// Progress

/** The same tests failing the same way: their names (else their count) and the failure. */
const testsSignature = (a: LoopAction): string | undefined =>
  a.tests === undefined || a.tests.failed === 0
    ? undefined
    : `${a.tests.names.length > 0 ? a.tests.names.join('\n') : `${a.tests.failed} failed`}\n${a.failure ?? ''}`

/**
 * What showed the work moving, in order: a failing command or test run that
 * now passes (strength 1), failing tests that now pass, more tests passing, an
 * error never seen before, a completed task, an edit in a new part of the code.
 */
export function findProgress(actions: readonly LoopAction[]): ProgressEvent[] {
  const events: ProgressEvent[] = []
  const lastRun = new Map<string, LoopAction>()
  const seenFailures = new Set<string>()
  const seenAreas = new Set<string>()
  let todosDone: number | undefined

  for (const a of actions) {
    const add = (kind: ProgressEvent['kind'], strength: number, detail: string) =>
      events.push({ seq: a.seq, kind, strength, detail })

    if (a.kind === 'task') {
      const done = a.tasksDone ?? 0
      if (a.tool === 'TodoWrite') {
        if (todosDone !== undefined && done > todosDone) add('task-completed', 1, 'A task was marked completed')
        todosDone = done
      } else if (done > 0) {
        add('task-completed', 1, 'A task was marked completed')
      }
      continue
    }

    if (a.kind === 'run') {
      const before = lastRun.get(a.target)
      if (before !== undefined && isFailing(before)) {
        const was = before.tests
        const now = a.tests
        if (!isFailing(a)) {
          if (a.isTest) add('tests-pass', 1, `\`${a.label}\` passes after failing`)
          else add('command-succeeded', 1, `\`${a.label}\` succeeds after failing`)
        } else if (was !== undefined && now !== undefined && now.failed < was.failed) {
          const fixed = was.names.filter(name => !now.names.includes(name))
          add(
            'tests-fixed',
            0.7,
            fixed[0] === undefined
              ? `Failing tests went from ${was.failed} to ${now.failed}`
              : `Previously failing test now passes: ${fixed[0]}`,
          )
        } else if (a.failure !== undefined && a.failure !== before.failure && !seenFailures.has(a.failure)) {
          add('error-changed', 0.5, `The error changed: "${a.failureHeadline ?? a.failure}"`)
        }
      } else if (before !== undefined && !isFailing(a) && a.tests !== undefined && before.tests !== undefined) {
        if (a.tests.passed > before.tests.passed) {
          add('new-tests-pass', 0.4, `${a.tests.passed - before.tests.passed} more tests pass`)
        }
      }
      lastRun.set(a.target, a)
    }

    if (a.kind === 'edit' && a.area !== undefined && seenAreas.size > 0 && !seenAreas.has(a.area)) {
      add('moved-on', 0.6, `Moved on to ${a.area}`)
    }
    if (a.area !== undefined) seenAreas.add(a.area)
    if (a.failure !== undefined) seenFailures.add(a.failure)
  }
  return events
}

// ---------------------------------------------------------------------------
// Repetition structures

type BlockCycle = { block: LoopAction[]; copies: number }

/** A block of 2..6 actions repeating back to back at the end (one mismatch per three steps allowed). */
function findBlockCycle(actions: readonly LoopAction[]): BlockCycle | undefined {
  const sigs = actions.map(a => a.sig)
  for (let k = 2; k <= MAX_CYCLE; k++) {
    const block = sigs.slice(-k)
    if (block.length < k || new Set(block).size < 2) continue
    const tolerance = Math.floor(k / 3)
    let copies = 1
    for (;;) {
      const start = sigs.length - k * (copies + 1)
      if (start < 0) break
      const mismatches = sigs.slice(start, start + k).filter((sig, at) => sig !== block[at]).length
      if (mismatches > tolerance) break
      copies += 1
    }
    if (copies >= 2) return { block: actions.slice(-k), copies }
  }
  return undefined
}

/** Edits that put back what an earlier edit to the same file replaced, or rewrite it to an earlier content. */
function countReverts(edits: readonly LoopAction[]): number {
  let reverts = 0
  edits.forEach((edit, at) => {
    if (edit.change === undefined) return
    const earlier = edits.slice(0, at).filter(e => e.target === edit.target)
    const [before, after] = edit.change.split('>')
    const isUndo =
      after === undefined
        ? earlier.slice(0, -1).some(e => e.change === edit.change) && earlier.at(-1)?.change !== edit.change
        : earlier.some(e => e.change === `${after}>${before}`)
    if (isUndo) reverts += 1
  })
  return reverts
}

type Attempt = { run: LoopAction; files: LoopAction[] }
type AttemptChain = { attempts: Attempt[]; run: LoopAction; files: string[]; isSameFailure: boolean }

/**
 * The trailing run of similar attempts at one check: edits, then the same
 * command, failing with an error already seen (the first attempt of the chain
 * may be the one that first produced it), all within a small set of files.
 * Edits that differ in content still count: it is the approach going round,
 * not the exact tool call.
 */
function findAttemptChain(episode: readonly LoopAction[], firstSeen: ReadonlyMap<string, number>): AttemptChain | undefined {
  const isNovel = (a: LoopAction) => a.failure !== undefined && firstSeen.get(a.failure) === a.seq
  let best: AttemptChain | undefined

  for (const runs of groupBy(episode.filter(a => a.kind === 'run'), a => a.target).values()) {
    const attempts: Attempt[] = []
    let from = (episode[0]?.seq ?? 0) - 1
    for (const run of runs) {
      const files = episode.filter(a => a.kind === 'edit' && a.seq > from && a.seq < run.seq)
      if (files.length > 0) attempts.push({ run, files })
      from = run.seq
    }

    const latest = attempts.at(-1)
    if (latest === undefined || !isFailing(latest.run) || runs.at(-1) !== latest.run) continue
    const chain = [latest]
    const union = new Set(latest.files.map(f => f.target))
    if (!isNovel(latest.run)) {
      for (let at = attempts.length - 2; at >= 0; at--) {
        const attempt = attempts[at]
        if (attempt === undefined || !isFailing(attempt.run)) break
        const widened = new Set([...union, ...attempt.files.map(f => f.target)])
        if (widened.size > SMALL_FILE_SET) break
        widened.forEach(target => union.add(target))
        chain.unshift(attempt)
        if (isNovel(attempt.run)) break
      }
    }

    if (best === undefined || chain.length > best.attempts.length) {
      // The files the approach keeps coming back to: those changed in two or more attempts
      // (a test file written once at the start is not part of the loop), else all of them.
      const edits = chain.flatMap(attempt => attempt.files)
      const revisited = chain.length < 2 ? [] : edits.filter(edit => chain.filter(a => a.files.some(f => f.target === edit.target)).length >= 2)
      best = {
        attempts: chain,
        run: latest.run,
        files: filesByCount(revisited.length > 0 ? revisited : edits),
        isSameFailure: chain.every(attempt => attempt.run.failure === latest.run.failure),
      }
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// The assessment

function reading(id: SignalId, value: number, detail: string): SignalReading {
  return { id, label: SIGNAL_LABELS[id], value: pct(value), detail }
}

export function assess(history: readonly LoopAction[], t: Thresholds = DEFAULTS): LoopAssessment {
  const window = history.slice(-WINDOW)
  const progress = findProgress(window)
  const strong = progress.filter(event => event.strength >= 1).at(-1)
  const episodeStart = strong?.seq ?? (window[0]?.seq ?? 1) - 1
  const episode = window.filter(a => a.seq > episodeStart && a.kind !== 'task')
  const newest = window.at(-1)?.seq ?? 0

  const firstSeen = new Map<string, number>()
  for (const a of window) if (a.failure !== undefined && !firstSeen.has(a.failure)) firstSeen.set(a.failure, a.seq)

  // 1. Action repetition: re-doing earlier actions, exact duplicates, a block of steps going round.
  const sigs = episode.map(a => a.sig)
  const repeats = episode.filter((a, at) => sigs.indexOf(a.sig) < at).length
  const exact = episode.filter((a, at) => episode.findIndex(b => b.sig === a.sig && b.call === a.call) < at).length
  const identical = episode.filter(
    (a, at) =>
      a.outputHash !== undefined &&
      episode.findIndex(b => b.sig === a.sig && b.outputHash === a.outputHash) < at,
  ).length
  const block = findBlockCycle(episode)
  const s1 = Math.max(
    (episode.length === 0 ? 0 : repeats / episode.length) * ramp(episode.length, 3, 10),
    ramp(block?.copies ?? 1, 1, 1 + t.cycleRepeats),
    ramp(exact, 0, 3),
  )
  const blockSteps = block?.block.map(stepOf) ?? []
  const s1Detail =
    block !== undefined
      ? `A ${block.block.length}-step sequence repeated ${block.copies} times: ${blockSteps.map(s => s.short).join(' → ')}`
      : exact >= 2
        ? `${exact} tool calls exactly repeated earlier ones`
        : `${repeats} of the last ${episode.length} actions repeat earlier ones`

  // 2. Command repetition.
  const runGroups = groupBy(
    episode.filter(a => a.kind === 'run'),
    a => a.target,
  )
  const topRun = topGroup(runGroups)
  const runCount = topRun?.items.length ?? 0
  const topRunLast = topRun?.items.at(-1)
  const isSameOutput = runCount >= 2 && new Set(topRun?.items.map(a => a.outputHash)).size === 1
  const s2 = ramp(runCount, 1, t.commandRepeats)
  const s2Detail =
    topRunLast === undefined
      ? 'No command ran more than once'
      : `\`${topRunLast.label}\` ran ${runCount} time${runCount === 1 ? '' : 's'}${isSameOutput ? ' with identical output' : ''}`

  // 3. File repetition.
  const edits = episode.filter(a => a.kind === 'edit')
  const topFile = topGroup(groupBy(edits, a => a.target))
  const fileCount = topFile?.items.length ?? 0
  const fileLabel = topFile?.items.at(-1)?.label
  const s3 = ramp(fileCount, 1, t.fileEdits)
  const s3Detail =
    fileLabel === undefined ? 'No file was modified' : `${fileLabel} modified ${fileCount} time${fileCount === 1 ? '' : 's'}`

  // 4. Error repetition.
  const topFailure = topGroup(groupBy(episode.filter(a => a.failure !== undefined), a => a.failure ?? ''))
  const failureCount = topFailure?.items.length ?? 0
  const failureHeadline = topFailure?.items.at(-1)?.failureHeadline
  const s4 = ramp(failureCount, 1, t.failureRepeats)
  const s4Detail =
    failureHeadline === undefined
      ? 'No failures'
      : `Same failure seen ${failureCount} time${failureCount === 1 ? '' : 's'}: "${failureHeadline}"`

  // 5. Test-result repetition: the same failing tests, run after run.
  const testRuns = episode.filter(a => testsSignature(a) !== undefined)
  const testRepeats = testRuns.filter((a, at) => testRuns.findIndex(b => testsSignature(b) === testsSignature(a)) < at).length
  const topTests = topGroup(groupBy(testRuns, a => testsSignature(a) ?? ''))
  const topTestsRun = topTests?.items.at(-1)
  const s5 = ramp(testRepeats, 0, t.failureRepeats - 1)
  const s5Detail =
    topTestsRun?.tests === undefined
      ? 'No repeated test results'
      : `The same ${topTestsRun.tests.failed} failing test${topTestsRun.tests.failed === 1 ? '' : 's'} in ${topTests?.items.length ?? 0} runs`

  // 6. Similar edit → test → failure attempts, and edits that undo earlier edits.
  const chain = findAttemptChain(episode, firstSeen)
  const chainLength = chain?.attempts.length ?? 0
  const reverts = countReverts(edits)
  const s6 = Math.max(ramp(chainLength, 1, 1 + t.cycleRepeats), ramp(reverts, 0, 2))
  const s6Detail =
    chain !== undefined && chainLength >= 2
      ? `${chainLength} similar attempts (modify ${chain.files.join(', ')} → ${chain.run.label}) ended with ${
          chain.isSameFailure ? 'the same failure' : 'failures already seen'
        }`
      : reverts > 0
        ? `${reverts} edit${reverts === 1 ? '' : 's'} undid an earlier edit`
        : 'No repeated attempts'

  // 7. Lack of observable progress: actions since the last progress, and how many told nothing new.
  const lastProgress = progress.at(-1)
  const since = window.filter(a => a.seq > (lastProgress?.seq ?? episodeStart) && a.kind !== 'task')
  const stale = since.filter(
    (a, at) =>
      isFailing(a) ||
      (a.outputHash !== undefined && since.findIndex(b => b.sig === a.sig && b.outputHash === a.outputHash) < at),
  ).length
  const s7 =
    stale > 0 ? Math.max(ramp(stale, 0, 3), ramp(since.length, 4, 20)) : 0.6 * ramp(since.length, 6, 24)
  const s7Detail =
    since.length === 0
      ? lastProgress === undefined
        ? 'Nothing observed yet'
        : `Progress just now: ${lastProgress.detail}`
      : `No observable progress for ${since.length} action${since.length === 1 ? '' : 's'}${
          stale > 0 ? ` (${stale} failed or repeated an earlier result)` : ''
        }${lastProgress === undefined ? '' : `; last progress: ${lastProgress.detail}`}`

  const repetition = 0.5 * Math.max(s1, s2, s3) + 0.5 * mean([s1, s2, s3])
  // The same successful output again is a weaker "same result" than the same failure again.
  const sameOutput = 0.6 * ramp(identical, 0, 3)
  const sameResult = 0.6 * Math.max(s4, s5, s6, sameOutput) + 0.4 * mean([s4, s5, s6])
  const stagnation = 0.55 * sameResult + 0.45 * s7
  const recentWeak = progress.filter(
    event => event.strength < 1 && event.seq > episodeStart && event.seq > newest - RECENT_PROGRESS,
  )
  const decay = recentWeak.reduce((factor, event) => factor * (1 - 0.5 * event.strength), 1)
  const score = Math.round(100 * repetition * (0.25 + 0.75 * stagnation) * decay)

  const signals = [
    reading('action-repetition', s1, s1Detail),
    reading('command-repetition', s2, s2Detail),
    reading('file-repetition', s3, s3Detail),
    reading('error-repetition', s4, s4Detail),
    reading('test-result-repetition', s5, s5Detail),
    reading('attempt-cycle', s6, s6Detail),
    reading('no-progress', s7, s7Detail),
  ]

  // The story: what is going round, step by step.
  let cycle: LoopCycle | null = null
  let pattern = ''
  let approach = ''
  let anchor = ''
  const plain = (a: LoopAction): string => (a.kind === 'run' ? a.label : stepOf(a).short)
  if (chain !== undefined && chainLength >= 2) {
    const sameFailureRuns = episode.filter(a => a.target === chain.run.target && a.failure === chain.run.failure).length
    cycle = {
      steps: [`Modify ${chain.files.join(', ')}`, `Run ${chain.run.label}`, chain.isSameFailure ? 'Receive same failure' : 'Receive a failure seen before'],
      kinds: ['edit', chain.run.isTest ? 'test' : 'run', 'failure'],
      occurrences: Math.max(chainLength, sameFailureRuns),
    }
    pattern = `${chain.files.join(', ')} → ${runLabel(chain.run)} → same failure`
    approach = `${chain.files.join(', ')} → ${chain.run.label} → same failure`
    anchor = `chain:${chain.run.target}:${chain.run.failure ?? ''}`
  } else if (block !== undefined) {
    const lastRun = [...block.block].reverse().find(a => a.kind === 'run')
    const ends = lastRun !== undefined && isFailing(lastRun)
    cycle = {
      steps: [...blockSteps.map(s => s.step), ...(ends ? ['Receive same failure'] : [])],
      kinds: [...blockSteps.map(s => s.kind), ...(ends ? ['failure'] : [])],
      occurrences: block.copies,
    }
    pattern = blockSteps.map(s => s.short).join(' → ') + (ends ? ' → same failure' : '')
    approach = block.block.map(plain).join(' → ') + (ends ? ' → same failure' : '')
    anchor = `block:${[...new Set(block.block.map(a => a.sig))].sort().join('|')}`
  } else if (s4 >= Math.max(s2, s3) && failureHeadline !== undefined && failureCount >= 2) {
    const source = topFailure?.items.at(-1)
    pattern = `${source === undefined ? 'a call' : stepOf(source).short} → same failure`
    approach = `${source === undefined ? 'a call' : plain(source)} → same failure`
    anchor = `failure:${topFailure?.key ?? ''}`
  } else if (s2 >= s3 && topRunLast !== undefined && runCount >= 2) {
    pattern = `${runLabel(topRunLast)}${isSameOutput ? ' → same result' : ''}`
    approach = `${topRunLast.label}${isSameOutput ? ' → same result' : ''}`
    anchor = `command:${topRunLast.target}`
  } else if (fileLabel !== undefined && fileCount >= 2) {
    pattern = `modify ${fileLabel}`
    approach = pattern
    anchor = `file:${topFile?.key ?? ''}`
  }
  const repetitions =
    cycle?.occurrences ?? Math.max(failureCount >= 2 ? failureCount : 0, runCount >= 2 ? runCount : 0, fileCount >= 2 ? fileCount : 0)

  const failureKey = chain?.run.failure ?? topFailure?.key
  const key = anchor === '' ? 'none' : hash(anchor)
  const family = failureKey !== undefined && (failureCount >= 2 || chainLength >= 2) ? `f:${hash(failureKey)}` : key

  const reasons = signals
    .filter(signal => signal.id !== 'no-progress' && signal.value >= 50)
    .sort((a, b) => b.value - a.value)
    .map(signal => signal.detail)
  if (s7 >= 0.5) reasons.push(s7Detail)
  if (decay < 1) reasons.push(`Recent progress lowered the score: ${recentWeak.map(e => e.detail).join('; ')}`)

  const topTestsFailed = topTestsRun?.tests
  return {
    score,
    band: bandOf(score),
    key,
    family,
    pattern,
    approach,
    cycle,
    repetitions,
    signals,
    factors: { repetition: pct(repetition), sameResult: pct(sameResult), noProgress: pct(s7) },
    decay: Math.round(decay * 100) / 100,
    progress,
    episodeStart,
    files: tallies(edits, a => a.target),
    commands: tallies(episode.filter(a => a.kind === 'run'), a => a.target),
    errors: tallies(episode, a => a.failure, a => a.failureHeadline ?? a.label),
    ...(failureHeadline === undefined || failureCount < 2
      ? {}
      : {
          failure: {
            headline: failureHeadline,
            count: failureCount,
            isTest: topFailure?.items.some(a => a.isTest) ?? false,
          },
        }),
    ...(topTestsFailed === undefined || (topTests?.items.length ?? 0) < 2
      ? {}
      : { tests: { failed: topTestsFailed.failed, names: topTestsFailed.names, runs: topTests?.items.length ?? 0 } }),
    reasons,
  }
}
