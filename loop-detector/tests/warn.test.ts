import { describe, expect, test } from 'claude-code/testing'

import type { LoopAssessment, MonitorState } from '../types'
import { decide } from '../hooks/warn'

const EMPTY: MonitorState = { alert: null, suppressions: [] }

function reading(overrides: Partial<LoopAssessment> = {}): LoopAssessment {
  return {
    score: 80,
    band: 'loop',
    key: 'chain:npm test',
    family: 'f:401',
    pattern: 'auth.ts → run tests → same failure',
    approach: 'auth.ts → npm test → same failure',
    cycle: null,
    repetitions: 3,
    signals: [],
    factors: { repetition: 90, sameResult: 90, noProgress: 90 },
    decay: 1,
    progress: [],
    episodeStart: 0,
    files: [],
    commands: [],
    errors: [],
    reasons: [],
    ...overrides,
  }
}

/** Feeds readings in, one action apart, and returns each effect and the final state. */
function run(readings: readonly LoopAssessment[], warnAt: 'suspicious' | 'loop' = 'loop', from: MonitorState = EMPTY) {
  let state = from
  const effects = readings.map((assessment, at) => {
    const decided = decide(state, assessment, at + 1, warnAt)
    state = decided.state
    return decided.effect
  })
  return { effects, state }
}

describe('warnings', () => {
  test('a loop warns once when it reaches the warn band, then follows its numbers', () => {
    const { effects, state } = run([
      reading({ band: 'suspicious', score: 55 }),
      reading({ repetitions: 3 }),
      reading({ repetitions: 4, score: 90 }),
    ])
    expect(effects).toEqual(['none', 'warn', 'refresh'])
    expect(state.alert?.assessment.score).toBe(90)
  })

  test('warning from the suspicious band is a setting', () => {
    expect(run([reading({ band: 'suspicious', score: 55 })], 'suspicious').effects).toEqual(['warn'])
  })

  test('an acknowledged warning stays acknowledged while the loop goes on', () => {
    const shown = run([reading()]).state
    const acknowledged: MonitorState = {
      ...shown,
      alert: shown.alert === null ? null : { ...shown.alert, isAcknowledged: true },
    }
    const { effects, state } = run([reading({ repetitions: 4 }), reading({ repetitions: 5 })], 'loop', acknowledged)
    expect(effects).toEqual(['refresh', 'refresh'])
    expect(state.alert?.isAcknowledged).toBe(true)
  })

  test('a rising band warns again', () => {
    const { effects } = run([reading({ band: 'suspicious', score: 50 }), reading({ band: 'loop' })], 'suspicious')
    expect(effects).toEqual(['warn', 'warn'])
  })

  test('doubled repetitions warn again', () => {
    expect(run([reading({ repetitions: 3 }), reading({ repetitions: 5 }), reading({ repetitions: 6 })]).effects).toEqual([
      'warn',
      'refresh',
      'warn',
    ])
  })

  test('a related reading of the same loop (same failure, another key) does not warn again', () => {
    expect(run([reading(), reading({ key: 'block:edit|run' })]).effects).toEqual(['warn', 'refresh'])
  })

  test('a dip to suspicious keeps the warning; back to normal resolves it', () => {
    const { effects, state } = run([reading(), reading({ band: 'suspicious', score: 60 }), reading({ band: 'normal', score: 10 })])
    expect(effects).toEqual(['warn', 'refresh', 'resolve'])
    expect(state.alert).toBeNull()
  })

  test('another loop replaces the warning', () => {
    const { effects, state } = run([reading(), reading({ key: 'command:git status', family: 'command:git status' })])
    expect(effects).toEqual(['warn', 'warn'])
    expect(state.alert?.assessment.key).toBe('command:git status')
  })

  test('a loop unseen for 15 actions may warn again', () => {
    const quiet = Array.from({ length: 16 }, () => reading({ band: 'normal', score: 0, key: 'none', family: 'none' }))
    expect(run([reading(), ...quiet, reading()]).effects.at(-1)).toBe('warn')
    expect(run([reading(), ...quiet.slice(0, 10), reading()]).effects.at(-1)).toBe('none')
  })
})
