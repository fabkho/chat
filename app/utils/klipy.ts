import type { Result } from '../types/adapter'

/**
 * The chat's GIF picker talks to KLIPY (https://docs.klipy.com) straight from the member's
 * phone, as KLIPY's integration requirements ask: requests and media loads come from the
 * end user's client, the media URLs are used as the API returns them (never copied into our
 * storage), the results are shown in the order they come (no blending, no filtering of ours;
 * filtering is the Partner Panel's), and KLIPY's content is its own grid.
 *
 * The app key is part of the request path (`/api/v1/{key}/gifs/search`), so it ships in the
 * bundle on purpose (the app's public key, like its other public keys). KLIPY allows the
 * browser to call (CORS `*`) and answers with `Cache-Control: public, max-age=21600`, so a
 * repeated search costs the browser's cache, not a call (a test key has 100 calls an hour).
 *
 * What KLIPY learns: the search words, the member's IP address and device data (it is the
 * phone asking), and an opaque id (`customer_id`, see `customerIdFor`). Nothing else.
 */

export const KLIPY_BASE = 'https://api.klipy.com'
/** Where KLIPY's media lives (docs: "Network requirements"); the database accepts only these hosts. */
export const KLIPY_MEDIA_HOST = /^https:\/\/static[0-9]*\.klipy\.com\//

/** Results per page: a dozen, so a screen of the grid is one call. */
export const PAGE_SIZE = 12
/** KLIPY's strictest content filter level, on every request (the Partner Panel's setting is the same). */
export const CONTENT_FILTER = 'high'

/** A GIF in the picker: KLIPY's slug, the grid's preview, and what a tap sends. */
export type GifItem = {
  /** KLIPY's slug: its id for the share call. */
  id: string
  /** The preview's size (the grid keeps the shape before it loads). */
  width: number
  height: number
  /** The preview in the grid (a small animated WebP). */
  preview: string
  /** The rendition the chat message holds (a bigger animated WebP) and its size. */
  url: string
  sentWidth: number
  sentHeight: number
}
/** One page; `next` is the number of the next page, null on the last. */
export type GifPage = { items: GifItem[]; next: number | null }

export const MAX_QUERY = 50

// --------------------------------------------------------------- responses

type Rendition = { url?: unknown; width?: unknown; height?: unknown }
type Sizes = Record<string, Record<string, Rendition | undefined> | undefined>

const num = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

/** The first of `sizes` that has an animated WebP: its URL and size, or null. */
function webp(file: Sizes | undefined, sizes: readonly string[]): { url: string; width: number; height: number } | null {
  for (const size of sizes) {
    const r = file?.[size]?.webp
    if (!r || typeof r.url !== 'string' || !KLIPY_MEDIA_HOST.test(r.url)) continue
    const width = num(r.width)
    const height = num(r.height)
    if (width > 0 && height > 0) return { url: r.url, width, height }
  }
  return null
}

/** One result as the picker's item; null when it has no usable WebP or no slug. */
export function toGif(raw: unknown): GifItem | null {
  const gif = raw as { slug?: unknown; file?: Sizes } | null
  if (!gif || typeof gif.slug !== 'string' || gif.slug === '') return null
  const preview = webp(gif.file, ['sm', 'md', 'xs', 'hd'])
  const sent = webp(gif.file, ['md', 'sm', 'hd', 'xs'])
  if (!preview || !sent) return null
  return {
    id: gif.slug,
    width: preview.width,
    height: preview.height,
    preview: preview.url,
    url: sent.url,
    sentWidth: sent.width,
    sentHeight: sent.height,
  }
}

/** A page from the body of a search or trending answer; null when it is not one. */
export function toPage(body: unknown): GifPage | null {
  const root = body as { result?: unknown; data?: { data?: unknown; current_page?: unknown; has_next?: unknown } } | null
  if (!root || root.result !== true || !root.data || !Array.isArray(root.data.data)) return null
  const items: GifItem[] = []
  const seen = new Set<string>()
  for (const raw of root.data.data) {
    const gif = toGif(raw)
    if (gif && !seen.has(gif.id)) {
      seen.add(gif.id)
      items.push(gif)
    }
  }
  const page = num(root.data.current_page) || 1
  return { items, next: root.data.has_next === true ? page + 1 : null }
}

// ---------------------------------------------------------------- requests

/**
 * The search URL, or trending without `q`. The key is in the path, as KLIPY has it; the
 * member's words are `q`, the language `locale` (ISO 3166 alpha-2 country, as KLIPY wants it), the strictest `content_filter`, and only
 * WebP is asked for (the grid and the bubble use nothing else).
 */
export function klipyUrl(key: string, q: string | null, page: number, customerId: string | null, locale: string): string {
  const params = new URLSearchParams({
    page: String(Math.max(1, Math.floor(page))),
    per_page: String(PAGE_SIZE),
    locale,
    content_filter: CONTENT_FILTER,
    format_filter: 'webp',
  })
  if (q) params.set('q', q)
  if (customerId) params.set('customer_id', customerId)
  return `${KLIPY_BASE}/api/v1/${encodeURIComponent(key)}/gifs/${q ? 'search' : 'trending'}?${params}`
}

/** KLIPY's share trigger: which GIF a search led to (`POST /gifs/share/{slug}`), so its ranking learns. */
export function klipyShareUrl(key: string, slug: string): string {
  return `${KLIPY_BASE}/api/v1/${encodeURIComponent(key)}/gifs/share/${encodeURIComponent(slug)}`
}

/**
 * An opaque, stable id for KLIPY's `customer_id` (it asks for one per user to rank and to
 * count users): the SHA-256 of the app's own label (`salt`) and the member's id, in hex. KLIPY gets
 * neither her id nor her e-mail address, and cannot get from it to her. KLIPY ranks by this id, so an
 * app keeps its salt for good: a new one is a new user to KLIPY.
 */
export async function customerIdFor(memberId: string, salt: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  const bytes = await subtle.digest('SHA-256', new TextEncoder().encode(`${salt}${memberId}`))
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export type KlipyOptions = {
  /** The app key (the app's public KLIPY key). */
  key: string
  /** KLIPY's `locale`: the member's language as an ISO 3166 alpha-2 country. */
  locale: string
  /**
   * The topics the picker offers while nothing is searched, each as the search words behind it; `null` is
   * KLIPY's trending. A topic that is not named here is trending.
   */
  topics: Record<string, string | null>
  /** The opaque id of the signed-in member (`customerIdFor`), or null. */
  customerId?: () => Promise<string | null>
  fetchImpl?: typeof fetch
}

/** What goes wrong with a call: no connection, or KLIPY not answering as it should. Codes; the app words them. */
export type KlipyError = 'network' | 'klipy_unavailable'

/**
 * Which of several overlapping requests may still show: the last one started. A chip tapped
 * while another topic is loading starts a new one, and the answer that comes back late is
 * dropped, so the grid always ends on the last tap.
 */
export function latestRequest() {
  let current = 0
  return {
    /** A new request; the ones before it are stale from now on. */
    start(): number {
      return ++current
    },
    /** Whether `ticket` is still the newest request. */
    isCurrent(ticket: number): boolean {
      return ticket === current
    },
    /** Stale every request in flight, without starting one. */
    cancel(): void {
      current++
    },
  }
}

/** The GIF picker's calls to KLIPY; what goes wrong comes back as a code (`KlipyError`), never as a sentence. */
export function createKlipy({ key, locale, topics, customerId, fetchImpl = fetch }: KlipyOptions) {
  const id = async () => (customerId ? await customerId().catch(() => null) : null)
  /** Each topic's first page, kept for this client's life (see `gifs`). */
  const firstPages = new Map<string, Promise<Result<GifPage>>>()
  const wordsOf = (topic: string): string | null => topics[topic] ?? null

  async function get(q: string | null, page: number): Promise<Result<GifPage>> {
    let res: Response
    try {
      res = await fetchImpl(klipyUrl(key, q, page, await id(), locale))
    } catch {
      return { ok: false, error: 'network' satisfies KlipyError, retryable: true }
    }
    if (!res.ok) return { ok: false, error: 'klipy_unavailable' satisfies KlipyError, retryable: true }
    const body = await res.json().catch(() => null)
    const result = toPage(body)
    return result ? { ok: true, value: result } : { ok: false, error: 'klipy_unavailable' satisfies KlipyError, retryable: true }
  }

  return {
    /**
     * Search (`q` set), or with `q` empty the `topic`: its search words or trending. `page` starts
     * at 1; the page's `next` is the one after.
     */
    gifs(q: string, page = 1, topic = 'trending'): Promise<Result<GifPage>> {
      const words = q.trim().slice(0, MAX_QUERY)
      if (words) return get(words, page)
      if (page > 1) return get(wordsOf(topic), page)
      // A topic's first page is kept for as long as this client lives (the picker's, the session's):
      // switching back costs no call. A failure is not kept, and a call in flight is shared.
      const kept = firstPages.get(topic)
      if (kept) return kept
      const pending = get(wordsOf(topic), 1)
      firstPages.set(topic, pending)
      void pending.then((result) => {
        if (!result.ok) firstPages.delete(topic)
      })
      return pending
    },

    /** Tells KLIPY which GIF she sent (and the words that found it); fire and forget. */
    async share(gif: GifItem, q: string): Promise<void> {
      try {
        const customer = await id()
        await fetchImpl(klipyShareUrl(key, gif.id), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...(customer ? { customer_id: customer } : {}), ...(q ? { q } : {}) }),
        })
      } catch {
        // Analytics only: a failure changes nothing for her.
      }
    },
  }
}
