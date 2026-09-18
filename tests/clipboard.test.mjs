import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyText } from '../src/util/clipboard.ts'

test('HTTP copy selects text synchronously and cleans up on success or refusal', async t => {
  const originals = new Map(['navigator', 'document', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  t.after(() => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } })
  let field, attached = false, restored = false, selected = false, allowed = true
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { getSelection: () => null } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    activeElement: { focus() { restored = true } },
    createElement() { return field = { style: {}, focus() {}, select() { selected = true }, setSelectionRange() {}, remove() { attached = false } } },
    body: { appendChild() { attached = true } },
    execCommand(command) { assert.equal(command, 'copy'); assert.equal(attached && selected, true); assert.equal(field.value, '测试文本'); return allowed },
  } })
  const copied = copyText('测试文本')
  assert.equal(selected, true)
  await copied
  assert.equal(attached, false)
  assert.equal(restored, true)
  allowed = false
  await assert.rejects(copyText('测试文本'), /手动选择/)
  assert.equal(attached, false)
})
