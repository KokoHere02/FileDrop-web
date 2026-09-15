/** 文件按顺序发送，并限制 DataChannel 缓冲，避免多文件数据交错及内存堆积。 */
export async function sendFileQueue(
  files: File[],
  channel: Pick<RTCDataChannel, 'readyState' | 'bufferedAmount' | 'send'>,
  signal: AbortSignal,
  paused: () => boolean,
  progress: (name: string, percent: number) => void,
  options: { maxMessageSize?: number; confirm?: (fileId: string, size: number) => Promise<void> } = {},
) {
  const limit = options.maxMessageSize && options.maxMessageSize > 0 ? options.maxMessageSize : 16 * 1024
  const chunkSize = Math.min(16 * 1024, limit)
  async function ready() {
    let started = Date.now()
    while (true) {
      signal.throwIfAborted()
      if (channel.readyState !== 'open') throw new Error('文件传输连接已断开')
      if (!paused() && channel.bufferedAmount <= 256 * 1024) return
      if (paused()) started = Date.now()
      if (!paused() && Date.now() - started > 30000) throw new Error('文件传输超时，请重新连接')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  for (const file of files) {
    await ready()
    const fileId = crypto.randomUUID()
    const header = JSON.stringify({ type: 'file-info', fileId, name: file.name, size: file.size, mimeType: file.type })
    if (new TextEncoder().encode(header).length > limit) throw new Error('文件信息超过通道消息大小限制')
    channel.send(header)
    progress(file.name, 0)
    for (let offset = 0; offset < file.size;) {
      const chunk = await file.slice(offset, offset + chunkSize).arrayBuffer()
      await ready()
      channel.send(chunk)
      offset += chunk.byteLength
      progress(file.name, Math.min(99, offset / file.size * 100))
    }
    await ready()
    if (options.confirm) await options.confirm(fileId, file.size)
    else channel.send(JSON.stringify({ type: 'file-end', fileId }))
    progress(file.name, 100)
  }
}

/** 在发送结束标记之前监听确认，100% 表示对端已核对接收字节数。 */
export function confirmFile(channel: RTCDataChannel, signal: AbortSignal, fileId: string, size: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      channel.removeEventListener('message', message)
      channel.removeEventListener('close', closed)
      signal.removeEventListener('abort', aborted)
    }
    const finish = (err?: Error) => { cleanup(); if (err) reject(err); else resolve() }
    const message = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'file-ack' && msg.fileId === fileId) {
          finish(msg.size === size ? undefined : new Error('对端确认的文件大小不一致'))
        }
      } catch { /* 无关消息由页面处理器解析。 */ }
    }
    const closed = () => finish(new Error('等待文件确认时连接已断开'))
    const aborted = () => finish(new DOMException('传输已取消', 'AbortError'))
    const timer = setTimeout(() => finish(new Error('等待接收确认超时，请确认双方使用相同版本的前端')), 30000)
    channel.addEventListener('message', message)
    channel.addEventListener('close', closed)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) { aborted(); return }
    if (channel.readyState !== 'open') { closed(); return }
    try { channel.send(JSON.stringify({ type: 'file-end', fileId })) }
    catch (err) { finish(err instanceof Error ? err : new Error('发送文件结束标记失败')) }
  })
}
