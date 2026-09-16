import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isRoomCode, parseRoomResponse, signalingCloseMessage, signalingErrorMessage } from '../src/util/protocol.ts'
test('v3 room response requires code and valid sender credential', () => {
  const data = { code: 'Ab3xY9', senderToken: 'x'.repeat(43) }
  assert.deepEqual(parseRoomResponse({ code: 200, data }), data)
  for (const value of [null, {}, { code: 500, data }, { code: 200, data: 'Ab3xY9' }, { code: 200, data: { code: 'Ab3xY9' } }, { code: 200, data: { ...data, senderToken: 'bad' } }]) assert.throws(() => parseRoomResponse(value))
  assert.equal(isRoomCode(' Ab3xY9'), false)
  assert.equal(isRoomCode('中文1234'), false)
})
test('v3 close codes and business errors explain exact failure', () => {
  assert.match(signalingCloseMessage(4403), /凭证/)
  assert.match(signalingCloseMessage(4404), /不存在/)
  assert.match(signalingCloseMessage(4409), /发送方已在线/)
  assert.match(signalingCloseMessage(4410), /过期/)
  assert.match(signalingCloseMessage(4001), /心跳/)
  assert.match(signalingCloseMessage(4500), /积压/)
  assert.match(signalingErrorMessage('TARGET_FORBIDDEN'), /其他连接不受影响/)
  assert.match(signalingCloseMessage(1006), /Origin/)
})
