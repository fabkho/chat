# @fabkho/chat

A chat's client logic as a Nuxt layer, taken by an app as a tag-pinned git dependency (MIT, nothing is published to npm).

- **Send queue**: ordered, retried with a back-off, kept across a reload, one tab owns a member's queue (Web Locks), a refusal handed back instead of dropped.
- **Threads and chapters**: runs, unread counts, read points, and a conversation divided into chapters (`app/utils/thread.ts`, `app/utils/chapters.ts`, `useThread`, `useBuddyRead`).
- **Spoiler veil**: which chapters are open for a reading marker, a peek, what a row may show (`app/utils/veil.ts`).
- **Media**: photo preparation (EXIF stripped, size-limited), a GIF-search client, the refusal codes (`photo.ts`, `klipy.ts`, `errors.ts`).
- **Realtime core**: a private topic, resync after a rejoin, a revived socket after the page was suspended (`app/utils/liveChannel.ts`). The Realtime client is **injected** (`RealtimeLike`); the layer imports no Realtime library.

It is a *layer of logic*, not of screens: TypeScript and a little Vue reactivity behind an adapter, no components, no words (it returns codes and state; the app words them).

## Not in it

SQL and database functions, stores (Pinia or other), pages and components, copy in any language, and any Realtime client. An app writes those and plugs them in through the adapter.

## Taking it

```sh
pnpm add -E github:fabkho/chat#vX.Y.Z
```

Pin a tag, never a branch; a bump is the same command with the new tag (it changes `package.json` and the lockfile only).

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  extends: ['@fabkho/ui', '@fabkho/chat'],
})
```

An app with a switch for a local checkout wraps the name, the way `UI_LAYER` is usually done:

```ts
// chat.config.ts
export const chatLayer = () => process.env.CHAT_LAYER || '@fabkho/chat'
// nuxt.config.ts: extends: [uiLayer(), chatLayer()]
```

`CHAT_LAYER=/path/to/chat pnpm dev` then runs the app on a checkout of this repository.

**The alias.** Nuxt makes `#layers/chat` of the layer's `$meta.name`, so an app reaches a file as `#layers/chat/app/utils/queue`. Plain Vitest does not know it: map it once,
`alias: { '#layers/chat': process.env.CHAT_LAYER || resolve('./node_modules/@fabkho/chat') }`.
The layer's utils and composables are also auto-imported by Nuxt, like any layer's `app/utils` and `app/composables` (`useThread`, `createSaveQueue`, …).

**Peer dependencies.** `@fabkho/ui`, `nuxt` and `vue`. The only import from the base is `@fabkho/ui/pure/*` (a few pure helpers). The base is declared as `"@fabkho/ui": "*"` because an app installs it from a git URL (`github:fabkho/ui#v…`), and a git URL cannot satisfy a semver range: with a range pnpm reports `unmet peer @fabkho/ui` and does not link it. Keep the base itself pinned to a tag in the app.

## The rules

1. **No words.** No sentence in any language: modules return codes and state, the app's components word them. No product names.
2. **No app imports.** Files import only themselves (relative paths), `vue` and `@fabkho/ui/pure/*`. No `~/`, `@/`, `#imports`, no `#layers/chat/` inside the package, no auto-imports (a layer file imports `computed` from `vue` itself).
3. **No Supabase, no `@supabase/realtime-js`.** The Realtime client comes in through `RealtimeLike`, which is `{ setAuth, channel, removeChannel }`; an app adapts its own client in a few lines, and may load it lazily so that it stays out of the entry chunk.

`tests/layer-guard.test.ts` enforces them (imports, aliases, auto-imports, domain and German words, the `package.json` contract), so a new file is checked without a list to keep. `pnpm test` runs it with the unit tests (plain Node Vitest, no Nuxt runtime).

## The adapter contract

`app/types/adapter.ts` is the whole contract: types only, no runtime code. An app fills the interfaces; the layer's modules only ever talk to them.

```ts
type Result<T> = { ok: true; value: T } | { ok: false; error: string; retryable: boolean }

interface ChatAdapter {
  me(): Id | null // the signed-in member
  can(action: 'write' | 'manageGroup' | 'manageBuddyRead', conversationId: Id): boolean
  page(q: { conversationId; threadId: Id | null; before?; after?; limit }): Promise<Result<ChatRecord[]>>
  send(job: SendJob): Promise<Result<ChatRecord>>
  markRead(q: { conversationId; threadId: Id | null; upTo: string }): Promise<Result<void>>
  react(messageId: Id, emoji: string | null): Promise<Result<void>>
  upload(conversationId: Id, file: Blob, kind: 'image' | 'voice'): Promise<Result<{ path: string }>>
  sign(paths: string[]): Promise<Result<Record<string, string>>>
  live(on: LiveHandlers): () => void // message, reaction, changed, resync; returns the stop function
  storage: { get(key): string | null; set(key, value): void; remove(key): void }
  lock?<T>(name: string, run: () => Promise<T>): Promise<T> // a cross-tab lock, when the platform has one
}

interface GroupAdapter { group(id); setAdmin(id, memberId, admin); leave(id); mute?(id, until) }
interface BuddyReadAdapter { buddyRead(id); setMarker(id, readThrough); setChapters(id, plan); peeked: { has(threadId); add(threadId) } }
interface InviteAdapter { join(sourceId); dismiss(sourceId) } // the app's way into a group
```

`ChatRecord` (a message: `id`, `conversationId`, `threadId`, `senderId`, `clientId`, `kind`, `body`, `createdAt`, `replyTo`, `spoiler`, `media`, `payload?`), `SendJob`, `BuddyChapter`, `BuddyReadData` and `ChapterPlan` are in the same file. A *thread* is a chapter of a buddy read (a section of a book, in another app); the type names `BuddyChapter`, `BuddyReadData`, `ChapterPlan` and the functions `chapterOpen` / `chapterView` keep the word *chapter* and the layer's own id field is the neutral `threadId`. An app keeps its own column names and maps them at the adapter boundary.

## Releases

`release-please` keeps one pull request open on `main`, "chore(main): release x.y.z", from the conventional commits (`feat:` bumps the minor, `fix:` the patch, while the major is 0). Merging it tags `vX.Y.Z` and creates the GitHub release. Then each app moves its pin: `pnpm add -E github:fabkho/chat#vX.Y.Z`.

## Development

```sh
pnpm install
pnpm test
```

## Licence

MIT, see `LICENSE`.
