import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { db } from "@/utils/offline/db"
import {
	appendRecoveryEvent,
	buildRecoveryPackage,
	canonicalJson,
	getTerminalId,
} from "@/utils/offline/recoveryJournal"

describe("offline recovery journal", () => {
	beforeEach(async () => {
		await Promise.all([
			db.recovery_journal.clear(),
			db.invoice_queue.clear(),
			db.customer_queue.clear(),
			db.settings.delete("recovery_terminal_id"),
		])
	})

	afterEach(async () => {
		await Promise.all([
			db.recovery_journal.clear(),
			db.invoice_queue.clear(),
			db.customer_queue.clear(),
			db.settings.delete("recovery_terminal_id"),
		])
	})

	it("uses canonical JSON independent of object key order", () => {
		expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
			canonicalJson({ a: { c: 3, d: 4 }, b: 2 }),
		)
	})

	it("appends hash-chained events and redacts sensitive fields", async () => {
		const first = await appendRecoveryEvent({
			event_type: "invoice_created",
			pos_profile: "POS-A",
			payload: {
				pos_profile: "POS-A",
				customer: "Walk-in",
				api_secret: "do-not-store",
				payments: [{ mode_of_payment: "Cash", amount: 10 }],
			},
		})
		const second = await appendRecoveryEvent({
			event_type: "invoice_submit_success",
			pos_profile: "POS-A",
			server_docname: "SINV-1",
			payload: {
				pos_profile: "POS-A",
				server_invoice: "SINV-1",
				authorization: "Bearer secret",
			},
		})

		expect(first.previous_hash).toBeNull()
		expect(second.previous_hash).toBe(first.record_hash)
		expect(first.payload.api_secret).toBe("[REDACTED]")
		expect(second.payload.authorization).toBe("[REDACTED]")
		expect(first.record_hash).toMatch(/^[a-f0-9]{64}$/)
	})

	it("builds an export package with journal, queues, manifest, and totals", async () => {
		const terminalId = await getTerminalId()
		await appendRecoveryEvent({
			event_type: "invoice_created",
			pos_profile: "POS-A",
			payload: {
				pos_profile: "POS-A",
				customer: "Walk-in",
				grand_total: 42,
				payments: [{ mode_of_payment: "Cash", amount: 42 }],
			},
		})
		await db.invoice_queue.add({
			offline_id: "pos_offline_1",
			data: { customer: "Walk-in" },
			timestamp: Date.now(),
			synced: false,
			retry_count: 0,
		})

		const recoveryPackage = await buildRecoveryPackage()

		expect(recoveryPackage.manifest.terminal_id).toBe(terminalId)
		expect(recoveryPackage.manifest.event_count).toBe(1)
		expect(recoveryPackage.journal).toHaveLength(1)
		expect(recoveryPackage.pending_invoice_queue).toHaveLength(1)
		expect(recoveryPackage.local_summary).toMatchObject({
			invoice_count: 1,
			pending_invoice_count: 1,
			gross_total: 42,
			payment_totals_by_mode: { Cash: 42 },
		})
		expect(recoveryPackage.manifest.journal_sha256).toMatch(/^[a-f0-9]{64}$/)
	})

	it("keeps the hash chain intact under concurrent appends", async () => {
		const concurrency = 10
		const events = Array.from({ length: concurrency }, (_, i) => ({
			event_type: "invoice_created",
			pos_profile: "POS-A",
			payload: { seq: i, pos_profile: "POS-A" },
		}))

		// Fire all appends without awaiting between them — this is the
		// pattern that breaks naive read-then-write hash chaining.
		const results = await Promise.all(events.map((e) => appendRecoveryEvent(e)))

		// Each row's previous_hash must equal the prior row's record_hash.
		// IDs are assigned in commit order; sort by id and walk the chain.
		const ordered = [...results].sort((a, b) => a.id - b.id)
		expect(ordered[0].previous_hash).toBeNull()
		for (let i = 1; i < ordered.length; i++) {
			expect(ordered[i].previous_hash).toBe(ordered[i - 1].record_hash)
		}

		// All record_hashes must be distinct (no collisions from same input).
		const hashes = new Set(ordered.map((r) => r.record_hash))
		expect(hashes.size).toBe(concurrency)
	})

	it("filters journal rows by date range", async () => {
		await appendRecoveryEvent({
			event_type: "invoice_created",
			event_time: "2026-01-01T10:00:00.000Z",
			payload: { tag: "old" },
		})
		await appendRecoveryEvent({
			event_type: "invoice_created",
			event_time: "2026-04-15T10:00:00.000Z",
			payload: { tag: "in_range" },
		})
		await appendRecoveryEvent({
			event_type: "invoice_created",
			event_time: "2026-12-31T10:00:00.000Z",
			payload: { tag: "future" },
		})

		const recoveryPackage = await buildRecoveryPackage({
			from: "2026-04-01T00:00:00.000Z",
			to: "2026-04-30T23:59:59.999Z",
		})

		expect(recoveryPackage.manifest.event_count).toBe(1)
		expect(recoveryPackage.journal[0].payload.tag).toBe("in_range")
		expect(recoveryPackage.manifest.date_range).toEqual({
			from: "2026-04-01T00:00:00.000Z",
			to: "2026-04-30T23:59:59.999Z",
		})
	})

	it("builds a valid empty package when nothing has been journaled", async () => {
		const recoveryPackage = await buildRecoveryPackage()

		expect(recoveryPackage.manifest.event_count).toBe(0)
		expect(recoveryPackage.manifest.first_event_hash).toBeNull()
		expect(recoveryPackage.manifest.last_event_hash).toBeNull()
		expect(recoveryPackage.journal).toHaveLength(0)
		expect(recoveryPackage.pending_invoice_queue).toHaveLength(0)
		expect(recoveryPackage.local_summary).toMatchObject({
			invoice_count: 0,
			pending_invoice_count: 0,
			gross_total: 0,
			payment_totals_by_mode: {},
		})
		// SHA-256 of empty string still has a stable value.
		expect(recoveryPackage.manifest.journal_sha256).toMatch(/^[a-f0-9]{64}$/)
	})

	it("returns the same terminal_id across calls", async () => {
		const first = await getTerminalId()
		const second = await getTerminalId()
		expect(first).toBe(second)
		expect(first).toMatch(/^terminal_/)
	})

	it("redacts sensitive fields in nested arrays of objects", async () => {
		const event = await appendRecoveryEvent({
			event_type: "payment_created",
			payload: {
				payments: [
					{ mode_of_payment: "Cash", amount: 10, token: "leak-1" },
					{
						mode_of_payment: "Card",
						amount: 5,
						gateway: { authorization: "Bearer X", reference: "ref-1" },
					},
				],
			},
		})

		expect(event.payload.payments[0].token).toBe("[REDACTED]")
		expect(event.payload.payments[1].gateway.authorization).toBe("[REDACTED]")
		// Non-sensitive siblings survive.
		expect(event.payload.payments[0].mode_of_payment).toBe("Cash")
		expect(event.payload.payments[1].gateway.reference).toBe("ref-1")
	})
})
