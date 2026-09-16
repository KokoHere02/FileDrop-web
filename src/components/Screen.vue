<script setup lang="ts">
import { ref, shallowRef } from 'vue'
import SessionPanel from './SessionPanel.vue'
import ScreenViewer from './ScreenViewer.vue'
import { useSession } from '../composables/useSession'
const local = shallowRef<MediaStream | null>(null)
const remote = shallowRef<MediaStream | null>(null)
const paused = ref(false)
const starting = ref(false)
let captureGeneration = 0
const session = useSession('screen', {
  peer(pc) {
    pc.ontrack = (event) => { remote.value = event.streams[0] ?? new MediaStream([event.track]) }
  },
  message(type) {
    if (type === 'screen-pause') paused.value = true
    if (type === 'screen-resume') paused.value = false
  },
  cleanup() {
    captureGeneration++
    local.value?.getTracks().forEach((track) => { track.onended = null; track.stop() })
    local.value = remote.value = null
    paused.value = starting.value = false
  },
})
async function start() {
  if (starting.value || local.value || !session.connected.value) return
  if (!navigator.mediaDevices?.getDisplayMedia) { session.error.value = '当前浏览器不支持屏幕共享，请使用桌面浏览器并通过 HTTPS 或 localhost 访问'; return }
  starting.value = true
  const current = ++captureGeneration
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
    if (current !== captureGeneration || !session.isWs.value) { stream.getTracks().forEach((track) => track.stop()); return }
    local.value = stream
    const pc = session.ensurePeer()
    stream.getTracks().forEach((track) => { pc.addTrack(track, stream); track.onended = session.disconnect })
    await session.offer()
  } catch (err) {
    if (current === captureGeneration) { session.disconnect(); session.report(err) }
  } finally { if (current === captureGeneration) starting.value = false }
}
function togglePause() {
  if (!local.value) return
  try {
    session.send(paused.value ? 'screen-resume' : 'screen-pause')
    paused.value = !paused.value
    local.value.getVideoTracks().forEach((track) => { track.enabled = !paused.value })
  } catch (err) { session.report(err) }
}
</script>
<template>
  <SessionPanel title="屏幕共享" description="分享一个窗口，或展示整个屏幕。" :session="session">
    <ScreenViewer :stream="session.role === 'sender' ? local : remote" :paused="paused" :placeholder="session.role === 'sender' ? '让对方看到你的屏幕' : '等待对方共享屏幕'" />
    <div class="action-row"><span class="muted">{{ local ? '正在共享屏幕，可随时结束连接' : '仅分享你选择的屏幕或窗口' }}</span><div v-if="session.role === 'sender'" class="button-group"><button class="button primary" :disabled="!session.connected.value || starting || !!local" @click="start">{{ starting ? '正在准备…' : '开始共享' }}</button><button v-if="local" class="button secondary" @click="togglePause">{{ paused ? '继续共享' : '暂停共享' }}</button></div></div>
  </SessionPanel>
</template>

