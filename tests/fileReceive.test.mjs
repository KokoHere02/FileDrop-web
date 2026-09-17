import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { parse, compileScript } from '@vue/compiler-sfc'
import { createRenderer, nextTick } from 'vue'

// Compile the real receiver and template, replacing only the room/signaling shell.
await build({
  stdin: { contents: "export { default as Receiver } from './src/components/FileTransfer.vue'; export { useFileDistribution } from './src/composables/useFileDistribution'; export { session, options } from 'test-session'", resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', packages: 'external',
  outfile: 'node_modules/.tmp/file-receive-test.mjs',
  plugins: [{ name: 'receiver-fixture', setup(build) {
    build.onResolve({ filter: /(?:\/useSession|^test-session)$/ }, () => ({ path: 'session', namespace: 'fixture' }))
    build.onResolve({ filter: /SessionPanel\.vue$/ }, () => ({ path: 'panel', namespace: 'fixture' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'panel'
      ? "export default { props: ['title', 'description', 'session'], setup(_, { slots }) { return () => slots.default?.() } }"
      : `import { ref } from 'vue';
         export let options;
         export const session = { role: 'receiver', peers: new Map(), connectedPeers: ref([]), error: ref(''), notice: ref(''),
           send() {}, report(error) { this.error.value = String(error) },
           failPeer(id, error) { this.peers.get(id).status = 'failed'; this.error.value = String(error) } };
         export function useSession(_, callbacks) { options = callbacks; return session }`, loader: 'js', resolveDir: process.cwd() }))
    build.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
      const { descriptor } = parse(await readFile(path, 'utf8'), { filename: path })
      return { contents: compileScript(descriptor, { id: 'receiver-test', inlineTemplate: true }).content, loader: 'ts' }
    })
  } }],
})
const fixture = await import('../node_modules/.tmp/file-receive-test.mjs')
const { Receiver, useFileDistribution, session } = fixture

function node(type, text = '') { return { type, text, props: {}, children: [], parent: null } }
function remove(child) {
  if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
  child.parent = null
}
const renderer = createRenderer({
  createElement: type => node(type), createText: text => node('#text', text), createComment: () => node('#comment'),
  setText: (node, text) => { node.text = text },
  setElementText: (node, text) => { node.children = []; node.text = text },
  patchProp: (node, key, _, value) => { node.props[key] = value },
  insert(child, parent, anchor) { remove(child); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index < 0 ? parent.children.length : index, 0, child) },
  remove, parentNode: node => node.parent,
  nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1],
})
function find(root, predicate) {
  if (predicate(root)) return root
  for (const child of root.children) { const result = find(child, predicate); if (result) return result }
}
async function until(predicate) {
  for (let i = 0; i < 200; i++) { await nextTick(); if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  throw new Error('condition timed out')
}

test('pause during file completion keeps a working resume button for the next file', async t => {
  const root = node('root')
  const app = renderer.createApp(Receiver)
  app.mount(root)
  t.after(() => app.unmount())
  const distribution = useFileDistribution((_, error) => { session.error.value = String(error) })
  t.after(() => distribution.clear())
  const receiverChannel = new EventTarget()
  const senderChannel = new EventTarget()
  senderChannel.readyState = 'open'
  senderChannel.bufferedAmount = 0
  const peer = { id: 'sender', status: 'connected', connected: true, channel: senderChannel, pc: {} }
  session.peers.set(peer.id, peer)
  session.connectedPeers.value = [peer]
  session.send = (id, type) => distribution.pause(id, type === 'file-pause')
  receiverChannel.send = data => senderChannel.dispatchEvent(new MessageEvent('message', { data }))
  fixture.options.channel(receiverChannel, peer)
  let pausedOnce = false
  senderChannel.send = data => {
    receiverChannel.onmessage({ data })
    if (!pausedOnce && typeof data === 'string' && JSON.parse(data).type === 'file-end') {
      pausedOnce = true
      const pause = find(root, node => node.type === 'button' && node.text === '暂停接收')
      assert.ok(pause)
      pause.props.onClick()
    }
  }
  distribution.publish([new File(['first'], 'first.txt'), new File(['second'], 'second.txt')], [peer])
  await until(() => !!find(root, node => node.type === 'a' && node.props.download === 'first.txt'))
  assert.equal(find(root, node => node.type === 'a' && node.props.download === 'second.txt'), undefined)
  const resume = find(root, node => node.type === 'button' && node.text === '继续接收')
  assert.ok(resume, 'resume must remain visible after the first file has completed')
  resume.props.onClick()
  await until(() => distribution.transfers.get(peer.id).state === 'done')
  assert.ok(find(root, node => node.type === 'a' && node.props.download === 'second.txt'))
  assert.equal(session.error.value, '')
})
