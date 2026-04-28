# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

This is a **Frappe/ERPNext v15 app** (`pos_next`) that ships a modern POS frontend. The repo contains three distinct code bases side by side:

- [pos_next/](pos_next/) — Python Frappe app (API, DocTypes, hooks, overrides, fixtures, server-side services). This is what `bench install-app pos_next` installs.
- [POS/](POS/) — Vue 3 / Vite / Tailwind frontend. It builds into `pos_next/public/pos/` and is served at `/pos` via the `website_route_rules` in [pos_next/hooks.py](pos_next/hooks.py).
- [desktop/](desktop/) — Tauri v2 shell that wraps the same `POS/` Vue app into a per-customer Windows `.exe`. Talks to a remote Frappe Cloud site instead of a same-origin bench. Per-customer build inputs live in `desktop/customers/<slug>.json` (gitignored — see [.github/workflows/desktop-build.yml](.github/workflows/desktop-build.yml) for the secret-based config flow).

Do not confuse them: edit Python inside `pos_next/`, edit JS/Vue inside `POS/src/`, edit the Tauri shell inside `desktop/src-tauri/`.

## Common commands

All `npm`/`yarn`/`vite`/`biome`/`vitest` commands must be run from [POS/](POS/), not from the repo root. The root [package.json](package.json) proxies `dev`/`build` into `POS/` but lint/test do not proxy.

```bash
# Frontend dev server on :8080, proxies /api,/app,/assets,/files to bench on :8000
cd POS && yarn dev                 # or: npm run dev

# Production build into ../pos_next/public/pos/ with base=/assets/pos_next/pos/
cd POS && yarn build               # also writes pos_next/public/pos/version.json

# Lint / format (Biome, tabs, double quotes, no semis)
cd POS && yarn lint                # biome check .
cd POS && yarn lint:fix            # biome check --write .
cd POS && yarn format

# Frontend tests (Vitest + jsdom + fake-indexeddb). Specs live under POS/tests/.
cd POS && yarn test                # watch mode
cd POS && yarn test:run            # single run (39 tests across the offline subsystem)
cd POS && yarn test:run -- path/to/file.test.js   # single file
cd POS && yarn test:coverage       # v8 coverage; report under POS/coverage/

# Frontend E2E (Playwright). Auto-starts the Vite dev server (reuses one
# if already running). Browser binary path: PLAYWRIGHT_BROWSERS_PATH.
cd POS && yarn e2e                 # headless
cd POS && yarn e2e:headed          # see the browser
cd POS && yarn e2e:install         # install chromium binary if missing

# Desktop (Tauri v2 / Windows .exe per customer). Run from repo root.
# Requires `desktop/customers/<slug>.json` (see desktop/customers/_template.json).
yarn desktop:dev <slug>            # vite dev + `tauri dev`, baseUrl=customer's siteUrl
yarn desktop:build <slug>          # produces desktop/dist/<slug>/*-Setup.exe
yarn desktop:build:all             # loops every desktop/customers/*.json
yarn desktop:publish <slug>        # signs + writes latest.json for the GH Releases channel
# Cross-platform: production .exe builds run on `windows-latest` via
# `.github/workflows/desktop-build.yml`. Local Linux can build for dev only.

# Backend: run from ~/frappe-bench
bench --site <site> run-tests --app pos_next
bench --site <site> run-tests --app pos_next --module pos_next.api.test_customers

# Backend install/migrate cycle
bench --site <site> install-app pos_next
bench --site <site> migrate
bench build --app pos_next          # rebuilds assets via vite
bench --site <site> clear-cache
```

Backend Python is linted with **ruff** (config in [pyproject.toml](pyproject.toml): `target-version = py310`, tabs, double quotes, line length 110). Pre-commit hooks are set up via `pre-commit install` from the app root.

Source maps in production builds are **off by default** — set `POS_NEXT_ENABLE_SOURCEMAP=true` before `yarn build` if you need them. The build version is stamped from `POS_NEXT_BUILD_VERSION` env or `Date.now()` and is the cache-busting key surfaced by [pos_next/utils.py:get_build_version](pos_next/utils.py).

## Big-picture architecture

### Frontend → Backend integration surface

The frontend does **not** define its own REST routes. It calls whitelisted Frappe methods under `pos_next.api.*` through `frappe-ui`'s `frappeRequest`. See [pos_next/api/](pos_next/api/) for the full surface (bootstrap, invoices, items, offers, customers, shifts, wallet, partial_payments, credit_sales, promotions, branding, localization, qz, offline_data). Any new frontend capability typically means: add a `@frappe.whitelist()` in `pos_next/api/*.py`, then call it from `POS/src/`.

Reference data for offline use lives in [pos_next/api/offline_data.py](pos_next/api/offline_data.py): `get_taxes`, `get_uoms`, `get_loyalty_programs`, and the one-shot `get_offline_bundle` (taxes + UOMs + loyalty in a single round-trip). Customer enrichment for offline (addresses, loyalty points, wallet balance) and the offline customer-create replay endpoint live in [pos_next/api/customers.py](pos_next/api/customers.py): `get_customers_for_offline`, `get_customer_offline_extras`, `replay_offline_customer` (idempotent on `offline_id`, uses a `pos_next_offline_id` Custom Field on Customer when present).

Server→client realtime uses Socket.IO. Frappe document events in [hooks.py](pos_next/hooks.py) (`doc_events` on `Sales Invoice`, `Customer`, `POS Profile`) fan out through [pos_next/realtime_events.py](pos_next/realtime_events.py) and are consumed by `POS/src/composables/useRealtime*.js` plus `POS/src/socket.js`.

### Frappe integration points to know before editing

[pos_next/hooks.py](pos_next/hooks.py) is the contract with the framework. Key extension points already used:

- `override_doctype_class` — **Sales Invoice is overridden** by [pos_next/overrides/sales_invoice.py](pos_next/overrides/sales_invoice.py). Changing invoice behavior usually means editing that subclass, not patching ERPNext.
- `standard_queries` — custom `Item` query in [pos_next/validations.py](pos_next/validations.py) (company-aware filtering).
- `doc_events` — Sales Invoice validate/submit/cancel run multiple hooks (`sales_invoice_hooks`, `wallet`, `realtime_events`). Order matters; list position is execution order.
- `fixtures` — the roles `POSNext Cashier` and `Nexus POS Manager` plus their Custom DocPerms sync on migrate. Editing permissions in the UI must be followed by `bench export-fixtures` to persist.
- `scheduler_events` — hourly/daily/monthly tasks live in [pos_next/tasks/](pos_next/tasks/) (branding monitor, promo cleanup).
- `website_route_rules` — maps `/pos/<path>` to the `pos` template ([pos_next/www/pos.html](pos_next/www/pos.html)), which is the Jinja entry that bootstraps the SPA.
- `after_install` / `after_migrate` — [pos_next/install.py](pos_next/install.py) runs post-fixture setup and cache clearing.

### Frontend architecture

Entry is [POS/src/main.js](POS/src/main.js). Startup sequence (documented in that file) is non-trivial and order-sensitive:

1. Register PWA service worker (vite-plugin-pwa, generated workbox config in [vite.config.js](POS/vite.config.js)).
2. Create Vue app + Pinia, install `frappe-ui` plugins, wrap `resourceFetcher` with a **CSRF-aware retry** ([POS/src/utils/csrf.js](POS/src/utils/csrf.js) — auto-refreshes token on 401/403, re-syncs to the offline worker).
3. CSRF fetch and user resource fetch run in parallel; the app does not mount until both settle.
4. After mount, [POS/src/stores/bootstrap.js](POS/src/stores/bootstrap.js) preloads POS profile/precision data and then initializes Socket.IO with the site name from that payload.
5. CSRF token is refreshed every 30 minutes via `setInterval`.

**State (Pinia)** lives in [POS/src/stores/](POS/src/stores/). `posCart.js` is the biggest; it uses an internal async queue (`createAsyncQueue`) to serialize cart recalculations — when adding cart mutations, enqueue through it rather than racing state directly. `posSettings`, `posShift`, `posOffers`, `posDrafts`, `posSync`, `itemSearch`, `customerSearch`, `stock` are separate concerns; reuse them instead of adding duplicate state in components.

**Composables** in [POS/src/composables/](POS/src/composables/) wrap cross-cutting UX (shift, offline status, payment numpad, session lock, QZ Tray printing, realtime subscriptions). Prefer extending these over inlining logic in `.vue` components.

**Offline support** is the most complex subsystem. See [docs/OFFLINE_DATA_GUIDE.md](docs/OFFLINE_DATA_GUIDE.md) for the full data-side reference and [docs/OFFLINE_SYNC.md](docs/OFFLINE_SYNC.md) for the queue sync state machine.

- A dedicated Web Worker [POS/src/workers/offline.worker.js](POS/src/workers/offline.worker.js) is copied into the build by `vite-plugin-static-copy`. The main thread talks to it via [POS/src/utils/offline/workerClient.js](POS/src/utils/offline/workerClient.js) (RPC, health checks, crash recovery).
- Persistence uses Dexie/IndexedDB ([POS/src/utils/offline/db.js](POS/src/utils/offline/db.js)). The schema is **auto-versioned** via a hash of `CURRENT_SCHEMA` — bump the schema by editing that object; Dexie auto-migrates on next load. Tables include items, customers, item_prices, stock, payment_methods, sales_persons, taxes, uoms, item_groups, brands, loyalty_programs, offers, invoice_history, unpaid_invoices, translations, plus the queues `invoice_queue`, `payment_queue`, `customer_queue`, `drafts`, and `settings`.
- Service-worker runtime caching in [vite.config.js](POS/vite.config.js) uses different strategies per URL (CacheFirst for assets/fonts, StaleWhileRevalidate for `/files/*.{jpg,png,...}` product images, NetworkFirst for `/api/*` with a 10 s timeout). Navigation to `/pos` uses a 3 s NetworkFirst.
- Item images are also **eagerly pre-downloaded** after item-cache seeding by [POS/src/utils/offline/imagePrefetch.js](POS/src/utils/offline/imagePrefetch.js) (throttled, resumable, cancellable), so the SW image cache covers everything in the catalog, not just what the cashier has viewed.
- CSRF token is forwarded to the worker on boot and on every refresh; offline invoice submission depends on that sync.

**Offline write queues** — invoices and customers both have idempotent queues:

- `invoice_queue` (in [POS/src/utils/offline/sync.js](POS/src/utils/offline/sync.js)) — `saveOfflineInvoice` records a `stock_delta` so a permanent sync failure or a manual delete can revert the optimistic stock decrement (`revertLocalStockForInvoice`).
- `customer_queue` (in [POS/src/utils/offline/customerQueue.js](POS/src/utils/offline/customerQueue.js)) — `enqueueOfflineCustomer` writes a placeholder customer row immediately so it's selectable mid-session; `syncOfflineCustomers` (run BEFORE invoice sync in `posSync.syncPending`) replays via `replay_offline_customer`, which is idempotent on `offline_id`.

**Three durability layers protect queued POS data:**

1. **`navigator.storage.persist()`** — [POS/src/utils/offline/persistence.js](POS/src/utils/offline/persistence.js). Asks the browser not to evict our IndexedDB under storage pressure. Fired once on boot from `main.js`.
2. **Service-worker runtime caches** — covered above; protect assets and opportunistic API responses.
3. **QZ-Tray on-disk mirror** — [POS/src/utils/offline/diskBackup.js](POS/src/utils/offline/diskBackup.js). Mirrors every queued invoice + customer to JSON files on the host filesystem via QZ Tray's sandbox file API (no certificate elevation needed). `restoreFromDisk()` re-inserts any rows missing from IndexedDB after a "Clear site data" or browser reinstall, and runs automatically 5 s after boot. A "Restore from Disk" button is exposed in the offline-invoices dialog. Best-effort: silently degrades to layers 1 + 2 when QZ isn't running.

**Routing** ([POS/src/router.js](POS/src/router.js)) is minimal — three routes (`POSSale`, `Login`, catch-all) with an auth guard against `session.isLoggedIn`. Base path is branched on `runtimeConfig.isDesktop`: web is `/pos`, desktop is `/` (Tauri serves the bundle from the root of `tauri://localhost`).

**Aliases**: `@` → `POS/src`. `tailwind.config.js` alias is set so `frappe-ui` components can resolve it.

### Desktop (Tauri) build

The same `POS/` Vue app ships unchanged inside a Tauri v2 shell as a per-customer Windows `.exe`. The frontend branches on **`runtimeConfig.isDesktop`** ([POS/src/utils/runtimeConfig.js](POS/src/utils/runtimeConfig.js)) — single source of truth for "where do we run, and against what backend." It reads `__POS_TARGET__` and `__FRAPPE_BASE_URL__` injected at build time by [POS/vite.config.js](POS/vite.config.js).

What desktop mode changes vs. web:

- **Transport**: every Frappe API call goes through [POS/src/utils/desktopTransport.js](POS/src/utils/desktopTransport.js) → `@tauri-apps/plugin-http` → Rust reqwest, which **bypasses the WebView's CORS** entirely. No preflights, no Frappe-side `Access-Control-*` config needed. Wired in [POS/src/main.js](POS/src/main.js) via `setConfig("resourceFetcher", desktopFrappeRequest)`. Short-form Frappe paths (e.g. `frappe.auth.get_logged_user`) get auto-prefixed with `/api/method/` by `normalizeFrappePath()` to match the original `frappeRequest` behaviour.
- **Auth**: API key + secret as `Authorization: token <key>:<secret>`, **not** session cookies. The login flow runs in Rust ([desktop/src-tauri/src/lib.rs](desktop/src-tauri/src/lib.rs) → `frappe_login` Tauri command) because Tauri's plugin-http strips the `Cookie` header (Fetch spec "forbidden header"), which would break the `login → generate_keys` chain. Credentials are persisted in `tauri-plugin-stronghold` via [POS/src/utils/desktopAuth.js](POS/src/utils/desktopAuth.js).
- **Identity**: there is no `user_id` cookie in `tauri://` — `session.user`, `userData.userId`, and the session-lock cached-password ownership check all read from `userResource.data` (the email returned by `get_logged_user`) or the Stronghold-cached email. Helper: `userData.setIdentity({userId, fullName})` in [POS/src/data/user.js](POS/src/data/user.js).
- **Disabled subsystems**: PWA service worker, Socket.IO, CSRF — all short-circuit when `runtimeConfig.isDesktop` (see `runtimeConfig.hasServiceWorker`, `hasRealtime`, [POS/src/utils/csrf.js](POS/src/utils/csrf.js)). Real-time updates fall back to the existing realtime composables tolerating a no-op socket.
- **Logging**: [POS/src/utils/logger.js](POS/src/utils/logger.js) mirrors warn/error to a rotating file via `tauri-plugin-log` so a cashier's machine can be debugged after the fact.
- **Auto-update**: `tauri-plugin-updater` polled by [POS/src/composables/useDesktopUpdate.js](POS/src/composables/useDesktopUpdate.js) every 6 hours, banner in [POS/src/components/DesktopUpdateBanner.vue](POS/src/components/DesktopUpdateBanner.vue). Endpoint is a per-customer **mutable GitHub Release tag** (`desktop-channel-<slug>`) carrying `latest.json` + the signed installer. Signing key is per-customer minisign in `desktop/keys/` (gitignored).

Per-customer build: [desktop/scripts/build-customer.mjs](desktop/scripts/build-customer.mjs) reads `desktop/customers/<slug>.json` (`{ siteUrl, displayName, identifier, version, updater }`), generates icons if missing, runs `vite build --mode desktop` with `VITE_POS_TARGET=desktop VITE_FRAPPE_BASE_URL=<siteUrl>`, then `tauri build`. Cross-platform `.exe` production builds run on `windows-latest` via [.github/workflows/desktop-build.yml](.github/workflows/desktop-build.yml) — customer configs are stored as `CUSTOMER_CONFIG_<SLUG_UPPER>` GitHub secrets, not committed.

When editing the desktop subsystem, **always check the `.claude/skills/desktop/SKILL.md`** for the current set of conventions and gotchas — it's the authoritative quick-reference for the Tauri shell.

### Where to add things

- New server API: `pos_next/api/<module>.py` with `@frappe.whitelist()`. Keep hooks thin — business logic belongs in the module, not `hooks.py`.
- New DocType: `pos_next/pos_next/doctype/<name>/` (follow the existing pattern, including `test_<name>.py`).
- New Vue view: page in `POS/src/pages/` + route in `router.js`; prefer Pinia store over page-local state for anything shared.
- New realtime event: emit from a `doc_events` handler in `pos_next/realtime_events.py`, subscribe in a `useRealtime*.js` composable.
- New offline cache: add a Dexie store to `CURRENT_SCHEMA` in [POS/src/utils/offline/db.js](POS/src/utils/offline/db.js) (auto-versioned), then add a `cacheXFromServer` + `getCachedX` pair to [POS/src/utils/offline/cache.js](POS/src/utils/offline/cache.js) and re-export from [POS/src/utils/offline/index.js](POS/src/utils/offline/index.js). Seed it from `posSync.preloadDataForOffline`.
- New offline write queue: follow the `customerQueue.js` pattern — write a placeholder/optimistic row + a queue row inside one transaction, drain via a `syncX` function gated by `isOffline()`, replay through an idempotent backend method keyed on `offline_id`, drop the disk mirror via `removeMirroredX` on success.
- New frontend test: drop a `*.test.js` under [POS/tests/](POS/tests/). [POS/tests/setup.js](POS/tests/setup.js) installs `fake-indexeddb` globally so Dexie works under jsdom; mock `@/utils/apiWrapper` for any code that calls the server. The Tauri JS plugins are stubbed at `POS/tests/stubs/tauri-*.js` (registered as Vite aliases in [POS/vitest.config.js](POS/vitest.config.js)) so `runtimeConfig.isDesktop=false` paths still import cleanly.
- New desktop customer: copy [desktop/customers/_template.json](desktop/customers/_template.json) to `<slug>.json` (gitignored) for local dev, and add the same JSON as a `CUSTOMER_CONFIG_<SLUG_UPPER>` GitHub secret for CI. Generate a signing keypair with `tauri signer generate -w desktop/keys/<slug>.key`; commit only the public key to the `updater.pubkey` field of the customer config.
- New code that reads cookies / `window.csrf_token` / `window.frappe.*` for control flow: gate it on `runtimeConfig.isDesktop` or read from `userData` / `session.user` / `userResource.data` instead — those work in both modes.

## Constraints worth remembering

- **Dev requires `"ignore_csrf": 1`** in `site_config.json` for the Vite dev server on :8080 to reach `/api` on :8000. Production relies on `window.csrf_token` injected by `pos.html`.
- Vite **web** build must stay targeted at `../pos_next/public/pos/` with `base=/assets/pos_next/pos/` — changing either breaks asset URLs in the Jinja shell. The desktop branch (`VITE_POS_TARGET=desktop`) overrides both: output goes to `desktop/dist-frontend/` with `base: "./"`, PWA disabled, and `__FRAPPE_BASE_URL__` set to the customer's site URL.
- ES2015 target, `chunkSizeWarningLimit` is 1500 — acceptable for this app; don't silently lower it without checking bundle impact.
- CI: [.github/workflows/ci.yml](.github/workflows/ci.yml) verifies install on a fresh bench + runs linters (backend `run-tests` is commented out — treat `bench run-tests` as local-only). [.github/workflows/desktop-build.yml](.github/workflows/desktop-build.yml) builds the per-customer Windows installer on `windows-latest`; trigger via workflow_dispatch or by pushing a tag matching `desktop-v<version>-<slug>`.
- **Desktop credentials never leave the bundle securely.** The site URL baked into a per-customer build is visible to anyone with the .exe. Sensitive customer-specific config (anything beyond `siteUrl` / `displayName` / `identifier`) belongs in a backend setting fetched after login, not in `desktop/customers/<slug>.json`.
- License is **AGPL-3.0** — any distributed modifications inherit copyleft.
