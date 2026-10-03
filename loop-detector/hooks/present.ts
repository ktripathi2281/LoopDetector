// The words the UI shows, from an assessment: the live indicator, the
// warning card's facts, the inspect view's activity and "why" bullets. Pure.

import type { Band, LoopAction, LoopAssessment } from '../types'

export const BAND_NAMES: Record<Band, string> = {
  normal: 'Normal',
  suspicious: 'Suspicious',
  loop: 'Possible loop',
}

const BAND_DOTS: Record<Band, string> = { normal: '🟢', suspicious: '🟡', loop: '🔴' }

export const BAND_COLORS: Record<Band, string> = { normal: 'green', suspicious: 'yellow', loop: 'red' }

const CONFIDENCE: Record<Band, string> = { normal: 'Low', suspicious: 'Medium', loop: 'High' }

export const confidenceOf = (band: Band): string => CONFIDENCE[band]

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

/** The status line: always on, one glance. `Loop Detector 🟡 Suspicious · run `git status` → same result ×4` */
export function indicator(a: LoopAssessment, command: string): string {
  const head = `Loop Detector ${BAND_DOTS[a.band]} ${BAND_NAMES[a.band]}`
  if (a.band === 'normal' || a.pattern === '') return head
  return `${head} · ${a.pattern} ×${a.repetitions}${a.band === 'loop' ? ` · /${command}` : ''}`
}

/** The card's two facts: what keeps failing and what keeps changing. */
export function cardFacts(a: LoopAssessment): string[] {
  const facts: string[] = []
  if (a.failure !== undefined) facts.push(`Same ${a.failure.isTest ? 'test failure' : 'error'} × ${a.failure.count}`)
  const file = a.files[0]
  if (file !== undefined) facts.push(`${file.label} modified × ${file.count}`)
  const command = a.commands[0]
  if (a.failure === undefined && command !== undefined) facts.push(`${command.label} ran × ${command.count}`)
  if (facts.length === 0 && a.pattern !== '') facts.push(`${a.pattern} × ${a.repetitions}`)
  return facts.slice(0, 2)
}

/** The cycle by kind, back to where it starts: `edit → test → failure → edit`. */
export function cycleLine(a: LoopAssessment): string {
  const kinds = a.cycle?.kinds ?? []
  const first = kinds[0]
  return first === undefined ? a.pattern : [...kinds, first].join(' → ')
}

const signalValue = (a: LoopAssessment, id: LoopAssessment['signals'][number]['id']): number =>
  a.signals.find(signal => signal.id === id)?.value ?? 0

/** Short, plain bullets for "Why this was flagged", strongest evidence first. */
export function whyFlagged(a: LoopAssessment): string[] {
  const why: string[] = []
  if (a.failure !== undefined) why.push(`Same failure repeated ${a.failure.count} times`)
  if (a.tests !== undefined && a.failure === undefined) {
    why.push(`The same ${plural(a.tests.failed, 'test')} failed in ${a.tests.runs} runs`)
  }
  if (a.cycle !== null && signalValue(a, 'attempt-cycle') >= 50 && a.failure === undefined) {
    why.push(`The same ${a.cycle.steps.length}-step cycle repeated ${a.cycle.occurrences} times`)
  }
  if (a.files.length >= 2) why.push('Same files repeatedly modified')
  else if (a.files[0] !== undefined) why.push(`${a.files[0].label} modified ${a.files[0].count} times`)
  const command = a.commands[0]
  if (command !== undefined && a.failure === undefined && signalValue(a, 'command-repetition') >= 50) {
    why.push(`\`${command.label}\` ran ${command.count} times`)
  }
  if (a.cycle !== null && a.failure === undefined && a.files.length === 0 && signalValue(a, 'action-repetition') >= 50) {
    why.push(`The same calls repeated ${a.cycle.occurrences} times`)
  }
  if (signalValue(a, 'no-progress') >= 50) why.push('No observable progress')
  const recent = a.progress.filter(event => event.seq > a.episodeStart).at(-1)
  if (a.decay < 1 && recent !== undefined) why.push(`Some progress recently (${recent.detail}), so the score was lowered`)
  return why
}

export type ActivityLine = { isOk: boolean; text: string }

function outcomeOf(a: LoopAction): ActivityLine | undefined {
  if (a.tests !== undefined) {
    return a.tests.failed > 0
      ? { isOk: false, text: `${plural(a.tests.failed, 'test')} failed` }
      : { isOk: true, text: `${plural(a.tests.passed, 'test')} passed` }
  }
  if (a.isError || a.failure !== undefined) return { isOk: false, text: a.failureHeadline ?? 'failed' }
  return undefined
}

/** Recent tool calls as the inspect view lists them: a run, then its result on a line of its own. */
export function activityLines(actions: readonly LoopAction[], max: number): ActivityLine[] {
  const lines = actions.flatMap((a): ActivityLine[] => {
    switch (a.kind) {
      case 'edit':
        return [
          a.isError
            ? { isOk: false, text: `Edit ${a.label} — ${a.failureHeadline ?? 'failed'}` }
            : { isOk: true, text: `Edit ${a.label}` },
        ]
      case 'run': {
        const outcome = outcomeOf(a)
        return outcome === undefined ? [{ isOk: true, text: a.label }] : [{ isOk: true, text: a.label }, outcome]
      }
      case 'read':
        return [{ isOk: !a.isError, text: a.tool === 'Read' ? `Read ${a.label}` : a.label }]
      default:
        return [{ isOk: !a.isError, text: a.tool }]
    }
  })
  return lines.slice(-max)
}

/** What Rethink hands Claude: the loop in a few lines, then a request to change approach. */
export function rethinkMessage(a: LoopAssessment): string {
  const lines = [
    'LOOP DETECTED',
    '',
    `You have attempted the following approach ${a.repetitions} times:`,
    '',
    a.approach || a.pattern,
  ]
  if (a.failure !== undefined) lines.push('', 'Same failure:', a.failure.headline)
  if (a.files.length > 0) lines.push('', 'Files repeatedly modified:', ...a.files.map(file => file.label))
  if (signalValue(a, 'no-progress') >= 50) lines.push('', 'No observable progress has occurred.')
  lines.push(
    '',
    'Please stop repeating the current approach and reconsider the underlying assumption. ' +
      'Inspect the relevant code and propose a different approach before making another change.',
  )
  return lines.join('\n')
}

/** A strength as a short bar of ten cells: `▰▰▰▰▰▰▰▱▱▱`. */
export const meter = (value: number): string => {
  const filled = Math.round(Math.max(0, Math.min(100, value)) / 10)
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled)
}
