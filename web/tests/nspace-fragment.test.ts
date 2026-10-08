import { NFormItem, NInputNumber, NSpace } from 'naive-ui'
import { beforeEach, describe, expect, it } from 'vitest'
import { createElementBlock, createRenderer, Fragment, h, nextTick, openBlock, ref, type VNode } from 'vue'

/**
 * Why `TaskCreateView` keys every field wrapper.
 *
 * `NSpace` renders each child inside a wrapper whose key is the literal `1`
 * (naive-ui `es/space/src/Space.mjs`, the `key: 1` in its `children.map`), so a slot
 * with several children is a keyed fragment with **duplicate keys** and Vue reports
 * "Duplicate keys found during update". With the fields' `v-if` branches as NSpace's
 * own children, that made a change of action reuse the wrong nodes: the 「执行间隔」
 * field multiplied and a field the new action does not have (`加盐`) stayed on screen.
 *
 * This test is the mechanism on its own — Vue's custom renderer, the real `NSpace`,
 * no DOM and no bundler — so it fails fast and unmistakably if the arrangement
 * regresses, and names the paragraph of the codebase to read.
 */
interface FakeNode {
  readonly id: number
  readonly type: string
  children: FakeNode[]
  readonly props: Record<string, unknown>
}

let nextId = 1
const parentOf = new Map<number, FakeNode | null>()

function node(type: string, props: Record<string, unknown> = {}): FakeNode {
  const created: FakeNode = { id: nextId, type, children: [], props }
  nextId += 1
  parentOf.set(created.id, null)
  return created
}

function unlink(target: FakeNode): void {
  const parent = parentOf.get(target.id) ?? null
  if (parent === null) return
  const at = parent.children.indexOf(target)
  if (at !== -1) parent.children.splice(at, 1)
  parentOf.set(target.id, null)
}

/**
 * A renderer over plain objects, so Node's operation order is what the assertions
 * see. The parameter types are written out because there is no DOM in this
 * environment for Vue to infer them from.
 */
const renderer = createRenderer<FakeNode, FakeNode>({
  patchProp(el: FakeNode, key: string, _prev: unknown, next: unknown): void {
    el.props[key] = next
  },
  insert(el: FakeNode, parent: FakeNode, anchor: FakeNode | null): void {
    if (parent === null || parent === undefined) return
    unlink(el)
    const at = anchor === null ? parent.children.length : parent.children.indexOf(anchor)
    if (at === -1) parent.children.push(el)
    else parent.children.splice(at, 0, el)
    parentOf.set(el.id, parent)
  },
  remove(el: FakeNode): void {
    unlink(el)
  },
  createElement(type: string): FakeNode {
    return node(type)
  },
  createText(text: string): FakeNode {
    return node('#text', { text })
  },
  createComment(text: string): FakeNode {
    return node('#comment', { text })
  },
  setText(target: FakeNode, text: string): void {
    target.props['text'] = text
  },
  setElementText(target: FakeNode, text: string): void {
    target.props['text'] = text
  },
  parentNode(target: FakeNode): FakeNode | null {
    return parentOf.get(target.id) ?? null
  },
  nextSibling(target: FakeNode): FakeNode | null {
    const parent = parentOf.get(target.id) ?? null
    if (parent === null) return null
    const at = parent.children.indexOf(target)
    return at === -1 ? null : (parent.children[at + 1] ?? null)
  },
  querySelector(): null {
    return null
  },
  setScopeId(el: FakeNode, id: string): void {
    el.props['scopeId'] = id
  },
  insertStaticContent(): null {
    return null
  },
  cloneNode: undefined
} as never)

/**
 * Every box that renders that label.
 *
 * `NSpace` nests its own wrapper around the caller's, so a healthy field counts as
 * two (the item wrapper and the form item inside it) — but a *duplicated* field
 * counts as four, six, or more. What this test asserts on is therefore the change in
 * the count across a re-render: a healthy form keeps the same number of boxes for
 * every field it still shows.
 */
function labelBoxes(target: FakeNode, label: string): FakeNode[] {
  const own = target.type === 'div' && textStartsWith(target, label) ? [target] : []
  return own.concat(target.children.flatMap(child => labelBoxes(child, label)))
}

function textStartsWith(target: FakeNode, label: string): boolean {
  return textOf(target).trimStart().startsWith(label)
}

function textOf(target: FakeNode): string {
  const own = typeof target.props['text'] === 'string' ? String(target.props['text']) : ''
  return own + target.children.map(child => textOf(child)).join('')
}

function keyedFragment(key: number, children: VNode[]): VNode {
  openBlock()
  return createElementBlock(Fragment, { key }, children, 64)
}

async function mountCounting(
  build: (send: boolean) => VNode
): Promise<{ host: FakeNode; set: (value: boolean) => void }> {
  const flag = ref(true)
  const host = node('#host')
  renderer.createApp({ render: () => build(flag.value) }).mount(host)
  await nextTick()
  return {
    host,
    set: (value: boolean) => {
      flag.value = value
    }
  }
}

describe('an NSpace whose slot changes', () => {
  beforeEach(() => {
    nextId = 1
    parentOf.clear()
  })

  it('multiplies a field whose branch is NSpace\u2019s own child', async () => {
    const { host, set } = await mountCounting(isSend =>
      h(
        NSpace,
        { vertical: true, size: 18 },
        {
          default: () => [
            h(NFormItem, { label: '平台' }, { default: () => h('div', 'B站') }),
            isSend ? keyedFragment(3, [h(NFormItem, { label: '目标' }, { default: () => h('div', '房间') })]) : null,
            isSend ? keyedFragment(4, [h(NFormItem, { label: '文本库' }, { default: () => h('div', '库') })]) : null,
            h(NFormItem, { label: '执行间隔' }, { default: () => h(NInputNumber, { value: 30 }) }),
            isSend ? keyedFragment(8, [h(NFormItem, { label: '加盐' }, { default: () => h('div', '盐') })]) : null,
            h(NSpace, null, { default: () => h('div', '创建任务') })
          ]
        }
      )
    )

    const before = labelBoxes(host, '执行间隔').length
    set(false)
    await nextTick()
    const after = labelBoxes(host, '执行间隔').length

    // The bug, pinned: without the wrapper keys `after` is not `before` but zero —
    // the diff reuses the removed branches' nodes and the field disappears entirely.
    expect(before).toBeGreaterThan(0)
    expect(after).toBeGreaterThan(before)
  })

  it('leaves the set intact when every child carries its own key', async () => {
    const { host, set } = await mountCounting(isSend =>
      h(
        NSpace,
        { vertical: true, size: 18 },
        {
          default: () => [
            h('div', { key: 'field-platform' }, [h(NFormItem, { label: '平台' }, { default: () => h('div', 'B站') })]),
            h('div', { key: 'field-target' }, [
              isSend ? h(NFormItem, { label: '目标' }, { default: () => h('div', '房间') }) : null
            ]),
            h('div', { key: 'field-library' }, [
              isSend ? h(NFormItem, { label: '文本库' }, { default: () => h('div', '库') }) : null
            ]),
            h('div', { key: 'field-interval' }, [
              h(NFormItem, { label: '执行间隔' }, { default: () => h(NInputNumber, { value: 30 }) })
            ]),
            h('div', { key: 'field-salt' }, [
              isSend ? h(NFormItem, { label: '加盐' }, { default: () => h('div', '盐') }) : null
            ]),
            h('div', { key: 'actions' }, [h('div', '创建任务')])
          ]
        }
      )
    )

    const read = (label: string): number => labelBoxes(host, label).length
    const before = { interval: read('执行间隔'), salt: read('加盐'), target: read('目标') }
    expect(before.interval).toBeGreaterThan(0)
    expect(before.salt).toBe(before.interval)
    expect(before.target).toBe(before.interval)

    set(false)
    await nextTick()

    // Unchanged for the field that stays, gone for the three that do not.
    expect({ interval: read('执行间隔'), salt: read('加盐'), target: read('目标'), library: read('文本库') }).toEqual({
      interval: before.interval,
      salt: 0,
      target: 0,
      library: 0
    })
  })
})
