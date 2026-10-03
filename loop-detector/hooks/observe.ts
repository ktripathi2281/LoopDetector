// One tool call and its result, reduced to what the loop heuristics compare:
// what "the same" means for it, and what its result says (a failure, test
// counts, an output fingerprint). Pure: no `$`, no I/O.

import type { ActionKind, LoopAction, TestResult } from '../types'

export type ToolInput = { readonly tool: string } & Readonly<Record<string, unknown>>
export type ToolOutcome = { text?: string; isError?: boolean; deny?: string }

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const RUN_TOOLS = new Set(['Bash', 'PowerShell'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])
const TASK_TOOLS = new Set(['TodoWrite', 'TaskUpdate'])

/** Bookkeeping tools whose repetition says nothing about the work. */
export const IGNORED_TOOLS = new Set([
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'ScheduleWakeup',
  'Skill',
  'TaskStop',
  'ToolSearch',
])

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g
const CD_PREFIX = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/i
const OUTPUT_SHAPING =
  /\s*(?:2>&1|\|\s*(?:tail|head|less|more|cat|select-object|out-string)\b[^|]*)\s*$/i
const TEST_COMMAND =
  /\b(?:test|tests|spec|jest|vitest|pytest|mocha|rspec|phpunit|unittest|karma|ava|playwright|cypress|ctest)\b/i

/** Failure markers, strongest first: the index is the line's priority. */
const FAILURE_LINES: readonly RegExp[] = [
  /\bexpected\b.*\b(?:received|got|but|actual|to (?:be|equal|have|contain))\b/i,
  /\bassert(?:ion)?(?:error)?\b/i,
  /\b\w*(?:Error|Exception)\b\s*[:(]/,
  /\berror(?:\s+[A-Z]+\d+)?\s*:/i,
  /(?:^|[\s-])(?:FAIL|FAILED|ERROR)\b/,
  /\b[1-9]\d*\s+(?:failed|failing|failures?|errors?)\b/i,
  /[✕✗×✖]\s+\S/,
  /\bpanic(?:ked)?\b|\btraceback\b|\bsegmentation fault\b/i,
  /\b(?:cannot|could not|unable to|failed to)\b|\bnot found\b|\bno such file\b|\bENOENT\b|\bpermission denied\b/i,
  /\bexit(?:ed)? (?:code|status)\s*[1-9]\d*\b/i,
]
/**
 * The markers that make a test run that exited 0 a failure all the same (its
 * exit code lost to `| tail`): assertions, FAIL lines, failure counts, crosses.
 * A bare `Error:` is not one; passing suites log those too.
 */
const TEST_FAILURE_PRIORITIES = new Set([0, 1, 4, 5, 6])
const EXPECTED_LINE = /^[-+]?\s*expected\b/i
const RECEIVED_LINE = /^[-+]?\s*(?:received|actual|got)\b/i

/** `2 failed` (Jest, pytest, cargo), `2 failing` (mocha), `fail 2` (Node's test runner, TAP). */
const FAILED_COUNT = /\b(\d+)\s+(?:failed|failing)\b|\bfail\s+(\d+)\b/gi
const PASSED_COUNT = /\b(\d+)\s+(?:passed|passing)\b|\bpass\s+(\d+)\b/gi
/** Lines naming one failing test: Jest's `●`, a cross (Node's `✖`), pytest's `FAILED`, Go's `--- FAIL:`. */
const FAILING_TEST: readonly RegExp[] = [
  /^●\s+(?!Console\b)(.+)$/,
  /^[✕✗×✖]\s+(?!failing tests:)(.+)$/,
  /^FAILED\s+(\S+)/,
  /^--- FAIL:\s+(\S+)/,
]
const DURATION_SUFFIX = /\s*\(\d+(?:\.\d+)?\s*m?s\)\s*$/

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

export const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** FNV-1a, 32 bits, base 36: a short stable fingerprint. */
export function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

export function normalizePath(path: string): string {
  const slashed = path.trim().replace(/\\/g, '/').replace(/\/+/g, '/')
  return /^[a-z]:\//i.test(slashed) ? slashed.toLowerCase() : slashed
}

export function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? path
}

/** The directory a normalized path sits in: the subsystem it belongs to. */
export function areaOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at <= 0 ? '.' : path.slice(0, at)
}

/** Same command means same work: `cd x &&`, `2>&1` and `| tail -n 20` do not change what ran. */
export function normalizeCommand(command: string): string {
  let text = command.trim().replace(/\s+/g, ' ')
  for (;;) {
    const next = text.replace(CD_PREFIX, '').replace(OUTPUT_SHAPING, '')
    if (next === text) return text
    text = next
  }
}

/** Lowercases a line and blanks what differs between identical runs: timings, clocks, line:col, ids. */
export function normalizeLine(line: string): string {
  return line
    .replace(ANSI, '')
    .toLowerCase()
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|secs?|seconds?|min|minutes?)\b/g, '#t')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\b/g, '#clock')
    .replace(/:\d+(?::\d+)?\b/g, ':#')
    .replace(/\b0x[0-9a-f]+\b/g, '#h')
    .replace(/\b[0-9a-f]{8,}\b/g, '#id')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Output lines, trimmed, with Jest's `Expected: 401` / `Received: 200` pairs joined into one line. */
function outputLines(text: string): string[] {
  const raw = text
    .split(/\r?\n/)
    .map(line => line.replace(ANSI, '').trim())
    .filter(line => line.length > 0)
    .slice(0, 400)
  const lines: string[] = []
  for (let at = 0; at < raw.length; at++) {
    const line = raw[at] ?? ''
    const next = raw[at + 1]
    if (next !== undefined && EXPECTED_LINE.test(line) && RECEIVED_LINE.test(next)) {
      lines.push(`${line}, ${next}`)
      at += 1
    } else {
      lines.push(line)
    }
  }
  return lines
}

export type Failure = { key: string; headline: string }

/** The failure a result shows, if any: its key (the two most telling lines, normalized) and its headline. */
export function fingerprintFailure(text: string, isError: boolean): Failure | undefined {
  const lines = outputLines(text)
  const ranked = lines
    .flatMap((line, at) => {
      const priority = FAILURE_LINES.findIndex(marker => marker.test(line))
      return priority === -1 ? [] : [{ line, at, priority }]
    })
    .filter(hit => isError || TEST_FAILURE_PRIORITIES.has(hit.priority))
    .sort((a, b) => a.priority - b.priority || a.at - b.at)
  const best = ranked[0]

  if (best === undefined) {
    if (!isError) return undefined
    const first = lines[0] ?? '(no output)'
    return { key: normalizeLine(first), headline: clip(first, 100) }
  }

  return {
    key: ranked
      .slice(0, 2)
      .map(hit => normalizeLine(hit.line))
      .join(' | '),
    headline: clip(best.line, 100),
  }
}

function lastCount(pattern: RegExp, text: string): number | undefined {
  let found: number | undefined
  for (const match of text.matchAll(pattern)) found = Number(match[1] ?? match[2])
  return found
}

/** A test runner's summary: failed and passed counts (its last summary line wins) and the failing tests' names. */
export function parseTests(text: string): TestResult | undefined {
  const clean = text.replace(ANSI, '')
  const failed = lastCount(FAILED_COUNT, clean)
  const passed = lastCount(PASSED_COUNT, clean)
  const names = new Set<string>()
  for (const line of clean.split(/\r?\n/)) {
    const trimmed = line.trim()
    for (const marker of FAILING_TEST) {
      const name = marker.exec(trimmed)?.[1]?.replace(DURATION_SUFFIX, '').trim()
      if (name !== undefined && name.length > 0) {
        names.add(clip(name, 120))
        break
      }
    }
  }
  if (failed === undefined && passed === undefined && names.size === 0) return undefined
  return {
    failed: failed ?? names.size,
    passed: passed ?? 0,
    names: [...names].sort().slice(0, 50),
  }
}

function describeChange(input: ToolInput): string | undefined {
  switch (input.tool) {
    case 'Edit':
      return `${hash(str(input.old_string))}>${hash(str(input.new_string))}`
    case 'Write':
      return `w:${hash(str(input.content))}`
    case 'MultiEdit':
      return `m:${hash(JSON.stringify(input.edits ?? null))}`
    case 'NotebookEdit':
      return `n:${hash(`${str(input.cell_id)}\n${str(input.new_source)}`)}`
    default:
      return undefined
  }
}

function tasksDone(input: ToolInput): number {
  if (input.tool === 'TaskUpdate') return input.status === 'completed' ? 1 : 0
  const todos = Array.isArray(input.todos) ? (input.todos as readonly unknown[]) : []
  return todos.filter(
    todo => typeof todo === 'object' && todo !== null && (todo as { status?: unknown }).status === 'completed',
  ).length
}

function describeTarget(input: ToolInput): { kind: ActionKind; target: string; label: string; area?: string } {
  const { tool } = input

  if (EDIT_TOOLS.has(tool)) {
    const path = str(input.file_path) || str(input.notebook_path)
    const target = normalizePath(path)
    return { kind: 'edit', target, label: basename(path), area: areaOf(target) }
  }
  if (RUN_TOOLS.has(tool)) {
    const command = normalizeCommand(str(input.command))
    return { kind: 'run', target: command, label: clip(command, 48) }
  }
  if (READ_TOOLS.has(tool)) {
    if (tool === 'Read') {
      const path = str(input.file_path)
      const target = normalizePath(path)
      const range = input.offset === undefined ? '' : `@${String(input.offset)}`
      return { kind: 'read', target: `${target}${range}`, label: basename(path), area: areaOf(target) }
    }
    const pattern = str(input.pattern)
    const where = normalizePath(str(input.path) || '.')
    return {
      kind: 'read',
      target: `${tool.toLowerCase()}:${pattern}@${where}${str(input.glob)}`,
      label: clip(`${tool.toLowerCase()} ${pattern}`, 48),
    }
  }
  if (TASK_TOOLS.has(tool)) {
    return { kind: 'task', target: tool, label: tool }
  }
  return { kind: 'other', target: `${tool}:${callOf(input)}`, label: tool }
}

/** Hash of the call's own arguments, without what never changes the work (its description, ids). */
function callOf(input: ToolInput): string {
  return hash(
    Object.keys(input)
      .filter(key => key !== 'tool_use_id' && key !== 'agentId' && key !== 'description')
      .sort()
      .map(key => `${key}=${JSON.stringify(input[key])}`)
      .join('&'),
  )
}

export function toAction(input: ToolInput, outcome: ToolOutcome, seq: number): LoopAction {
  const { kind, target, label, area } = describeTarget(input)
  const text = outcome.deny ?? outcome.text ?? ''
  const isError = outcome.deny !== undefined || outcome.isError === true
  const isTest = kind === 'run' && TEST_COMMAND.test(target)
  const failure =
    kind === 'run'
      ? isError || isTest
        ? fingerprintFailure(text, isError)
        : undefined
      : isError
        ? fingerprintFailure(text, true)
        : undefined
  const tests = isTest ? parseTests(text) : undefined
  const change = describeChange(input)

  return {
    seq,
    tool: input.tool,
    kind,
    target,
    label,
    sig: `${kind}:${target}`,
    call: callOf(input),
    ...(area === undefined ? {} : { area }),
    isTest,
    isError,
    ...(failure === undefined
      ? {}
      : {
          failure: kind === 'run' ? `run: ${failure.key}` : `${input.tool}: ${failure.key}`,
          failureHeadline: failure.headline,
        }),
    ...(tests === undefined ? {} : { tests }),
    ...(kind === 'edit' || kind === 'task'
      ? {}
      : { outputHash: hash(text.split(/\r?\n/).map(normalizeLine).join('\n').slice(0, 8000)) }),
    ...(change === undefined ? {} : { change }),
    ...(kind === 'task' ? { tasksDone: tasksDone(input) } : {}),
  }
}
