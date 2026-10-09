import { describe, expect, it } from 'vitest'

import { describeLiveStatus, LiveStatus } from '../src/types/api.js'

/**
 * The status words. Every value that reaches `describeLiveStatus` is a normalised verdict (a task's
 * `lastLiveStatus`, a Target's `liveStatus`), so the table has two states and no raw Bilibili `2`.
 */
describe('describeLiveStatus', () => {
  it('labels the normalised live verdict as 直播中', () => {
    expect(describeLiveStatus(LiveStatus.Live)).toBe('直播中')
  })

  // 轮播 is folded into offline before it reaches the UI, and the word says so rather than promising a broadcast.
  it('labels the normalised offline verdict as 未开播（含轮播）', () => {
    expect(describeLiveStatus(LiveStatus.Offline)).toBe('未开播（含轮播）')
  })

  it('labels a task the probe has not yet read as 尚未探测', () => {
    expect(describeLiveStatus(null)).toBe('尚未探测')
  })

  // The raw Bilibili `2` can no longer reach the table. Before this change it was labelled 轮播中, which
  // promised a broadcast the scheduler never acts on; now an unrecognised value falls through to 未知.
  it('does not label a raw 2 as 轮播中, because no normalised value is 2', () => {
    expect(describeLiveStatus(2)).toBe('未知')
  })

  it('exposes only the two normalised values', () => {
    expect(LiveStatus).toEqual({ Offline: 0, Live: 1 })
  })
})
