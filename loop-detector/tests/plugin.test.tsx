import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

import type { MonitorState } from '../types'

const NPM_TEST_FAILURE = [
  'Exit code 1',
  'FAIL src/auth.test.ts',
  '    Expected: 401',
  '    Received: 200',
  'Tests:       1 failed, 3 passed, 4 total',
].join('\n')

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 24,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 24 },
    view: {},
  },
} as const

const PANE_PROPS = {
  title: 'Loop Detector',
  isFocused: false,
  bodyColumns: 80,
  placement: 'inline',
  scroll: { offset: 0, bodyRows: 60 },
}

const PANE = { component: 'Pane', requestId: 'loop-detector', props: PANE_PROPS as never } as const

/** Reads loop-detector's monitor state back through a command, since a test's `$` has no `state` noun. */
const PEEK = {
  name: 'peek',
  register(on: On) {
    on('command.run', { command: 'peek' }, async $ => {
      const { value } = await $.state.get({ plugin: 'loop-detector', key: 'monitor' })
      return { text: JSON.stringify(value ?? null) }
    })
  },
}

/** A slash command as the person runs it from the prompt. */
const typed = (command: string, args = '') => ({
  command,
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: true, columns: 120 },
})

type World = {
  toasts: string[]
  status: (string | undefined)[]
  aborted: string[]
  opened: string[]
  closed: string[]
  /** What landed in the prompt box, fill by fill. */
  filled: string[]
  /** Prompts the plugin submitted to Claude. */
  submitted: string[]
}

/** Stands for the engine beneath the plugin: `npm test` fails the same way every time, edits land. */
function engine(on: On, surfaces: readonly RenderSurface[] = ['terminal']): World {
  const world: World = { toasts: [], status: [], aborted: [], opened: [], closed: [], filled: [], submitted: [] }
  on('tool.call', ($, e) =>
    e.tool === 'Bash'
      ? { isError: true, result: NPM_TEST_FAILURE, text: NPM_TEST_FAILURE }
      : { result: {} as never, text: 'The file has been updated successfully.' },
  )
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.abort', ($, e) => {
    world.aborted.push(e.turnId)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    world.status.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    world.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    world.closed.push(e.id)
    return { value: undefined }
  })
  on('session.surfaces', () => ({ value: surfaces }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', ($, e) => {
    world.filled.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', ($, e) => {
    world.submitted.push(e.text)
    return { text: e.text }
  })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }) as never)
  return world
}

/** The rethink prompt for the loop `stagnantLoop($, 3)` builds. */
const RETHINK = [
  'LOOP DETECTED',
  '',
  'You have attempted the following approach 4 times:',
  '',
  'auth.ts → npm test → same failure',
  '',
  'Same failure:',
  'Expected: 401, Received: 200',
  '',
  'Files repeatedly modified:',
  'auth.ts',
  '',
  'No observable progress has occurred.',
  '',
  'Please stop repeating the current approach and reconsider the underlying assumption. ' +
    'Inspect the relevant code and propose a different approach before making another change.',
].join('\n')

const RETHINK_PANE = {
  component: 'Pane',
  requestId: 'loop-detector-rethink',
  props: { ...PANE_PROPS, title: 'Rethink', isFocused: true } as never,
} as const

async function monitorOf($: Engine): Promise<MonitorState | null> {
  const { text } = await $.command.run(typed('peek'))
  return JSON.parse(text ?? 'null') as MonitorState | null
}

/** One failing run (when starting), then `rounds` of edit auth.ts → run the tests → the same failure. */
async function stagnantLoop($: Engine, rounds: number, from = 0) {
  const run = () => $.tool.call({ tool: 'Bash', command: 'npm test 2>&1 | tail -30' })
  if (from === 0) await run()
  for (let round = from; round < from + rounds; round++) {
    await $.tool.call({
      tool: 'Edit',
      file_path: '/repo/src/auth.ts',
      old_string: `return ${round}`,
      new_string: `return ${round + 1}`,
    })
    await run()
  }
}

test('tool results pass through untouched', async ($, on) => {
  engine(on)
  const ran = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(ran).toMatchObject({ isError: true, text: NPM_TEST_FAILURE })
})

test('the live indicator goes from green to red as the loop builds', async ($, on) => {
  const world = engine(on)
  await stagnantLoop($, 3)
  expect(world.status[0]).toBe('Loop Detector 🟢 Normal')
  expect(world.status.at(-1)).toBe('Loop Detector 🔴 Possible loop · auth.ts → run tests → same failure ×4 · /loops')
})

test('a likely loop raises the warning card on terminal and desktop', { plugins: [PEEK] }, async ($, on) => {
  const world = engine(on)
  await stagnantLoop($, 3)

  expect((await monitorOf($))?.alert?.assessment).toMatchObject({ band: 'loop', repetitions: 4 })
  // The card says it; no toast where a card is drawn.
  expect(world.toasts).toEqual([])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'loop-detector', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: 'Claude may be looping' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Same test failure × 4' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'auth.ts modified × 3' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Current cycle' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'edit → test → failure → edit' })).toBeDefined()
    // No turn is running in this test, so there is nothing to pause.
    expect((await ui.findAll({ type: 'Button' })).map(button => button.key)).toEqual(['inspect', 'rethink', 'continue'])
    await ui.unmount()
  }
})

test('where no card is drawn (VS Code, mobile), a toast says it once', async ($, on) => {
  const world = engine(on, ['vscode'])
  await stagnantLoop($, 4)
  expect(world.toasts).toEqual(['Claude may be looping: auth.ts → run tests → same failure ×3'])
})

test('Continue hides the card; the same loop stays quiet until it doubles', { plugins: [PEEK] }, async ($, on) => {
  engine(on)
  await stagnantLoop($, 3)

  const ui = await $.ui.mount({ plugin: 'loop-detector', surface: 'terminal', ...BAND })
  await ui.press({ key: 'continue' })
  expect((await monitorOf($))?.alert?.isAcknowledged).toBe(true)
  expect(await ui.find({ type: 'Text', text: 'Claude may be looping' })).toBeUndefined()

  await stagnantLoop($, 1, 3)
  const quiet = await monitorOf($)
  expect(quiet?.alert?.isAcknowledged).toBe(true)
  expect(quiet?.alert?.assessment.repetitions).toBe(5)

  // First warned at ×3: at ×6 it has doubled, which is news.
  await stagnantLoop($, 1, 4)
  const again = await monitorOf($)
  expect(again?.alert?.isAcknowledged).toBe(false)
  expect(again?.alert?.assessment.repetitions).toBe(6)
})

test('Pause ends the running turn, only when pressed, then suggests a change of approach', async ($, on) => {
  const world = engine(on)
  const clock = mock.clock(on)
  const suggestions: string[] = []
  on('turn.complete', () => ({ text: '' }))
  on('prompt.suggest', ($, e) => {
    suggestions.push(e.text)
    return { isShown: true }
  })

  await $.turn.start({ text: 'make the auth test pass', turnId: 'turn-1' })
  await stagnantLoop($, 3)
  expect(world.aborted).toEqual([])

  const ui = await $.ui.mount({ plugin: 'loop-detector', surface: 'terminal', ...BAND })
  expect((await ui.findAll({ type: 'Button' })).map(button => button.key)).toEqual([
    'inspect',
    'rethink',
    'pause',
    'continue',
  ])
  await ui.press({ key: 'pause' })
  expect(world.aborted).toEqual(['turn-1'])

  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: true, turnId: 'turn-1', reason: 'aborted' })
  await clock.advance(300)
  expect(suggestions).toHaveLength(1)
  expect(suggestions[0]).toContain('auth.ts → run tests → same failure, 4 times')
})

test('Rethink, by default (only warn), drafts the summary in the prompt box and leaves Claude running', { plugins: [PEEK] }, async ($, on) => {
  const world = engine(on)
  await $.turn.start({ text: 'make the auth test pass', turnId: 'turn-1' })
  await stagnantLoop($, 3)

  const ui = await $.ui.mount({ plugin: 'loop-detector', surface: 'terminal', ...BAND })
  await ui.press({ key: 'rethink' })
  expect(world.filled).toEqual([RETHINK])
  expect(world.aborted).toEqual([])
  expect(world.submitted).toEqual([])
  expect((await monitorOf($))?.alert?.isAcknowledged).toBe(true)
})

test('Rethink set to confirm pauses Claude and asks before sending', async ($, on) => {
  const world = engine(on)
  expect((await $.command.run(typed('loops', 'rethink confirm'))).text).toBe(
    'Loop Detector: for this session, Rethink will pause and ask for confirmation.',
  )
  await $.turn.start({ text: 'make the auth test pass', turnId: 'turn-1' })
  await stagnantLoop($, 3)

  const band = await $.ui.mount({ plugin: 'loop-detector', surface: 'terminal', ...BAND })
  await band.press({ key: 'rethink' })
  expect(world.aborted).toEqual(['turn-1'])
  expect(world.opened).toEqual(['loop-detector-rethink'])
  expect(world.submitted).toEqual([])

  const dialog = await $.ui.mount({ plugin: 'loop-detector', surface: 'terminal', ...RETHINK_PANE })
  expect(await dialog.find({ type: 'Text', text: 'Claude is paused. Send this to Claude?' })).toBeDefined()
  expect(await dialog.find({ type: 'Text', text: 'auth.ts → npm test → same failure' })).toBeDefined()
  await dialog.press({ key: 'send' })
  expect(world.submitted).toEqual([RETHINK])
  expect(world.closed).toEqual(['loop-detector-rethink'])
})

test('in the confirm dialog, Edit first drafts it and Cancel sends nothing', async ($, on) => {
  const world = engine(on)
  await $.command.run(typed('loops', 'rethink confirm'))
  await stagnantLoop($, 3)

  const band = await $.ui.mount({ plugin: 'loop-detector', surface: 'desktop', ...BAND })
  await band.press({ key: 'rethink' })
  const dialog = await $.ui.mount({ plugin: 'loop-detector', surface: 'desktop', ...RETHINK_PANE })
  expect(await dialog.find({ type: 'Text', text: 'Claude is idle. Send this to Claude?' })).toBeDefined()
  await dialog.press({ key: 'edit' })
  expect(world.filled).toEqual([RETHINK])
  await band.unmount()
  await dialog.unmount()

  await stagnantLoop($, 3, 3)
  await (await $.ui.mount({ plugin: 'loop-detector', surface: 'desktop', ...BAND })).press({ key: 'rethink' })
  await (await $.ui.mount({ plugin: 'loop-detector', surface: 'desktop', ...RETHINK_PANE })).press({ key: 'cancel' })
  expect(world.submitted).toEqual([])
  expect(world.toasts.at(-1)).toBe('Rethink cancelled.')
})

test('Rethink set to inject pauses Claude and sends the summary at once', async ($, on) => {
  const world = engine(on)
  await $.command.run(typed('loops', 'rethink inject'))
  await $.turn.start({ text: 'make the auth test pass', turnId: 'turn-1' })
  await stagnantLoop($, 3)

  await (await $.ui.mount({ plugin: 'loop-detector', surface: 'terminal', ...BAND })).press({ key: 'rethink' })
  expect(world.aborted).toEqual(['turn-1'])
  expect(world.submitted).toEqual([RETHINK])
  expect(world.opened).toEqual([])
  expect(world.toasts.at(-1)).toBe('Rethink prompt sent to Claude.')
})

test('Rethink set to inject while Claude is idle just sends', async ($, on) => {
  const world = engine(on)
  await $.command.run(typed('loops', 'rethink inject'))
  await stagnantLoop($, 3)

  await (await $.ui.mount({ plugin: 'loop-detector', surface: 'terminal', ...BAND })).press({ key: 'rethink' })
  expect(world.aborted).toEqual([])
  expect(world.submitted).toEqual([RETHINK])
})

test('a short band draws the card in three lines', async ($, on) => {
  engine(on)
  await stagnantLoop($, 3)

  const ui = await $.ui.mount({
    plugin: 'loop-detector',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { ...BAND.props, maxRows: 6, scroll: { offset: 0, bodyRows: 6 } },
  })
  expect(await ui.find({ type: 'Text', text: 'Same test failure × 4 · auth.ts modified × 3' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Current cycle: edit → test → failure → edit' })).toBeDefined()
})

test('Inspect opens the detailed view', async ($, on) => {
  const world = engine(on)
  await stagnantLoop($, 3)

  const ui = await $.ui.mount({ plugin: 'loop-detector', surface: 'desktop', ...BAND })
  await ui.press({ key: 'inspect' })
  expect(world.opened).toEqual(['loop-detector'])
})

test('the detailed view explains the loop on every surface', async ($, on) => {
  engine(on)
  await stagnantLoop($, 3)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'loop-detector', surface, ...PANE })
    for (const text of [
      'LOOP DETECTOR',
      'Possible loop detected',
      'Confidence: High',
      'Repeated cycle:',
      '1. Modify auth.ts',
      '2. Run npm test',
      '3. Receive same failure',
      'Occurrences: 4',
      'Files:',
      'Repeated failure:',
      'Expected: 401, Received: 200',
      'Recent activity:',
      '1 test failed',
      'Why this was flagged:',
      '• Same failure repeated 4 times',
      '• auth.ts modified 3 times',
      '• No observable progress',
    ]) {
      expect(await ui.find({ type: 'Text', text }), `${surface}: ${text}`).toBeDefined()
    }
    expect(await ui.findAll({ type: 'Text', text: /^Lack of observable progress: / })).toHaveLength(1)
    await ui.unmount()
  }
})

test('the detailed view of a quiet session says so', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ plugin: 'loop-detector', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'No loop detected' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'No tool calls yet.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Why this was flagged:' })).toBeUndefined()
})

test('/loops summarizes and /loops reset clears', { plugins: [PEEK] }, async ($, on) => {
  const world = engine(on)
  await stagnantLoop($, 3)

  const { text } = await $.command.run(typed('loops'))
  expect(text).toContain('Strongest: auth.ts → run tests → same failure ×4 (loop score')
  expect(world.opened).toEqual(['loop-detector'])

  expect((await $.command.run(typed('loops', 'reset'))).text).toBe('Loop Detector: history cleared.')
  expect(await monitorOf($)).toEqual({ alert: null, suppressions: [] })
  expect(world.status.at(-1)).toBe('Loop Detector 🟢 Normal')
})
