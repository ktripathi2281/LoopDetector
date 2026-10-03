// When to warn. Pure: the monitor state after one more assessment.

import type { Band, LoopAssessment, MonitorState, Suppression } from '../types'

export type Effect = 'warn' | 'refresh' | 'resolve' | 'none'
export type WarnBand = Exclude<Band, 'normal'>

const BANDS: readonly Band[] = ['normal', 'suspicious', 'loop']
export const bandRank = (band: Band): number => BANDS.indexOf(band)

/** A loop that warned and then went unseen for this many actions may warn again. */
const FORGET_AFTER = 15

const isSame = (a: { key: string; family: string }, b: { key: string; family: string }): boolean =>
  a.key === b.key || a.family === b.family

/**
 * A loop warns once, when its score first reaches `warnAt`. It warns again only
 * when its band rises, its repetitions double, or it went unseen for
 * FORGET_AFTER actions and came back. A shown warning follows the loop's
 * numbers until the score falls back to normal or another loop takes over.
 */
export function decide(
  state: MonitorState,
  assessment: LoopAssessment,
  seq: number,
  warnAt: WarnBand,
): { state: MonitorState; effect: Effect } {
  const isActive = assessment.band !== 'normal'
  let suppressions: Suppression[] = state.suppressions
    .map(s => (isActive && isSame(assessment, s) ? { ...s, lastSeenSeq: seq } : s))
    .filter(s => seq - s.lastSeenSeq <= FORGET_AFTER)
  const shown = state.alert
  let alert = shown
  let effect: Effect = 'none'

  if (shown !== null && (!isActive || !isSame(assessment, shown.assessment))) {
    alert = null
    effect = 'resolve'
  }

  const held = suppressions.find(s => isSame(s, assessment))
  const isNews =
    bandRank(assessment.band) >= bandRank(warnAt) &&
    (held === undefined ||
      bandRank(assessment.band) > bandRank(held.band) ||
      assessment.repetitions >= 2 * Math.max(1, held.repetitions))

  if (isNews) {
    alert = { assessment, shownAtSeq: seq, isAcknowledged: false }
    suppressions = [
      ...suppressions.filter(s => s !== held),
      {
        key: assessment.key,
        family: assessment.family,
        band: assessment.band,
        repetitions: assessment.repetitions,
        lastSeenSeq: seq,
      },
    ]
    effect = 'warn'
  } else if (alert !== null && isActive) {
    alert = { ...alert, assessment }
    effect = 'refresh'
  }

  return { state: { alert, suppressions }, effect }
}
