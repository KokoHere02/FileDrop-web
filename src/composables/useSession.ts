import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { createRoom } from '../api/room'
import { useRoomStore } from '../store/RoomStore'
import type { TransferType } from '../type/type'
import { isRoomCode, signalingCloseMessage } from '../util/protocol'

interface SessionOptions {
  channel?: (channel: RTCDataChannel) => void
  peer?: (peer: RTCPeerConnection) => void
  message?: (type: string) => void
  cleanup?: () => void
}

export function useSession(type: TransferType, options: SessionOptions = {}) {
  const role = useRoomStore().role
  const roomId = ref('')
  const busy = ref(false)
  const isWs = ref(false)
  const connected = ref(false)
  const negotiating = ref(false)
  const error = ref('')
  const notice = ref('')
  const peer = shallowRef<RTCPeerConnection | null>(null)
  const channel = shallowRef<RTCDataChannel | null>(null)
  let socket: WebSocket | null = null
  let candidates: RTCIceCandidateInit[] = []
  let generation = 0
  let round = 0
  let negotiationTimeout: ReturnType<typeof setTimeout> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  const status = computed(() => connected.value ? '设备已连接' : negotiating.value ? '正在协商连接' : isWs.value ? '等待对方连接' : busy.value ? '正在连接' : '未连接')

  function report(err: unknown) { error.value = err instanceof Error ? err.message : '操作失败，请重试' }
  function resetPeer() {
    round++
    clearTimeout(negotiationTimeout)
    negotiating.value = false
    if (channel.value) {
      channel.value.onopen = channel.value.onclose = channel.value.onerror = channel.value.onmessage = null
      channel.value.close()
    }
    channel.value = null
    if (peer.value) {
      peer.value.onconnectionstatechange = peer.value.onicecandidate = peer.value.ondatachannel = peer.value.ontrack = null
      peer.value.close()
    }
    peer.value = null
    connected.value = false
    candidates = []
    options.cleanup?.()
  }
  function disconnect() {
    generation++
    clearTimeout(timeout)
    if (socket) {
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null
      socket.close()
      socket = null
    }
    resetPeer()
    roomId.value = ''
    isWs.value = busy.value = false
  }
  function send(type: string, payload?: unknown) {
    if (type === 'joined' || type === 'reset') throw new Error('不能发送服务端保留信令')
    if (socket?.readyState !== WebSocket.OPEN) throw new Error('房间连接已断开，请重新连接')
    socket.send(JSON.stringify({ type, payload }))
  }
  function bindChannel(value: RTCDataChannel) {
    channel.value = value
    value.onopen = () => {
      if (channel.value !== value) return
      connected.value = true
      negotiating.value = false
      clearTimeout(negotiationTimeout)
      error.value = notice.value = ''
    }
    value.onclose = () => { if (channel.value === value) fail('传输通道已关闭，请重新加入房间') }
    value.onerror = () => { if (channel.value === value) fail('传输通道异常，请重新连接') }
    options.channel?.(value)
  }
  function ensurePeer() {
    if (peer.value) return peer.value
    const iceServers: RTCIceServer[] = import.meta.env.VITE_ICE_SERVERS
      ? JSON.parse(import.meta.env.VITE_ICE_SERVERS)
      : [{ urls: import.meta.env.VITE_STUN_URL || 'stun:stun.l.google.com:19302' }]
    const pc = new RTCPeerConnection({ iceServers })
    peer.value = pc
    pc.onicecandidate = (event) => {
      if (peer.value === pc && event.candidate && socket?.readyState === WebSocket.OPEN) send('candidate', event.candidate)
    }
    pc.onconnectionstatechange = () => {
      if (peer.value !== pc) return
      connected.value = pc.connectionState === 'connected' && channel.value?.readyState === 'open'
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') fail('设备连接已中断，请重新加入房间或更换网络')
    }
    pc.ondatachannel = (event) => { if (peer.value === pc) bindChannel(event.channel) }
    options.peer?.(pc)
    return pc
  }
  function fail(message: string) { disconnect(); error.value = message }
  function startNegotiating() {
    negotiating.value = true
    clearTimeout(negotiationTimeout)
    negotiationTimeout = setTimeout(() => fail('设备协商超时，请重新连接并检查 STUN/TURN 配置'), 30000)
  }
  async function offer() {
    const pc = ensurePeer()
    if (pc.signalingState !== 'stable') return
    startNegotiating()
    const description = await pc.createOffer()
    if (peer.value !== pc) return
    await pc.setLocalDescription(description)
    if (peer.value === pc) send('offer', pc.localDescription)
  }
  async function receive(msg: { type: string; payload?: unknown }) {
    if (msg.type === 'joined') {
      const pc = ensurePeer()
      if (!channel.value) bindChannel(pc.createDataChannel(type, { ordered: true }))
      await offer()
      options.message?.(msg.type)
    } else if (msg.type === 'offer' || msg.type === 'answer') {
      const description = msg.payload as RTCSessionDescriptionInit | undefined
      if (description?.type !== msg.type || typeof description.sdp !== 'string') throw new Error('SDP 信令格式异常')
      const pc = ensurePeer()
      if (msg.type === 'offer') startNegotiating()
      await pc.setRemoteDescription(description)
      if (peer.value !== pc) return
      for (const candidate of candidates.splice(0)) {
        if (peer.value !== pc) return
        await pc.addIceCandidate(candidate)
      }
      if (msg.type === 'offer') {
        const answer = await pc.createAnswer()
        if (peer.value !== pc) return
        await pc.setLocalDescription(answer)
        if (peer.value === pc) send('answer', pc.localDescription)
      }
      if (peer.value === pc && channel.value?.readyState === 'open') {
        negotiating.value = false
        clearTimeout(negotiationTimeout)
      }
    } else if (msg.type === 'candidate' && msg.payload) {
      const candidate = msg.payload as RTCIceCandidateInit
      if (peer.value?.remoteDescription) await peer.value.addIceCandidate(candidate)
      else candidates.push(candidate)
    } else options.message?.(msg.type)
  }
  async function connect(input = '') {
    if (busy.value) return
    error.value = notice.value = ''
    if (role === 'receiver' && !isRoomCode(input.trim())) { error.value = '请输入 6 位字母或数字取件码，区分大小写'; return }
    disconnect()
    const current = generation
    busy.value = true
    try {
      const code = role === 'sender' ? await createRoom(type) : input.trim()
      if (current !== generation) return
      const url = new URL(import.meta.env.VITE_SIGNALING_URL || '/api/ws', window.location.href)
      if (url.protocol === 'http:') url.protocol = 'ws:'
      if (url.protocol === 'https:') url.protocol = 'wss:'
      url.searchParams.set('code', code)
      url.searchParams.set('role', role)
      const ws = new WebSocket(url)
      socket = ws
      timeout = setTimeout(() => { if (socket === ws && !isWs.value) { disconnect(); error.value = '连接超时，请检查服务地址后重试' } }, 10000)
      ws.onopen = () => { if (socket !== ws) return; clearTimeout(timeout); roomId.value = code; isWs.value = true; busy.value = false }
      ws.onclose = (event) => { if (socket === ws) fail(signalingCloseMessage(event.code)) }
      // error 后仍保留 close 处理器，避免丢失 1008 等有意义的关闭码。
      ws.onerror = () => { if (socket === ws) error.value = '连接异常，正在等待关闭状态；请检查网络与服务配置' }
      // 串行处理信令，避免 SDP 与 ICE 的异步竞争。
      let queue = Promise.resolve()
      ws.onmessage = (event) => {
        if (socket !== ws) return
        try {
          const msg = JSON.parse(event.data) as { type: string; payload?: unknown }
          if (!msg || typeof msg.type !== 'string' || !msg.type.trim()) throw new Error('信令消息格式异常')
          // reset 不等待旧协商完成，立即使该轮异步结果和排队任务失效。
          if (msg.type === 'reset') {
            resetPeer()
            queue = Promise.resolve()
            notice.value = '对方已离开，等待重新连接'
            return
          }
          const currentRound = round
          queue = queue.then(async () => { if (socket === ws && round === currentRound) await receive(msg) }).catch((err) => {
            if (socket === ws && round === currentRound) { disconnect(); report(err) }
          })
        } catch (err) { disconnect(); report(err) }
      }
    } catch (err) {
      if (current === generation) { disconnect(); report(err) }
    }
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); notice.value = '已复制到剪贴板' }
    catch { error.value = '复制失败，请手动选择并复制内容' }
  }
  onBeforeUnmount(disconnect)
  return { role, roomId, busy, isWs, connected, negotiating, status, error, notice, peer, channel, connect, disconnect, send, ensurePeer, offer, report, copy }
}
