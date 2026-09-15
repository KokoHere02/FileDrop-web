import { defineStore } from 'pinia'
import { ref } from 'vue'
export const useRoomStore = defineStore('room', () => {
  const role = ref<'sender' | 'receiver'>('sender')
  function setRole(value: 'sender' | 'receiver') { role.value = value }
  return { role, setRole }
})
