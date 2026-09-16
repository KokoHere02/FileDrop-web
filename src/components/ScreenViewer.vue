<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue'

const props = defineProps<{ stream: MediaStream | null; paused: boolean; placeholder: string }>()
const viewer = ref<HTMLDivElement | null>(null)
const viewport = ref<HTMLDivElement | null>(null)
const video = ref<HTMLVideoElement | null>(null)
const zoom = ref(1)
const x = ref(0)
const y = ref(0)
const dragging = ref(false)
const fullscreen = ref(false)
const fullscreenAvailable = ref(false)
const fullscreenBusy = ref(false)
const error = ref('')
const percent = computed(() => `${Math.round(zoom.value * 100)}%`)
let observer: ResizeObserver | undefined
let drag: { id: number; x: number; y: number } | null = null
let disposed = false

watchEffect(() => { if (video.value) video.value.srcObject = props.stream })
function clampPosition() {
  const width = viewport.value?.clientWidth ?? 0
  const height = viewport.value?.clientHeight ?? 0
  const limitX = width * (zoom.value - 1) / 2
  const limitY = height * (zoom.value - 1) / 2
  x.value = Math.max(-limitX, Math.min(limitX, x.value))
  y.value = Math.max(-limitY, Math.min(limitY, y.value))
}
function stopDrag() {
  if (drag && viewport.value?.hasPointerCapture(drag.id)) viewport.value.releasePointerCapture(drag.id)
  drag = null
  dragging.value = false
}
function resetView() { stopDrag(); zoom.value = 1; x.value = y.value = 0 }
function changeZoom(delta: number) {
  if (!props.stream) return
  zoom.value = Math.max(1, Math.min(4, zoom.value + delta))
  clampPosition()
  if (zoom.value === 1) stopDrag()
}
function pointerDown(event: PointerEvent) {
  if (!props.stream || zoom.value === 1 || event.button !== 0 || drag) return
  viewport.value?.focus({ preventScroll: true })
  viewport.value?.setPointerCapture(event.pointerId)
  drag = { id: event.pointerId, x: event.clientX - x.value, y: event.clientY - y.value }
  dragging.value = true
}
function pointerMove(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.id) return
  x.value = event.clientX - drag.x
  y.value = event.clientY - drag.y
  clampPosition()
}
function pointerEnd(event: PointerEvent) { if (drag?.id === event.pointerId) stopDrag() }
function fullscreenChanged() {
  fullscreen.value = document.fullscreenElement === viewer.value
  clampPosition()
}
async function toggleFullscreen() {
  if (!fullscreenAvailable.value || fullscreenBusy.value || !props.stream) return
  error.value = ''
  fullscreenBusy.value = true
  try {
    if (document.fullscreenElement === viewer.value) await document.exitFullscreen()
    else await viewer.value?.requestFullscreen()
  } catch { if (!disposed) error.value = '无法进入全屏，请检查浏览器的全屏权限。' }
  finally { if (!disposed) fullscreenBusy.value = false }
}
function keydown(event: KeyboardEvent) {
  if (!props.stream || event.ctrlKey || event.metaKey || event.altKey) return
  const moves: Record<string, [number, number]> = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }
  const move = moves[event.key]
  if (event.key === '+' || event.key === '=') changeZoom(.25)
  else if (event.key === '-') changeZoom(-.25)
  else if (event.key === '0') resetView()
  else if (event.key.toLowerCase() === 'f') void toggleFullscreen()
  else if (move && zoom.value > 1) { x.value += move[0]; y.value += move[1]; clampPosition() }
  else return
  event.preventDefault()
}
watch(() => props.stream, (stream) => {
  resetView()
  error.value = ''
  if (!stream && document.fullscreenElement === viewer.value) void document.exitFullscreen().catch(() => {})
})
onMounted(() => {
  fullscreenAvailable.value = !!document.fullscreenEnabled && typeof viewer.value?.requestFullscreen === 'function'
  document.addEventListener('fullscreenchange', fullscreenChanged)
  observer = new ResizeObserver(clampPosition)
  if (viewport.value) observer.observe(viewport.value)
})
onBeforeUnmount(() => {
  disposed = true
  stopDrag()
  observer?.disconnect()
  document.removeEventListener('fullscreenchange', fullscreenChanged)
  if (document.fullscreenElement === viewer.value) void document.exitFullscreen().catch(() => {})
})
</script>

<template>
  <div ref="viewer" class="screen-viewer">
    <div ref="viewport" class="screen-viewport" :class="{ zoomed: zoom > 1, dragging }" tabindex="0" role="region" aria-label="共享画面，使用加减键缩放，方向键移动，0 恢复，F 全屏"
      @keydown="keydown" @dblclick="toggleFullscreen" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerEnd" @pointercancel="pointerEnd" @lostpointercapture="pointerEnd">
      <video ref="video" autoplay playsinline muted :class="{ invisible: !stream }" :style="{ transform: `translate(${x}px, ${y}px) scale(${zoom})` }" aria-label="共享屏幕预览" />
      <div v-if="!stream" class="video-placeholder"><span aria-hidden="true">▣</span><h3>{{ placeholder }}</h3><p>共享画面将在这里显示</p></div>
      <span v-if="paused" class="video-badge">共享已暂停</span>
    </div>
    <div class="viewer-toolbar" role="group" aria-label="画面显示控制">
      <div class="viewer-controls">
        <button :disabled="!stream || zoom <= 1" aria-label="缩小画面" title="缩小（−）" @click="changeZoom(-.25)">−</button>
        <output aria-label="画面缩放比例" aria-live="polite">{{ percent }}</output>
        <button :disabled="!stream || zoom >= 4" aria-label="放大画面" title="放大（+）" @click="changeZoom(.25)">+</button>
        <button :disabled="!stream" title="恢复适应窗口（0）" @click="resetView">适应窗口</button>
      </div>
      <button :disabled="!stream || !fullscreenAvailable || fullscreenBusy" :title="fullscreenAvailable ? '双击画面或按 F 切换全屏，Esc 退出' : '当前浏览器不支持全屏'" @click="toggleFullscreen">{{ fullscreen ? '退出全屏' : '全屏查看' }}</button>
    </div>
    <p v-if="stream" class="viewer-hint">{{ zoom > 1 ? '拖动画面或使用方向键查看细节' : '支持 100%–400% 放大，双击画面可切换全屏' }}</p>
    <p v-if="error" class="viewer-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.screen-viewer { background: #182236; color: #e7eefa; border: 1px solid #34405b; border-radius: 12px; overflow: hidden; }
.screen-viewport { position: relative; aspect-ratio: 16/10; overflow: hidden; background: #111a2c; }
.screen-viewport:focus-visible { outline-offset: -3px; }
.screen-viewport video { width: 100%; height: 100%; object-fit: contain; pointer-events: none; user-select: none; }
.screen-viewport.zoomed { cursor: grab; touch-action: none; }
.screen-viewport.dragging { cursor: grabbing; }
.viewer-toolbar, .viewer-controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.viewer-toolbar { justify-content: space-between; padding: 10px; border-top: 1px solid #34405b; }
.viewer-toolbar button { min-height: 36px; min-width: 36px; padding: 6px 10px; border: 1px solid #495671; border-radius: 7px; background: #293750; color: #eef3ff; font-size: 12px; }
.viewer-toolbar button:hover:not(:disabled) { background: #425778; }
.viewer-toolbar output { min-width: 46px; font-size: 12px; text-align: center; font-variant-numeric: tabular-nums; }
.viewer-hint, .viewer-error { margin: 0; padding: 0 12px 12px; color: #bbc9df; font-size: 11px; line-height: 1.7; }
.viewer-error { color: #ffc5ce; }
.screen-viewer:fullscreen { width: 100%; height: 100%; border: 0; border-radius: 0; display: flex; flex-direction: column; }
.screen-viewer:fullscreen .screen-viewport { flex: 1; min-height: 0; aspect-ratio: auto; }
.screen-viewer:fullscreen .viewer-toolbar { flex-shrink: 0; }
.screen-viewer::backdrop { background: #111a2c; }
</style>
