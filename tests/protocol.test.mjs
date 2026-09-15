import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isRoomCode, parseRoomResponse, signalingCloseMessage } from '../src/util/protocol.ts'

test('room response requires business success and a six-character case-sensitive string', () => {
  assert.equal(parseRoomResponse({ code: 200, data: 'Ab3xY9' }), 'Ab3xY9')
  for (const value of [null, {}, { code: 500, data: 'Ab3xY9' }, { code: 200, data: 123456 }, { code: 200, data: 'tooLong' }]) assert.throws(() => parseRoomResponse(value))
  assert.equal(isRoomCode(' Ab3xY9'), false)
  assert.equal(isRoomCode('中文1234'), false)
})
test('close codes distinguish policy, protocol, network and normal closure', () => {
  assert.match(signalingCloseMessage(1008), /角色已被占用/)
  assert.match(signalingCloseMessage(1007), /协议错误/)
  assert.match(signalingCloseMessage(1006), /Origin/)
  assert.doesNotMatch(signalingCloseMessage(1000), /过期/)
})
