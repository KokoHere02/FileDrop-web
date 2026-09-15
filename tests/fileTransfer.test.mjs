import { test } from 'node:test'
import assert from 'node:assert/strict'
import { confirmFile, sendFileQueue } from '../src/util/fileTransfer.ts'

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
