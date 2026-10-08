import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { readFanBadges } from '../src/platform/douyu/protocol.js'

/**
 * 今日亲密度, measured against the page rather than taken from a sentence.
 *
 * The design says the fourth `<td>` of a badge row is 今日亲密度 and that zero means nothing has been
 * sent there today. **That was written from a reading, and this file is the measurement.** The captured
 * page's own `<thead>` is parsed here and the header is asserted, so the cell index the reader uses is
 * the cell the table itself names — not an index a person remembered. Then the values are pinned as
 * literals (`0` for room 12293234, `2` for room 12306), which is the part that would survive a rewrite of
 * the reader: an implementation that read the third cell instead would answer `null` (that cell's text is
 * `28224.3/34500`, not digits) or, with the fixture below, the wrong number.
 *
 * Nothing here reaches the network: `fetch` answers a page off disk, through the real `readFanBadges`.
 */

const HTML = readFileSync(new URL('./captured/douyu-fan-badges.html', import.meta.url), 'utf8')

/**
 * The credential this read is given.
 *
 * Hand-written and shaped like a stored blob: the point of these cases is the *page*, and a real token
 * here would be a credential in a test file. `readFanBadges` sends both halves, which is the captured
 * call's own shape.
 */
const TOKEN = '123456789_1_abcdef0123456789_0_69117311'
const WEB_COOKIES = 'acf_auth=1_1_abcdef; acf_uid=456918967'

/** One read of the badge wall, with `fetch` answering `html`. */
async function readPage(html: string): Promise<string> {
  vi.stubGlobal('fetch', async () => new Response(html, { status: 200 }))
  const list = await readFanBadges(TOKEN, WEB_COOKIES)
  return JSON.stringify(list.badges)
}

/** One row of a hand-written table, so a case can state the shape it is about. */
function table(rows: readonly string[], headers = ['徽章', '主播', '亲密值', '今日亲密度', '排名', '操作']): string {
  return [
    '<table class="aui_room_table fans-badge-list">',
    '<thead><tr>',
    ...headers.map(name => `<th>${name}</th>`),
    '</tr></thead><tbody>',
    ...rows,
    '</tbody></table>'
  ].join('')
}

/** One badge row with the cells a case needs, in the order the table names them. */
function row(roomId: string, anchor: string, today: string): string {
  return [
    `<tr data-fans-room="${roomId}" data-fans-level="12">`,
    `<td><div class="FansBadgeV4"></div></td>`,
    `<td><a class="anchor--name">${anchor}</a></td>`,
    `<td>10769.9/15000<div data-anchor_name="${anchor}"></div></td>`,
    today,
    '<td>4532</td>',
    `<td><a data-rid="${roomId}"></a></td>`,
    '</tr>'
  ].join('')
}

describe('今日亲密度 — the fourth cell', () => {
  it('reads the captured page’s own numbers, and the table says that cell is 今日亲密度', async () => {
    // The header, read out of the fixture rather than remembered. If Douyu ever reorders these columns,
    // this is the case that fails first, and it fails with the row of names in the message.
    const header = HTML.slice(HTML.indexOf('<thead>'), HTML.indexOf('</thead>'))
    // `<th>` *or* `<th width="23%">`, and not `<thead>` — which the looser `<th[^>]*>` matches, which is
    // how this case first failed: it swallowed the `<tr>` and the first header into one cell.
    const names = [...header.matchAll(/<th(?:\s[^>]*)?>([\s\S]*?)<\/th>/g)].map(match => (match[1] ?? '').trim())
    expect(names).toEqual(['徽章', '主播', '亲密值', '今日亲密度', '排名', '操作'])
    expect(names.indexOf('今日亲密度')).toBe(3)

    // The two captured rows, in full: the medal's room, the anchor's display name, and today's reading.
    // `0` for 145oni's room and `2` for 电棍's — the pair the reconnaissance report measured, and the
    // reason this field exists at all: room 12306's `2` was already there at 02:05 while the account's
    // prop count never moved, so the number is a *state of the room* and not a count of gifts.
    expect(JSON.parse(await readPage(HTML))).toEqual([
      { roomId: '12293234', anchorName: '145oni', todayIntimacy: 0 },
      { roomId: '12306', anchorName: '电棍', todayIntimacy: 2 }
    ])
  })

  it('reads the cell the table names, not the one beside it', async () => {
    // The third cell reads `28224.3/34500` on the real page, which is why an index slipped by one would
    // more often answer `null` than the wrong number — so the boundary is stated with a third cell that IS
    // a plain integer. `7` is 亲密值 here; the answer must be `3`.
    const html = table([row('12306', '电棍', '<td><span>3</span></td>').replace('<td>10769.9/15000', '<td>7')])

    expect(JSON.parse(await readPage(html))).toEqual([{ roomId: '12306', anchorName: '电棍', todayIntimacy: 3 }])
  })

  it('answers null — never 0 — for a cell it cannot read', async () => {
    // Three ways to be unreadable, and all three are the same answer. `0` is the one value this field may
    // not invent: it is the reading that means 「今天还没送过」, and a form that printed it for a cell
    // nobody could parse would be telling a person today's gift is still owed (or already sent) on no
    // evidence at all.
    const unreadable = table([
      row('1', '甲', '<td><span class="">--</span></td>'),
      row('2', '乙', '<td><span class="">2.5</span></td>'),
      row('3', '丙', '<td></td>')
    ])

    expect(JSON.parse(await readPage(unreadable))).toEqual([
      { roomId: '1', anchorName: '甲', todayIntimacy: null },
      { roomId: '2', anchorName: '乙', todayIntimacy: null },
      { roomId: '3', anchorName: '丙', todayIntimacy: null }
    ])

    // And a row that lost the cell entirely: the same answer, not a crash and not a zero.
    const truncated = table(['<tr data-fans-room="9"><td>9</td></tr>'])
    expect(JSON.parse(await readPage(truncated))).toEqual([{ roomId: '9', anchorName: '', todayIntimacy: null }])
  })

  it('keeps reading the rooms it always did, so the new cell changed nothing else', async () => {
    // The two fields this reader had are still exactly two, whatever the fourth cell says: the medal's
    // room, from `data-fans-room`, and the anchor's name, from the 亲密值 cell's `data-anchor_name`.
    const html = table([
      '<tr data-fans-room="74960"><td><span class="is-wearing"></span></td><td>甲</td><td><div data-anchor_name="甲"></div></td><td>1</td></tr>'
    ])

    const list = JSON.parse(await readPage(html)) as readonly Record<string, unknown>[]
    expect(list.map(badge => Object.keys(badge).sort())).toEqual([['anchorName', 'roomId', 'todayIntimacy']])
  })
})
