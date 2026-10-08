// Side-effect import, and it must stay the first one. It loads `.env`, and module
// bodies evaluate in import order — move it below any other import and the setting
// is read too late to matter, because `DEFAULT_DB_PATH` below resolves at module
// scope. No suppression comment is needed: biome's import organiser leaves this
// line where it is (it reports a suppression as unused if you add one), so the
// order is stable and the comment is here for the person, not the formatter.
import './env.js'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance, LogController } from 'fastify'
import { ChoiceSourceRegistry } from './actions/action-options.js'
import { resolveSessionSecret } from './auth/token.js'
// Still needed by `AppContext`, which the routes use until they are platform-aware.
// The scheduler no longer wants it — an adapter builds its own client — so removing
// it here means removing it from the context too, in one move.
import { WbiKeyStore } from './bilibili/live.js'
import { closeDatabase, openDatabase } from './db/index.js'
// Side-effect import: this is what registers the Platform adapters. Every lookup
// goes through `registry.platformFor(task.platform)`, so without this line the
// registry is empty, every task resolves to `null`, and the scheduler fails every
// one of them at run time with no hint as to why.
import './platform/index.js'
import { registerAccountRoutes } from './routes/accounts.js'
import { registerActionSettingRoutes } from './routes/action-settings.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerBiliRoutes } from './routes/bili.js'
import { type AppContext, createAccountClientFactory, LoginSessionStore } from './routes/context.js'
import { registerDouyuRoutes } from './routes/douyu.js'
import type { BackpackFetch } from './routes/douyu-backpack.js'
import { registerDouyuOptionSources } from './routes/douyu-options.js'
import { registerEventRoutes } from './routes/events.js'
import { registerLibraryRoutes } from './routes/libraries.js'
import { registerPlatformRoutes } from './routes/platforms.js'
import { registerReplacementRoutes } from './routes/replacements.js'
import { registerTaskRoutes } from './routes/tasks.js'
import { installZodValidation } from './routes/validation.js'
import { Scheduler } from './scheduler/runner.js'

/**
 * Service entry point.
 *
 * Wiring only: every behaviour lives in a module that can be tested without a
 * listening socket. `buildServer` returns the pieces rather than starting
 * anything so tests can drive the app with `app.inject()`.
 */

export interface BuildServerOptions {
  readonly logger?: boolean
  /** Override the database location; tests pass `:memory:`. */
  readonly dbPath?: string
  /** Run the scheduler sweep loop. Off in tests. */
  readonly schedulerTickMs?: number
  /**
   * The clock the HTTP layer reads. Defaults to `Date.now`, which is what a running
   * service wants and what every existing caller gets without passing anything.
   *
   * Optional and last for that reason: a test that cares *which Platform day it is*
   * passes a function that returns a fixed instant, and the answer stops depending on
   * the hour the suite happens to run at. Nothing else changes — the scheduler keeps
   * its own `tick(now)` parameter, which is already injectable.
   */
  readonly now?: () => number
  /**
   * The transport a choice source reads over, when it differs from the runtime's own `fetch`.
   *
   * The one substitution a suite needs to answer `GET /api/action-settings/options` without a
   * Platform: everything else about that route is real, so what the form is shown — a list, a
   * refusal, a contract change — is asserted as the route produces it. Absent means this build's
   * own wiring, which is every non-test caller.
   */
  readonly optionFetch?: BackpackFetch
}

export interface BuiltServer {
  readonly app: FastifyInstance
  readonly ctx: AppContext
  readonly scheduler: Scheduler
}

/**
 * What an operator is told when the process signs with a key of its own.
 *
 * `resolveSessionSecret` treats a value it cannot use exactly as it treats an absent one — that is
 * its own business, and `session-secret.test.ts` pins it. The two are **not** the same thing to
 * whoever has to fix it, though: a deployment that set `SESSION_SECRET` to something too short was
 * told the variable "is not set", so the person reading the log went looking at an environment
 * variable that was sitting right there. So this asks what the environment held, and never describes
 * a value that exists as one that does not.
 *
 * The bound itself is not restated here: it belongs to `auth/token.ts`, and a second copy of it in a
 * sentence is exactly how the sentence and the judgement drift apart again.
 */
export function sessionSecretWarning(configured: string | undefined): string {
  if (configured === undefined) {
    return 'SESSION_SECRET is not set — using a per-process random key. Every login is invalidated when the process restarts.'
  }
  return 'SESSION_SECRET is set but too short to use — using a per-process random key instead. Every login is invalidated when the process restarts.'
}

/** The four things the shutdown path orders, each of them something a test can substitute. */
export interface ShutdownParts {
  readonly log: { readonly info: (message: string) => void; readonly error: (error: unknown) => void }
  /** Resolves once no sweep is running: `Scheduler.stop()`. */
  readonly stopScheduler: () => Promise<void>
  readonly closeServer: () => Promise<void>
  /** The database handle, closed last. */
  readonly closeDatabase: () => void
}

/**
 * Builds the shutdown path: the function a signal handler calls.
 *
 * **The order is the promise, and the `await` is what makes it hold.** The sweep loop is stopped
 * first — `Scheduler.stop()` clears the timer and then waits for the tick that is already running,
 * so what it resolves on is "no sweep will touch the database again" — and only then is the handle
 * closed. The first version of this comment claimed exactly that while `stop()` returned `void`:
 * `clearInterval` stops the *next* sweep and not the current one, so a send that was out when SIGTERM
 * arrived came back to a closed handle and its write was lost to a `task N sweep error: …` line.
 *
 * What is awaited is the sweep's own completion, not a grace period: there is no timer here, and
 * whoever resumes past it has already seen the last write. That promise is why this is a function
 * with substitutable parts rather than five lines inside the entry block — an ordering nobody can
 * watch is the one this file already got wrong once, and `shutdown-drain.test.ts` now watches it.
 *
 * A second signal is ignored: the first one is already doing all of this.
 */
export function createShutdown(parts: ShutdownParts): (signal: string) => Promise<void> {
  let shuttingDown = false

  return async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    parts.log.info(`received ${signal}, shutting down`)

    try {
      await parts.stopScheduler()
      await parts.closeServer()
      parts.closeDatabase()
    } catch (error: unknown) {
      parts.log.error(error)
    } finally {
      process.exitCode = 0
    }
  }
}

export function buildServer(options: BuildServerOptions = {}): BuiltServer {
  const app = Fastify({
    logger: options.logger ?? true,
    // Per-request logging is off by default. The scheduler polls live status and
    // sends on a timer, so "incoming request" plus "request completed" for every
    // call adds up to tens of megabytes a day — and those lines say nothing that
    // the send log and task status do not already say better. Set LOG_REQUESTS=1
    // when actually debugging request flow.
    //
    // Fastify 5 replaced the top-level `disableRequestLogging` option with a
    // controller instance. `disableRequestLogging` also accepts a predicate on
    // the request, which leaves room to keep logs for selected routes later.
    logController: new LogController({
      disableRequestLogging: process.env['LOG_REQUESTS'] !== '1'
    }),
    // A novel import arrives as one JSON body. The 1 MB default would reject
    // anything past a few hundred KB, which is well below a real book.
    bodyLimit: 32 * 1024 * 1024
  })

  // Before the first route, not after: Fastify captures the validator compiler
  // per route at registration time, so a route added above this line would keep
  // the default JSON Schema one and quietly validate nothing.
  installZodValidation(app)

  const db = openDatabase(options.dbPath)
  const { secret, ephemeral } = resolveSessionSecret()

  if (ephemeral) {
    app.log.warn(sessionSecretWarning(process.env['SESSION_SECRET']))
  }

  const { httpForAccount, forgetAccountClient } = createAccountClientFactory(db)
  const wbi = new WbiKeyStore()

  // Filled here rather than by a module-level side effect, so this build's one Platform-specific
  // choice source is named in the same place every other dependency is wired — and so a suite can
  // substitute the transport without substituting the reader.
  const choiceSources = new ChoiceSourceRegistry()
  registerDouyuOptionSources(choiceSources, db, options.optionFetch ?? globalThis.fetch)

  const ctx: AppContext = {
    db,
    sessionSecret: secret,
    // Resolved once at wiring time, not per call, so a test's clock is the only clock
    // this process ever reads through `ctx`.
    now: options.now ?? Date.now,
    wbi,
    httpForAccount,
    forgetAccountClient,
    loginSessions: new LoginSessionStore(),
    choiceSources
  }

  /**
   * Built here rather than beside the routes that use it, for one reason: `/api/health` reports whether
   * the sweep loop is armed (see the endpoint below), so the scheduler has to exist before that route is
   * registered. It depends on nothing that comes later — the log is `app.log`, which Fastify has by now —
   * and returning it from `buildServer` is what lets a test drive `tick()` and a signal handler stop it.
   */
  const scheduler = new Scheduler({
    db,
    // The scheduler no longer needs a WBI store or a client factory: an adapter
    // builds whatever it requires from the account's credential blob. What is left
    // is only the cache-invalidation hook, and that one matters because a refresh
    // rotates the credential.
    forgetAccountClient,
    log: (message: string): void => {
      app.log.info(message)
    }
  })

  /**
   * The container healthcheck's endpoint, and the one field in it that is not a constant.
   *
   * `schedulerReady` used to be the literal `true`, which is a claim nothing checked: the same answer
   * would come from a process whose sweep loop had been stopped, and the healthcheck's own reasoning
   * (`Dockerfile`: 「The scheduler runs in-process, so a healthcheck that only proves the HTTP server is
   * up is enough」) leans on precisely that fact. It is read off the loop now, so "ready" means "the
   * sweep is armed" — `scheduler.start()` is the entry point's call and never `buildServer`'s, so a
   * test-built server answers `false` and means it.
   */
  app.get('/api/health', async () => ({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    storage: 'sqlite',
    schedulerReady: scheduler.isRunning()
  }))

  /**
   * Rate limiting.
   *
   * Generous by default — this is a single-user-account personal tool, and the
   * frontend polls a few endpoints on a timer — but present, because the
   * unauthenticated auth routes are otherwise a free brute-force target. The
   * stricter per-route budgets live on those routes themselves.
   *
   * The container healthcheck hits `/api/health` every 30s from inside; it is
   * exempted so its calls do not consume the budget meant for real clients.
   *
   * **The routes are registered inside `after`, and that is load-bearing.**
   * `register` hands a plugin to avvio, which loads it on the next tick; Fastify
   * fixes each route's hook chain when that route is registered. Registering the
   * routes in the same synchronous block as this call therefore produced routes
   * with *no limiter in their chain at all* — 600/min and the per-route auth
   * budgets alike were decorative. `after` runs once this plugin has loaded, so
   * every route below is built with the limiter already in place.
   */
  void app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    allowList: (request: { url: string }) => request.url === '/api/health'
  })

  // avvio hands `null` (not `undefined`) on success, so the check is `!== null`.
  app.after((error: Error | null) => {
    if (error !== null) throw error

    registerAuthRoutes(app, ctx)
    registerBiliRoutes(app, ctx)
    registerDouyuRoutes(app, ctx)
    registerAccountRoutes(app, ctx)
    registerPlatformRoutes(app, ctx)
    registerActionSettingRoutes(app, ctx)
    registerLibraryRoutes(app, ctx)
    registerTaskRoutes(app, ctx)
    registerReplacementRoutes(app, ctx)
    registerEventRoutes(app, ctx)
  })

  // Serve the built frontend when it is present. In development the Vite dev
  // server handles the UI and proxies /api here, so this root simply does not
  // exist and the app runs API-only.
  const webRoot = process.env['WEB_DIST'] ?? resolve(process.cwd(), '../web/dist')
  if (existsSync(webRoot)) {
    void app.register(fastifyStatic, { root: webRoot, prefix: '/', index: ['index.html'] })

    // Unknown paths: API prefixes get a JSON 404, everything else falls back to
    // index.html. The app uses hash routing so the fallback is rarely needed,
    // but it keeps a hand-typed URL from returning a bare static 404.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ ok: false, error: '接口不存在' })
      }
      return reply.sendFile('index.html')
    })
  } else {
    app.log.warn(`frontend assets not found at ${webRoot} — serving API only`)
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ ok: false, error: '接口不存在' }))
  }

  return { app, ctx, scheduler }
}

/** True when this file was launched directly rather than imported. */
function isMainModule(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return resolve(fileURLToPath(import.meta.url)) === resolve(entry)
}

if (isMainModule()) {
  const port = Number.parseInt(process.env['PORT'] ?? '8787', 10)
  const host = process.env['HOST'] ?? '0.0.0.0'

  const { app, scheduler } = buildServer()

  app
    .listen({ port, host })
    .then(address => {
      app.log.info(`listening on ${address}`)
      scheduler.start()
    })
    .catch((error: unknown) => {
      app.log.error(error)
      process.exitCode = 1
    })

  /**
   * The shutdown path itself, wired to this build's pieces — see `createShutdown` for the ordering
   * it promises and why the `await` in it is the point.
   */
  const shutdown = createShutdown({
    log: app.log,
    stopScheduler: () => scheduler.stop(),
    closeServer: () => app.close(),
    closeDatabase
  })

  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })

  /**
   * A rejected promise nobody awaited is logged rather than left silent — the
   * default behaviour of crashing the process is worse for a service that is
   * supposed to keep monitoring rooms overnight.
   */
  process.on('unhandledRejection', (reason: unknown) => {
    app.log.error({ reason }, 'unhandled promise rejection')
  })

  /**
   * An uncaught exception leaves the process in an unknown state, so it is not
   * safe to keep serving. Log, shut down cleanly, and let the orchestrator
   * restart the container.
   *
   * The exit happens **after** the shutdown, so the drain is not cut short by the way out of a
   * process that is already broken — a sweep that is awaiting the Platform still gets to finish its
   * write. The timer beside it is a backstop for a drain that never finishes (a Platform call that
   * hangs), not the ordinary path: it is `unref`'d and one second out, so it only matters when
   * nothing else is going to produce an exit code.
   */
  process.on('uncaughtException', (error: Error) => {
    app.log.fatal({ err: error }, 'uncaught exception — shutting down')
    void shutdown('uncaughtException').finally(() => {
      process.exit(1)
    })
    setTimeout(() => {
      process.exit(1)
    }, 1_000).unref()
  })
}
