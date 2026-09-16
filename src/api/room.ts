import request from '../util/request'
import type { TransferType } from '../type/type'
import { parseRoomResponse, type RoomCredentials } from '../util/protocol'
export async function createRoom(type: TransferType): Promise<RoomCredentials> {
  const response = await request.post<unknown>('/web/createRoom', null, { params: { type } })
  return parseRoomResponse(response.data)
}
