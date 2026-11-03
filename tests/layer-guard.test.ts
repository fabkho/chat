import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The package's guard. This package is taken by apps (as a tag-pinned git dependency), so it never reaches into one:
 * every file of the layer (`app/**`, `nuxt.config.ts`) imports only from itself (relative paths), `vue` and the UI base's
 * pure helpers (`@fabkho/ui/pure/*`); it knows no app alias (`~/`, `@/`, `~~/`, `#imports`), not its own `#layers/chat/`
 * alias, no Pinia, no Supabase and no realtime-js (the Realtime client is injected, `RealtimeLike`); it uses no auto-import;
 * and it says no word of any app's product or language. A new file is checked without a list to keep. Plain Node.
 */

const root = fileURLToPath(new URL('../', import.meta.url))
const layer = join(root, 'app')
const self = fileURLToPath(import.meta.url)

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

const isSource = (file: string) => /\.(ts|js|mjs|vue)$/.test(file)
/** What the package ships: `app/**` and `nuxt.config.ts`. */
const files = [...filesUnder(layer), join(root, 'nuxt.config.ts')].filter(isSource)
/** The package's own tests: they say no app's word either (this guard names the words, so it is left out). */
const tests = filesUnder(join(root, 'tests')).filter((file) => isSource(file) && file !== self)
const sourceOf = (file: string) => readFileSync(file, 'utf8')
const nameOf = (file: string) => relative(root, file).split(sep).join('/')

/** Every module specifier a file imports, statically, dynamically or by `export … from`. */
function importsOf(source: string): string[] {
  const found: string[] = []
  const patterns = [/\b(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g]
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.push(match[1]!)
  return found
}

/** What an import may be: the package itself (by a relative path), Vue and the UI base's pure helpers. */
function allowed(file: string, specifier: string): boolean {
  if (specifier === 'vue') return true
  if (specifier.startsWith('@fabkho/ui/pure/')) return true
  // Inside the package a file reaches another by a relative path: the `#layers/chat/` alias is the app's way in, and the package has none.
  if (specifier.startsWith('.')) {
    const target = resolve(dirname(file), specifier)
    return target === root.replace(/\/$/, '') || target.startsWith(root)
  }
  return false
}

// The apps' domain words: none of them in an identifier, a string or a comment of the package.
const DOMAIN_WORDS = /\b(trappist|betterreads|libellus|bookretreats|orga|verbind\w*|wochenend\w*|volume\w*|feed\w*|friends|gespräch\w*|inbox)\b/i

// German in a package that is public: an umlaut, the „ “ quotes of a German sentence, and the words of the apps' own
// language that would be their book clubs' (`\b` keeps `Prologue` and `chat` out of it).
const GERMAN = /[äöüß„“]|\b(?:kapitel|prolog|buch|bücher|gruppe|gruppen|gastgeberin|nachricht|nachrichten|lesestand|stelle|davor|danach|zusammen|gelesen|neu|je|nein|bitte|und|der|das)\b/i

// Nuxt would auto-import these; the layer imports them from `vue`.
const AUTO_IMPORTS = ['ref', 'computed', 'reactive', 'watch', 'watchEffect', 'toValue', 'toRef', 'onMounted', 'onBeforeUnmount', 'shallowRef', 'defineStore', 'useRoute', 'useRouter', 'navigateTo']

const offendersIn = (list: string[], pattern: RegExp, verb: string) =>
  list.flatMap((file) =>
    sourceOf(file)
      .split('\n')
      .flatMap((line, index) => {
        const hit = pattern.exec(line)
        return hit ? [`${nameOf(file)}:${index + 1} ${verb} "${hit[0]}"`] : []
      }),
  )

describe('the chat layer', () => {
  it('has files to guard', () => {
    expect(files.length).toBeGreaterThan(0)
    expect(existsSync(join(root, 'nuxt.config.ts'))).toBe(true)
    expect(files.map(nameOf)).toEqual(
      expect.arrayContaining([
        'app/types/adapter.ts',
        'app/utils/queue.ts',
        'app/utils/thread.ts',
        'app/utils/chapters.ts',
        'app/utils/veil.ts',
        'app/utils/photo.ts',
        'app/utils/klipy.ts',
        'app/utils/errors.ts',
        'app/utils/liveChannel.ts',
        'app/composables/useThread.ts',
        'app/composables/useBuddyRead.ts',
      ]),
    )
    // An app's invitation state is the app's own.
    expect(files.map(nameOf)).not.toContain('app/utils/inviteState.ts')
  })

  it('imports only from itself (relative paths), Vue and the UI base\'s pure helpers', () => {
    const offenders = files.flatMap((file) =>
      importsOf(sourceOf(file))
        .filter((specifier) => !allowed(file, specifier))
        .map((specifier) => `${nameOf(file)} imports ${specifier}`),
    )
    expect(offenders).toEqual([])
  })

  it('has no `#layers/chat/` alias inside the package: the alias is the app\'s way in', () => {
    expect(offendersIn([...files, ...tests], /#layers\/chat\b/, 'uses')).toEqual([])
  })

  it('knows no app alias, no Pinia, no Supabase', () => {
    const banned = /(?:^|['"`])(?:~\/|@\/|~~\/|@@\/|#imports|#app|pinia|@pinia|@supabase)/
    const offenders = files.flatMap((file) =>
      sourceOf(file)
        .split('\n')
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /\bfrom\s|import\(|require\(/.test(line) && banned.test(line))
        .map(({ index }) => `${nameOf(file)}:${index + 1}`),
    )
    expect(offenders).toEqual([])
  })

  it('names no Supabase and no realtime-js, and the live channel takes its client as an injected `RealtimeLike`', () => {
    expect(offendersIn(files, /supabase|realtime-js/i, 'names')).toEqual([])
    const file = files.find((f) => nameOf(f) === 'app/utils/liveChannel.ts')
    expect(file).toBeDefined()
    expect(sourceOf(file!)).toContain('RealtimeLike')
  })

  it('uses no auto-import', () => {
    const offenders = files.flatMap((file) => {
      const source = sourceOf(file)
      const imported = importsOf(source).length ? source : ''
      return AUTO_IMPORTS.filter((name) => new RegExp(`(?<![.\\w])${name}\\(`).test(source))
        .filter((name) => !new RegExp(`import[^;]*\\b${name}\\b[^;]*from\\s*['"]vue['"]`, 's').test(imported) && !new RegExp(`\\bfunction ${name}\\b|\\bconst ${name}\\b`).test(source))
        .map((name) => `${nameOf(file)} calls ${name}() without importing it`)
    })
    expect(offenders).toEqual([])
  })

  it('says no word of an app\'s domain', () => {
    expect(offendersIn(files.filter((file) => nameOf(file) !== 'nuxt.config.ts'), DOMAIN_WORDS, 'says')).toEqual([])
    expect(offendersIn(tests, DOMAIN_WORDS, 'says')).toEqual([])
  })

  it('has no German in it, comments and tests included', () => {
    expect(offendersIn([...files, ...tests], GERMAN, 'has')).toEqual([])
  })

  it('ships `app` and `nuxt.config.ts`, as a public package with nothing to install at runtime', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('@fabkho/chat')
    expect(pkg.private).toBeFalsy()
    expect(pkg.files).toEqual(['app', 'nuxt.config.ts'])
    expect(pkg.dependencies).toBeUndefined()
    // A git-URL install cannot satisfy a semver range, so the base is a `*` peer (the README says why).
    expect(pkg.peerDependencies['@fabkho/ui']).toBe('*')
    expect(Object.keys(pkg.peerDependencies).sort()).toEqual(['@fabkho/ui', 'nuxt', 'vue'])
  })

  it('sees an offender when there is one (the checks are not blind)', () => {
    const at = (path: string) => join(root, 'app/utils', path)
    expect(allowed(at('x.ts'), '~/data/chat')).toBe(false)
    expect(allowed(at('x.ts'), 'pinia')).toBe(false)
    expect(allowed(at('x.ts'), '@supabase/supabase-js')).toBe(false)
    expect(allowed(at('x.ts'), '../../../outside/app')).toBe(false)
    expect(allowed(at('x.ts'), '../types/adapter')).toBe(true)
    expect(allowed(at('x.ts'), '#layers/chat/app/types/adapter')).toBe(false)
    expect(allowed(at('x.ts'), '#layers/ui/app/utils/x')).toBe(false)
    expect(allowed(at('x.ts'), '@fabkho/ui/pure/timeline')).toBe(true)
    expect(allowed(at('x.ts'), '@fabkho/ui/app/components/x')).toBe(false)
    expect(importsOf("import { a } from '~/x'\nexport * from '@supabase/supabase-js'\nconst m = await import('./y')")).toEqual([
      '~/x',
      '@supabase/supabase-js',
      './y',
    ])
    for (const word of ['the Orga hides a message', 'Trappist', 'BetterReads', 'the Feed', 'Libellus']) expect(DOMAIN_WORDS.test(word), word).toBe(true)
    expect(DOMAIN_WORDS.test('a message in a thread')).toBe(false)
    for (const german of ['Kapitel 7', 'a „quote“', 'Größe', 'Das ganze Buch', 'je 3 zusammen', 'Nein.', 'Bitte warten']) expect(GERMAN.test(german), german).toBe(true)
    for (const english of ['Chapter 7', 'the Prologue', 'a chat message', 'a new thread', 'a book, a group', 'the stellar view']) expect(GERMAN.test(english), english).toBe(false)
  })
})
