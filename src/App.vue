<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import { useRoomStore } from './store/RoomStore'
const room = useRoomStore()
const route = useRoute()
const tabIndex = computed(() => route.path === '/file' ? 1 : route.path === '/screen' ? 2 : 0)
</script>
<template>
  <div class="app-shell" :data-theme="tabIndex">
    <header class="site-header">
      <RouterLink to="/text" class="brand" aria-label="FileDrop 首页"><span class="brand-mark" aria-hidden="true">↗</span></RouterLink>
      <span class="header-note">点对点传输</span>
    </header>
    <main>
      <div class="workspace-toolbar">
        <nav aria-label="传输方式" class="tabs" :style="{ '--tab-index': tabIndex }">
          <span class="tab-indicator" aria-hidden="true" />
          <RouterLink to="/text">文本传送</RouterLink><RouterLink to="/file">文件传输</RouterLink><RouterLink to="/screen">屏幕共享</RouterLink>
        </nav>
        <div class="role-switch" :class="{ receiving: room.role === 'receiver' }" role="group" aria-label="当前身份">
          <span class="role-indicator" aria-hidden="true" />
          <button :aria-pressed="room.role === 'sender'" @click="room.setRole('sender')">我要发送</button>
          <button :aria-pressed="room.role === 'receiver'" @click="room.setRole('receiver')">我要接收</button>
        </div>
      </div>
      <div class="view-stage">
        <RouterView v-slot="{ Component, route: currentRoute }">
          <Transition name="workspace" mode="out-in">
            <component :is="Component" :key="`${currentRoute.path}-${room.role}`" />
          </Transition>
        </RouterView>
      </div>
      <div class="tips"><span><b>01</b> 发送方创建房间</span><span><b>02</b> 接收方输入取件码</span><span><b>03</b> 连接后开始分享</span></div>
    </main>
    <footer>FileDrop <span>切换传输方式或身份会结束当前连接 · 屏幕共享需要 HTTPS 或 localhost</span></footer>
  </div>
</template>
