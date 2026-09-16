<script setup lang="ts">
import { onBeforeUnmount, ref, computed } from 'vue'
import SessionPanel from './SessionPanel.vue'
import { useSession } from '../composables/useSession'
import { useFileDistribution } from '../composables/useFileDistribution'
import { fileHash, MAX_FILE_SIZE } from '../util/fileTransfer'
const files = ref<File[]>([])
const dragging = ref(false)
const downloads = ref<{ name: string; url: string }[]>([])
const receiving = ref(false)
const paused = ref(false)
const progress = ref(0)
const filename = ref('')
const distribution = useFileDistribution((id, error) => session.failPeer(id, error))
const session = useSession('file', {
  connected(peer) { if (session.role === 'sender') distribution.enqueue(peer) },
  channel(channel, peer) {
    if (session.role !== 'receiver') return
    channel.binaryType = 'arraybuffer'
    let buffers: ArrayBuffer[] = []
    let header: { fileId: string; name: string; size: number; mimeType: string; sha256: string } | null = null
    let received = 0
    let queue = Promise.resolve()
    const current = () => session.peers.get(peer.id) === peer && peer.status !== 'failed'
    channel.onmessage = event => {
      queue = queue.then(async () => {
        if (!current()) return
        if (typeof event.data === 'string') {
          const msg = JSON.parse(event.data)
          if (msg.type === 'file-info') {
            if (header || typeof msg.fileId !== 'string' || !msg.fileId || typeof msg.name !== 'string' || !Number.isSafeInteger(msg.size) || msg.size < 0 || msg.size > MAX_FILE_SIZE || !/^[a-f0-9]{64}$/.test(msg.sha256)) throw new Error('文件信息无效或超过 256 MB，请确认双方前端版本一致')
            header = msg
            filename.value = msg.name
            received = 0
            buffers = []
            receiving.value = true
            progress.value = 0
          } else if (msg.type === 'file-end') {
            if (!header || msg.fileId !== header.fileId || received !== header.size) throw new Error('文件接收不完整')
            const blob = new Blob(buffers, { type: header.mimeType })
            const hash = await fileHash(blob)
            if (!current()) return
            if (hash !== header.sha256) throw new Error('文件哈希校验失败，请重新接收')
            channel.send(JSON.stringify({ type: 'file-ack', fileId: header.fileId, size: received, sha256: hash }))
            downloads.value.push({ name: header.name, url: URL.createObjectURL(blob) })
            buffers = []
            header = null
            receiving.value = false
            progress.value = 100
          }
        } else {
          if (!header || !(event.data instanceof ArrayBuffer) || received + event.data.byteLength > header.size) throw new Error('文件分片异常')
          buffers.push(event.data)
          received += event.data.byteLength
          progress.value = header.size ? Math.min(99, received / header.size * 100) : 0
        }
      }).catch(error => { buffers = []; header = null; if (current()) session.failPeer(peer.id, error) })
    }
    channel.addEventListener('close', () => { buffers = []; header = null })
  },
  message(type, peer) {
    if (session.role !== 'sender') return
    if (type === 'file-start') distribution.enqueue(peer)
    if (type === 'file-pause') distribution.pause(peer.id, true)
    if (type === 'file-resume') distribution.pause(peer.id, false)
  },
  peerCleanup(peer) {
    distribution.remove(peer.id)
    if (session.role === 'receiver') { receiving.value = paused.value = false; progress.value = 0; filename.value = '' }
  },
  cleanup() { distribution.clear() },
})
const sender = computed(() => session.connectedPeers.value[0])
function select(list: FileList | null) {
  if (!list || distribution.active.value) return
  if (Array.from(list).some(file => file.size > MAX_FILE_SIZE)) { session.error.value = '当前支持单文件不超过 256 MB，请分批或拆分文件'; return }
  distribution.clear()
  files.value = Array.from(list)
}
function pick(event: Event) { const input = event.target as HTMLInputElement; select(input.files); input.value = '' }
function drop(event: DragEvent) { dragging.value = false; select(event.dataTransfer?.files ?? null) }
function size(value: number) { return value < 1024 ? value + ' B' : value < 1048576 ? (value / 1024).toFixed(1) + ' KB' : (value / 1048576).toFixed(1) + ' MB' }
function publish() {
  distribution.publish(files.value, session.connectedPeers.value)
  session.notice.value = '已开启分发；后加入的设备会从头接收当前文件，每次最多向两台设备同时发送'
}
function togglePause() {
  if (!sender.value) return
  try { session.send(sender.value.id, paused.value ? 'file-resume' : 'file-pause'); paused.value = !paused.value }
  catch (error) { session.report(error) }
}
function clearDownloads() { downloads.value.forEach(file => URL.revokeObjectURL(file.url)); downloads.value = [] }
onBeforeUnmount(clearDownloads)
</script>
<template>
  <SessionPanel title="文件传输" description="一个房间，多台设备分别接收，独立查看传输进度。" :session="session">
    <template v-if="session.role === 'sender'">
      <label class="drop-zone" :class="{ dragging }" @dragover.prevent="dragging = true" @dragleave.prevent="dragging = false" @drop.prevent="drop">
        <span class="upload-icon" aria-hidden="true">↑</span><strong>拖拽文件到这里</strong><span>支持多选，单文件最多 256 MB</span>
        <input class="sr-only" type="file" multiple :disabled="distribution.active.value" @change="pick" />
      </label>
      <ul v-if="files.length" class="file-list"><li v-for="(file, index) in files" :key="index"><span>{{ file.name }}</span><small>{{ size(file.size) }}</small></li></ul>
      <div class="action-row"><span class="muted">已选择 {{ files.length }} 个文件 · 每台设备各占一份上传带宽</span><button class="button primary" :disabled="!files.length || distribution.active.value" @click="publish">发送给所有接收者</button></div>
      <div v-for="item in distribution.list.value" :key="item.peer.id" class="transfer-progress">
        <div class="content-heading"><span>{{ item.peer.id }} · {{ item.name || '等待发送' }}</span><span>{{ item.progress.toFixed(1) }}%</span></div>
        <progress :value="item.progress" max="100" :aria-label="item.peer.id + ' 的传输进度'" />
        <div class="action-row"><span class="muted">{{ item.state === 'done' ? '已完成并通过完整性校验' : item.state === 'queued' ? '排队等待发送' : item.paused ? '该设备已暂停' : item.state === 'failed' ? item.error : '正在发送 / 等待确认' }}</span><button v-if="item.state === 'queued' || item.state === 'sending'" class="button secondary" @click="session.failPeer(item.peer.id, '已取消该设备传输，请重新加入以接收')">取消此设备传输</button></div>
      </div>
    </template>
    <div v-else class="receive-area"><span class="upload-icon" aria-hidden="true">↓</span><h3>等待发送方分发文件</h3><p class="muted">连接后自动接收已发布的文件；重新加入会从头开始。</p>
      <div v-if="filename" class="transfer-progress"><div class="content-heading"><span>{{ filename }}</span><span>{{ progress.toFixed(1) }}%</span></div><progress :value="progress" max="100" aria-label="接收进度" /><div class="action-row"><span class="muted">{{ receiving ? paused ? '已暂停' : '正在接收 / 校验' : '接收完成，校验通过' }}</span><button v-if="receiving" class="button secondary" @click="togglePause">{{ paused ? '继续接收' : '暂停接收' }}</button></div></div>
    </div>
    <ul v-if="downloads.length" class="file-list"><li v-for="(file, index) in downloads" :key="index"><span>{{ file.name }}</span><a :href="file.url" :download="file.name">保存文件 ↓</a></li></ul>
    <button v-if="downloads.length" class="button secondary" @click="clearDownloads">清空下载列表并释放内存</button>
  </SessionPanel>
</template>
