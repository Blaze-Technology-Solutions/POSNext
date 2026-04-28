import { logger } from "../logger"
import { db } from "./db"

const log = logger.create("RecoveryJournal")

const JOURNAL_SCHEMA_VERSION = 1
const TERMINAL_ID_KEY = "recovery_terminal_id"
const REDACTED = "[REDACTED]"
const SENSITIVE_KEY_PATTERN =
	/(api[_-]?secret|authorization|cookie|csrf|password|passwd|secret|token)/i

function safeClone(value) {
	if (value === undefined) return null
	try {
		return JSON.parse(JSON.stringify(value))
	} catch (error) {
		return { unserializable: true, value: String(value) }
	}
}

function redactSensitive(value) {
	if (Array.isArray(value)) {
		return value.map((item) => redactSensitive(item))
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactSensitive(item),
			]),
		)
	}
	return value
}

function canonicalize(value) {
	if (Array.isArray(value)) {
		return value.map((item) => canonicalize(item))
	}
	if (value && typeof value === "object") {
		return Object.keys(value)
			.sort()
			.reduce((result, key) => {
				const item = value[key]
				if (item !== undefined) {
					result[key] = canonicalize(item)
				}
				return result
			}, {})
	}
	return value
}

export function canonicalJson(value) {
	return JSON.stringify(canonicalize(value))
}

async function sha256(value) {
	const data = new TextEncoder().encode(
		typeof value === "string" ? value : canonicalJson(value),
	)
	const digest = await globalThis.crypto.subtle.digest("SHA-256", data)
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")
}

function generateId(prefix) {
	if (globalThis.crypto?.randomUUID) {
		return `${prefix}_${globalThis.crypto.randomUUID()}`
	}
	return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

export async function getTerminalId() {
	const existing = await db.settings.get(TERMINAL_ID_KEY)
	if (existing?.value) return existing.value

	const terminalId = generateId("terminal")
	await db.settings.put({
		key: TERMINAL_ID_KEY,
		value: terminalId,
		created_at: Date.now(),
	})
	return terminalId
}

// Module-level promise chain — every appendRecoveryEvent call awaits the
// previous one before reading the previous_hash and adding the new row.
// This is the only thing that keeps the hash chain consistent: a Dexie
// transaction wouldn't help here because SHA-256 is a non-Dexie await,
// and Dexie auto-commits the transaction at the next non-Dexie boundary.
// All journal writes must originate from the main thread (the offline
// worker has its own Dexie connection and is not allowed to journal).
let _writeChain = Promise.resolve()

export async function appendRecoveryEvent(event) {
	const next = _writeChain.then(() => doAppendRecoveryEvent(event))
	// Swallow rejections on the chain so one failed append doesn't poison
	// every subsequent call — the original promise we return still rejects.
	_writeChain = next.catch(() => {})
	return next
}

async function doAppendRecoveryEvent(event) {
	const payload = redactSensitive(safeClone(event.payload || {}))
	const terminalId = event.terminal_id || (await getTerminalId())
	const eventTime = event.event_time || new Date().toISOString()
	const payloadHash = await sha256(payload)
	const last = await db.recovery_journal.orderBy("id").last()
	const previousHash = last?.record_hash || null

	const rowWithoutHash = {
		event_id: event.event_id || generateId("event"),
		event_type: event.event_type,
		event_time: eventTime,
		terminal_id: terminalId,
		site_url: event.site_url || globalThis.location?.origin || null,
		pos_profile: event.pos_profile || payload.pos_profile || null,
		company: event.company || payload.company || null,
		warehouse: event.warehouse || payload.warehouse || null,
		cashier: event.cashier || globalThis.frappe?.session?.user || null,
		pos_opening_shift:
			event.pos_opening_shift || payload.posa_pos_opening_shift || null,
		offline_id: event.offline_id || payload.offline_id || null,
		server_docname: event.server_docname || null,
		doctype: event.doctype || payload.doctype || "Sales Invoice",
		payload,
		payload_hash: payloadHash,
		previous_hash: previousHash,
		schema_version: JOURNAL_SCHEMA_VERSION,
	}

	const recordHash = await sha256(rowWithoutHash)
	const id = await db.recovery_journal.add({
		...rowWithoutHash,
		record_hash: recordHash,
	})

	return { id, ...rowWithoutHash, record_hash: recordHash }
}

export async function safeAppendRecoveryEvent(event) {
	try {
		return await appendRecoveryEvent(event)
	} catch (error) {
		log.warn("Failed to append recovery event", {
			event_type: event?.event_type,
			error: error?.message || error,
		})
		return null
	}
}

function inRange(row, { from = null, to = null } = {}) {
	if (from && row.event_time < from) return false
	if (to && row.event_time > to) return false
	return true
}

function sumPayments(rows) {
	const totals = {}
	for (const row of rows) {
		const payments = Array.isArray(row.payload?.payments)
			? row.payload.payments
			: []
		for (const payment of payments) {
			const mode = payment.mode_of_payment || "Unknown"
			totals[mode] = Number(
				((totals[mode] || 0) + Number(payment.amount || 0)).toFixed(6),
			)
		}
	}
	return totals
}

function buildLocalSummary(journalRows, pendingInvoices, pendingCustomers) {
	const invoiceCreatedRows = journalRows.filter(
		(row) => row.event_type === "invoice_created",
	)
	const submitSuccessRows = journalRows.filter(
		(row) => row.event_type === "invoice_submit_success",
	)
	const submitFailureRows = journalRows.filter(
		(row) => row.event_type === "invoice_submit_failure",
	)

	return {
		invoice_count: invoiceCreatedRows.length,
		synced_count: submitSuccessRows.length,
		failed_count: submitFailureRows.length,
		pending_invoice_count: pendingInvoices.length,
		pending_customer_count: pendingCustomers.length,
		gross_total: Number(
			invoiceCreatedRows
				.reduce(
					(sum, row) =>
						sum +
						Number(row.payload?.grand_total || row.payload?.rounded_total || 0),
					0,
				)
				.toFixed(6),
		),
		payment_totals_by_mode: sumPayments(invoiceCreatedRows),
		first_event_time: journalRows[0]?.event_time || null,
		last_event_time: journalRows.at(-1)?.event_time || null,
	}
}

export async function getRecoveryJournalRows(options = {}) {
	const rows = await db.recovery_journal.orderBy("id").toArray()
	return rows.filter((row) => inRange(row, options))
}

export async function buildRecoveryPackage(options = {}) {
	const journalRows = await getRecoveryJournalRows(options)
	const pendingInvoices = await db.invoice_queue
		.filter((invoice) => !invoice.synced && !invoice.superseded)
		.toArray()
	const pendingCustomers = await db.customer_queue
		.filter((customer) => !customer.synced)
		.toArray()
	const terminalId = await getTerminalId()
	const journalJsonl = journalRows.map((row) => canonicalJson(row)).join("\n")
	const journalSha256 = await sha256(journalJsonl)
	const createdAt = new Date().toISOString()

	return {
		manifest: {
			package_version: 1,
			created_at: createdAt,
			terminal_id: terminalId,
			site_url: globalThis.location?.origin || null,
			date_range: {
				from: options.from || null,
				to: options.to || null,
			},
			event_count: journalRows.length,
			first_event_hash: journalRows[0]?.record_hash || null,
			last_event_hash: journalRows.at(-1)?.record_hash || null,
			journal_sha256: journalSha256,
			app_version: globalThis.__BUILD_VERSION__ || null,
		},
		journal: journalRows,
		journal_jsonl: journalJsonl,
		pending_invoice_queue: pendingInvoices,
		pending_customer_queue: pendingCustomers,
		local_summary: buildLocalSummary(
			journalRows,
			pendingInvoices,
			pendingCustomers,
		),
		signatures: {
			hash_algorithm: "SHA-256",
			signed: false,
		},
	}
}

export async function downloadRecoveryPackage(options = {}) {
	const recoveryPackage = await buildRecoveryPackage(options)
	const filename = `pos-next-recovery-${recoveryPackage.manifest.terminal_id}-${recoveryPackage.manifest.created_at.slice(0, 10)}.json`
	const blob = new Blob([JSON.stringify(recoveryPackage, null, 2)], {
		type: "application/json",
	})
	const url = URL.createObjectURL(blob)
	const link = document.createElement("a")
	link.href = url
	link.download = filename
	document.body.appendChild(link)
	link.click()
	link.remove()
	URL.revokeObjectURL(url)
	return { filename, package: recoveryPackage }
}
