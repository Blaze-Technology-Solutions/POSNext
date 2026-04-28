/**
 * desktopAuth — login + Stronghold persistence for the Tauri desktop build.
 *
 * Stronghold is Tauri's encrypted on-disk vault. We use it to keep the Frappe
 * API key + secret across app restarts so the cashier only types their password
 * once per device. The vault file lives under the app's data dir
 * (`%APPDATA%\<bundle.identifier>\`) and is encrypted with a passphrase
 * derived from a per-device salt + a constant app secret.
 *
 * No-ops cleanly when imported under web/Vitest (where the tauri plugins
 * aren't available) — every public function is async and silently returns
 * `null`/`false` if the import fails.
 */

import {
	apiUrl,
	clearApiCredentials,
	runtimeConfig,
	setApiCredentials,
} from "./runtimeConfig"

const VAULT_FILE = "pos-next.stronghold"
const CLIENT_NAME = "pos-next-client"
const RECORD_KEY = "frappe-api-credentials"
const DEVICE_SALT_STORE_KEY = "pos-next-device-salt"
const DEVICE_SALT_FILE = "settings.json"

let strongholdHandle = null
let storeHandle = null

async function loadStronghold() {
	if (!runtimeConfig.isDesktop) return null
	if (strongholdHandle) return strongholdHandle
	const { Stronghold } = await import("@tauri-apps/plugin-stronghold")
	const { appDataDir, join } = await import("@tauri-apps/api/path")
	const dir = await appDataDir()
	const path = await join(dir, VAULT_FILE)
	const passphrase = await deriveVaultPassphrase()
	strongholdHandle = await Stronghold.load(path, passphrase)
	return strongholdHandle
}

async function loadStore() {
	if (!runtimeConfig.isDesktop) return null
	if (storeHandle) return storeHandle
	const { load } = await import("@tauri-apps/plugin-store")
	storeHandle = await load(DEVICE_SALT_FILE, { autoSave: true })
	return storeHandle
}

async function getOrCreateDeviceSalt() {
	const store = await loadStore()
	if (!store) return "pos-next-fallback-salt"
	let salt = await store.get(DEVICE_SALT_STORE_KEY)
	if (typeof salt !== "string" || salt.length < 16) {
		salt = crypto.randomUUID() + crypto.randomUUID()
		await store.set(DEVICE_SALT_STORE_KEY, salt)
		await store.save()
	}
	return salt
}

async function deriveVaultPassphrase() {
	const salt = await getOrCreateDeviceSalt()
	// Stronghold's JS plugin accepts a string passphrase. The Rust side hashes it
	// (see desktop/src-tauri/src/lib.rs) into the actual encryption key, so we
	// just need a stable per-device value here.
	return `${salt}::pos-next::v1`
}

async function getClient(stronghold) {
	try {
		return await stronghold.loadClient(CLIENT_NAME)
	} catch {
		return await stronghold.createClient(CLIENT_NAME)
	}
}

function bytesToString(value) {
	if (!value) return null
	if (typeof value === "string") return value
	if (value instanceof Uint8Array) return new TextDecoder().decode(value)
	if (Array.isArray(value))
		return new TextDecoder().decode(new Uint8Array(value))
	return null
}

function stringToBytes(value) {
	return Array.from(new TextEncoder().encode(value))
}

/**
 * Persist the API key/secret pair to Stronghold and update the in-memory
 * cache used by `desktopTransport`.
 */
export async function persistApiCredentials({ apiKey, apiSecret, userEmail }) {
	if (!runtimeConfig.isDesktop) return false
	setApiCredentials({ apiKey, apiSecret })

	try {
		const stronghold = await loadStronghold()
		if (!stronghold) return false
		const client = await getClient(stronghold)
		const store = client.getStore()
		const payload = JSON.stringify({
			apiKey,
			apiSecret,
			userEmail,
			siteUrl: runtimeConfig.baseUrl,
			savedAt: new Date().toISOString(),
		})
		await store.insert(RECORD_KEY, stringToBytes(payload))
		await stronghold.save()
		return true
	} catch (error) {
		console.warn("[desktopAuth] persist failed", error)
		return false
	}
}

/**
 * Pull the API key/secret pair from Stronghold (if present) and load it into
 * the in-memory cache so subsequent requests authenticate.
 *
 * @returns {Promise<null | { apiKey: string, apiSecret: string, userEmail?: string }>}
 */
export async function restoreApiCredentialsFromStronghold() {
	if (!runtimeConfig.isDesktop) return null
	try {
		const stronghold = await loadStronghold()
		if (!stronghold) return null
		const client = await getClient(stronghold)
		const store = client.getStore()
		const raw = await store.get(RECORD_KEY)
		const decoded = bytesToString(raw)
		if (!decoded) return null
		const parsed = JSON.parse(decoded)
		if (!parsed?.apiKey || !parsed?.apiSecret) return null
		setApiCredentials({ apiKey: parsed.apiKey, apiSecret: parsed.apiSecret })
		return parsed
	} catch (error) {
		console.warn("[desktopAuth] restore failed", error)
		return null
	}
}

/**
 * Wipe stored credentials from both memory and Stronghold. Used by Logout.
 */
export async function clearStoredApiCredentials() {
	clearApiCredentials()
	if (!runtimeConfig.isDesktop) return
	try {
		const stronghold = await loadStronghold()
		if (!stronghold) return
		const client = await getClient(stronghold)
		const store = client.getStore()
		await store.remove(RECORD_KEY)
		await stronghold.save()
	} catch (error) {
		console.warn("[desktopAuth] clear failed", error)
	}
}

/**
 * Pull the sid value out of a Set-Cookie response header. Handles both the
 * single-string form (older fetch APIs) and the modern getSetCookie() array.
 */
function extractSid(response) {
	const candidates = []
	if (typeof response.headers.getSetCookie === "function") {
		candidates.push(...response.headers.getSetCookie())
	}
	const single = response.headers.get("set-cookie")
	if (single) candidates.push(single)
	for (const raw of candidates) {
		const match = raw.match(/sid=([^;]+)/)
		if (match) return match[1]
	}
	return null
}

/**
 * Submit a Frappe email/password login through the Tauri HTTP plugin and
 * trade it for an API key+secret pair via `generate_keys`. Returns the
 * pair without persisting — the caller should call `persistApiCredentials`
 * on success.
 *
 * Tauri's HTTP plugin doesn't share a cookie jar between requests, so we
 * pull the `sid` out of the login response and pass it as an explicit
 * Cookie header on the generate_keys call. Frappe's generate_keys returns
 * both api_key and api_secret in a single response, so no third call is
 * needed.
 *
 * @param {{ email: string, password: string }} creds
 */
export async function loginAndGenerateKeys({ email, password }) {
	if (!runtimeConfig.isDesktop) {
		throw new Error("loginAndGenerateKeys is desktop-only")
	}
	const { fetch: tFetch } = await import("@tauri-apps/plugin-http")

	const loginRes = await tFetch(apiUrl("/api/method/login"), {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ usr: email, pwd: password }),
	})
	if (!loginRes.ok) {
		const text = await loginRes.text().catch(() => "")
		throw new Error(
			`Login failed (${loginRes.status}): ${text || "invalid credentials"}`,
		)
	}

	const sid = extractSid(loginRes)
	if (!sid) {
		throw new Error(
			"Login succeeded but no sid cookie was returned. The Frappe site may be misconfigured.",
		)
	}

	const keysRes = await tFetch(
		apiUrl(
			`/api/method/frappe.core.doctype.user.user.generate_keys?user=${encodeURIComponent(email)}`,
		),
		{
			method: "POST",
			headers: {
				Accept: "application/json",
				Cookie: `sid=${sid}`,
			},
		},
	)
	if (!keysRes.ok) {
		const text = await keysRes.text().catch(() => "")
		throw new Error(`generate_keys failed (${keysRes.status}): ${text}`)
	}
	const data = await keysRes.json()
	const message = data?.message || data
	const apiKey = message?.api_key
	const apiSecret = message?.api_secret
	if (!apiKey || !apiSecret) {
		throw new Error("generate_keys response missing api_key or api_secret")
	}

	return { apiKey, apiSecret }
}
