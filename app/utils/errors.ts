// The chat's refusal codes: what the database raises for a send (`raise exception 'message_empty'`) and the storage
// says for a file, as codes. No sentence: the app words each one in its own language (the app should keep a test that every code here has a
// sentence), and the phone, host and group refusals are the app's own.

/** The generic codes the chat's functions raise and a client must word. */
export const CHAT_ERROR_CODES = [
  'message_conversation_unavailable',
  'message_empty',
  'message_too_long',
  'message_reply_unavailable',
  'message_rate_limited',
  'message_client_id_required',
  'message_client_id_reused',
  'media_kind_unknown',
  'media_size_invalid',
  'media_path_invalid',
  'media_url_invalid',
  'media_missing',
  'media_type_invalid',
  'media_duration_invalid',
  'media_peaks_invalid',
  'media_too_large',
  'klipy_unavailable',
] as const

export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[number]

/** What the storage API says instead of a code, and the code it means. */
const STORAGE_MESSAGES: ReadonlyArray<readonly [string, ChatErrorCode]> = [
  ['exceeded the maximum allowed size', 'media_too_large'],
  ['mime type', 'media_type_invalid'],
]

/**
 * The chat code a refusal's message carries (a message *contains* its code, any case), or null when it is none of
 * the chat's: the app then words it itself (no connection, a session that ran out, its own rules).
 */
export function chatErrorCode(message: string): string | null {
  const m = message.toLowerCase()
  return CHAT_ERROR_CODES.find((code) => m.includes(code)) ?? STORAGE_MESSAGES.find(([text]) => m.includes(text))?.[1] ?? null
}
