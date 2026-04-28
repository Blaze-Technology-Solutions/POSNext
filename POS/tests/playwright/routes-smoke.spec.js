import { expect, test } from "@playwright/test"

function captureUncaught(page) {
	const pageErrors = []
	page.on("pageerror", (err) => pageErrors.push(String(err)))
	return pageErrors
}

test.describe("SPA routes (desktop viewport) smoke", () => {
	test("Login and root routes mount without uncaught exceptions", async ({
		page,
	}) => {
		const pageErrors = captureUncaught(page)

		await page.goto("/pos/account/login", { waitUntil: "domcontentloaded" })
		await expect(page.locator("body")).toContainText(/sign in/i)

		await page.goto("/pos/", { waitUntil: "domcontentloaded" })
		await page.waitForLoadState("networkidle", { timeout: 30_000 })
		await expect(page.locator("body")).toContainText(/sign in/i)

		expect(
			pageErrors,
			`uncaught JS exceptions:\n  ${pageErrors.join("\n  ")}`,
		).toEqual([])
	})

	test("Unknown routes redirect safely", async ({ page }) => {
		const pageErrors = captureUncaught(page)

		await page.goto("/pos/this-route-does-not-exist", {
			waitUntil: "domcontentloaded",
		})
		await page.waitForLoadState("networkidle", { timeout: 30_000 })

		// Not logged in → everything redirects to the Login page.
		await expect(page).toHaveURL(/\/pos\/account\/login/)
		await expect(page.locator("body")).toContainText(/sign in/i)

		expect(
			pageErrors,
			`uncaught JS exceptions:\n  ${pageErrors.join("\n  ")}`,
		).toEqual([])
	})

	test("App remains interactive when browser goes offline (after initial load)", async ({
		page,
	}) => {
		const pageErrors = captureUncaught(page)

		await page.goto("/pos/account/login", { waitUntil: "domcontentloaded" })
		await page.waitForLoadState("networkidle", { timeout: 30_000 })

		await page.context().setOffline(true)

		// The page should remain usable even without network: typing into the
		// login form should not throw.
		const inputs = page.locator("input")
		const inputCount = await inputs.count()
		expect(inputCount).toBeGreaterThan(0)

		await inputs.first().fill("offline-smoke")
		await expect(inputs.first()).toHaveValue("offline-smoke")

		expect(
			pageErrors,
			`uncaught JS exceptions:\n  ${pageErrors.join("\n  ")}`,
		).toEqual([])
	})
})
