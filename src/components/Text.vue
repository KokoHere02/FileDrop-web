<script setup lang="ts">
import { ref, watch } from 'vue'
import SessionPanel from './SessionPanel.vue'
import { useSession } from '../composables/useSession'
const message = ref('')
const session = useSession('text', {
  connected(peer) { if (session.role === 'sender') sync(peer.id) },
  channel(channel) {
    channel.onmessage = (event) => { if (session.role === 'receiver' && typeof event.data === 'string') message.value = event.data }
  },
})
function sync(onlyPeer?: string) {
  if (session.role !== 'sender') return
  try {
    if (new TextEncoder().encode(message.value).length > 16000) throw new Error('文本过长，请将内容保存为文件后传输（最多 16 KB）')
    for (const peer of session.connectedPeers.value) {
      if (onlyPeer && peer.id !== onlyPeer) continue
      try { peer.channel?.send(message.value) } catch (err) { session.failPeer(peer.id, err) }
    }
  } catch (err) { session.report(err) }
}
watch(message, () => sync())
</script>
<template>
  <SessionPanel title="文本传送" description="把想法、链接和文字，送到另一块屏幕。" :session="session">
    <div class="content-heading"><h3>{{ session.role === 'sender' ? '编辑文本' : '接收文本' }}</h3><span>{{ message.length }} 字符</span></div>
    <label for="shared-text" class="sr-only">共享文本内容</label>
    <textarea id="shared-text" v-model="message" :readonly="session.role === 'receiver'" placeholder="在这里输入或粘贴文字…" rows="12" />
    <div class="action-row"><span class="muted">{{ session.connected.value ? '连接期间自动同步' : '连接后自动同步当前内容' }}</span><button class="button secondary" :disabled="!message" @click="session.copy(message)">复制文本</button></div>
  </SessionPanel>
</template>
