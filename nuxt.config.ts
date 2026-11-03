// The chat layer: a chat's client logic, framework-free TypeScript behind an adapter (`app/types/adapter.ts`).
// The source is `app/`; its files import each other and Vue explicitly (no auto-imports in the layer). An app
// reaches them through the alias Nuxt makes of `$meta.name` (see the README). `tests/layer-guard.test.ts`
// guards the rules.
export default defineNuxtConfig({
  $meta: { name: 'chat' },
})
