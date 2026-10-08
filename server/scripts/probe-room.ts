/**
 * Live probe for the room-resolution path.
 *
 * Run against the real Bilibili API to confirm the schemas still match what the
 * service actually returns. Unit tests use captured payloads, which age; this
 * is the check that catches upstream drift before a user does.
 *
 *   pnpm exec tsx scripts/probe-room.ts [shortRoomId]
 */
import { BiliHttp, CookieJar } from '../src/bilibili/http.js'
import { fetchRoomInfo, resolveRoom } from '../src/bilibili/live.js'

const shortId = Number.parseInt(process.argv[2] ?? '22637261', 10)
if (!Number.isSafeInteger(shortId) || shortId <= 0) {
  console.error('usage: probe-room.ts <shortRoomId>')
  process.exit(1)
}

const http = new BiliHttp({ cookies: new CookieJar() })

console.log(`probing room ${String(shortId)}`)

try {
  const room = await resolveRoom(http, shortId)
  console.log('room_init  ok')
  console.log(`  room_id     : ${String(room.room_id)}`)
  console.log(`  short_id    : ${String(room.short_id)}`)
  console.log(`  uid         : ${String(room.uid)}`)
  console.log(`  live_status : ${String(room.live_status)}`)
} catch (error: unknown) {
  console.error('room_init  FAILED:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

try {
  const room = await resolveRoom(http, shortId)
  const info = await fetchRoomInfo(http, room.room_id)
  console.log('get_info   ok')
  console.log(`  title       : ${info.title}`)
  console.log(`  live_status : ${String(info.live_status)}`)
  console.log(`  live_time   : ${String(info.live_time)}`)
} catch (error: unknown) {
  console.error('get_info   FAILED:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
