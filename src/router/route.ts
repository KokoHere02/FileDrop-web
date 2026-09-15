import type { RouteRecordRaw } from 'vue-router'
const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/text' },
  { path: '/text', component: () => import('../components/Text.vue') },
  { path: '/file', component: () => import('../components/FileTransfer.vue') },
  { path: '/screen', component: () => import('../components/Screen.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/text' },
]
export default routes
