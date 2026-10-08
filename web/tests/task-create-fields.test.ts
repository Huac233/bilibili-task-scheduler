import { describe, expect, it } from 'vitest'

import type { ActionDescriptor } from '../src/types/api.js'
import { FIELD_KEY, FORM_FIELDS, type FormField, fieldsFor } from '../src/views/task-create-fields.js'

/**
 * The invariant the reported bug broke: an action's fields are decided by the
 * descriptor and nothing else.
 *
 * `fieldsFor` is the whole form's field set as data, so this is the cheapest seam at
 * which "the form shows exactly the descriptor's asks and nothing else" can be
 * asserted — no DOM, no Platform, no catalogue request.
 */
function descriptor(overrides: Partial<ActionDescriptor>): ActionDescriptor {
  return {
    key: 'send_danmaku',
    action: 'send',
    label: '发送弹幕',
    description: '',
    costly: false,
    needsTarget: true,
    needsLibrary: true,
    maxMessageLength: 20,
    defaultIntervalSeconds: 30,
    minIntervalSeconds: 10,
    ...overrides
  }
}

describe('fieldsFor', () => {
  it('asks for nothing before an action is chosen', () => {
    expect(fieldsFor(null)).toEqual([])
  })

  it('gives a Send action its target, library and 加盐', () => {
    expect(fieldsFor(descriptor({}))).toEqual(['目标', '文本库', '等待开播', '加盐'])
  })

  it('gives an account-scoped Reconcile action no target, library or 加盐', () => {
    const signIn = descriptor({
      key: 'sign_in',
      action: 'reconcile',
      label: '客户端签到',
      needsTarget: false,
      needsLibrary: false,
      maxMessageLength: 0,
      defaultIntervalSeconds: 300,
      minIntervalSeconds: 60
    })
    expect(fieldsFor(signIn)).toEqual([])
  })

  it('follows needsTarget on its own, so a target-only action is expressible', () => {
    const like = descriptor({
      key: 'like',
      action: 'reconcile',
      label: '点赞',
      needsLibrary: false,
      maxMessageLength: 0,
      defaultIntervalSeconds: 120,
      minIntervalSeconds: 5
    })
    expect(fieldsFor(like)).toEqual(['目标', '等待开播'])
  })

  it('decides 加盐 by the executor, not by the Platform', () => {
    const sendWithoutLibrary = descriptor({
      key: 'send_only',
      label: '只发一条',
      needsLibrary: false,
      maxMessageLength: 70
    })
    expect(fieldsFor(sendWithoutLibrary)).toEqual(['目标', '等待开播', '加盐'])
  })

  it('keeps 执行间隔 out of the field set, because every task has a cadence', () => {
    for (const field of fieldsFor(descriptor({}))) {
      expect(field).not.toBe('执行间隔')
    }
  })

  it('keys every field it can return exactly once', () => {
    const everyField: FormField[] = [
      FORM_FIELDS.target,
      FORM_FIELDS.library,
      FORM_FIELDS.requireOnline,
      FORM_FIELDS.salt
    ]
    const keys = everyField.map(field => FIELD_KEY[field])
    expect(new Set(keys).size).toBe(everyField.length)
    for (const key of keys) expect(key).not.toBe('')
  })
})
