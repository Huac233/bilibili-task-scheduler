/**
 * The day boundary.
 *
 * "Today" for this system means Asia/Shanghai's today, not the container's.
 * Douyu resets its daily obligations on that clock — the check-in answers "当天
 * 已经领过鱼丸" and the TV check-in only opens after 19:00 local — so a container
 * running UTC, which is the default in Docker, would roll over eight hours late
 * and re-run a day's work it had already done.
 *
 * This is a fixed constant rather than a setting on purpose: every endpoint it
 * describes is on Chinese local time, so making it configurable would only offer
 * a way to get it wrong.
 */
export const DAY_TIME_ZONE = 'Asia/Shanghai'

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: DAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
})

const hourFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: DAY_TIME_ZONE,
  hour: '2-digit',
  hour12: false
})

const offsetFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: DAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
})

/** `YYYY-MM-DD` in the Platform's timezone — the key a daily action resets on. */
export function dayKeyOf(now: number): string {
  return dayFormatter.format(new Date(now))
}

/**
 * The instant the Platform's current day began, as epoch milliseconds.
 *
 * Needed to ask "what did we already settle today?" as a **range query** instead of
 * by reading the newest N rows. A task whose action is retrying in a loop fills any
 * fixed-size window with its own entries, pushing an earlier, already-settled action
 * out of view — and then the scheduler asks the Platform about it again. The question
 * the caller actually has is bounded by the day, so it is asked that way.
 *
 * Asia/Shanghai observes no daylight saving, but this does not assume that: the zone
 * offset is read from `Intl` for the instant in question, so pointing
 * `DAY_TIME_ZONE` at a zone that does observe it stays correct.
 */
export function startOfPlatformDay(now: number): number {
  const [yearText, monthText, dayText] = dayKeyOf(now).split('-')
  const year = Number.parseInt(yearText ?? '', 10)
  const month = Number.parseInt(monthText ?? '', 10)
  const day = Number.parseInt(dayText ?? '', 10)
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month) || !Number.isSafeInteger(day)) return now

  const midnightUtc = Date.UTC(year, month - 1, day)
  return midnightUtc - zoneOffsetMs(midnightUtc)
}

/** The zone's offset from UTC at one instant, in milliseconds. */
function zoneOffsetMs(instant: number): number {
  const parts = offsetFormatter.formatToParts(new Date(instant))
  const read = (type: string): number => {
    const found = parts.find(part => part.type === type)
    return found === undefined ? 0 : Number.parseInt(found.value, 10)
  }
  const asIfUtc = Date.UTC(read('year'), read('month') - 1, read('day'), read('hour'), read('minute'), read('second'))
  // `instant` may carry sub-second precision the formatter cannot render.
  return asIfUtc - Math.floor(instant / 1000) * 1000
}

/** Hour of day, 0–23, in the Platform's timezone. */
export function hourOf(now: number): number {
  const parsed = Number.parseInt(hourFormatter.format(new Date(now)), 10)
  return Number.isSafeInteger(parsed) ? parsed : 0
}

/**
 * True when `now` falls inside a local-time window.
 *
 * Used by the actions that only open part of the day — Douyu's TV check-in
 * refuses before 19:00 — so the scheduler can wait rather than accumulate
 * failures that look like faults.
 */
export function withinLocalWindow(now: number, fromHour: number, toHour: number): boolean {
  const hour = hourOf(now)
  return fromHour <= toHour ? hour >= fromHour && hour < toHour : hour >= fromHour || hour < toHour
}
