export function isRoomCode(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9]{6}$/.test(value)
}

export interface RoomCredentials { code: string; senderToken: string }
export function parseRoomResponse(value: unknown): RoomCredentials {
  const result = value as { code?: unknown; data?: Partial<RoomCredentials> } | null
  if (!result || result.code !== 200 || !isRoomCode(result.data?.code) || typeof result.data.senderToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.data.senderToken)) throw new Error('创建房间响应异常，请确认后端支持协议 v3')
  return { code: result.data.code, senderToken: result.data.senderToken }
}

export function signalingErrorMessage(code?: string): string {
  const messages: Record<string, string> = {
    INVALID_PARAMETERS: '入房参数非法，请检查取件码及客户端版本',
    SENDER_UNAUTHORIZED: '发送端凭证已失效，请重新创建房间',
    ROOM_NOT_FOUND: '房间不存在，请检查取件码或重新创建',
    ROLE_OCCUPIED: '发送方已在线，请关闭重复的发送页面或稍后重连',
    ROOM_EXPIRED: '房间已过期，请重新创建',
    TARGET_REQUIRED: '消息缺少目标设备，请检查客户端版本',
    TARGET_NOT_FOUND: '目标设备已离开或重新连接，其他连接不受影响',
    TARGET_FORBIDDEN: '无法向该设备发送消息，其他连接不受影响',
  }
  return messages[code ?? ''] ?? '房间服务返回错误，请重试或检查客户端版本'
}

export function signalingCloseMessage(code: number): string {
  switch (code) {
    case 4400: return signalingErrorMessage('INVALID_PARAMETERS')
    case 4403: return signalingErrorMessage('SENDER_UNAUTHORIZED')
    case 4404: return signalingErrorMessage('ROOM_NOT_FOUND')
    case 4409: return signalingErrorMessage('ROLE_OCCUPIED')
    case 4410: return signalingErrorMessage('ROOM_EXPIRED')
    case 4001: return '连接心跳超时，请重新连接当前房间'
    case 4500: return '信令积压，连接已释放，请稍后重新连接'
    case 1000: return '房间连接已结束，可以重新加入或创建房间'
    case 1008: return '房间不可用或角色已被占用，请检查取件码或重新创建房间'
    case 1007: return '信令协议错误，请刷新页面或联系维护者'
    case 1003: return '信令格式不受支持，请刷新页面或联系维护者'
    case 1011: return '房间服务异常，请稍后重新连接'
    case 1006: return '连接异常，请检查网络、服务地址及后端允许的 Origin'
    default: return `房间连接已关闭（${code}），请重新连接`
  }
}
