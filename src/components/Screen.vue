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
  peer(peer) {
    peer.pc.ontrack = (event) => { remote.value = event.streams[0] ?? new MediaStream([event.track]) }
    if (session.role === 'sender' && local.value) attachStream(peer.id)
  },
  connected(peer) { if (session.role === 'sender' && paused.value) session.send(peer.id, 'screen-pause') },
  message(type) {
    if (session.role !== 'receiver') return
    if (type === 'screen-pause') paused.value = true
    if (type === 'screen-resume') paused.value = false
  },
  peerCleanup() { if (session.role === 'receiver') { remote.value = null; paused.value = false } },
  cleanup() {
    captureGeneration++
    local.value?.getTracks().forEach((track) => { track.onended = null; track.stop() })
    local.value = remote.value = null
    paused.value = starting.value = false
  },
})
function attachStream(id: string) {
  const peer = session.peers.get(id)
  if (!peer || !local.value) return
  const stream = local.value
  stream.getTracks().forEach(track => {
    if (!peer.pc.getSenders().some(sender => sender.track === track)) peer.pc.addTrack(track, stream)
  })
}
async function start() {
  if (starting.value || local.value || !session.accepted.value) return
  if (!navigator.mediaDevices?.getDisplayMedia) {
    session.error.value = window.isSecureContext === false
      ? '浏览器禁止在普通 HTTP 页面发起屏幕共享；请在共享端使用 localhost 访问，或由管理员将此站点配置为可信来源后重启浏览器'
      : '当前浏览器不支持屏幕共享，请使用支持屏幕共享的桌面浏览器'
    return
  }
  starting.value = true
  session.error.value = ''
  const current = ++captureGeneration
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
    if (current !== captureGeneration || !session.accepted.value) { stream.getTracks().forEach((track) => track.stop()); return }
    local.value = stream
    stream.getTracks().forEach(track => { track.onended = session.disconnect })
    for (const peer of session.peerList.value) {
      if (peer.status === 'failed') continue
      try { attachStream(peer.id); void session.offer(peer.id) } catch (error) { session.failPeer(peer.id, error) }
    }
  } catch (err) {
    if (current === captureGeneration) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') session.error.value = '未开始屏幕共享，请重新选择屏幕或允许共享权限'
      else session.report(err)
    }
  } finally { if (current === captureGeneration) starting.value = false }
}
function togglePause() {
  if (!local.value) return
  try {
    paused.value = !paused.value
    local.value.getVideoTracks().forEach((track) => { track.enabled = !paused.value })
    for (const peer of session.peerList.value) {
      if (peer.status !== 'failed') session.send(peer.id, paused.value ? 'screen-pause' : 'screen-resume')
    }
  } catch (err) { session.report(err) }
}
</script>
<template>
  <SessionPanel title="屏幕共享" description="分享一个窗口，或展示整个屏幕。" :session="session">
    <ScreenViewer :stream="session.role === 'sender' ? local : remote" :paused="paused" :placeholder="session.role === 'sender' ? '让对方看到你的屏幕' : '等待对方共享屏幕'" />
    <div class="action-row"><span class="muted">{{ local ? '正在共享屏幕，可随时结束连接' : '仅分享你选择的屏幕或窗口' }}</span><div v-if="session.role === 'sender'" class="button-group"><button class="button primary" :disabled="!session.accepted.value || starting || !!local" @click="start">{{ starting ? '正在准备…' : '开始共享' }}</button><button v-if="local" class="button secondary" @click="togglePause">{{ paused ? '继续共享' : '暂停共享' }}</button></div></div>
  </SessionPanel>
</template>
