import { computed, onBeforeUnmount, ref, shallowReactive } from 'vue'
import { createRoom } from '../api/room'
import { useRoomStore } from '../store/RoomStore'
import type { TransferType } from '../type/type'
import { isRoomCode, signalingCloseMessage, signalingErrorMessage, type RoomCredentials } from '../util/protocol'

export interface SessionPeer {
  id: string
  pc: RTCPeerConnection
  channel: RTCDataChannel | null
  connected: boolean
  status: 'negotiating' | 'connected' | 'failed'
  error: string
  candidates: RTCIceCandidateInit[]
  queue: Promise<void>
  timer?: ReturnType<typeof setTimeout>
  pendingOffer: boolean
}
interface Signal { type: string; from?: string; to?: string; payload?: unknown }
interface SessionOptions {
  peer?: (peer: SessionPeer) => void
  channel?: (channel: RTCDataChannel, peer: SessionPeer) => void
  connected?: (peer: SessionPeer) => void
  message?: (type: string, peer: SessionPeer, payload: unknown) => void
  peerCleanup?: (peer: SessionPeer) => void
  cleanup?: () => void
}
const RESERVED = new Set(['accepted', 'peer-ready', 'reset', 'error', 'joined'])

export function useSession(type: TransferType, options: SessionOptions = {}) {
  const role = useRoomStore().role
  const roomId = ref('')
  const clientId = ref('')
  const busy = ref(false)
  const isWs = ref(false)
  const accepted = ref(false)
  const error = ref('')
  const notice = ref('')
  const canReconnect = ref(false)
  const peers = shallowReactive(new Map<string, SessionPeer>())
  const peerList = computed(() => [...peers.values()])
  const connectedPeers = computed(() => peerList.value.filter(peer => peer.connected))
  const connected = computed(() => connectedPeers.value.length > 0)
  const status = computed(() => busy.value ? '正在加入房间' : connected.value
    ? role === 'sender' ? `${connectedPeers.value.length} 台设备已连接` : '设备已连接'
    : peerList.value.some(peer => peer.status === 'negotiating') ? '正在协商连接' : accepted.value ? '等待对方连接' : '未连接')
  let socket: WebSocket | null = null
  let credentials: RoomCredentials | null = null
  let receiverCode = ''
  let generation = 0
  let timeout: ReturnType<typeof setTimeout> | undefined
  let fatalMessage = ''

  function report(err: unknown) { error.value = err instanceof Error ? err.message : '操作失败，请重试' }
  function current(peer: SessionPeer) { return peers.get(peer.id) === peer && peer.status !== 'failed' }
  function disposePeer(peer: SessionPeer) {
    clearTimeout(peer.timer)
    peer.connected = false
    peer.candidates = []
    peer.pendingOffer = false
    if (peer.channel) {
      peer.channel.onopen = peer.channel.onclose = peer.channel.onerror = peer.channel.onmessage = null
      peer.channel.close()
    }
    peer.pc.onconnectionstatechange = peer.pc.onicecandidate = peer.pc.ondatachannel = peer.pc.ontrack = null
    peer.pc.close()
    options.peerCleanup?.(peer)
  }
  function removePeer(id: string) {
    const peer = peers.get(id)
    if (!peer) return
    peers.delete(id)
    disposePeer(peer)
  }
  function failPeer(id: string, err: unknown) {
    const peer = peers.get(id)
    if (!peer || peer.status === 'failed') return
    peer.status = 'failed'
    peer.error = err instanceof Error ? err.message : String(err)
    disposePeer(peer)
  }
  function closeSession(forget: boolean) {
    generation++
    clearTimeout(timeout)
    if (socket) {
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null
      socket.close()
      socket = null
    }
    for (const id of [...peers.keys()]) removePeer(id)
    options.cleanup?.()
    roomId.value = clientId.value = ''
    isWs.value = accepted.value = busy.value = false
    if (forget) { credentials = null; receiverCode = '' }
    canReconnect.value = !!(role === 'sender' ? credentials : receiverCode)
  }
  function disconnect() { closeSession(true) }
  function send(peerId: string, messageType: string, payload?: unknown) {
    if (RESERVED.has(messageType)) throw new Error('不能发送服务端保留信令')
    if (!accepted.value || socket?.readyState !== WebSocket.OPEN) throw new Error('尚未加入房间，请重新连接')
    if (!peers.has(peerId)) throw new Error('目标设备已离开')
    socket.send(JSON.stringify({ type: messageType, to: peerId, payload }))
  }
  function startTimer(peer: SessionPeer) {
    clearTimeout(peer.timer)
    peer.timer = setTimeout(() => { if (current(peer)) failPeer(peer.id, '设备协商超时，请让该设备重新加入并检查网络配置') }, 30000)
  }
  function bindChannel(peer: SessionPeer, channel: RTCDataChannel) {
    if (!current(peer) || peer.channel) { channel.close(); return }
    peer.channel = channel
    channel.onopen = () => {
      if (!current(peer)) return
      peer.connected = true
      peer.status = 'connected'
      clearTimeout(peer.timer)
      try { options.connected?.(peer) } catch (err) { failPeer(peer.id, err) }
    }
    channel.onclose = () => { if (current(peer)) failPeer(peer.id, '传输通道已关闭，请让该设备重新加入') }
    channel.onerror = () => { if (current(peer)) failPeer(peer.id, '传输通道异常，请让该设备重新加入') }
    options.channel?.(channel, peer)
  }
  function addPeer(id: string) {
    const iceServers: RTCIceServer[] = import.meta.env.VITE_ICE_SERVERS
      ? JSON.parse(import.meta.env.VITE_ICE_SERVERS)
      : [{ urls: import.meta.env.VITE_STUN_URL || 'stun:stun.l.google.com:19302' }]
    const pc = new RTCPeerConnection({ iceServers })
    const peer = shallowReactive<SessionPeer>({ id, pc, channel: null, connected: false, status: 'negotiating', error: '', candidates: [], queue: Promise.resolve(), pendingOffer: false })
    peers.set(id, peer)
    pc.onicecandidate = event => {
      if (current(peer) && event.candidate && socket?.readyState === WebSocket.OPEN) send(id, 'candidate', event.candidate)
    }
    pc.onconnectionstatechange = () => {
      if (!current(peer)) return
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') failPeer(id, '设备连接已中断，请让该设备重新加入')
    }
    pc.ondatachannel = event => bindChannel(peer, event.channel)
    startTimer(peer)
    options.peer?.(peer)
    return peer
  }
  function enqueue(peer: SessionPeer, task: () => Promise<void>) {
    peer.queue = peer.queue.then(async () => { if (current(peer)) await task() }).catch(err => { if (current(peer)) failPeer(peer.id, err) })
    return peer.queue
  }
  async function makeOffer(peer: SessionPeer) {
    if (role !== 'sender' || !current(peer)) return
    if (peer.pc.signalingState !== 'stable') { peer.pendingOffer = true; return }
    peer.pendingOffer = false
    startTimer(peer)
    const description = await peer.pc.createOffer()
    if (!current(peer)) return
    await peer.pc.setLocalDescription(description)
    if (current(peer)) send(peer.id, 'offer', peer.pc.localDescription)
  }
  function offer(id: string) {
    const peer = peers.get(id)
    return peer ? enqueue(peer, () => makeOffer(peer)) : Promise.resolve()
  }
  async function receive(peer: SessionPeer, msg: Signal) {
    if (msg.type === 'offer' || msg.type === 'answer') {
      if ((msg.type === 'offer') !== (role === 'receiver')) throw new Error('协商角色不符合 v3 协议')
      const description = msg.payload as RTCSessionDescriptionInit | undefined
      if (description?.type !== msg.type || typeof description.sdp !== 'string') throw new Error('SDP 信令格式异常')
      await peer.pc.setRemoteDescription(description)
      if (!current(peer)) return
      for (const candidate of peer.candidates.splice(0)) {
        if (!current(peer)) return
        await peer.pc.addIceCandidate(candidate)
      }
      if (!current(peer)) return
      if (msg.type === 'offer') {
        const answer = await peer.pc.createAnswer()
        if (!current(peer)) return
        await peer.pc.setLocalDescription(answer)
        if (current(peer)) send(peer.id, 'answer', peer.pc.localDescription)
      }
      if (!current(peer)) return
      if (peer.connected) clearTimeout(peer.timer)
      if (peer.pendingOffer) await makeOffer(peer)
    } else if (msg.type === 'candidate' && msg.payload) {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(msg.payload as RTCIceCandidateInit)
      else peer.candidates.push(msg.payload as RTCIceCandidateInit)
    } else options.message?.(msg.type, peer, msg.payload)
  }
  function handle(msg: Signal, code: string) {
    if (msg.type === 'error') {
      const payload = msg.payload as { code?: string; fatal?: boolean; closeCode?: number } | null
      const message = signalingErrorMessage(payload?.code)
      error.value = message
      if (payload?.fatal === false) return // 不含目标信息，不能推测或移除任意成员。
      fatalMessage = message
      closeSession(['SENDER_UNAUTHORIZED', 'ROOM_NOT_FOUND', 'ROOM_EXPIRED', 'INVALID_PARAMETERS'].includes(payload?.code ?? ''))
      return
    }
    if (msg.type === 'accepted') {
      const payload = msg.payload as { protocolVersion?: number; code?: string; role?: string; clientId?: string } | null
      if (accepted.value || payload?.protocolVersion !== 3 || payload.code !== code || payload.role !== role || !payload.clientId || msg.to !== payload.clientId) throw new Error('入房响应不符合协议 v3，请同步升级前后端')
      clearTimeout(timeout)
      clientId.value = payload.clientId
      roomId.value = code
      accepted.value = true
      busy.value = false
      canReconnect.value = false
      return
    }
    if (!accepted.value) throw new Error('未收到入房确认，无法建立连接')
    if (msg.to !== clientId.value) return
    if (msg.type === 'peer-ready') {
      const payload = msg.payload as { peerId?: string; peerRole?: string; initiator?: boolean } | null
      if (!payload?.peerId || payload.peerId !== msg.from || payload.peerId === clientId.value || payload.peerRole !== (role === 'sender' ? 'receiver' : 'sender') || payload.initiator !== (role === 'sender')) throw new Error('对端通知不符合协议 v3')
      if (peers.has(payload.peerId)) return
      if (role === 'receiver' && peers.size) throw new Error('房间中出现多个发送方')
      try {
        const peer = addPeer(payload.peerId)
        if (role === 'sender') {
          bindChannel(peer, peer.pc.createDataChannel(type, { ordered: true }))
          void offer(peer.id)
        }
      } catch (err) {
        if (peers.has(payload.peerId)) failPeer(payload.peerId, err)
        else report(err)
      }
    } else if (msg.type === 'reset') {
      if (msg.from) removePeer(msg.from)
      notice.value = role === 'sender' ? '一台接收设备已离开，其他连接不受影响' : '发送方已离开，等待重新连接'
    } else {
      const peer = msg.from ? peers.get(msg.from) : undefined
      if (peer) void enqueue(peer, () => receive(peer, msg))
    }
  }
  async function connect(input = '', resume = false) {
    if (busy.value) return
    error.value = notice.value = fatalMessage = ''
    if (!resume && role === 'receiver' && !isRoomCode(input.trim())) { error.value = '请输入 6 位字母或数字取件码，区分大小写'; return }
    closeSession(!resume)
    const currentGeneration = generation
    busy.value = true
    try {
      if (role === 'sender' && !credentials) {
        const created = await createRoom(type)
        if (currentGeneration !== generation) return
        credentials = created
      }
      if (currentGeneration !== generation) return
      if (role === 'receiver' && !resume) receiverCode = input.trim()
      const code = role === 'sender' ? credentials?.code : receiverCode
      if (!code) throw new Error('房间信息已失效，请重新创建或加入')
      const url = new URL(import.meta.env.VITE_SIGNALING_URL || '/api/ws', window.location.href)
      if (url.protocol === 'http:') url.protocol = 'ws:'
      if (url.protocol === 'https:') url.protocol = 'wss:'
      url.search = new URLSearchParams({ code, role, ...(role === 'sender' ? { senderToken: credentials!.senderToken } : {}) }).toString()
      const ws = new WebSocket(url)
      socket = ws
      timeout = setTimeout(() => { if (socket === ws) { closeSession(false); error.value = '等待入房确认超时，请检查服务地址及后端版本' } }, 10000)
      ws.onopen = () => { if (socket === ws) isWs.value = true }
      ws.onclose = event => {
        if (socket !== ws) return
        closeSession([4400, 4403, 4404, 4410].includes(event.code))
        error.value = fatalMessage || signalingCloseMessage(event.code)
      }
      ws.onerror = () => { if (socket === ws) error.value = '连接异常，正在等待关闭状态；请检查网络与服务配置' }
      ws.onmessage = event => {
        if (socket !== ws) return
        try {
          const msg = JSON.parse(event.data) as Signal
          if (!msg || typeof msg.type !== 'string' || !msg.type.trim()) throw new Error('信令消息格式异常')
          handle(msg, code)
        } catch (err) { closeSession(false); report(err) }
      }
    } catch (err) { if (currentGeneration === generation) { closeSession(false); report(err) } }
  }
  function reconnect() { return connect('', true) }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); notice.value = '已复制到剪贴板' }
    catch { error.value = '复制失败，请手动选择并复制内容' }
  }
  onBeforeUnmount(disconnect)
  return { role, roomId, clientId, busy, isWs, accepted, connected, connectedPeers, peers, peerList, status, error, notice, canReconnect, connect, reconnect, disconnect, send, offer, failPeer, report, copy }
}
