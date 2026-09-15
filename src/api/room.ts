import request from '../util/request'
import type { TransferType } from '../type/type'
import { parseRoomResponse } from '../util/protocol'
export async function createRoom(type: TransferType): Promise<string> {
  const response = await request.post<unknown>('/web/createRoom', null, { params: { type } })
  return parseRoomResponse(response.data)
}
