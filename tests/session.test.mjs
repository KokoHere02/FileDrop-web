import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRenderer } from 'vue'
import { createPinia } from 'pinia'
import axios from 'axios'

const token = 'x'.repeat(43)
let requests = 0
axios.defaults.adapter = async config => { requests++; return { data: { code: 200, data: { code: 'Ab3xY9', senderToken: token } }, status: 200, statusText: 'OK', headers: {}, config } }
await build({ stdin: { contents: "export { useSession } from './src/composables/useSession'; export { useRoomStore } from './src/store/RoomStore'; export { useFileDistribution } from './src/composables/useFileDistribution'", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', packages: 'external', define: { 'import.meta.env': '{}' }, outfile: 'node_modules/.tmp/session-test.mjs' })
const { useSession, useRoomStore, useFileDistribution } = await import('../node_modules/.tmp/session-test.mjs')
const saved = { WebSocket: globalThis.WebSocket, RTCPeerConnection: globalThis.RTCPeerConnection, window: globalThis.window }
after(() => Object.assign(globalThis, saved))
class Channel extends EventTarget {
  readyState = 'connecting'
  close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')) }
  open() { this.readyState = 'open'; this.onopen?.() }
}
class Peer {
  signalingState = 'stable'
  connectionState = 'new'
  remoteDescription = null
  channels = []
  candidates = []
  createDataChannel(label, options) { assert.equal(options.ordered, true); const channel = new Channel(); this.channels.push(channel); return channel }
  async createOffer() { return { type: 'offer', sdp: 'test-offer' } }
  async createAnswer() { return { type: 'answer', sdp: 'test-answer' } }
  async setLocalDescription(value) { this.localDescription = value; this.signalingState = value.type === 'offer' ? 'have-local-offer' : 'stable' }
  async setRemoteDescription(value) { this.remoteDescription = value; this.signalingState = value.type === 'offer' ? 'have-remote-offer' : 'stable' }
  async addIceCandidate(value) { assert.ok(this.remoteDescription); this.candidates.push(value) }
  close() { this.connectionState = 'closed'; this.signalingState = 'closed' }
}
class Socket {
  static OPEN = 1
  static instances = []
  readyState = 0
  sent = []
  constructor(url) { this.url = url; Socket.instances.push(this) }
  open() { this.readyState = 1; this.onopen?.() }
  send(data) { this.sent.push(JSON.parse(data)) }
  receive(type, payload, from, to = 'self') { this.onmessage?.({ data: JSON.stringify({ type, payload, from, to }) }) }
  close() { this.readyState = 3 }
}
globalThis.WebSocket = Socket
globalThis.RTCPeerConnection = Peer
globalThis.window = { location: { href: 'http://localhost:5173/' } }
const renderer = createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode() {}, nextSibling() {} })
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
async function mount(t, role = 'receiver', type = 'file', options = {}) {
  let session
  const app = renderer.createApp({ setup() { useRoomStore().setRole(role); session = useSession(type, options); return () => null } })
  app.use(createPinia()); app.mount({})
  t.after(() => app.unmount())
  await session.connect('Ab3xY9')
  const ws = Socket.instances.at(-1)
  ws.open()
  return { session, ws, accept: () => ws.receive('accepted', { protocolVersion: 3, code: 'Ab3xY9', role, clientId: 'self' }), ready: (id = 'other') => ws.receive('peer-ready', { peerId: id, peerRole: role === 'sender' ? 'receiver' : 'sender', initiator: role === 'sender' }, id) }
}

test('sender uses token, onopen does not imply accepted, credentials are not exposed', async t => {
  const { session, ws, accept } = await mount(t, 'sender')
  assert.equal(ws.url.searchParams.get('senderToken'), token)
  assert.equal(session.accepted.value, false)
  assert.equal(session.roomId.value, '')
  assert.equal(session.busy.value, true)
  accept()
  assert.equal(session.roomId.value, 'Ab3xY9')
  assert.equal(session.clientId.value, 'self')
  assert.equal(session.senderToken, undefined)
})
test('receiver never includes sender credential', async t => {
  const { ws } = await mount(t)
  assert.equal(ws.url.searchParams.has('senderToken'), false)
})
test('old protocol accepted is rejected explicitly', async t => {
  const { session, ws } = await mount(t)
  ws.receive('accepted', { protocolVersion: 2, code: 'Ab3xY9', role: 'receiver', clientId: 'self' })
  assert.match(session.error.value, /v3/)
  assert.equal(session.accepted.value, false)
})
test('sender offers independently to two receivers; repeated peer-ready is idempotent', async t => {
  const { session, ws, accept, ready } = await mount(t, 'sender')
  accept(); ready('A'); ready('B'); ready('A')
  await flush()
  assert.equal(session.peers.size, 2)
  assert.deepEqual(ws.sent.filter(msg => msg.type === 'offer').map(msg => msg.to), ['A', 'B'])
  for (const peer of session.peers.values()) assert.equal(peer.pc.channels.length, 1)
  session.peers.get('A').pc.onicecandidate({ candidate: { candidate: 'ice-A' } })
  assert.equal(ws.sent.at(-1).to, 'A')
})
test('receiver never initiates; sends answer to trusted sender ID', async t => {
  const { session, ws, accept, ready } = await mount(t)
  accept(); ready('S'); await flush()
  assert.equal(ws.sent.length, 0)
  ws.receive('offer', { type: 'offer', sdp: 'remote' }, 'S')
  await flush()
  assert.equal(session.peers.get('S').pc.channels.length, 0)
  assert.equal(ws.sent.at(-1).type, 'answer')
  assert.equal(ws.sent.at(-1).to, 'S')
})
test('ICE queues are isolated by peer ID', async t => {
  const { session, ws, accept, ready } = await mount(t, 'sender')
  accept(); ready('A'); ready('B'); await flush()
  ws.receive('candidate', { candidate: 'ice-A' }, 'A')
  ws.receive('candidate', { candidate: 'ice-B' }, 'B')
  ws.receive('answer', { type: 'answer', sdp: 'a' }, 'A')
  await flush()
  assert.deepEqual(session.peers.get('A').pc.candidates, [{ candidate: 'ice-A' }])
  assert.deepEqual(session.peers.get('B').pc.candidates, [])
  assert.equal(session.peers.get('B').candidates.length, 1)
})
test('reset cancels only departed peer and invalidates its pending offer', async t => {
  const { session, ws, accept, ready } = await mount(t, 'sender')
  accept(); ready('A')
  const old = session.peers.get('A')
  let release
  old.pc.createOffer = () => new Promise(resolve => { release = resolve })
  await flush()
  ready('B'); await flush()
  ws.receive('reset', 'reset', 'A')
  release({ type: 'offer', sdp: 'stale' }); await flush()
  assert.equal(session.peers.has('A'), false)
  assert.equal(session.peers.get('B').status, 'negotiating')
  assert.deepEqual(ws.sent.filter(msg => msg.type === 'offer').map(msg => msg.to), ['B'])
  assert.equal(session.accepted.value, true)
  ready('C'); await flush()
  assert.equal(ws.sent.at(-1).to, 'C')
})
test('peer failure does not close other devices or signaling', async t => {
  const { session, accept, ready } = await mount(t, 'sender')
  accept(); ready('A'); ready('B'); await flush()
  session.peers.get('B').channel.open()
  session.failPeer('A', new Error('test failure'))
  assert.equal(session.peers.get('B').connected, true)
  assert.equal(session.accepted.value, true)
})
function connectionState(peer, state) { peer.pc.connectionState = state; peer.pc.onconnectionstatechange?.() }

test('temporary RTC disconnect recovers with the same channel and no duplicate connected callback', async t => {
  let connections = 0
  const { session, accept, ready } = await mount(t, 'sender', 'file', { connected() { connections++ } })
  accept(); ready('A'); await flush()
  const peer = session.peers.get('A')
  peer.channel.open()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  connectionState(peer, 'disconnected')
  assert.match(session.status.value, /等待恢复/)
  t.mock.timers.tick(14999)
  assert.equal(peer.channel.readyState, 'open')
  connectionState(peer, 'connected')
  t.mock.timers.tick(30000)
  assert.equal(session.peers.get('A'), peer)
  assert.equal(peer.channel.readyState, 'open')
  assert.equal(peer.disconnectTimer, undefined)
  assert.equal(connections, 1)
  assert.match(session.status.value, /已连接/)
  // A later interruption gets its own full recovery window.
  connectionState(peer, 'disconnected')
  t.mock.timers.tick(14999)
  assert.equal(peer.status, 'connected')
  t.mock.timers.tick(1)
  assert.equal(peer.status, 'failed')
})

test('RTC recovery deadline cannot be extended by repeated events and only fails the affected peer', async t => {
  const { session, accept, ready } = await mount(t, 'sender')
  accept(); ready('A'); ready('B'); await flush()
  const a = session.peers.get('A'), b = session.peers.get('B')
  a.channel.open(); b.channel.open()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  connectionState(a, 'disconnected')
  t.mock.timers.tick(10000)
  connectionState(a, 'disconnected')
  connectionState(a, 'connecting')
  t.mock.timers.tick(5000)
  assert.equal(a.status, 'failed')
  assert.match(a.error, /15 秒/)
  assert.equal(a.channel.readyState, 'closed')
  assert.equal(b.channel.readyState, 'open')
  assert.equal(session.accepted.value, true)
})

test('RTC failed is immediate and reset or session cleanup cancels recovery timers', async t => {
  const cleaned = []
  const { session, ws, accept, ready } = await mount(t, 'sender', 'file', { peerCleanup(peer) { cleaned.push(peer.id) } })
  accept(); ready('A'); ready('B'); await flush()
  const a = session.peers.get('A'), b = session.peers.get('B')
  a.channel.open(); b.channel.open()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  connectionState(a, 'disconnected')
  connectionState(a, 'failed')
  assert.equal(a.status, 'failed')
  assert.equal(a.disconnectTimer, undefined)
  connectionState(b, 'disconnected')
  ws.receive('reset', 'reset', 'B')
  assert.equal(b.disconnectTimer, undefined)
  ready('B'); await flush()
  const replacement = session.peers.get('B')
  replacement.channel.open()
  t.mock.timers.tick(15000)
  assert.equal(replacement.status, 'connected')
  connectionState(replacement, 'disconnected')
  session.disconnect()
  assert.equal(replacement.disconnectTimer, undefined)
  t.mock.timers.tick(30000)
  assert.deepEqual(cleaned, ['A', 'B', 'A', 'B'])
})

test('screen renegotiation requested during initial offer waits for answer', async t => {
  const { session, ws, accept, ready } = await mount(t, 'sender', 'screen')
  accept(); ready('A'); await flush()
  await session.offer('A')
  assert.equal(ws.sent.filter(msg => msg.type === 'offer').length, 1)
  ws.receive('answer', { type: 'answer', sdp: 'initial-answer' }, 'A')
  await flush()
  assert.equal(ws.sent.filter(msg => msg.type === 'offer').length, 2)
})
test('one peer setup error does not terminate the room or another peer', async t => {
  const { session, accept, ready } = await mount(t, 'sender', 'screen', { peer(peer) { if (peer.id === 'B') throw new Error('track failure') } })
  accept(); ready('A'); ready('B'); await flush()
  assert.equal(session.accepted.value, true)
  assert.equal(session.peers.get('A').status, 'negotiating')
  assert.equal(session.peers.get('B').status, 'failed')
})
test('nonfatal route error does not remove any peer', async t => {
  const { session, ws, accept, ready } = await mount(t, 'sender')
  accept(); ready('A'); ready('B')
  ws.receive('error', { code: 'TARGET_NOT_FOUND', fatal: false })
  assert.equal(session.peers.size, 2)
  assert.equal(session.accepted.value, true)
  assert.match(session.error.value, /目标设备/)
})
test('fatal business error clears invalid credentials and survives generic close', async t => {
  const { session, ws } = await mount(t, 'sender')
  ws.receive('error', { code: 'SENDER_UNAUTHORIZED', closeCode: 4403 })
  ws.onclose?.({ code: 1006 })
  assert.match(session.error.value, /凭证/)
  assert.equal(session.canReconnect.value, false)
})
test('transient close permits reconnect to same room without creating another room', async t => {
  const { session, ws, accept, ready } = await mount(t, 'sender')
  accept(); ready('A'); await flush()
  const count = requests
  ws.onclose({ code: 4001 })
  assert.equal(session.peers.size, 0)
  assert.equal(session.canReconnect.value, true)
  await session.reconnect()
  const next = Socket.instances.at(-1)
  assert.equal(next.url.searchParams.get('senderToken'), token)
  assert.equal(requests, count)
  assert.equal(session.accepted.value, false)
})
test('receiver waits for returning sender after reset', async t => {
  const { session, ws, accept, ready } = await mount(t)
  accept(); ready('old-sender'); ws.receive('reset', 'reset', 'old-sender')
  assert.equal(session.accepted.value, true)
  ready('new-sender')
  assert.equal(session.peers.size, 1)
  assert.ok(session.peers.has('new-sender'))
})
test('reserved messages cannot be sent by client', async t => {
  const { session, accept, ready } = await mount(t, 'sender')
  accept(); ready('A')
  for (const type of ['accepted', 'peer-ready', 'reset', 'error', 'joined']) assert.throws(() => session.send('A', type), /保留/)
})
test('invalid code does not open WebSocket; mixed case is preserved', async t => {
  const { session, ws } = await mount(t)
  session.disconnect()
  const count = Socket.instances.length
  await session.connect('abcdefg')
  assert.equal(Socket.instances.length, count)
  assert.equal(ws.url.searchParams.get('code'), 'Ab3xY9')
})
test('malformed signal cleans up the session', async t => {
  const { session, ws, accept } = await mount(t)
  accept(); ws.onmessage({ data: '{' })
  assert.equal(session.accepted.value, false)
  assert.ok(session.error.value)
})

class FileChannel extends EventTarget {
  readyState = 'open'
  bufferedAmount = 0
  headers = []
  send(data) {
    if (typeof data !== 'string') return
    const msg = JSON.parse(data)
    if (msg.type === 'file-info') this.headers.push(msg)
    if (msg.type === 'file-end') {
      const header = this.headers.at(-1)
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'file-ack', fileId: msg.fileId, size: header.size, sha256: header.sha256 }) }))
    }
  }
}
const device = id => ({ id, connected: true, channel: new FileChannel(), pc: {} })
async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)) }; throw new Error('condition timed out') }
test('two independent file recipients complete; late peer receives once from the beginning', async () => {
  const distribution = useFileDistribution((_, error) => { throw error })
  const a = device('A'), b = device('B'), c = device('C')
  distribution.publish([new File(['v3-data'], 'test.txt')], [a, b])
  await until(() => distribution.list.value.every(item => item.state === 'done'))
  distribution.enqueue(c); distribution.enqueue(a)
  await until(() => distribution.transfers.get('C').state === 'done')
  assert.equal(a.channel.headers.length, 1)
  assert.equal(b.channel.headers.length, 1)
  assert.equal(c.channel.headers.length, 1)
  distribution.clear()
})
test('cancel stalled recipient leaves other transfer healthy and starts queued recipient', async () => {
  const distribution = useFileDistribution(() => {})
  const a = device('A'), b = device('B'), c = device('C')
  a.channel.bufferedAmount = 300000
  distribution.publish([new File(['v3-data'], 'test.txt')], [a, b, c])
  assert.equal(distribution.transfers.get('C').state, 'queued')
  distribution.remove('A')
  await until(() => distribution.transfers.get('B').state === 'done' && distribution.transfers.get('C').state === 'done')
  assert.equal(a.channel.headers.length, 0)
  distribution.clear()
})

test('paused recipients release slots and resume within the two-device limit without restarting files', async t => {
  const failures = []
  const distribution = useFileDistribution((id, error) => failures.push({ id, error }))
  t.after(() => distribution.clear())
  const devices = ['A', 'B', 'C', 'D'].map(device)
  const bytes = new Uint8Array(50000).fill(17)
  const received = new Map()
  for (const peer of devices) {
    const chunks = []
    received.set(peer.id, chunks)
    const send = peer.channel.send.bind(peer.channel)
    peer.channel.send = data => {
      if (typeof data !== 'string') {
        chunks.push(data)
        // Stop after the first chunk so pauses happen midway through a file.
        if (chunks.length === 1) peer.channel.bufferedAmount = 300000
      }
      send(data)
    }
  }
  distribution.publish([new File([bytes], 'payload.bin')], devices)
  await until(() => received.get('A').length === 1 && received.get('B').length === 1)
  distribution.pause('A', true)
  distribution.pause('B', true)
  await until(() => received.get('C').length === 1 && received.get('D').length === 1)
  distribution.pause('A', false)
  distribution.pause('B', false)
  devices[0].channel.bufferedAmount = devices[1].channel.bufferedAmount = 0
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(received.get('A').length, 1)
  assert.equal(received.get('B').length, 1)
  assert.equal(distribution.transfers.get('A').state, 'queued')
  assert.equal(distribution.list.value.filter(item => item.state === 'sending').length, 2)
  devices[2].channel.bufferedAmount = devices[3].channel.bufferedAmount = 0
  await until(() => distribution.list.value.every(item => item.state === 'done'))
  for (const peer of devices) {
    assert.equal(peer.channel.headers.length, 1)
    assert.deepEqual(new Uint8Array(await new Blob(received.get(peer.id)).arrayBuffer()), bytes)
  }
  assert.deepEqual(failures, [])
})

test('removing paused tasks and clearing old queues does not consume new sending slots', async t => {
  const distribution = useFileDistribution(() => {})
  t.after(() => distribution.clear())
  const a = device('A'), b = device('B'), c = device('C')
  a.channel.bufferedAmount = b.channel.bufferedAmount = 300000
  distribution.publish([new File(['old'], 'old.txt')], [a, b, c])
  distribution.pause('A', true)
  distribution.remove('A')
  distribution.clear()
  const next = ['A', 'B', 'C'].map(device)
  distribution.publish([new File(['new'], 'new.txt')], next)
  await until(() => distribution.list.value.every(item => item.state === 'done'))
  for (const peer of next) assert.deepEqual(peer.channel.headers.map(header => header.name), ['new.txt'])
})
