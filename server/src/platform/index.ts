import { bilibiliPlatform } from './bilibili/index.js'
import { douyuPlatform } from './douyu/index.js'
import { registerPlatform } from './registry.js'

/**
 * Adapter registration — the one module that knows which Platforms exist.
 *
 * Importing this module is what registers them. That is deliberate: the names
 * `bilibili` and `douyu` then appear nowhere else, so the registry, the scheduler
 * and the routes stay free of Platform names, and an adapter's dependencies are
 * pulled in exactly when the process decides to serve it — importing `registry.js`
 * on its own never drags them along.
 *
 * The entry point imports this file once. Nothing else needs to, and a process that
 * forgets to will see `platformFor()` answer null for every task.
 */

registerPlatform(bilibiliPlatform)
registerPlatform(douyuPlatform)
