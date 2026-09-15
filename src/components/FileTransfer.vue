<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import SessionPanel from './SessionPanel.vue'
import { useSession } from '../composables/useSession'
import { confirmFile, sendFileQueue } from '../util/fileTransfer'
const files = ref<File[]>([])
const active = ref(false)
const paused = ref(false)
const progress = ref(0)
const filename = ref('')
const dragging = ref(false)
const downloads = ref<{ name: string; url: string }[]>([])
let controller = new AbortController()
let buffers: ArrayBuffer[] = []
let expected = 0
let received = 0
let hasHeader = false
let fileId = ''
let mimeType = ''
const session = useSession('file', {
  channel(channel) {
    channel.binaryType = 'arraybuffer'
    channel.onmessage = (event) => {
      if (session.role !== 'receiver') return
      try {
        if (typeof event.data === 'string') {
          const msg = JSON.parse(event.data)
          if (msg.type === 'file-info') {
            if (hasHeader || typeof msg.fileId !== 'string' || !msg.fileId || typeof msg.name !== 'string' || !Number.isSafeInteger(msg.size) || msg.size < 0) throw new Error('文件信息无效，请确认双方使用相同版本前端')
            fileId = msg.fileId
            mimeType = typeof msg.mimeType === 'string' ? msg.mimeType : ''
            filename.value = msg.name
            expected = msg.size
            received = 0
            buffers = []
            hasHeader = true
            active.value = true
            progress.value = 0
          } else if (msg.type === 'file-end') {
            if (!hasHeader || msg.fileId !== fileId || received !== expected) throw new Error('文件接收不完整，请重新接收')
            downloads.value.push({ name: filename.value, url: URL.createObjectURL(new Blob(buffers, { type: mimeType })) })
            channel.send(JSON.stringify({ type: 'file-ack', fileId, size: received }))
            buffers = []
            hasHeader = false
            progress.value = 100
            active.value = false
          }
        } else {
          if (!hasHeader || !(event.data instanceof ArrayBuffer) || received + event.data.byteLength > expected) throw new Error('文件数据异常，请重新连接')
          buffers.push(event.data)
          received += event.data.byteLength
          progress.value = expected ? received / expected * 100 : 100
        }
      } catch (err) { session.disconnect(); session.report(err) }
    }
    channel.addEventListener('close', () => { active.value = false; buffers = []; hasHeader = false })
  },
  message(type) {
    if (session.role !== 'sender') return
    if (type === 'file-start') void sendFiles()
    if (type === 'file-pause') paused.value = true
    if (type === 'file-resume') paused.value = false
  },
  cleanup() {
    controller.abort()
    active.value = paused.value = false
    buffers = []
    hasHeader = false
    filename.value = ''
    progress.value = expected = received = 0
    fileId = mimeType = ''
  },
})
function select(list: FileList | null) {
  if (list && !active.value) files.value = Array.from(list)
}
function pick(event: Event) {
  const input = event.target as HTMLInputElement
  select(input.files)
  input.value = ''
}
function drop(event: DragEvent) { dragging.value = false; select(event.dataTransfer?.files ?? null) }
function size(value: number) {
  return value < 1024 ? value + ' B' : value < 1048576 ? (value / 1024).toFixed(1) + ' KB' : (value / 1048576).toFixed(1) + ' MB'
}
async function sendFiles() {
  const channel = session.channel.value
  if (active.value || !channel || channel.readyState !== 'open') return
  if (!files.value.length) { session.notice.value = '请先选择文件，然后点击发送文件'; return }
  controller = new AbortController()
  const transfer = controller
  active.value = true
  paused.value = false
  try {
    await sendFileQueue(files.value, channel, transfer.signal, () => paused.value, (name, percent) => { filename.value = name; progress.value = percent }, {
      maxMessageSize: session.peer.value?.sctp?.maxMessageSize,
      confirm: (fileId, size) => confirmFile(channel, transfer.signal, fileId, size),
    })
  } catch (err) { if (!transfer.signal.aborted) { session.disconnect(); session.report(err) } }
  finally { if (controller === transfer) active.value = false }
}
function requestFiles() {
  try { session.send('file-start'); session.notice.value = '已请求发送，请等待发送方选择并发送文件' }
  catch (err) { session.report(err) }
}
function togglePause() {
  try { session.send(paused.value ? 'file-resume' : 'file-pause'); paused.value = !paused.value }
  catch (err) { session.report(err) }
}
onBeforeUnmount(() => downloads.value.forEach((file) => URL.revokeObjectURL(file.url)))
</script>
<template>
  <SessionPanel title="文件传输" description="选择文件，让两台设备直接传递。" :session="session">
    <template v-if="session.role === 'sender'">
      <label class="drop-zone" :class="{ dragging }" @dragover.prevent="dragging = true" @dragleave.prevent="dragging = false" @drop.prevent="drop">
        <span class="upload-icon" aria-hidden="true">↑</span><strong>拖拽文件到这里</strong><span>或点击选择文件，支持多选</span>
        <input class="sr-only" type="file" multiple :disabled="active" @change="pick" />
      </label>
      <ul v-if="files.length" class="file-list"><li v-for="(file, index) in files" :key="index"><span>{{ file.name }}</span><small>{{ size(file.size) }}</small></li></ul>
      <div class="action-row"><span class="muted">已选择 {{ files.length }} 个文件</span><button class="button primary" :disabled="!session.connected.value || !files.length || active" @click="sendFiles">{{ active ? '正在发送…' : '发送文件' }}</button></div>
    </template>
    <div v-else class="receive-area"><span class="upload-icon" aria-hidden="true">↓</span><h3>准备接收文件</h3><p class="muted">发送方选择文件后可直接发送，也可以请求对方开始传输。</p><button class="button primary" :disabled="!session.connected.value || active" @click="requestFiles">请求接收文件</button></div>
    <div v-if="filename" class="transfer-progress"><div class="content-heading"><span>{{ filename }}</span><span>{{ progress.toFixed(1) }}%</span></div><progress :value="progress" max="100" aria-label="文件传输进度" /><div class="action-row"><span class="muted">{{ active ? paused ? '传输已暂停' : '正在传输…' : progress === 100 ? '传输完成' : '传输已中断' }}</span><button v-if="session.role === 'receiver' && active" class="button secondary" @click="togglePause">{{ paused ? '继续接收' : '暂停接收' }}</button></div></div>
    <ul v-if="downloads.length" class="file-list"><li v-for="(file, index) in downloads" :key="index"><span>{{ file.name }}</span><a :href="file.url" :download="file.name">保存文件 ↓</a></li></ul>
  </SessionPanel>
</template>
