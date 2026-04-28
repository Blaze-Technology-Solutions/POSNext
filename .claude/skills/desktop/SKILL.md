---
name: desktop
description: Build, release, and troubleshoot the POS Next Tauri desktop installer. Trigger when the user wants to package the POS frontend as a Windows .exe, onboard a new customer with a per-customer build, trigger or debug the GitHub Actions desktop build workflow, configure or roll out auto-updates, or troubleshoot a deployed cashier install (login failing, queue not draining, offline mode misbehaving on the desktop client). Do NOT trigger for general POS bug fixes that aren't desktop-specific.
---

# POS Next desktop wrapper — operations skill

This skill captures the desktop-build subsystem that lives under [desktop/](../../../desktop/) and the runtime config branching it depends on across [POS/src/](../../../POS/src/). The full reference is at [desktop/INSTALL.md](../../../desktop/INSTALL.md) — read it before you act.

## How the desktop build works (mental model)

The Vue POS frontend is a single codebase that branches at build time via `VITE_POS_TARGET`:

- **web mode** (default): served by Frappe at `/pos`, same-origin, CSRF + cookies, Socket.IO realtime, PWA SW. Untouched by desktop work.
- **desktop mode**: served by Tauri WebView2 from `tauri://localhost`, talks to a remote Frappe Cloud site over HTTPS via `@tauri-apps/plugin-http` (Rust HTTP, **bypasses browser CORS**). Auth is API key + secret stored in Stronghold. Service worker, Socket.IO, and CSRF are no-ops in desktop mode.

The single source of truth for "which mode am I in?" is [POS/src/utils/runtimeConfig.js](../../../POS/src/utils/runtimeConfig.js). Every code path that needs to behave differently reads from there.

Per-customer builds use [desktop/customers/<slug>.json](../../../desktop/customers/) (gitignored, except `_template.json`) to bake the customer's Frappe Cloud URL + branding into the installer.

## Trigger triage — what is the user actually asking for?

Before writing code, classify the request:

| Phrase pattern | Action |
|----------------|--------|
| "build the exe", "package for windows", "ship to acme" | → [Trigger a build](#trigger-a-build) |
| "add a new customer", "set up acme", "onboard rpos15" | → [Onboard a new customer](#onboard-a-new-customer) |
| "tauri build failed", "exe won't open", "login spins forever" | → [Debug a build or runtime issue](#debug-a-build-or-runtime-issue) |
| "turn on auto-update", "publish a new release", "push update to tills" | → [Auto-update workflow](#auto-update-workflow) |
| "modify the desktop login screen", "change how the offline worker fetches" | → Standard code change, but read [desktop/INSTALL.md](../../../desktop/INSTALL.md) first to understand the runtime split |
| "should we use Electron instead" | → No. Architecture is settled. Refer them to the trade-off summary in this file. |

## Onboard a new customer

1. Confirm the customer's Frappe Cloud URL with the user (must be `https://...`).
2. Pick a slug — lowercase, no spaces, ideally matching a meaningful name (subdomain, customer short name).
3. Copy `desktop/customers/_template.json` to `desktop/customers/<slug>.json` and edit:
   - `slug`, `productName`, `identifier` (must be **unique** per customer — Windows uses it as a registry key), `version`, `siteUrl`, `displayName`.
   - Leave `updater.active: false` for the first release.
4. **Never** put the real customer URL in `_template.json` — that file is the only customer file in git and would leak the URL to the repo. The runtime config files (`<slug>.json`) are gitignored deliberately.
5. (Optional) Add icons under `desktop/assets/customers/<slug>/icons/` and point `iconDir` at it.
6. Tell the user the next step is one of the [Trigger a build](#trigger-a-build) options.

## Trigger a build

Three paths. Match the path to the user's environment:

### Path A — GitHub Actions (recommended, works from any OS)

The workflow lives at [.github/workflows/desktop-build.yml](../../../.github/workflows/desktop-build.yml).

1. **One-time per customer**: a repo secret named `CUSTOMER_CONFIG_<SLUG_UPPER>` with the entire JSON contents of `desktop/customers/<slug>.json`. Hyphens in the slug become underscores in the secret name. Without this secret the workflow errors immediately.
2. **Trigger**:
   - Manual: Actions tab → "Build desktop installer" → Run workflow → enter slug.
   - Tag-driven: `git tag desktop-v<version>-<slug> && git push --tags` → builds + drafts a GitHub Release.
3. The `.exe` lands as a workflow artifact named `pos-next-<slug>-<version>` (or attached to the draft Release on tag pushes). `windows-latest` runners take ~5 min.

### Path B — Local build on Windows

```bash
# Prerequisites: Rust 1.77+, VS Build Tools 2022 with C++ workload
cd POS && yarn install && cd ..
cd desktop && yarn install && cd ..
yarn desktop:build <slug>
```

Output lands at `desktop/src-tauri/target/release/bundle/nsis/<productName>_<version>_x64-setup.exe`.

### Path C — Local build on Linux/macOS

**You cannot produce a Windows `.exe` from Linux/macOS directly.** Tauri's docs say cross-compilation is possible via `cargo-xwin`, but it's fragile with plugins. Don't recommend it for production POS. Tell the user to use Path A or Path B.

You CAN run `yarn desktop:dev <slug>` on Linux — it opens a Linux GTK WebKit window pointed at the customer's site. Useful for testing the Vue code + offline behaviour, but the final QA must happen on Windows because WebView2's CSS/font rendering differs slightly.

## Debug a build or runtime issue

Read [desktop/INSTALL.md section F](../../../desktop/INSTALL.md) first — it lists the common ones with fixes. Beyond that:

### Build-time failures

- **`Failed to resolve import "@tauri-apps/plugin-http"`**: deps not installed. Run `cd POS && yarn install`.
- **Rust compile errors mentioning `tauri_plugin_*`**: Cargo.toml versions out of sync with the JS plugin versions. Bump both halves together to the latest 2.x.
- **`No bundle output at desktop/src-tauri/target/release/bundle`**: WebView2 SDK / VS C++ tools missing. On Windows: re-run the VS installer. In CI: the `windows-latest` runner has them; check the Setup Rust toolchain step succeeded.
- **`No secret named CUSTOMER_CONFIG_<...>`** in CI: the user forgot to add the repo secret. Tell them which secret name is missing.

### Runtime failures (post-install)

- **Login spinning forever**: open Tauri devtools (F12) → Network. Check if `/api/method/login` request appears.
  - No request = HTTP plugin allowlist doesn't include the customer's domain. Edit [desktop/src-tauri/capabilities/default.json](../../../desktop/src-tauri/capabilities/default.json), add the URL pattern, rebuild.
  - 401 = wrong credentials.
  - 200 but app stays on login = `generate_keys` failed. Check the Frappe user has API access (POSNext Cashier role provides this).
- **Queue not draining after reconnect**: open the offline dialog → check per-invoice errors. Customer queue must drain before invoices (this is automatic in `posSync.syncPending`). If a customer create failed, all invoices that reference it will fail too.
- **Stale credentials after server-side rotation**: Stronghold has the old key. User clicks Logout → re-logs in → fresh keys.

### Files most likely to need touching

| Symptom | File |
|---------|------|
| Wrong base URL / auth header logic | [POS/src/utils/runtimeConfig.js](../../../POS/src/utils/runtimeConfig.js) |
| Login flow / Stronghold storage | [POS/src/utils/desktopAuth.js](../../../POS/src/utils/desktopAuth.js), [POS/src/pages/Login.vue](../../../POS/src/pages/Login.vue) |
| API request shape / error handling | [POS/src/utils/desktopTransport.js](../../../POS/src/utils/desktopTransport.js) |
| Worker-side fetches (stock sync, ping) | [POS/src/workers/offline.worker.js](../../../POS/src/workers/offline.worker.js) (search for `apiUrl(` / `buildAuthHeaders`) |
| Tauri config (window size, plugins, allowlist) | [desktop/src-tauri/tauri.conf.json](../../../desktop/src-tauri/tauri.conf.json), [capabilities/default.json](../../../desktop/src-tauri/capabilities/default.json) |
| Build script | [desktop/scripts/build-customer.mjs](../../../desktop/scripts/build-customer.mjs) |

## Auto-update workflow

Off by default (`updater.active: false` in customer configs). To enable:

1. `cd desktop && yarn tauri signer generate -w keys/<slug>.key` — produces `<slug>.key` (private, **never commit**, gitignored already) and `<slug>.key.pub`.
2. Edit the customer config: `updater.active: true`, `endpoint` to the URL where you'll host `latest.json`, `pubkey` to the `.pub` contents.
3. After each build: `yarn desktop:publish <slug>` signs the `.exe` and writes `latest.json`. Upload both files to the configured endpoint.
4. The desktop app polls `latest.json` on boot + every 6 hours via [POS/src/composables/useDesktopUpdate.js](../../../POS/src/composables/useDesktopUpdate.js).

For CI-driven updates, the workflow already accepts `CUSTOMER_UPDATER_KEY_<SLUG_UPPER>` and `CUSTOMER_UPDATER_KEY_PWD_<SLUG_UPPER>` secrets.

## Things NEVER to do

- **Don't put real customer URLs in `desktop/customers/_template.json`** — it's the only customer file in git.
- **Don't commit `desktop/keys/`** — gitignored, but check `git status` before pushing if you've been generating signing keys.
- **Don't run `git add -A` from the repo root** when working on desktop/. Use specific paths to avoid accidentally staging `desktop/dist-frontend/` (large) or a forgotten `desktop/customers/<slug>.json`.
- **Don't change the runtime branching strategy** without updating the test stubs in [POS/tests/stubs/](../../../POS/tests/stubs/) and the vitest config aliases.
- **Don't add Socket.IO or CSRF to the desktop path** — they require cookies + CORS we deliberately avoid. If realtime is critical, add a Rust-side socket relay; don't try to make browser Socket.IO work cross-origin.
- **Don't recommend Electron** as an alternative. The architecture is settled; switching would discard the entire offline subsystem's compatibility.

## Quick verification commands

After any desktop-relevant change:

```bash
# Frontend tests (must stay 43/43 green)
cd POS && yarn test:run --pool=forks --poolOptions.forks.singleFork

# Lint only the files you touched (repo-wide lint has pre-existing issues)
cd POS && npx biome check src/utils/runtimeConfig.js src/utils/desktopTransport.js src/utils/desktopAuth.js <other_changed_files>

# YAML sanity for the workflow
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/desktop-build.yml'))"
```
