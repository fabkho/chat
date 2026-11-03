// The chat layer's contract with an app: what the layer needs to read and write a conversation, and nothing about how the app does it (a database, a transport, a store). An app
// fills these interfaces; the layer's pure modules and thin composables only ever talk to them.
//
// Words never pass through it: the pure modules return codes, the composables return state, the app's components
// word them. Types only: this file has no runtime code, so it may be imported from anywhere.
//
// The app's words are no part of it: a thread is a chapter of a buddy read, a Section in another app.

export type Id = string

/** A call's answer: a value, or the app's error key (`retryable`: the same call may work later, e.g. no connection). */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string; retryable: boolean }

/** One message as the layer needs it; an app's own kinds ride in `payload`. */
export interface ChatRecord {
  id: Id
  conversationId: Id
  /**
   * The thread it belongs to, when the conversation has more than one: a thread is a chapter of a buddy read, a Section in
   * another app. Null in the conversation itself.
   */
  threadId: Id | null
  /** Null for a system line and for a member who has gone. */
  senderId: Id | null
  clientId: Id | null
  kind: string
  body: string
  createdAt: string
  replyTo: Id | null
  spoiler: boolean
  media: { kind: 'image' | 'gif' | 'voice'; path: string | null; url: string | null; width: number; height: number } | null
  payload?: unknown
}

/** One send, as the queue keeps it until the app has delivered it. */
export interface SendJob {
  conversationId: Id
  threadId: Id | null
  clientId: Id
  kind: string
  body: string
  replyTo: Id | null
  spoiler: boolean
  media?: unknown
  payload?: unknown
  createdAt: string
}

/** What a member may do in a conversation; the app decides (the database does, really). */
export type ChatAction = 'write' | 'manageGroup' | 'manageBuddyRead'

export interface LiveHandlers {
  message(record: ChatRecord): void
  reaction(event: { messageId: Id; memberId: Id; emoji: string | null }): void
  changed(event: { conversationId: Id; what: 'group' | 'buddyRead'; id: Id }): void
  /** Something may have been missed (the channel came back, the app returned): read again. */
  resync(): void
}

export interface ChatAdapter {
  /** The signed-in member. */
  me(): Id | null
  can(action: ChatAction, conversationId: Id): boolean
  page(q: { conversationId: Id; threadId: Id | null; before?: string; after?: string; limit: number }): Promise<Result<ChatRecord[]>>
  send(job: SendJob): Promise<Result<ChatRecord>>
  markRead(q: { conversationId: Id; threadId: Id | null; upTo: string }): Promise<Result<void>>
  react(messageId: Id, emoji: string | null): Promise<Result<void>>
  upload(conversationId: Id, file: Blob, kind: 'image' | 'voice'): Promise<Result<{ path: string }>>
  sign(paths: string[]): Promise<Result<Record<string, string>>>
  /** Listens to the live transport; returns the function that stops. */
  live(on: LiveHandlers): () => void
  storage: { get(key: string): string | null; set(key: string, value: string): void; remove(key: string): void }
  /** A cross-tab lock, when the platform has one (Web Locks). */
  lock?<T>(name: string, run: () => Promise<T>): Promise<T>
}

export interface GroupMemberInfo {
  id: Id
  name: string
  avatar: string | null
  role: 'admin' | 'member'
}

export interface GroupAdapter {
  group(conversationId: Id): Promise<Result<{ title: string; myRole: 'admin' | 'member'; muted: string | null; members: GroupMemberInfo[] }>>
  setAdmin(conversationId: Id, memberId: Id, admin: boolean): Promise<Result<void>>
  leave(conversationId: Id): Promise<Result<void>>
  /** Optional until an app has the call (an app that has per-group sound settings). */
  mute?(conversationId: Id, until: string | null): Promise<Result<void>>
}

/** One chapter of a buddy read as the screen needs it (`kind: 'end'` is the whole book, always last). */
export interface BuddyChapter {
  id: Id
  position: number
  kind: 'chapter' | 'end'
  title: string
  pages: [number, number] | null
  /** Comments in it, from members she may see. */
  count: number
  /** New to her since her cursor; numbers only, never words of a comment. */
  unread: number
}

/** A buddy read as its screen is drawn (one read of the database). */
export interface BuddyReadData {
  id: Id
  conversationId: Id
  book: { title: string; author: string | null; cover: string | null }
  status: 'active' | 'finished' | 'archived'
  /** The call it was made for, when she may read it. */
  sourceId: Id | null
  chaptersFrom: 'count' | 'pages' | null
  createdAt: string
  chapters: BuddyChapter[]
  /** The other members' markers she may see, hers included. */
  marks: { memberId: Id; readThrough: number }[]
  /** Hers: 0 is not started. */
  readThrough: number
  /** She may divide, finish and archive (an admin of the group). */
  canManage: boolean
}

/** What a division asks for: `count` chapters (`per` of them together), or a book of `pageCount` pages in parts of `per` pages. */
export interface ChapterPlan {
  from: 'count' | 'pages'
  count?: number
  per?: number
  pageCount?: number
}

export interface BuddyReadAdapter {
  buddyRead(id: Id): Promise<Result<BuddyReadData>>
  setMarker(id: Id, readThrough: number): Promise<Result<void>>
  setChapters(id: Id, plan: ChapterPlan): Promise<Result<void>>
  /** Which veiled chapters she opened anyway; device-local. */
  peeked: { has(threadId: Id): boolean; add(threadId: Id): void }
}

/** The app's way into a group: a call to read together, a link or an invitation. */
export interface InviteAdapter {
  join(sourceId: Id): Promise<Result<{ conversationId: Id }>>
  dismiss(sourceId: Id): Promise<Result<void>>
}
