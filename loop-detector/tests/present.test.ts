import { describe, expect, test } from 'claude-code/testing'

import { assess } from '../hooks/assess'
import { activityLines, cardFacts, cycleLine, indicator, meter, rethinkMessage, whyFlagged } from '../hooks/present'
import { history } from './history'

const AUTH = '/repo/src/auth/auth.ts'
const MIDDLEWARE = '/repo/src/auth/authMiddleware.ts'
const TWO_FAILING = ['auth › rejects a missing token', 'auth › rejects an expired token']

/** The loop from the brief: auth.ts (and its middleware) → npm test → the same 2 tests fail, five times. */
const loop = () =>
  history().repeat(5, (h, round) => {
    h.edit(AUTH)
    if (round % 2 === 1) h.edit(MIDDLEWARE)
    h.tests(TWO_FAILING)
  })

describe('live indicator', () => {
  test('green, yellow, red', () => {
    expect(indicator(assess([]), 'loops')).toBe('Loop Detector 🟢 Normal')
    expect(indicator(assess(history().repeat(4, h => h.run('git status', 'clean')).actions), 'loops')).toBe(
      'Loop Detector 🟡 Suspicious · run `git status` → same result ×4',
    )
    expect(indicator(assess(loop().actions), 'loops')).toBe(
      'Loop Detector 🔴 Possible loop · auth.ts, authMiddleware.ts → run tests → same failure ×5 · /loops',
    )
  })
})

describe('warning card', () => {
  test('two facts and the cycle', () => {
    const a = assess(loop().actions)
    expect(cardFacts(a)).toEqual(['Same test failure × 5', 'auth.ts modified × 5'])
    expect(cycleLine(a)).toBe('edit → test → failure → edit')
  })

  test('a repeated command with no failure says how often it ran', () => {
    expect(cardFacts(assess(history().repeat(4, h => h.run('git status', 'clean')).actions))).toEqual(['git status ran × 4'])
  })
})

describe('inspect view', () => {
  test('why this was flagged, in plain words', () => {
    expect(whyFlagged(assess(loop().actions))).toEqual([
      'Same failure repeated 5 times',
      'Same files repeatedly modified',
      'No observable progress',
    ])
  })

  test('recent activity: each run, then its result', () => {
    const h = history().edit(AUTH).tests(TWO_FAILING).edit(AUTH).tests([])
    expect(activityLines(h.actions, 10)).toEqual([
      { isOk: true, text: 'Edit auth.ts' },
      { isOk: true, text: 'npm test' },
      { isOk: false, text: '2 tests failed' },
      { isOk: true, text: 'Edit auth.ts' },
      { isOk: true, text: 'npm test' },
      { isOk: true, text: '10 tests passed' },
    ])
    expect(activityLines(h.actions, 2)).toHaveLength(2)
  })

  test('a failed edit says why', () => {
    expect(activityLines(history().badEdit(AUTH).actions, 5)).toEqual([
      { isOk: false, text: 'Edit auth.ts — String to replace not found in file.' },
    ])
  })

  test('the rethink prompt Claude receives', () => {
    expect(rethinkMessage(assess(loop().actions))).toBe(
      [
        'LOOP DETECTED',
        '',
        'You have attempted the following approach 5 times:',
        '',
        'auth.ts, authMiddleware.ts → npm test → same failure',
        '',
        'Same failure:',
        'Expected: 401, Received: 200',
        '',
        'Files repeatedly modified:',
        'auth.ts',
        'authMiddleware.ts',
        '',
        'No observable progress has occurred.',
        '',
        'Please stop repeating the current approach and reconsider the underlying assumption. ' +
          'Inspect the relevant code and propose a different approach before making another change.',
      ].join('\n'),
    )
  })

  test('signal meters', () => {
    expect(meter(0)).toBe('▱▱▱▱▱▱▱▱▱▱')
    expect(meter(86)).toBe('▰▰▰▰▰▰▰▰▰▱')
    expect(meter(100)).toBe('▰▰▰▰▰▰▰▰▰▰')
  })
})
