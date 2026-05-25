# AGENTS.md — shazi (傻子展览馆)

Single `_worker.js` (1500 lines) Cloudflare Workers project. No build step, no dependencies, no package.json.

## Commands

Deploy via:
- Dashboard: paste `_worker.js` directly
- CLI: `wrangler deploy` (uses `wrangler.toml`; fill in KV IDs first)
- One-liner (no config): `wrangler deploy --name shazi _worker.js` (set bindings & env in Dashboard)

## KV Bindings

Two KV namespaces (or one fallback):

| Binding | Purpose |
|---|---|
| `PROFILE_KV` | Stores people list (JSON under key `"people"`) |
| `IMAGES_KV` | Stores uploaded image binaries |

If only a single KV is bound, the worker falls back in order: `PROFILE_KV` → `DATA_KV` → `NOTES_KV` → `KV`. Image KV falls back: `IMAGES_KV` → `IMAGE_KV` → data KV.

## Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `ADMIN_USERNAME` | For admin | Admin login username |
| `ADMIN_PASSWORD` | For admin | Admin login password |
| `SITE_PASSWORD` | Optional | If set, site is locked behind a password page |

Without `ADMIN_USERNAME`/`ADMIN_PASSWORD`, the admin panel shows a "not configured" message.

## Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | Site PW | Public people grid |
| POST | `/unlock` | – | Site unlock form |
| GET | `/p/:id` | Site PW | Single person detail page |
| GET | `/admin` | – | Login or admin panel |
| POST | `/admin/login` | – | Form login |
| POST | `/admin/logout` | – | Clear session |
| GET | `/api/people` | Session | List people (JSON) |
| PUT | `/api/people` | Session | Save all people |
| DELETE | `/api/people/:id` | Session | Delete one person |
| GET | `/api/images?personId=` | Session | List images for person |
| POST | `/api/images` | Session | Upload images (max 8 MB each, image/* only) |
| DELETE | `/api/images/:personId/:imageId` | Session | Delete single image |
| GET | `/i/:personId/:imageId` | – | Serve cached image (immutable, 1y) |

## Architecture Notes

- **No framework** — vanilla JS, zero dependencies, ~1500 lines in one file.
- **Admin JS** is server-injected via `adminScript()` as a template literal, serialized inline. `renderMarkdown()` + `inlineMarkdown()` are duplicated into client scope via `Function.toString()`.
- **Admin keyboard shortcut**: `Ctrl/Cmd+S` saves people data.
- **Session auth**: HMAC-SHA256 signed cookies, constant-time comparison. `SITE_PASSWORD` uses same signing scheme.
- **Image storage**: keys prefixed `img:{personId}:{imageId}`. Metadata stored alongside value.
- **Markdown renderer**: custom minimal parser (`renderMarkdown` + `inlineMarkdown`), no library.
- **Data format**: people array stored as KV JSON under key `"people"`. Each person has `id`, `username`, `contact`, `introMarkdown`, `sortOrder`, `createdAt`, `updatedAt`.

## Conventions

- All text in Chinese (zh-CN). Sort uses `"zh-CN"` locale.
- HTML escaping via `escapeHtml`, `escapeAttr`, `safeJson` utilities.
- No TypeScript, no lint, no test tooling. No codegen or migrations.
