import { describe, expect, it } from 'vitest'

import { createShutdown } from '../src/index.js'

/**
 * The order the shutdown path promises.
 *
 * `index.ts`'s comment used to claim that "an in-flight send cannot write to a closed handle" while
 * `Scheduler.stop()` returned `void` — so nothing was waited for, and a sweep that was out when
 * SIGTERM arrived came back to a closed database and lost its write to a `task N sweep error: …`
 * line. The sentence and the code disagreed, and no test could tell.
 *
 * This pins the sentence instead of reading it: the parts are substitutable, so a whole shutdown can
 * be run with a sweep that is deliberately still writing, and the assertion is on the order of the
 * four things rather than on any of them individually.
 */

/** Every part appended to one list, so the assertion can be about order. */
function events(): { readonly seen: string[]; readonly parts: Parameters<typeof createShutdown>[0] } {
  const seen: string[] = []
  return {
    seen,
    parts: {
      log: {
        info: (message: string) => seen.push(`log: ${message}`),
        error: (error: unknown) => seen.push(`error: ${String(error)}`)
      },
      stopScheduler: async () => {
        seen.push('scheduler stopped')
      },
      closeServer: async () => {
        seen.push('server closed')
      },
      closeDatabase: () => {
        seen.push('database closed')
      }
    }
  }
}

describe('the shutdown path', () => {
  it('closes the database only after the scheduler has finished the sweep it was running', async () => {
    const seen: string[] = []
    let finishSweep = (): void => {}
    const sweep = new Promise<void>(resolve => {
      finishSweep = resolve
    })

    const shutdown = createShutdown({
      log: {
        info: (message: string) => seen.push(`log: ${message}`),
        error: (error: unknown) => seen.push(`error: ${String(error)}`)
      },
      // A sweep mid-write: `stop()` is what waits for it, so this resolves only when the test says so.
      stopScheduler: async () => {
        await sweep
        seen.push('sweep finished')
      },
      closeServer: async () => {
        seen.push('server closed')
      },
      closeDatabase: () => {
        seen.push('database closed')
      }
    })

    const stopping = shutdown('SIGTERM')
    // Far enough for the call to reach the first await, which is the sweep.
    await Promise.resolve()
    await Promise.resolve()

    // Nothing has been closed while the sweep is still out — this is the line the old code crossed.
    expect(seen).toEqual(['log: received SIGTERM, shutting down'])

    finishSweep()
    await stopping

    expect(seen).toEqual(['log: received SIGTERM, shutting down', 'sweep finished', 'server closed', 'database closed'])
  })

  it('takes the whole path once, however many signals arrive', async () => {
    const { seen, parts } = events()
    const shutdown = createShutdown(parts)

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT'), shutdown('SIGTERM')])

    // One "received" line and one close: a second signal is not a second teardown.
    expect(seen.filter(line => line.startsWith('log: received'))).toHaveLength(1)
    expect(seen.filter(line => line === 'database closed')).toHaveLength(1)
    expect(seen).toEqual([
      'log: received SIGTERM, shutting down',
      'scheduler stopped',
      'server closed',
      'database closed'
    ])
  })

  it('reports a failure instead of leaving the close half-done in silence', async () => {
    const { seen, parts } = events()
    const shutdown = createShutdown({
      ...parts,
      stopScheduler: async () => {
        throw new Error('the sweep never finished')
      }
    })

    await shutdown('SIGTERM')

    // The database is *not* closed behind a failed stop — a caller that reached this point knows the
    // sweep is unaccounted for, and closing anyway is the thing the drain exists to prevent.
    expect(seen).toEqual(['log: received SIGTERM, shutting down', 'error: Error: the sweep never finished'])
  })
})
