import { describe, expect, test } from 'claude-code/testing'

import { fingerprintFailure, normalizeCommand, parseTests, toAction } from '../hooks/observe'
import { jestOutput } from './history'

const JEST_401 = jestOutput(['auth › rejects a request without a token'])

describe('commands', () => {
  test('a command is the same command whatever wraps its output', () => {
    expect(normalizeCommand('cd /repo && npm test 2>&1 | tail -n 30')).toBe('npm test')
    expect(normalizeCommand('  npm   test  ')).toBe('npm test')
    expect(normalizeCommand('npm test -- auth')).toBe('npm test -- auth')
  })

  test('the description does not make a call different', () => {
    const a = toAction({ tool: 'Bash', command: 'npm test', description: 'Run tests' }, { text: '' }, 1)
    const b = toAction({ tool: 'Bash', command: 'npm test', description: 'Run the suite again' }, { text: '' }, 2)
    expect(a.call).toBe(b.call)
  })
})

describe('failures', () => {
  test("Jest's Expected/Received pair becomes one headline", () => {
    expect(fingerprintFailure(JEST_401, true)?.headline).toBe('Expected: 401, Received: 200')
  })

  test('timings and line numbers do not make a failure new', () => {
    const later = JEST_401.replace('1.84 s', '2.07 s')
    expect(fingerprintFailure(`${later}\n    at auth.test.ts:15:9`, true)?.key).toBe(
      fingerprintFailure(`${JEST_401}\n    at auth.test.ts:14:23`, true)?.key,
    )
  })

  test('a different assertion is a different failure', () => {
    const other = JEST_401.replace('Received: 200', 'Received: 500')
    expect(fingerprintFailure(other, true)?.key).not.toBe(fingerprintFailure(JEST_401, true)?.key)
  })

  test('a passing run is no failure; a failing test piped through tail still is', () => {
    expect(fingerprintFailure('PASS src/a.test.ts\nTests: 0 failed, 3 passed', false)).toBeUndefined()
    expect(fingerprintFailure(JEST_401, false)?.headline).toBe('Expected: 401, Received: 200')
  })
})

describe('test results', () => {
  test('Jest: counts and failing test names', () => {
    expect(parseTests(jestOutput(['auth › a', 'auth › b'], { passed: 7 }))).toEqual({
      failed: 2,
      passed: 7,
      names: ['auth › a', 'auth › b'],
    })
  })

  test('pytest, Go, mocha and cargo summaries', () => {
    expect(parseTests('FAILED tests/test_auth.py::test_401 - assert 200 == 401\n== 1 failed, 9 passed in 0.4s ==')).toEqual({
      failed: 1,
      passed: 9,
      names: ['tests/test_auth.py::test_401'],
    })
    expect(parseTests('--- FAIL: TestAuth (0.00s)\nFAIL\texample.com/auth')?.names).toEqual(['TestAuth'])
    expect(parseTests('  12 passing (40ms)\n  2 failing')).toMatchObject({ failed: 2, passed: 12 })
    expect(parseTests('test result: FAILED. 10 passed; 2 failed; 0 ignored')).toMatchObject({ failed: 2, passed: 10 })
  })

  test("Node's built-in test runner: crosses and the ℹ summary", () => {
    const output = [
      '✖ returns the numeric id from "user:123" (3.961ms)',
      '✔ returns the numeric id from "user:7" (0.1827ms)',
      'ℹ tests 4',
      'ℹ pass 3',
      'ℹ fail 1',
      '',
      '✖ failing tests:',
      '',
      'test at parseUserId.test.js:7:1',
      '✖ returns the numeric id from "user:123" (3.961ms)',
      '  AssertionError [ERR_ASSERTION]: Expected 123, received 83',
    ].join('\n')
    expect(parseTests(output)).toEqual({ failed: 1, passed: 3, names: ['returns the numeric id from "user:123"'] })
    expect(fingerprintFailure(output, false)?.headline).toBe('AssertionError [ERR_ASSERTION]: Expected 123, received 83')
  })

  test('only test commands are read for test results', () => {
    const output = jestOutput(['auth › a'])
    expect(toAction({ tool: 'Bash', command: 'npm test' }, { text: output, isError: true }, 1).tests?.failed).toBe(1)
    expect(toAction({ tool: 'Bash', command: 'cat log.txt' }, { text: output }, 1).tests).toBeUndefined()
  })
})

describe('actions', () => {
  test('edits know their file, area and change', () => {
    const edit = toAction(
      { tool: 'Edit', file_path: 'C:\\Repo\\src\\auth\\Auth.ts', old_string: 'a', new_string: 'b' },
      { text: 'ok' },
      1,
    )
    expect(edit).toMatchObject({ kind: 'edit', label: 'Auth.ts', target: 'c:/repo/src/auth/auth.ts', area: 'c:/repo/src/auth' })
    expect(edit.change).toBeDefined()
    expect(edit.outputHash).toBeUndefined()
  })

  test('a todo list counts its completed tasks', () => {
    const todos = [
      { content: 'a', activeForm: 'a', status: 'completed' },
      { content: 'b', activeForm: 'b', status: 'in_progress' },
    ]
    expect(toAction({ tool: 'TodoWrite', todos }, { text: '' }, 1)).toMatchObject({ kind: 'task', tasksDone: 1 })
  })
})
