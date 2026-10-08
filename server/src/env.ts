import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Loads `.env` from the server's own directory, for its side effect.
 *
 * **This module must be imported first, and that order is load-bearing rather
 * than stylistic.** ES modules evaluate their bodies in import order, so a load
 * placed anywhere later runs after some other module has already read
 * `process.env` — `index.ts` itself resolves `DB_PATH` at module scope, and
 * `auth/token.ts` reads `SESSION_SECRET`. A `.env` read one module too late is
 * the worst kind of configuration file: it exists, it looks correct, and it
 * changes nothing at all.
 *
 * The path comes from `process.cwd()` rather than `import.meta.url` because the
 * server always runs with its own package directory as the working directory —
 * both `tsx watch src/index.ts` and `node dist/index.js` — which is the same
 * assumption `WEB_DIST`'s default (`../web/dist`) already makes. Resolving from
 * this module's own location would point inside `dist/` once built.
 *
 * A missing file is normal: an operator may set the real environment instead, or
 * run with no configuration at all. A present-but-broken one is not, so there is
 * deliberately **no `try`/`catch`** around the load. `process.loadEnvFile` throws
 * on a malformed file, and that message is the one worth reading — swallowing it
 * would reintroduce exactly the silent-nothing this module exists to prevent.
 */
const envPath = resolve(process.cwd(), '.env')

if (existsSync(envPath)) {
  process.loadEnvFile(envPath)
}
