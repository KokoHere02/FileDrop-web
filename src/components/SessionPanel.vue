<script setup lang="ts">
import { ref } from 'vue'
import type { useSession } from '../composables/useSession'
defineProps<{ title: string; description: string; session: ReturnType<typeof useSession> }>()
const code = ref('')
</script>
<template>
  <section class="panel">
    <header class="panel-header"><div><h2>{{ title }}</h2><p>{{ description }}</p></div><span class="status" :class="{ online: session.connected.value }"><i />{{ session.status.value }}</span></header>
    <p v-if="session.error.value" class="alert error" role="alert">{{ session.error.value }}</p>
    <p v-if="session.notice.value" class="alert" role="status">{{ session.notice.value }}</p>
    <div v-if="!session.roomId.value" class="empty-state">
      <div class="empty-icon" aria-hidden="true">↗</div>
      <h3>{{ session.role === 'sender' ? '从一个新房间开始' : '连接另一台设备' }}</h3>
      <p>{{ session.role === 'sender' ? '创建房间后，将取件码分享给接收方。' : '选择与发送方相同的传输方式，再输入取件码。' }}</p>
      <form class="connect-form" @submit.prevent="session.connect(code)">
        <label v-if="session.role === 'receiver'" for="room-code" class="sr-only">取件码</label>
        <input v-if="session.role === 'receiver'" id="room-code" v-model="code" placeholder="6 位取件码，区分大小写" autocomplete="off" autocapitalize="off" :spellcheck="false" :disabled="session.busy.value" />
        <button class="button primary" :disabled="session.busy.value">{{ session.busy.value ? '正在连接…' : session.role === 'sender' ? '创建房间 →' : '加入房间 →' }}</button>
      </form>
    </div>
    <div v-else class="session-grid">
      <div class="content-card"><slot /></div>
      <aside class="code-card"><span class="eyebrow">ROOM CODE</span><h3>房间取件码</h3><p>在另一台设备上选择相同的传输方式，并输入下方取件码。</p><strong class="room-code">{{ session.roomId.value }}</strong><button class="button primary" @click="session.copy(session.roomId.value)">复制取件码</button><button class="button secondary" @click="session.disconnect">结束连接</button></aside>
    </div>
  </section>
</template>
