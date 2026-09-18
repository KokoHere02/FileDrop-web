import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { confirmFile, fileHash, sendFileQueue } from '../src/util/fileTransfer.ts'

test('HTTP without subtle or randomUUID preserves SHA-256 and unique file IDs', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) } })
  t.after(() => Object.defineProperty(globalThis, 'crypto', descriptor))
  const files = [new File([], 'empty'), new File(['hello 世界'], 'text'), new File([new Uint8Array(1024 * 1024 + 65).fill(137)], 'binary')]
  const { sent, channel, controller } = setup()
  const confirmed = []
  await sendFileQueue(files, channel, controller.signal, () => false, () => {}, {
    confirm: async (id, size, hash) => { confirmed.push({ id, size, hash }) },
  })
  const headers = sent.filter(item => typeof item === 'string').map(JSON.parse)
  assert.equal(new Set(headers.map(header => header.fileId)).size, files.length)
  for (const [index, file] of files.entries()) {
    const expected = createHash('sha256').update(new Uint8Array(await file.arrayBuffer())).digest('hex')
    assert.equal(headers[index].sha256, expected)
    assert.match(headers[index].fileId, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
    assert.deepEqual(confirmed[index], { id: headers[index].fileId, size: file.size, hash: expected })
    assert.equal(await fileHash(new Blob([file])), expected)
  }
})

function setup() {
  const sent = []
  const channel = { readyState: 'open', bufferedAmount: 0, send(data) { sent.push(data) } }
  return { sent, channel, controller: new AbortController() }
}

test('multiple files preserve boundaries and bytes, including an empty file', async () => {
  const { sent, channel, controller } = setup()
  const files = [new File([new Uint8Array(40000).fill(17)], 'a.bin'), new File(['hello'], 'b.txt'), new File([], 'empty')]
  await sendFileQueue(files, channel, controller.signal, () => false, () => {})
  let index = 0
  let chunks = []
  for (const item of sent) {
    if (typeof item !== 'string') { assert.ok(item.byteLength <= 16384); chunks.push(item); continue }
    const msg = JSON.parse(item)
    if (msg.type === 'file-info') { assert.equal(msg.name, files[index].name); assert.equal(chunks.length, 0) }
    else {
      assert.deepEqual(await new Blob(chunks).arrayBuffer(), await files[index].arrayBuffer())
      chunks = []
      index++
    }
  }
  assert.equal(index, 3)
})

test('backpressure blocks sending until buffered bytes drain', async () => {
  const { sent, channel, controller } = setup()
  channel.bufferedAmount = 300000
  const task = sendFileQueue([new File(['x'], 'x')], channel, controller.signal, () => false, () => {})
  await new Promise(resolve => setTimeout(resolve, 35))
  assert.equal(sent.length, 0)
  channel.bufferedAmount = 0
  await task
  assert.equal(sent.length, 3)
})

test('paused transfer resumes without losing data', async () => {
  const { sent, channel, controller } = setup()
  let paused = true
  const task = sendFileQueue([new File(['x'], 'x')], channel, controller.signal, () => paused, () => {})
  await new Promise(resolve => setTimeout(resolve, 35))
  assert.equal(sent.length, 0)
  paused = false
  await task
  assert.equal(sent.length, 3)
})

test('disconnect while paused rejects promptly', async () => {
  const { channel, controller } = setup()
  const task = sendFileQueue([new File(['x'], 'x')], channel, controller.signal, () => true, () => {})
  channel.readyState = 'closed'
  await assert.rejects(task, /连接已断开/)
})

test('cleanup aborts a paused transfer', async () => {
  const { sent, channel, controller } = setup()
  const task = sendFileQueue([new File(['x'], 'x')], channel, controller.signal, () => true, () => {})
  controller.abort()
  await assert.rejects(task, { name: 'AbortError' })
  assert.equal(sent.length, 0)
})

test('chunks respect negotiated SCTP message size', async () => {
  const { sent, channel, controller } = setup()
  await sendFileQueue([new File([new Uint8Array(9000)], 'small-chunks')], channel, controller.signal, () => false, () => {}, { maxMessageSize: 1024 })
  assert.ok(sent.filter(value => typeof value !== 'string').every(value => value.byteLength <= 1024))
})

class AckChannel extends EventTarget {
  readyState = 'open'
  bufferedAmount = 0
  sent = []
  send(value) { this.sent.push(value) }
  ack(fileId, size) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'file-ack', fileId, size }) })) }
}

test('sender stays below 100% until matching receiver acknowledgement', async () => {
  const channel = new AckChannel()
  const controller = new AbortController()
  const values = []
  const task = sendFileQueue([new File(['hello'], 'a.txt')], channel, controller.signal, () => false, (_, value) => values.push(value), {
    confirm: (fileId, size) => confirmFile(channel, controller.signal, fileId, size),
  })
  while (!channel.sent.some(value => typeof value === 'string' && JSON.parse(value).type === 'file-end')) await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(values.at(-1), 99)
  const end = JSON.parse(channel.sent.at(-1))
  channel.ack('old-file-id', 5)
  await Promise.resolve()
  assert.equal(values.at(-1), 99)
  channel.ack(end.fileId, 5)
  await task
  assert.equal(values.at(-1), 100)
})

test('incorrect acknowledgement size rejects the transfer', async () => {
  const channel = new AckChannel()
  const task = confirmFile(channel, new AbortController().signal, 'id', 10)
  channel.ack('id', 9)
  await assert.rejects(task, /大小不一致/)
})

test('abort while waiting for acknowledgement rejects promptly', async () => {
  const channel = new AckChannel()
  const controller = new AbortController()
  const task = confirmFile(channel, controller.signal, 'id', 10)
  controller.abort()
  await assert.rejects(task, { name: 'AbortError' })
})

test('SHA-256 matches known bytes and rejects mismatched content acknowledgement', async () => {
  const hash = await fileHash(new Blob(['hello']))
  assert.equal(hash, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  const channel = new AckChannel()
  const task = confirmFile(channel, new AbortController().signal, 'id', 5, hash)
  channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'file-ack', fileId: 'id', size: 5, sha256: '0'.repeat(64) }) }))
  await assert.rejects(task, /哈希校验失败/)
})
