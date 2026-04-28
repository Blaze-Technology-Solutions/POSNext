# Offline Recovery & Audit Roadmap

Status: partially implemented. The local journal and export MVP are working;
the desktop disk mirror, Frappe validation backend/page, and replay workflow
are still pending.

This roadmap defines the next offline durability layer for POS Next. The goal
is simple: every POS transaction should leave a local audit trail, including
offline sales, online successful sales, payments, customer creates, sync
attempts, and final server acknowledgements. If a terminal is damaged, cleared,
or sync is suspected to be incomplete, support should be able to upload a
recovery file into a Frappe custom page and identify missing invoices,
payments, customers, or mismatched totals.

## Problem Statement

Today POS Next already stores pending offline invoices in IndexedDB
(`invoice_queue`) and can mirror pending invoices to JSON files through QZ Tray.
That protects the queue, but it does not yet give us a complete business audit
file for:

- Transactions created online and submitted successfully.
- Offline invoices that later synced successfully.
- Payment rows and payment reconciliation evidence.
- Failed or interrupted sync attempts.
- A one-file support workflow that can be uploaded into Frappe for validation.

The new system should preserve both pending and successful records so we can
answer: "What did this POS terminal believe happened, and what reached
Frappe/ERPNext?"

## Target Outcome

Build a POS recovery package system with these capabilities:

- Record every important POS write action in an append-only local journal.
- Keep successful online and offline records after server submission.
- Export one signed recovery package from the desktop app.
- Upload that package to a Frappe custom page.
- Validate each local record against ERPNext documents and sync tracker records.
- Show missing invoices, missing payments, duplicate offline IDs, mismatched
  totals, and records safe to replay.
- Optionally replay only validated missing records through idempotent APIs.

## v1 Scope (Reviewer Recommendation)

The full roadmap below is the long-term target. To keep the first release
shippable and low-risk, v1 should be **validation-only** and explicitly
exclude replay. Concretely:

- **In v1:** Phases 1, 2 (Tauri writer first, QZ as compatibility mirror only),
  3 (export), 4 (validation API + `Recovery Session` DocType), 5 (Desk page,
  view-only).
- **Out of v1:** Phase 6 (replay). Hash metadata is already present in the
  local journal/export, but server-side hash-chain validation can remain
  warning-only until there is a real non-repudiation requirement.
- **Default package boundary:** one package per shift, with custom date range
  as an explicit override. Shifts already exist as a unit cashiers reason
  about and bound package size predictably.
- **Replay path when Phase 6 lands:** reuse the existing idempotent endpoints
  in [pos_next/api/invoices.py](../pos_next/api/invoices.py) and
  `replay_offline_customer` in
  [pos_next/api/customers.py](../pos_next/api/customers.py). Do **not** build
  parallel `replay_missing_*` APIs.

This boundary is what unlocks "ship in a quarter": append journal → disk
mirror → export shift package → upload → read report. Replay can follow
once the report is trusted in production.

## Current Implementation Status

Checked against the codebase on 2026-04-28.

| Area | Status | Notes |
| --- | --- | --- |
| IndexedDB journal table | Done | `recovery_journal` exists in `POS/src/utils/offline/db.js`. |
| Journal helper | Done | `recoveryJournal.js` appends redacted events and builds export packages. |
| Terminal ID | Partial | Stable ID exists in IndexedDB settings; Stronghold/app-data lifecycle is not done. |
| Offline invoice events | Partial | Create, queue, sync attempt, success, duplicate success, and failure are covered. Delete/abandoned lifecycle is not covered. |
| Online invoice/payment events | Partial | Sales Invoice submit and embedded POS payment evidence are covered. Standalone Payment Entry, wallet, loyalty, and partial-payment recovery are not covered. |
| Customer/shift events | Pending | `customer_created_offline`, `customer_sync_success`, `shift_opened`, and `shift_closed` are not journaled yet. |
| Recovery export | Done | Export includes manifest, journal JSONL, pending queues, summary, and hash metadata. |
| Export UI | Done | Offline Invoices dialog has an "Export Recovery" button. |
| Signed package | Pending | Export currently records `signed: false`; minisign/server verification is not implemented. |
| Desktop JSONL disk mirror | Pending | No Tauri app-data writer or recovery JSONL mirror exists yet. |
| Frappe validation backend | Pending | No `pos_next.api.offline_recovery` or Recovery Session DocType exists yet. |
| Frappe upload page | Pending | No `pos-offline-recovery` Desk page exists yet. |
| Controlled replay | Pending | Intentionally post-v1; should reuse existing idempotent endpoints when added. |
| Support workflow docs | Pending | Roadmap exists, but operator/support runbook is not written. |

## Proposed Architecture

```
POS action
   |
   v
Append-only local audit journal
   |
   +--> IndexedDB recovery_journal table
   |
   +--> Desktop disk mirror JSONL files
   |
   v
Recovery export package (.posrecovery.json or .zip)
   |
   v
Frappe custom page upload
   |
   v
Validation report + optional controlled replay
```

## Local Data To Store

Add a new append-only journal separate from `invoice_queue`. The queue remains
the operational sync queue. The journal becomes the permanent local audit trail.

### Journal Record Types

| Type | When written | Purpose |
| --- | --- | --- |
| `invoice_created` | Before local save or online submit | Captures the full invoice intent. |
| `invoice_queued` | After offline queue write succeeds | Proves the invoice was stored locally. |
| `invoice_submit_attempt` | Before every server submit call | Tracks retry history. |
| `invoice_submit_success` | After server returns invoice name | Links local record to Sales Invoice. |
| `invoice_submit_failure` | After failed submit | Stores error code/message safely. |
| `payment_created` | When payment payload is finalized | Captures payment split and modes. |
| `payment_submit_success` | After server confirms payment | Links payment evidence to server docs. |
| `customer_created_offline` | When customer is created offline | Tracks placeholder to real customer mapping. |
| `customer_sync_success` | After replay succeeds | Links placeholder to real Customer. |
| `shift_opened` | After opening shift is loaded/created | Scopes transactions to a register session. |
| `shift_closed` | After close shift succeeds | Captures expected totals and closure state. |
| `sync_checkpoint` | At sync start/end | Gives support a timeline of sync status. Include a `network_state` snapshot so a 2-hour gap is distinguishable from "offline" vs. "idle". |
| `invoice_abandoned` | After N failed retries or manual delete | Terminal state so validation can separate "still in flight" from "client gave up". |
| `export_created` | When package is exported | Audits recovery package creation. |

### Required Fields

Every journal row should include:

- `event_id`: UUID.
- `terminal_id`: stable desktop installation ID.
- `site_url`: target Frappe site.
- `pos_profile`, `company`, `warehouse`, `cashier`.
- `pos_opening_shift`, if available.
- `offline_id`, when related to an offline-created object.
- `server_docname`, when known.
- `doctype`: `Sales Invoice`, `Payment Entry`, `Customer`, or tracker doctype.
- `event_type`.
- `event_time`.
- `payload`: sanitized business payload needed for recovery.
- `payload_hash`: SHA-256 of canonical payload JSON.
- `previous_hash`: previous journal record hash for tamper evidence. **Deferred
  past v1** — concurrent appends from main thread + offline worker would need a
  global lock (e.g. routed through `createAsyncQueue`) or the chain breaks.
- `record_hash`: hash of the full canonical journal row. **Deferred past v1**
  for the same reason as `previous_hash`.
- `schema_version`.
- `app_version`, `build_version`: stamped per event, not just in the manifest,
  so a package that spans a mid-day update can still be parsed with the
  per-event rules.

### Payload Rules

- Store enough data to recreate or validate the transaction.
- Redact secrets, API keys, cookies, and Stronghold data.
- Do not store raw card data. Only store payment mode, amount, reference number,
  and safe gateway/reference metadata already allowed in ERPNext.
- Store both local totals and server totals when available.
- Preserve tax rows, item rows, discounts, loyalty/wallet fields, write-off, and
  payment split.

## Disk Storage Strategy

Use two layers:

1. IndexedDB table `recovery_journal` for fast app reads and UI status.
2. Desktop disk mirror using JSONL files for disaster recovery.

Suggested disk path:

`%APPDATA%\QZ\sandbox\tauri-localhost\pos_next\recovery_journal\YYYY-MM-DD.jsonl`

Each line is one complete journal event. JSONL is better than one giant JSON
file because appending is simple, partial writes are easier to detect, and a
large store can be streamed during upload.

If we want this to work without QZ Tray, add a Tauri command later to write to
the app data directory directly:

`%APPDATA%\com.blazetech.posnext.<slug>\recovery\YYYY-MM-DD.jsonl`

My recommendation is to implement the Tauri writer for desktop and keep QZ as a
secondary compatibility mirror. That gives us durability even when QZ is not
running.

### Retention And Rotation

Append-only without a ceiling is unbounded growth. v1 policy:

- Keep journal events for **90 days after** the corresponding
  `invoice_submit_success` (or `invoice_abandoned`).
- Older days roll up into a single compressed `YYYY-MM.jsonl.gz` archive.
- Hard-cap total recovery disk footprint at ~500 MB; on overflow, evict
  oldest archives first.
- Retention is enforced both in IndexedDB and in the disk mirror so a wipe
  + restore lands in the same state.

## Recovery Export Package

The desktop app should provide an "Export Recovery File" action. It should
create either a single JSON file or a ZIP package.

Recommended package structure:

```
pos-next-recovery-<terminal_id>-<from>-<to>.zip
  manifest.json
  journal.jsonl
  pending_invoice_queue.json
  pending_customer_queue.json
  local_summary.json
  signatures.json
```

### `manifest.json`

Contains:

- `package_version`.
- `created_at`.
- `terminal_id`.
- `site_url`.
- `company`.
- `pos_profiles`.
- `cashiers`.
- `date_range`.
- `event_count`.
- `first_event_hash`.
- `last_event_hash`.
- `journal_sha256`.
- App version and build version.

### `local_summary.json`

Contains cashier-friendly totals:

- Invoice count.
- Return count.
- Gross total.
- Net total.
- Tax total.
- Discount total.
- Payment totals by mode.
- Synced count.
- Pending count.
- Failed count.
- Date/time range.

## Frappe Custom Page

Create a Frappe Desk page such as:

`pos-offline-recovery`

The page should support:

- Upload recovery package.
- Parse and validate client-side enough to show basic metadata quickly.
- Submit package to a server method for authoritative validation.
- Display validation report grouped by severity.
- Download report as CSV/Excel/PDF.
- Optionally create a Recovery Session DocType to store the uploaded package
  metadata and validation results.

## Backend Validation

Add backend APIs under a new module, for example:

`pos_next.api.offline_recovery`

Proposed methods:

- `validate_recovery_package(file_url_or_content)`
- `get_recovery_session(session_name)`
- `replay_missing_invoice(session_name, event_id)`
- `replay_missing_payment(session_name, event_id)`
- `mark_recovery_row_reviewed(session_name, event_id, note)`

### Validation Checks

For each local invoice/payment event:

- Check `offline_id` in `Offline Invoice Sync`.
- Check `server_docname` exists in ERPNext.
- Check `Sales Invoice` totals match local payload.
- Check payment rows/modes/amounts match submitted invoice.
- Check `Payment Entry` or POS invoice payment child rows where applicable.
- Check customer placeholder mappings.
- Check returns are linked to the correct original invoice.
- Check duplicate `offline_id` values inside the uploaded package.
- Check duplicate payload hashes with different offline IDs.
- Check hash chain continuity.
- Check journal date range against POS opening shifts.

### Report Statuses

| Status | Meaning | Action |
| --- | --- | --- |
| `matched` | Local record exists on server and totals match. | No action. |
| `missing_invoice` | Local invoice has no server match. | Review and optionally replay. |
| `missing_payment` | Invoice exists but payment evidence is missing/mismatched. | Review payment recovery. |
| `amount_mismatch` | Server and local totals differ. | Manual investigation. |
| `duplicate_local` | Same local transaction appears more than once. | Block replay until resolved. |
| `duplicate_server` | Server has more than one match. | Manual investigation. |
| `invalid_hash_chain` | Journal tamper/corruption risk. | Manual investigation. |
| `unsafe_to_replay` | Payload cannot be replayed confidently. | Manual entry only. |

## Replay Policy

Replay must be conservative. The upload page should validate first and replay
only records that are safe.

Safe replay requirements:

- Valid hash chain or explicitly accepted partial journal.
- Valid `offline_id`.
- No matching `Offline Invoice Sync` row.
- No matching `Sales Invoice` by offline ID, payload hash, customer/date/total,
  or POS profile/time window.
- Customer exists or customer recovery mapping is resolved.
- Shift/profile/company are valid.
- Payment modes are still valid for the POS profile.

Replay APIs must be idempotent. If the same recovery event is replayed twice,
the second attempt should return the existing server record instead of creating
a duplicate.

## UI Requirements

### Desktop POS

Add a small recovery/audit area to the offline or diagnostics UI:

- Journal health: active, degraded, disk mirror unavailable.
- Last local audit event time.
- Unsynced invoice count.
- Successful records retained count.
- Export recovery file button.
- Restore/import local disk journal button if IndexedDB was cleared.
- Warning if disk mirror is unavailable.

### Frappe Page

Show:

- Package metadata.
- Terminal, cashier, POS profile, date range.
- Summary totals.
- Validation progress.
- Findings table with filters by status.
- Row detail drawer with local payload, server match, and differences.
- Action buttons only for safe replay rows.

## Implementation Phases

### Phase 1: Local Journal Foundation

- Add `recovery_journal` IndexedDB table. **Done**
- Create `recoveryJournal.js` helper with append-only writes. **Done**
- Generate or load stable `terminal_id`. **Partial** — currently stored in
  IndexedDB settings; Stronghold/app-data lifecycle still pending.
- Write journal events for invoice creation, queue save, submit success/failure,
  and payment payload creation. **Partial** — core invoice/POS payment paths
  are covered; customer, shift, abandoned/delete, and standalone payment flows
  are pending.
- Add unit tests for canonical JSON hashing and append behavior. **Done**

### Phase 2: Desktop Disk Mirror

- Add Tauri file writer for recovery JSONL files, or extend existing disk mirror.
  **Pending**
- Append journal rows to daily JSONL files. **Pending**
- Add startup repair that can read disk JSONL and refill missing IndexedDB rows.
  **Pending**
- Add health indicator if disk writes fail. **Pending**

### Phase 3: Export Package

- Build export function that collects journal rows and pending queues. **Done**
- Generate manifest and local summary. **Done**
- Add "Export Recovery File" button in diagnostics/offline UI. **Done**
- Add tests for export shape and totals. **Done**
- Sign recovery package and verify signature server-side. **Pending**

### Phase 4: Frappe Recovery Backend

- Add Recovery Session DocType. **Pending**
- Add whitelisted validation API. **Pending**
- Parse package safely with size limits. **Pending**
- Validate hash chain/payload hashes and compare records against ERPNext.
  **Pending**
- Store validation results for review. **Pending**

### Phase 5: Frappe Custom Page

- Add Desk page for upload and report display. **Pending**
- Add filters, detail view, and report download. **Pending**
- Add role permissions for upload, validate, replay, and approve. **Pending**

### Phase 6: Controlled Replay (post-v1)

- **Reuse existing idempotent endpoints** instead of building parallel APIs:
  the offline submit path in [pos_next/api/invoices.py](../pos_next/api/invoices.py)
  already keys on `offline_id` via `Offline Invoice Sync`, and
  `replay_offline_customer` in
  [pos_next/api/customers.py](../pos_next/api/customers.py) is already
  idempotent. The recovery page should call those, not new methods.
- Add approval step before replay. **Pending**
- Write replay results back to Recovery Session. **Pending**
- Add audit comments and links to created server documents. **Pending**

### Phase 7: Operations & Monitoring

- Add docs for support workflow. **Pending**
- Add log export shortcut. **Pending**
- Add automated test scenario: offline sale, sync interrupted, recovery upload,
  missing invoice detected, safe replay succeeds. **Pending**
- Add periodic reminder if journal disk mirror is unhealthy. **Pending**

## Security And Permissions

- Recovery upload page should be restricted to System Manager or a new
  `POS Offline Recovery Manager` role.
- Recovery package should never include API secret, password, cookies, or
  Stronghold vault content.
- Uploaded packages should be stored as private files.
- Replay should require explicit approval and should log who replayed what.
- Large packages should be streamed or size-limited to prevent memory issues.
- Hashes are for tamper evidence, not full legal non-repudiation. If stronger
  proof is needed, add device signing keys later.
- **Sign the recovery package, do not encrypt it.** Reuse the per-customer
  minisign keypair already minted for the auto-updater (see
  [.github/workflows/desktop-build.yml](../.github/workflows/desktop-build.yml))
  or a sibling key. Verify the signature server-side on upload. Encryption is
  the wrong choice — support needs to read these files; signing gives us
  cheap non-repudiation without locking ourselves out.
- **Reject cross-site uploads.** A package created on site A must only be
  accepted on site A. Cross-site recovery is a migration tool, not a recovery
  tool, and accepting it leaks data across tenants.

## My Recommendations

1. Keep `invoice_queue` only for pending sync. Do not overload it into a full
   audit system.
2. Add a separate append-only `recovery_journal` so successful records are kept
   even after queue cleanup.
3. Store local successful online invoices too. Many real incidents happen when
   the cashier believes a transaction succeeded but the server state later
   differs.
4. Use JSONL for disk storage and export. It is easier to append, stream, repair,
   and inspect than one large mutable JSON blob.
5. Add a Tauri-native disk writer for desktop. QZ is useful, but recovery data
   is too important to depend only on the print helper being available.
6. Make replay optional and heavily guarded. The first version can be validation
   only; replay can come after we trust the report.
7. Store payment evidence in the journal even if payments are embedded in POS
   invoices. Recovery must answer both "invoice missing?" and "money missing?"
8. Add terminal ID and hash chain from day one. It will save support time when
   multiple counters upload recovery files for the same day.
9. Keep exports human-inspectable. Support teams should be able to open the
   manifest and summary without special tooling.

## Approval Checklist

Reviewer-recommended answers in **bold**; flip them only with explicit reason.

- Should the first implementation be validation-only, or include replay?
  → **Validation-only.**
- Should the desktop disk writer use Tauri app data first, QZ second?
  → **Yes.** QZ is a print helper; recovery durability is too important to
  ride on it.
- How long should successful journal records be retained locally?
  → **90 days after submit success**, then monthly compressed archives, with
  a ~500 MB hard cap and oldest-first eviction.
- Which roles can upload recovery files and replay missing transactions?
  → New role **`POS Offline Recovery Manager`** for upload + view; replay
  (when Phase 6 lands) gated on **`System Manager`** plus the Recovery
  Manager role.
- Should recovery packages be encrypted, or is private Frappe file storage
  enough for the first version?
  → **Don't encrypt. Sign** with the per-install minisign key reused from
  the updater. Private files are fine for confidentiality at rest.
- Which payment flows must be included first: POS invoice payments only,
  standalone Payment Entry, wallet, loyalty, partial payments, or all?
  → **POS-invoice-embedded payments only in v1.** Standalone Payment Entry,
  wallet, loyalty, partial payments are Phase 4.5.

## Open Questions

Reviewer-recommended answers in **bold**.

- Do we need one recovery package per shift, per day, or custom date range?
  → **Per shift by default**, custom range as an explicit override. Cashiers
  reason in shifts, and shift-bounded packages are predictable in size.
- Should shift close be blocked if journal disk writes are failing?
  → **No.** Loud warning + telemetry, never block. A failed close strands
  the cashier and is worse than degraded recovery coverage.
- Should the upload page compare against GL Entry and Stock Ledger Entry too,
  or only Sales Invoice/payment records in version one?
  → **Only Sales Invoice + payment child rows in v1.** GL/SLE adds noise and
  surface area without finding meaningfully more issues.
- Should a recovery upload be allowed on a different site URL from the one in
  the package, for migrations or disaster recovery?
  → **No.** Recovery is per-site. Cross-site is a migration tool, scope it
  separately if it ever comes up.
- Do we need automatic scheduled export to a folder or USB path?
  → **Not in v1.** Add only on concrete customer ask.

## Reviewer Notes (2026-04-28)

Captured from the v1-scope review so future readers see the rationale, not
just the cuts:

1. **Hash chain caution.** `previous_hash` / `record_hash` are implemented in
   the current main-thread journal helper. If future work appends directly from
   the offline worker
   ([POS/src/workers/offline.worker.js](../POS/src/workers/offline.worker.js)),
   route every append through one `createAsyncQueue`; otherwise two concurrent
   appends can produce siblings with the same `previous_hash` and validation
   will spuriously flag `invalid_hash_chain`.
2. **Reuse, don't fork, replay APIs.** Calling
   `Offline Invoice Sync` / `replay_offline_customer` from the recovery page
   means existing offline-replay tests cover recovery replay too.
3. **Terminal id lifecycle.** Tie `terminal_id` to Tauri Stronghold (so it
   survives app reinstall, not OS wipe) plus a human-set "Terminal Label"
   stored on the POS Profile. Support correlates "PC-RECEPTION-2" across
   re-issued ids using the label.
4. **Recovery Session DocType shape.** Parent `Recovery Session` + child
   table `Recovery Session Finding` with fields: `status`, `severity`,
   `event_id`, `doctype`, `server_docname`, `payload_hash`, `local_total`,
   `server_total`, `note`. Lets the Frappe page be a plain list view + child
   grid — no custom HTML.
5. **Per-event app/build version.** A package can span a mid-day update; per
   event versioning lets old payloads be parsed under their original rules.
6. **`invoice_abandoned` lifecycle event.** Today the queue implicitly
   distinguishes "still retrying" from "given up after N retries." Make it
   explicit so validation can tell "missing because in flight" from "missing
   because client gave up."
7. **Sign, don't encrypt.** Reuse the per-customer minisign keypair from the
   updater pipeline.
8. **Backend validation must be async.** A 10k-event upload should be
   accepted, queued, and validated in a background job; the upload UI polls
   the `Recovery Session` for status. Synchronous validation will time out
   on real shift packages.

## Definition Of Done

This roadmap is complete when:

- Every invoice/payment action writes a journal event.
- Successful records remain recoverable after normal sync cleanup.
- Desktop can export one recovery package.
- Frappe can upload the package and produce a missing/mismatched transaction
  report.
- Safe missing records can either be replayed idempotently or clearly marked
  for manual entry.
- Support documentation explains exactly how to recover after machine trouble.
