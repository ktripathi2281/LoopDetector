import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderChildren } from 'claude-code'

import type { LoopAction, LoopAssessment, MonitorState, RethinkMode } from '../types'
import { DEFAULTS, KEEP, assess, type Thresholds } from './assess'
import { IGNORED_TOOLS, toAction, type ToolInput, type ToolOutcome } from './observe'
import {
  BAND_COLORS,
  activityLines,
  cardFacts,
  confidenceOf,
  cycleLine,
  indicator,
  meter,
  rethinkMessage,
  whyFlagged,
} from './present'
import { decide, type Effect, type WarnBand } from './warn'

const PANE = 'loop-detector'
const RETHINK_PANE = 'loop-detector-rethink'
const COMMAND = 'loops'
const ACTIVITY_LINES = 8

const actionsAtom = atom({ plugin: 'loop-detector', key: 'actions' } as const, [])
const monitorAtom = atom({ plugin: 'loop-detector', key: 'monitor' } as const, {
  alert: null,
  suppressions: [],
})
const turnAtom = atom({ plugin: 'loop-detector', key: 'turnId' } as const, null)
const rethinkAtom = atom({ plugin: 'loop-detector', key: 'rethink' } as const, null)
const rethinkModeAtom = atom({ plugin: 'loop-detector', key: 'rethinkMode' } as const, null)

const RETHINK_MODES: readonly RethinkMode[] = ['warn', 'confirm', 'inject']
const RETHINK_MODE_NAMES: Record<RethinkMode, string> = {
  warn: 'only warn (draft it in the prompt box)',
  confirm: 'pause and ask for confirmation',
  inject: 'pause and send it at once',
}

type Settings = { thresholds: Thresholds; warnAt: WarnBand; rethink: RethinkMode }

function settingsFrom(options: PluginOptions): Settings {
  const whole = (key: keyof Thresholds): number => {
    const value = options[key]
    return typeof value === 'number' && value >= 1 ? Math.floor(value) : DEFAULTS[key]
  }
  return {
    thresholds: {
      commandRepeats: whole('commandRepeats'),
      fileEdits: whole('fileEdits'),
      failureRepeats: whole('failureRepeats'),
      cycleRepeats: whole('cycleRepeats'),
    },
    warnAt: options.warnAt === 'suspicious' ? 'suspicious' : 'loop',
    rethink: options.rethink === 'confirm' || options.rethink === 'inject' ? options.rethink : 'warn',
  }
}

const suggestionFor = (assessment: LoopAssessment): string =>
  `You seem to be repeating the same approach (${assessment.pattern}, ${assessment.repetitions} times). ` +
  "Stop, explain why it isn't working, and try a different approach."

const HEADLINES = {
  normal: 'No loop detected',
  suspicious: 'Suspicious repetition',
  loop: 'Possible loop detected',
} as const

function commandSummary(actions: readonly LoopAction[], assessment: LoopAssessment): string {
  if (assessment.pattern === '') {
    return `Loop Detector: ${actions.length} tool calls observed, no repetition patterns (loop score ${assessment.score}).`
  }
  return (
    `Loop Detector: ${actions.length} tool calls observed. ` +
    `Strongest: ${assessment.pattern} ×${assessment.repetitions} (loop score ${assessment.score}, ${assessment.band}). ` +
    'Details are in the Loop Detector pane.'
  )
}

// Set by Pause, read when that turn completes; a reload mid-pause only loses the suggestion.
let paused: { turnId: string; suggestion: string } | undefined

async function openInspector($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Loop Detector' })
}

/** Whether a surface of this session draws the band above the prompt (only the terminal and desktop do). */
async function drawsBand($: EngineInterface): Promise<boolean> {
  try {
    return (await $.session.surfaces()).some(surface => surface === 'terminal' || surface === 'desktop')
  } catch {
    return false
  }
}

async function reset($: EngineInterface): Promise<void> {
  await update($, actionsAtom, () => [])
  await update($, monitorAtom, () => ({ alert: null, suppressions: [] }))
  $.ui.status(indicator(assess([]), COMMAND))
}

async function acknowledge($: EngineInterface): Promise<void> {
  await update($, monitorAtom, monitor =>
    monitor.alert === null ? monitor : { ...monitor, alert: { ...monitor.alert, isAcknowledged: true } },
  )
}

/** Ends Claude's running turn (never automatic: only the Pause button calls it). */
async function pause($: EngineInterface, assessment: LoopAssessment): Promise<void> {
  const turnId = await read($, turnAtom)
  await acknowledge($)
  if (turnId === null) {
    $.ui.toast('Nothing to pause: Claude is not working right now.')
    return
  }
  paused = { turnId, suggestion: suggestionFor(assessment) }
  try {
    await $.turn.abort({ turnId })
    $.ui.toast('Paused. Tell Claude what to try differently (Tab takes the suggestion).', {
      timeoutMs: 8000,
    })
  } catch {
    paused = undefined
    $.ui.toast('Could not pause: that turn has already ended.')
  }
}

/** Ends the running turn, if one is; says whether it did. */
async function stopTurn($: EngineInterface): Promise<boolean> {
  const turnId = await read($, turnAtom)
  if (turnId === null) return false
  try {
    await $.turn.abort({ turnId })
    return true
  } catch {
    return false
  }
}

/** Puts the rethink prompt in the prompt box, after anything already typed; the clipboard when there is no box. */
async function draftRethink($: EngineInterface, message: string): Promise<void> {
  const box = await $.prompt.read()
  const isEmpty = box.text.trim() === ''
  const filled = await $.prompt.fill({ text: isEmpty ? message : `\n\n${message}`, mode: isEmpty ? 'replace' : 'append' })
  if (filled.isFilled) {
    $.ui.toast('The rethink prompt is in your prompt box: edit it, or press Enter to send it.', { timeoutMs: 8000 })
    return
  }
  const copied = await $.ui.copy({ text: message })
  $.ui.toast(copied.isCopied ? 'Rethink prompt copied to the clipboard.' : 'Could not place the rethink prompt.')
}

/**
 * Sends the rethink prompt to Claude as a prompt of its own, framed as coming
 * from this plugin; it starts Claude's next turn once the session is idle.
 */
async function sendRethink($: EngineInterface, message: string): Promise<void> {
  try {
    const sent = await $.prompt.submit({ text: message })
    if (sent.drop === undefined) {
      $.ui.toast('Rethink prompt sent to Claude.')
      return
    }
  } catch {
    // Falls through to the draft below.
  }
  await draftRethink($, message)
}

/** The Rethink button: drafts, asks, or sends (as `/loops rethink`, else the setting, says); pauses Claude for the latter two. */
async function rethink($: EngineInterface, assessment: LoopAssessment, setting: RethinkMode): Promise<void> {
  const mode = (await read($, rethinkModeAtom)) ?? setting
  const message = rethinkMessage(assessment)
  await acknowledge($)
  if (mode === 'warn') {
    await draftRethink($, message)
    return
  }
  const wasPaused = await stopTurn($)
  if (mode === 'inject') {
    await sendRethink($, message)
    return
  }
  await update($, rethinkAtom, () => ({ message, wasPaused }))
  await $.ui.open({
    id: RETHINK_PANE,
    title: 'Rethink',
    focus: true,
    closeOnEscape: true,
    holdToasts: true,
    rows: message.split('\n').length + 6,
  })
}

async function answerRethink($: EngineInterface, choice: 'send' | 'edit' | 'cancel'): Promise<void> {
  const pending = await read($, rethinkAtom)
  await update($, rethinkAtom, () => null)
  await $.ui.close({ id: RETHINK_PANE })
  if (pending === null) return
  if (choice === 'send') await sendRethink($, pending.message)
  else if (choice === 'edit') await draftRethink($, pending.message)
  else $.ui.toast(pending.wasPaused ? 'Rethink cancelled. Claude stays paused until your next prompt.' : 'Rethink cancelled.')
}

async function observe($: EngineInterface, input: ToolInput, outcome: ToolOutcome, settings: Settings): Promise<void> {
  // `update` may run its change more than once (a parallel call wrote first); keep the last run's values.
  const last: { action?: LoopAction; effect: Effect } = { effect: 'none' }
  const actions = await update($, actionsAtom, list => {
    const action = toAction(input, outcome, (list.at(-1)?.seq ?? 0) + 1)
    last.action = action
    return [...list, action].slice(-KEEP)
  })
  const seq = last.action?.seq
  if (seq === undefined) return
  const assessment = assess(actions, settings.thresholds)

  const monitor: MonitorState = await update($, monitorAtom, state => {
    const decided = decide(state, assessment, seq, settings.warnAt)
    last.effect = decided.effect
    return decided.state
  })

  $.ui.status(indicator(assessment, COMMAND))
  const { alert } = monitor
  // The card says it where a band is drawn; elsewhere (VS Code, mobile) a toast does.
  if (last.effect === 'warn' && alert !== null && !(await drawsBand($))) {
    $.ui.toast(`Claude may be looping: ${alert.assessment.pattern} ×${alert.assessment.repetitions}`, {
      timeoutMs: 8000,
    })
  }
}

export const register: Register = (on, options) => {
  const settings = settingsFrom(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Loop Detector: inspect repetition (now: Rethink without a click)',
      argumentHint: '[now | reset | rethink warn|confirm|inject]',
      // Runs while Claude is still working, so `/loops now` can interrupt a loop as the button does.
      immediate: true,
    })
    $.ui.status(indicator(assess(await read($, actionsAtom), settings.thresholds), COMMAND))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await reset($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, turnAtom, () => e.turnId)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result

    await update($, turnAtom, () => null)
    const held = paused
    if (held !== undefined && held.turnId === e.turnId) {
      paused = undefined
      // The box takes a suggestion only once the turn is over.
      $.clock.after(300, () => void $.prompt.suggest({ text: held.suggestion }))
    }
    return result
  })

  // Observe every main-loop tool call and its result; the result passes through untouched.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || IGNORED_TOOLS.has(e.tool)) return ran

    try {
      const outcome: ToolOutcome = {
        ...(ran.text === undefined ? {} : { text: ran.text }),
        ...(ran.isError === true ? { isError: true } : {}),
        ...(ran.deny === undefined ? {} : { deny: ran.deny }),
      }
      await observe($, e, outcome, settings)
    } catch (error) {
      $.ui.log(`observe failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
    }
    return ran
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const [verb, value] = e.args.trim().split(/\s+/)
    if (verb === 'reset') {
      await reset($)
      return { text: 'Loop Detector: history cleared.' }
    }
    if (verb === 'now') {
      const assessment = assess(await read($, actionsAtom), settings.thresholds)
      if (assessment.pattern === '') return { text: 'Loop Detector: nothing is repeating right now.' }
      // After the command has answered: a prompt cannot be submitted from inside a command's own run.
      $.clock.after(0, () => void rethink($, assessment, settings.rethink))
      return { text: `Loop Detector: rethink requested for ${assessment.pattern} ×${assessment.repetitions}.` }
    }
    if (verb === 'rethink') {
      const mode = RETHINK_MODES.find(m => m === value)
      if (mode === undefined) {
        const current = (await read($, rethinkModeAtom)) ?? settings.rethink
        return { text: `Loop Detector: Rethink will ${RETHINK_MODE_NAMES[current]}. Use /${COMMAND} rethink warn|confirm|inject.` }
      }
      await update($, rethinkModeAtom, () => mode)
      return { text: `Loop Detector: for this session, Rethink will ${RETHINK_MODE_NAMES[mode]}.` }
    }
    const actions = await read($, actionsAtom)
    await openInspector($)
    return { text: commandSummary(actions, assess(actions, settings.thresholds)) }
  })

  // The warning card, above the prompt while an unacknowledged alert stands.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { alert } = await read($, monitorAtom)
    if (e.props.hasSurvey || alert === null || alert.isAcknowledged) return next(e)

    const turnId = await read($, turnAtom)
    const { Box, Button, Text } = $.ui.resolve(e)
    const { assessment } = alert
    const facts = cardFacts(assessment)
    const cycle = cycleLine(assessment)
    const canPause = e.props.isWorking && turnId !== null
    const buttons = (
      <Box flexDirection="row" gap={1}>
        <Button key="inspect" label="Inspect" hotkey="i" onPress={() => openInspector($)} />
        <Button
          key="rethink"
          label="Rethink"
          hotkey="r"
          variant="primary"
          onPress={() => rethink($, assessment, settings.rethink)}
        />
        {canPause && <Button key="pause" label="Pause" hotkey="p" onPress={() => pause($, assessment)} />}
        <Button key="continue" label="Continue" hotkey="c" onPress={() => acknowledge($)} />
      </Box>
    )

    if (e.props.maxRows < 12) {
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text bold color="yellow">
              ⚠️ Claude may be looping
            </Text>
            <Text dimColor wrap="truncate-end">
              {facts.join(' · ')}
            </Text>
          </Box>
          {cycle !== '' && (
            <Text dimColor wrap="truncate-end">
              Current cycle: {cycle}
            </Text>
          )}
          {buttons}
        </Box>
      )
    }

    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="yellow"
        paddingX={1}
        width={Math.min(e.props.bodyColumns, 56)}
      >
        <Text bold color="yellow">
          ⚠️ Claude may be looping
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {facts.map(fact => (
            <Text>{fact}</Text>
          ))}
        </Box>
        {cycle !== '' && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Current cycle</Text>
            <Text wrap="truncate-end">{cycle}</Text>
          </Box>
        )}
        <Box marginTop={1}>{buttons}</Box>
      </Box>
    )
  })

  // The inspect view: what is repeating, the recent activity, and why it was flagged.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const actions = await read($, actionsAtom)
    const turnId = await read($, turnAtom)
    const assessment = assess(actions, settings.thresholds)
    const isFlagged = assessment.band !== 'normal' && assessment.pattern !== ''
    const why = whyFlagged(assessment)
    const activity = activityLines(actions, ACTIVITY_LINES)
    const rule = '─'.repeat(Math.max(8, Math.min(e.props.bodyColumns, 40)))

    const section = (title: string, ...body: RenderChildren[]) => (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>{title}</Text>
        {body}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Text bold>LOOP DETECTOR</Text>
        <Text dimColor>{rule}</Text>
        <Text bold color={BAND_COLORS[assessment.band]}>
          {HEADLINES[assessment.band]}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Text>Confidence: {confidenceOf(assessment.band)}</Text>
          <Text dimColor>(loop score {assessment.score}/100, a heuristic, not a probability)</Text>
        </Box>

        {isFlagged &&
          section(
            assessment.cycle === null ? 'Repeated pattern:' : 'Repeated cycle:',
            assessment.cycle === null ? (
              <Text>{assessment.pattern}</Text>
            ) : (
              assessment.cycle.steps.map((step, at) => (
                <Text>
                  {at + 1}. {step}
                </Text>
              ))
            ),
          )}
        {isFlagged && (
          <Box marginTop={1}>
            <Text>Occurrences: {assessment.cycle?.occurrences ?? assessment.repetitions}</Text>
          </Box>
        )}
        {isFlagged &&
          assessment.files.length > 0 &&
          section(
            'Files:',
            assessment.files.map(file => <Text>{file.label}</Text>),
          )}
        {isFlagged &&
          assessment.failure !== undefined &&
          section('Repeated failure:', <Text wrap="truncate-end">{assessment.failure.headline}</Text>)}

        {section(
          'Recent activity:',
          activity.length === 0 ? (
            <Text dimColor>No tool calls yet.</Text>
          ) : (
            activity.map(line => (
              <Box flexDirection="row" gap={1}>
                <Text color={line.isOk ? 'green' : 'red'}>{line.isOk ? '✓' : '✗'}</Text>
                <Text wrap="truncate-end">{line.text}</Text>
              </Box>
            ))
          ),
        )}

        {isFlagged &&
          why.length > 0 &&
          section(
            'Why this was flagged:',
            why.map(reason => <Text>• {reason}</Text>),
          )}

        {section(
          'Signals',
          assessment.signals.map(signal => (
            <Box flexDirection="row" gap={1}>
              <Text color={BAND_COLORS[signal.value >= 70 ? 'loop' : signal.value >= 40 ? 'suspicious' : 'normal']}>
                {meter(signal.value)}
              </Text>
              <Text dimColor wrap="truncate-end">
                {signal.label}: {signal.detail}
              </Text>
            </Box>
          )),
        )}

        <Box flexDirection="row" gap={1} marginTop={1}>
          {isFlagged && (
            <Button
              key="rethink"
              label="Rethink"
              variant="primary"
              onPress={() => rethink($, assessment, settings.rethink)}
            />
          )}
          {turnId !== null && isFlagged && <Button key="pause" label="Pause" onPress={() => pause($, assessment)} />}
          <Button key="reset" label="Reset history" onPress={() => reset($)} />
          <Button key="close" label="Close" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })

  // Rethink, when it asks first: the prompt Claude would get, and the person's choice.
  on('ui.render', { component: 'Pane', requestId: RETHINK_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const pending = await read($, rethinkAtom)
    if (pending === null) return <Text dimColor>No rethink prompt is waiting.</Text>

    return (
      <Box flexDirection="column">
        <Text bold>{pending.wasPaused ? 'Claude is paused.' : 'Claude is idle.'} Send this to Claude?</Text>
        <Box flexDirection="column" marginTop={1} paddingX={1} borderStyle="round" borderDimColor>
          {pending.message.split('\n').map(line => (
            <Text>{line === '' ? ' ' : line}</Text>
          ))}
        </Box>
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Button
            key="send"
            label="Send to Claude"
            hotkey="s"
            variant="primary"
            autoFocus
            onPress={() => answerRethink($, 'send')}
          />
          <Button key="edit" label="Edit first" hotkey="e" onPress={() => answerRethink($, 'edit')} />
          <Button key="cancel" label="Cancel" role="dismiss" onPress={() => answerRethink($, 'cancel')} />
        </Box>
      </Box>
    )
  })
}
