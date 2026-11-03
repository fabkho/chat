import { describe, expect, it } from 'vitest'
import { CHAT_ERROR_CODES, chatErrorCode } from '../app/utils/errors'

/**
 * The layer names the refusals as codes (`app/utils/errors.ts`); an app words them. An app keeps its own test that every
 * code has a sentence, because a code without one would reach a member raw. Here: finding the code in a message.
 */
describe('the chat error codes', () => {
  it('finds the code in a message, any case, and knows the storage\'s messages', () => {
    for (const code of CHAT_ERROR_CODES) {
      expect(chatErrorCode(code)).toBe(code)
      expect(chatErrorCode(`P0001: ${code.toUpperCase()} (raised)`)).toBe(code)
    }
    expect(chatErrorCode('The object exceeded the maximum allowed size')).toBe('media_too_large')
    expect(chatErrorCode('invalid mime type image/tiff')).toBe('media_type_invalid')
    expect(chatErrorCode('Failed to fetch')).toBeNull()
    // The phone, host and group refusals are the app's, not the layer's.
    expect(chatErrorCode('phone_invalid')).toBeNull()
    expect(chatErrorCode('host_only')).toBeNull()
  })

  it('maps a code to itself and lists each once', () => {
    expect(new Set(CHAT_ERROR_CODES).size).toBe(CHAT_ERROR_CODES.length)
    expect(CHAT_ERROR_CODES.length).toBeGreaterThan(0)
  })
})
