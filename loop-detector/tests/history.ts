// Builds synthetic tool-call histories the way the tool.call hook records them.

import type { LoopAction } from '../types'
import { toAction, type ToolInput, type ToolOutcome } from '../hooks/observe'

type TestRun = {
  /** Assertion shown for each failing test. */
  expected?: string
  received?: string
  passed?: number
  command?: string
}

/** Jest-style output: `●` per failing test, the Expected/Received pair, the summary line. */
export function jestOutput(failing: readonly string[], run: TestRun = {}): string {
  const passed = run.passed ?? 10
  if (failing.length === 0) {
    return [`PASS src/auth.test.ts`, `Tests:       ${passed} passed, ${passed} total`, 'Time:        1.21 s'].join('\n')
  }
  return [
    'FAIL src/auth.test.ts',
    ...failing.flatMap(name => [
      `  ● ${name}`,
      '    expect(received).toBe(expected)',
      `    Expected: ${run.expected ?? '401'}`,
      `    Received: ${run.received ?? '200'}`,
    ]),
    `Tests:       ${failing.length} failed, ${passed} passed, ${failing.length + passed} total`,
    'Time:        1.84 s',
  ].join('\n')
}

export class History {
  readonly actions: LoopAction[] = []

  private add(input: ToolInput, outcome: ToolOutcome): this {
    this.actions.push(toAction(input, outcome, this.actions.length + 1))
    return this
  }

  get seq(): number {
    return this.actions.length
  }

  edit(file: string, from?: string, to?: string): this {
    const n = this.actions.length + 1
    return this.add(
      { tool: 'Edit', file_path: file, old_string: from ?? `old ${n}`, new_string: to ?? `new ${n}` },
      { text: 'The file has been updated.' },
    )
  }

  badEdit(file: string): this {
    return this.add(
      { tool: 'Edit', file_path: file, old_string: 'x', new_string: 'y' },
      { text: 'String to replace not found in file.', isError: true },
    )
  }

  run(command: string, text = 'ok'): this {
    return this.add({ tool: 'Bash', command }, { text })
  }

  fail(command: string, text: string): this {
    return this.add({ tool: 'Bash', command }, { text: `Exit code 1\n${text}`, isError: true })
  }

  /** `npm test` with these tests failing (none: the suite passes). */
  tests(failing: readonly string[], run: TestRun = {}): this {
    const command = run.command ?? 'npm test'
    const output = jestOutput(failing, run)
    return failing.length === 0 ? this.run(command, output) : this.fail(command, output)
  }

  read(file: string): this {
    return this.add({ tool: 'Read', file_path: file }, { text: `contents of ${file}` })
  }

  grep(pattern: string): this {
    return this.add({ tool: 'Grep', pattern }, { text: 'src/auth.ts' })
  }

  todos(done: number, total: number): this {
    const todos = Array.from({ length: total }, (_, at) => ({
      content: `step ${at + 1}`,
      activeForm: `doing step ${at + 1}`,
      status: at < done ? 'completed' : 'pending',
    }))
    return this.add({ tool: 'TodoWrite', todos }, { text: 'Todos updated' })
  }

  /** Runs `body` `times` times; `body` gets the round number. */
  repeat(times: number, body: (h: this, round: number) => void): this {
    for (let round = 0; round < times; round++) body(this, round)
    return this
  }
}

export const history = (): History => new History()
