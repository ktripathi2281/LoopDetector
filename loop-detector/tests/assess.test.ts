import { describe, expect, test } from 'claude-code/testing'

import { assess } from '../hooks/assess'
import { history } from './history'

const AUTH = '/repo/src/auth/auth.ts'
const MIDDLEWARE = '/repo/src/auth/authMiddleware.ts'
const TWO_FAILING = ['auth › rejects a missing token', 'auth › rejects an expired token']
const ONE_FAILING = ['auth › rejects a missing token']

describe('repetition + same result + no progress', () => {
  test('edit auth.ts → npm test → the same 2 tests fail, three times: a likely loop', () => {
    const a = assess(history().repeat(3, h => h.edit(AUTH).tests(TWO_FAILING)).actions)

    expect(a.band).toBe('loop')
    expect(a.score).toBeGreaterThanOrEqual(70)
    expect(a.pattern).toBe('auth.ts → run tests → same failure')
    expect(a.cycle).toEqual({
      steps: ['Modify auth.ts', 'Run npm test', 'Receive same failure'],
      kinds: ['edit', 'test', 'failure'],
      occurrences: 3,
    })
    expect(a.tests).toEqual({ failed: 2, names: TWO_FAILING, runs: 3 })
    expect(a.failure).toEqual({ headline: 'Expected: 401, Received: 200', count: 3, isTest: true })
    expect(a.files).toEqual([{ label: 'auth.ts', count: 3 }])
  })

  test('the score climbs with each repetition', () => {
    const h = history()
    const scores: number[] = []
    h.repeat(5, h => scores.push(assess(h.edit(AUTH).tests(TWO_FAILING).actions).score))
    scores.slice(1).forEach((score, at) => expect(score).toBeGreaterThanOrEqual(scores[at] ?? 0))
    expect(scores[0]).toBeLessThan(40)
    expect(scores[4]).toBeGreaterThan(scores[2] ?? 100)
  })

  test('A → B → test → failure: changing two files each time is still one approach going round', () => {
    const a = assess(history().repeat(3, h => h.edit(AUTH).edit(MIDDLEWARE).tests(TWO_FAILING)).actions)
    expect(a.band).toBe('loop')
    expect(a.cycle?.steps[0]).toBe('Modify auth.ts, authMiddleware.ts')
    expect(a.cycle?.occurrences).toBe(3)
  })

  test('alternating between two approaches that end in the same failure is a loop', () => {
    const a = assess(history().repeat(2, h => h.edit(AUTH).tests(ONE_FAILING).edit(MIDDLEWARE).tests(ONE_FAILING)).actions)
    expect(a.band).toBe('loop')
    expect(a.pattern).toBe('auth.ts, authMiddleware.ts → run tests → same failure')
  })

  test('a file written once at the start (the test) is not part of the approach going round', () => {
    const h = history().edit('/repo/src/parse.js').edit('/repo/test/parse.test.js').tests(ONE_FAILING)
    const a = assess(h.repeat(3, h => h.edit('/repo/src/parse.js').tests(ONE_FAILING)).actions)
    expect(a.pattern).toBe('parse.js → run tests → same failure')
    expect(a.cycle?.steps[0]).toBe('Modify parse.js')
  })

  test('edits whose content differs still count: it is the approach that repeats, not the exact call', () => {
    const h = history().repeat(3, (h, round) => h.edit(AUTH, `return ${round}`, `return ${round + 1}`).tests(ONE_FAILING))
    expect(new Set(h.actions.filter(a => a.kind === 'edit').map(a => a.call)).size).toBe(3)
    expect(assess(h.actions).band).toBe('loop')
  })
})

describe('progress', () => {
  test('fail, fail, pass: the pass resets the score', () => {
    const h = history().edit(AUTH).tests(TWO_FAILING).edit(AUTH).tests(TWO_FAILING)
    expect(assess(h.actions).score).toBeGreaterThan(0)

    const a = assess(h.edit(AUTH).tests([]).actions)
    expect(a.score).toBe(0)
    expect(a.band).toBe('normal')
    expect(a.progress.at(-1)).toMatchObject({ kind: 'tests-pass', strength: 1 })
    expect(a.episodeStart).toBe(h.seq)
  })

  test('a pass resets even a long loop', () => {
    const h = history().repeat(5, h => h.edit(AUTH).tests(TWO_FAILING))
    expect(assess(h.actions).band).toBe('loop')
    expect(assess(h.edit(AUTH).tests([]).actions).score).toBe(0)
  })

  test('fewer failing tests each time is progress, not a loop', () => {
    const h = history()
      .edit(AUTH)
      .tests(['auth › a', 'auth › b', 'auth › c'])
      .edit(AUTH)
      .tests(['auth › a', 'auth › b'])
      .edit(AUTH)
      .tests(['auth › a'])
    const a = assess(h.actions)
    expect(a.band).toBe('normal')
    expect(a.progress.map(event => event.kind)).toEqual(['tests-fixed', 'tests-fixed'])
    expect(a.progress[0]?.detail).toBe('Previously failing test now passes: auth › c')
  })

  test('a new error each time (test-driven progress) stays normal', () => {
    const received = ['500', '404', '403', '302']
    const a = assess(history().repeat(4, (h, round) => h.edit(AUTH).tests(ONE_FAILING, { received: received[round] })).actions)
    expect(a.band).toBe('normal')
    expect(a.progress.filter(event => event.kind === 'error-changed')).toHaveLength(3)
  })

  test('flip-flopping between two errors is not progress', () => {
    const received = ['500', '200']
    const a = assess(history().repeat(6, (h, round) => h.edit(AUTH).tests(ONE_FAILING, { received: received[round % 2] })).actions)
    expect(a.progress.filter(event => event.kind === 'error-changed')).toHaveLength(1)
    expect(a.band).toBe('loop')
  })

  test('a completed task resets the score', () => {
    const h = history().todos(0, 3).repeat(3, h => h.edit(AUTH).tests(TWO_FAILING))
    expect(assess(h.actions).band).toBe('loop')
    const a = assess(h.todos(1, 3).actions)
    expect(a.score).toBe(0)
    expect(a.progress.at(-1)).toMatchObject({ kind: 'task-completed', strength: 1 })
  })

  test('moving on to another part of the code lowers the score', () => {
    const h = history().repeat(3, h => h.edit(AUTH).tests(TWO_FAILING))
    const before = assess(h.actions).score
    const after = assess(h.edit('/repo/src/billing/invoice.ts').actions)
    expect(after.score).toBeLessThan(before)
    expect(after.progress.at(-1)?.kind).toBe('moved-on')
    expect(after.decay).toBeLessThan(1)
  })

  test('a failing command that succeeds is progress', () => {
    const h = history().repeat(3, h => h.edit(AUTH).fail('npm run build', "src/auth.ts(3,1): error TS2322: Type 'string' is not assignable"))
    expect(assess(h.actions).band).not.toBe('normal')
    const a = assess(h.edit(AUTH).run('npm run build', 'built in 2.1s').actions)
    expect(a.score).toBe(0)
    expect(a.progress.at(-1)?.kind).toBe('command-succeeded')
  })
})

describe('legitimate repetition stays normal', () => {
  test('writing a file in many edits: repetition alone', () => {
    const a = assess(history().repeat(7, h => h.edit(AUTH)).actions)
    expect(a.band).toBe('normal')
    expect(a.factors.repetition).toBeGreaterThan(50)
    expect(a.factors.sameResult).toBe(0)
  })

  test('running several different tests', () => {
    const h = history()
    for (const name of ['auth', 'users', 'billing', 'search', 'admin']) h.tests([], { command: `npm test -- ${name}` })
    expect(assess(h.actions).score).toBeLessThan(10)
  })

  test('reading around before changing anything', () => {
    const h = history().read('/repo/src/a.ts').read('/repo/src/b.ts').grep('handleAuth').read('/repo/src/c.ts').read('/repo/src/d.ts')
    expect(assess(h.actions).band).toBe('normal')
  })
})

describe('other repetition', () => {
  test('the same command with identical output, again and again, is suspicious', () => {
    const a = assess(history().repeat(4, h => h.run('git status', 'nothing to commit, working tree clean')).actions)
    expect(a.band).toBe('suspicious')
    expect(a.pattern).toBe('run `git status` → same result')
  })

  test('re-reading the same file and search in a circle is suspicious', () => {
    const a = assess(history().repeat(3, h => h.read(AUTH).grep('handleAuth')).actions)
    expect(a.band).toBe('suspicious')
    expect(a.cycle?.occurrences).toBe(3)
  })

  test('the same failing edit, again and again, is suspicious', () => {
    const a = assess(history().read(AUTH).repeat(3, h => h.badEdit(AUTH)).actions)
    expect(a.band).toBe('suspicious')
    expect(a.failure?.count).toBe(3)
  })

  test('edits that undo each other are suspicious', () => {
    const h = history().edit(AUTH, 'A', 'B').edit(AUTH, 'B', 'A').edit(AUTH, 'A', 'B').edit(AUTH, 'B', 'A').edit(AUTH, 'A', 'B')
    const a = assess(h.actions)
    expect(a.band).toBe('suspicious')
    expect(a.signals.find(s => s.id === 'attempt-cycle')?.detail).toBe('4 edits undid an earlier edit')
  })
})

describe('explanations', () => {
  test('every assessment carries all seven signals, in order, each 0-100', () => {
    for (const actions of [[], history().repeat(3, h => h.edit(AUTH).tests(TWO_FAILING)).actions]) {
      const a = assess(actions)
      expect(a.signals.map(s => s.id)).toEqual([
        'action-repetition',
        'command-repetition',
        'file-repetition',
        'error-repetition',
        'test-result-repetition',
        'attempt-cycle',
        'no-progress',
      ])
      for (const signal of a.signals) {
        expect(signal.value).toBeGreaterThanOrEqual(0)
        expect(signal.value).toBeLessThanOrEqual(100)
        expect(signal.detail.length).toBeGreaterThan(0)
      }
    }
  })

  test('a flagged loop says why', () => {
    const a = assess(history().repeat(3, h => h.edit(AUTH).tests(TWO_FAILING)).actions)
    expect(a.reasons).toContain('Same failure seen 3 times: "Expected: 401, Received: 200"')
    expect(a.reasons).toContain('The same 2 failing tests in 3 runs')
    expect(a.reasons).toContain('3 similar attempts (modify auth.ts → npm test) ended with the same failure')
    expect(a.reasons.at(-1)).toBe('No observable progress for 6 actions (3 failed or repeated an earlier result)')
  })

  test('recent progress is named when it lowers the score', () => {
    const h = history().repeat(3, h => h.edit(AUTH).tests(TWO_FAILING)).edit('/repo/src/billing/invoice.ts')
    expect(assess(h.actions).reasons.at(-1)).toBe('Recent progress lowered the score: Moved on to /repo/src/billing')
  })

  test('an empty history is normal and says so', () => {
    const a = assess([])
    expect(a).toMatchObject({ score: 0, band: 'normal', pattern: '', cycle: null, repetitions: 0 })
  })
})
