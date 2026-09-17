import { computed, shallowReactive } from 'vue'
import type { SessionPeer } from './useSession'
import { confirmFile, sendFileQueue } from '../util/fileTransfer'

interface Transfer {
  peer: SessionPeer; controller: AbortController; files: File[]; paused: boolean;
  state: 'queued' | 'sending' | 'done' | 'failed'; name: string; progress: number; error: string;
}

export function useFileDistribution(onFailure: (id: string, error: unknown) => void) {
  const transfers = shallowReactive(new Map<string, Transfer>())
  let published: File[] = []
  // A paused queue keeps its file offset, but releases its sending slot.
  const slots = new Set<Transfer>()
  const started = new WeakSet<Transfer>()
  const list = computed(() => [...transfers.values()])
  const active = computed(() => list.value.some(item => item.state === 'queued' || item.state === 'sending'))
  function remove(id: string) {
    const item = transfers.get(id)
    if (!item) return
    item.controller.abort()
    slots.delete(item)
    transfers.delete(id)
    pump()
  }
  function clear() {
    published = []
    for (const item of transfers.values()) item.controller.abort()
    transfers.clear()
    slots.clear()
  }
  function enqueue(peer: SessionPeer) {
    if (!published.length || !peer.connected || transfers.has(peer.id)) return
    transfers.set(peer.id, shallowReactive({ peer, controller: new AbortController(), files: [...published], paused: false, state: 'queued', name: '', progress: 0, error: '' }))
    pump()
  }
  function publish(files: File[], peers: SessionPeer[]) {
    if (active.value) return
    clear()
    published = [...files]
    for (const peer of peers) enqueue(peer)
  }
  function pump() {
    for (const item of transfers.values()) {
      if (slots.size >= 2) break
      if (item.state !== 'queued' || item.paused) continue
      const channel = item.peer.channel
      if (!channel || channel.readyState !== 'open') { item.state = 'failed'; item.error = '传输通道尚未就绪'; continue }
      slots.add(item)
      item.state = 'sending'
      if (started.has(item)) continue
      started.add(item)
      void sendFileQueue(item.files, channel, item.controller.signal, () => item.paused || !slots.has(item), (name, progress) => {
        item.name = name; item.progress = progress
      }, {
        maxMessageSize: item.peer.pc.sctp?.maxMessageSize,
        confirm: (id, size, hash) => confirmFile(channel, item.controller.signal, id, size, hash),
      }).then(() => { if (!item.controller.signal.aborted) item.state = 'done' }).catch(error => {
        if (!item.controller.signal.aborted) {
          item.state = 'failed'
          item.error = error instanceof Error ? error.message : '传输失败'
          onFailure(item.peer.id, error)
        }
      }).finally(() => { slots.delete(item); pump() })
    }
  }
  function pause(id: string, value: boolean) {
    const item = transfers.get(id)
    if (!item || (item.state !== 'queued' && item.state !== 'sending')) return
    item.paused = value
    if (value) { slots.delete(item); item.state = 'queued' }
    pump()
  }
  return { transfers, list, active, publish, enqueue, remove, clear, pause }
}
