export function isRoomCode(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9]{6}$/.test(value)
}

export function parseRoomResponse(value: unknown): string {
  const result = value as { code?: unknown; data?: unknown } | null
  if (!result || result.code !== 200 || !isRoomCode(result.data)) throw new Error('创建房间响应异常')
  return result.data
}

export function signalingCloseMessage(code: number): string {
  switch (code) {
    case 1000: return '房间连接已结束，可以重新加入或创建房间'
    case 1008: return '房间不可用或角色已被占用，请检查取件码或重新创建房间'
    case 1007: return '信令协议错误，请刷新页面或联系维护者'
    case 1003: return '信令格式不受支持，请刷新页面或联系维护者'
    case 1011: return '房间服务异常，请稍后重新连接'
    case 1006: return '连接异常，请检查网络、服务地址及后端允许的 Origin'
    default: return `房间连接已关闭（${code}），请重新连接`
  }
}
