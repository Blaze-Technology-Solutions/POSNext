#!/usr/bin/env node
/**
 * Per-customer Tauri build orchestrator.
 *
 *   yarn desktop:build <slug>          -> build one customer
 *   yarn desktop:build:all             -> loop over every customers/*.json
 *
 * For each customer:
 *   1. Read desktop/customers/<slug>.json
 *   2. Copy the customer's icon set into src-tauri/icons/ (if present)
 *   3. Write desktop/src-tauri/tauri.conf.<slug>.json by deep-merging the base
 *      tauri.conf.json with customer overrides (productName, identifier,
 *      version, updater endpoints, pubkey).
 *   4. Run `yarn build:desktop` in POS/ with VITE_POS_TARGET=desktop and
 *      VITE_FRAPPE_BASE_URL pointed at the customer's site.
 *   5. Run `tauri build --config tauri.conf.<slug>.json`.
 *   6. Move the resulting installer into desktop/dist/<slug>/.
 */

import { spawnSync } from "node:child_process"
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
	copyFileSync,
	statSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(__dirname, "..")
const repoRoot = resolve(desktopRoot, "..")
const tauriDir = join(desktopRoot, "src-tauri")
const customersDir = join(desktopRoot, "customers")
const baseConfigPath = join(tauriDir, "tauri.conf.json")
const distRoot = join(desktopRoot, "dist")

const REQUIRED_FIELDS = ["slug", "productName", "identifier", "version", "siteUrl"]

function die(msg) {
	console.error(`✗ ${msg}`)
	process.exit(1)
}

function loadCustomer(slug) {
	const path = join(customersDir, `${slug}.json`)
	if (!existsSync(path)) die(`No customer config at ${path}`)
	const cfg = JSON.parse(readFileSync(path, "utf8"))
	for (const field of REQUIRED_FIELDS) {
		if (!cfg[field]) die(`customers/${slug}.json missing required field: ${field}`)
	}
	if (!/^https?:\/\//.test(cfg.siteUrl)) {
		die(`siteUrl must include scheme (https://...). Got: ${cfg.siteUrl}`)
	}
	return cfg
}

function mergeConfig(base, customer) {
	const updaterEnabled = Boolean(customer.updater?.active)
	return {
		...base,
		productName: customer.productName,
		version: customer.version,
		identifier: customer.identifier,
		bundle: {
			...base.bundle,
			publisher: customer.publisher || base.bundle?.publisher,
			shortDescription: customer.shortDescription || base.bundle?.shortDescription,
		},
		plugins: {
			...base.plugins,
			updater: {
				...base.plugins?.updater,
				active: updaterEnabled,
				endpoints: updaterEnabled && customer.updater?.endpoint
					? [customer.updater.endpoint]
					: [],
				pubkey: updaterEnabled ? customer.updater?.pubkey || "" : "",
				dialog: false,
			},
		},
	}
}

function copyIcons(customer) {
	if (!customer.iconDir) return false
	const src = resolve(desktopRoot, customer.iconDir)
	if (!existsSync(src) || !statSync(src).isDirectory()) {
		console.warn(`! iconDir ${src} does not exist; will auto-generate`)
		return false
	}
	const dest = join(tauriDir, "icons")
	mkdirSync(dest, { recursive: true })
	for (const name of readdirSync(src)) {
		copyFileSync(join(src, name), join(dest, name))
	}
	console.log(`✓ Copied icons from ${src}`)
	return true
}

/**
 * Tauri's Windows bundler hard-requires icons/icon.ico. If the customer
 * didn't ship an icon set, generate the full set (32x32.png, 128x128.png,
 * 128x128@2x.png, icon.icns, icon.ico) from POS/public/favicon.png using
 * `tauri icon`. This way the build never fails on missing icons.
 */
function ensureIcons() {
	const iconDest = join(tauriDir, "icons")
	const requiredIco = join(iconDest, "icon.ico")
	if (existsSync(requiredIco)) return
	const source = join(repoRoot, "POS", "public", "favicon.png")
	if (!existsSync(source)) {
		die(`No icon source at ${source}; cannot auto-generate icons`)
	}
	console.log(`▶ Auto-generating icon set from ${source}`)
	mkdirSync(iconDest, { recursive: true })
	run(
		"yarn",
		["--cwd", desktopRoot, "tauri", "icon", source, "--output", iconDest],
		{},
	)
}

function run(cmd, args, opts = {}) {
	console.log(`$ ${cmd} ${args.join(" ")}`)
	const res = spawnSync(cmd, args, {
		stdio: "inherit",
		shell: process.platform === "win32",
		...opts,
	})
	if (res.status !== 0) die(`${cmd} ${args.join(" ")} exited ${res.status}`)
}

function buildOne(slug) {
	const customer = loadCustomer(slug)
	console.log(`\n=== Building ${customer.productName} (${slug}) ===`)
	console.log(`    siteUrl: ${customer.siteUrl}`)
	console.log(`    version: ${customer.version}`)

	const baseConfig = JSON.parse(readFileSync(baseConfigPath, "utf8"))
	const merged = mergeConfig(baseConfig, customer)
	const customConfigPath = join(tauriDir, `tauri.conf.${slug}.json`)
	writeFileSync(customConfigPath, JSON.stringify(merged, null, 2))
	console.log(`✓ Wrote ${customConfigPath}`)

	copyIcons(customer)
	ensureIcons()

	const env = {
		...process.env,
		VITE_POS_TARGET: "desktop",
		VITE_FRAPPE_BASE_URL: customer.siteUrl,
	}

	// Build the frontend bundle into desktop/dist-frontend/ first, then run
	// `tauri build` with the merged per-customer config. We invoke the tauri
	// CLI from desktop/ (where @tauri-apps/cli lives) and pass it the absolute
	// path to the merged config.
	run("yarn", ["--cwd", join(repoRoot, "POS"), "build:desktop"], { env })
	run(
		"yarn",
		[
			"--cwd",
			desktopRoot,
			"tauri",
			"build",
			"--config",
			customConfigPath,
		],
		{ env },
	)

	const customerDistDir = join(distRoot, slug)
	mkdirSync(customerDistDir, { recursive: true })
	console.log(
		`\n✓ Build complete. Installers under ${join(tauriDir, "target/release/bundle")}; copy them into ${customerDistDir}.`,
	)
}

function buildAll() {
	if (!existsSync(customersDir)) die(`customers/ does not exist`)
	const slugs = readdirSync(customersDir)
		.filter((f) => f.endsWith(".json") && !f.startsWith("_"))
		.map((f) => f.replace(/\.json$/, ""))
	if (!slugs.length) die("No customer configs found")
	for (const slug of slugs) buildOne(slug)
}

const arg = process.argv[2]
if (!arg) die("Usage: build-customer.mjs <slug> | --all")
if (arg === "--all") buildAll()
else buildOne(arg)
