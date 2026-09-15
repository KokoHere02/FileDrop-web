import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRenderer } from 'vue'
import { createPinia } from 'pinia'
import axios from 'axios'

// 编译真实 composable；只替换浏览器网络和 RTC API，不复制协商实现。
axios.defaults.adapter = async config => ({ data: { code: 200, data: 'Ab3xY9' }, status: 200, statusText: 'OK', headers: {}, config })
await build({ stdin: { contents: "export { useSession } from './src/composables/useSession'; export { useRoomStore } from './src/store/RoomStore'", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', packages: 'external', define: { 'import.meta.env': '{}' }, outfile: 'node_modules/.tmp/session-test.mjs' })
const { useSession, useRoomStore } = await import('../node_modules/.tmp/session-test.mjs')
const saved = { WebSocket: globalThis.WebSocket, RTCPeerConnection: globalThis.RTCPeerConnection, window: globalThis.window }
after(() => Object.assign(globalThis, saved))

class Channel extends EventTarget {
  readyState = 'connecting'
  close() { this.readyState = 'closed' }
}
class Peer {
  static instances = []
  signalingState = 'stable'
  connectionState = 'new'
  remoteDescription = null
  channels = []
  candidates = []
  constructor() { Peer.instances.push(this) }
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
  receive(type, payload) { this.onmessage?.({ data: JSON.stringify({ type, payload }) }) }
  close() { this.readyState = 3 }
}
globalThis.WebSocket = Socket
globalThis.RTCPeerConnection = Peer
globalThis.window = { location: { href: 'http://localhost:5173/' } }
const renderer = createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode() {}, nextSibling() {} })
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
async function mount(t, role = 'receiver', type = 'file') {
  let session
  const app = renderer.createApp({ setup() { useRoomStore().setRole(role); session = useSession(type); return () => null } })
  app.use(createPinia())
  app.mount({})
  t.after(() => app.unmount())
  await session.connect('Ab3xY9')
  const ws = Socket.instances.at(-1)
  ws.open()
  return { session, ws }
}

for (const role of ['sender', 'receiver']) {
  test(`${role} first: joined creates one ordered channel and offer`, async t => {
    const { session, ws } = await mount(t, role)
    assert.equal(session.connected.value, false)
    ws.receive('joined', 'joined')
    await flush()
    assert.equal(session.peer.value.channels.length, 1)
    assert.equal(ws.sent.filter(msg => msg.type === 'offer').length, 1)
    assert.equal(session.status.value, '正在协商连接')
  })
  test(`${role} second: offer produces answer without duplicate channel`, async t => {
    const { session, ws } = await mount(t, role)
    ws.receive('offer', { type: 'offer', sdp: 'remote' })
    await flush()
    assert.equal(session.peer.value.channels.length, 0)
    assert.equal(ws.sent.at(-1).type, 'answer')
  })
}
test('ICE before SDP queues and flushes after remote description', async t => {
  const { session, ws } = await mount(t)
  ws.receive('candidate', { candidate: 'early' })
  ws.receive('offer', { type: 'offer', sdp: 'remote' })
  await flush()
  assert.equal(session.peer.value.candidates[0].candidate, 'early')
})
test('reset invalidates in-flight offer and queued ICE; rejoin creates new peer', async t => {
  const { session, ws } = await mount(t)
  const oldPeer = session.ensurePeer()
  let release
  oldPeer.createOffer = () => new Promise(resolve => { release = resolve })
  ws.receive('joined', 'joined')
  await flush()
  ws.receive('candidate', { candidate: 'stale' })
  ws.receive('reset', 'reset')
  ws.receive('joined', 'joined')
  await flush()
  release({ type: 'offer', sdp: 'stale' })
  await flush()
  assert.notEqual(session.peer.value, oldPeer)
  assert.equal(oldPeer.connectionState, 'closed')
  assert.equal(ws.sent.filter(msg => msg.type === 'offer').length, 1)
  ws.receive('answer', { type: 'answer', sdp: 'new-answer' })
  await flush()
  assert.deepEqual(session.peer.value.candidates, [])
  assert.equal(session.isWs.value, true)
})
test('error preserves close handler and 1008 produces accurate message', async t => {
  const { session, ws } = await mount(t)
  ws.onerror()
  ws.onclose({ code: 1008, reason: '' })
  assert.match(session.error.value, /房间不可用或角色已被占用/)
  assert.equal(session.roomId.value, '')
})
test('invalid code never opens a WebSocket; code case is preserved', async t => {
  const { session, ws } = await mount(t)
  const count = Socket.instances.length
  await session.connect('abcdefg')
  assert.equal(Socket.instances.length, count)
  assert.equal(ws.url.searchParams.get('code'), 'Ab3xY9')
  assert.match(session.error.value, /6 位/)
})
test('screen also negotiates a control channel before capturing media', async t => {
  const { session, ws } = await mount(t, 'receiver', 'screen')
  ws.receive('joined', 'joined')
  await flush()
  assert.equal(session.peer.value.channels.length, 1)
  assert.equal(ws.sent.at(-1).type, 'offer')
})
test('malformed signal cleans up the current session', async t => {
  const { session, ws } = await mount(t)
  ws.onmessage({ data: '{' })
  assert.equal(session.isWs.value, false)
  assert.ok(session.error.value)
})
