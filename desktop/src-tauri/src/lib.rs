use tauri::Manager;

#[tauri::command]
fn get_app_info() -> serde_json::Value {
	serde_json::json!({
		"name": env!("CARGO_PKG_NAME"),
		"version": env!("CARGO_PKG_VERSION"),
	})
}

/// Frappe email/password login + API key bootstrap, run on the Rust side.
///
/// We do this in Rust because Tauri's plugin-http (used from JS) follows the
/// browser Fetch spec and silently filters "forbidden" headers like `Cookie`.
/// That means we can't carry the `sid` cookie from /api/method/login over to
/// the follow-up generate_keys call — Frappe sees the second request as Guest
/// and returns 404 (its odd routing for unauthorized whitelisted POSTs).
///
/// On the Rust side we use reqwest with a cookie store, so the `sid` cookie
/// flows automatically. Returns {api_key, api_secret} on success; the caller
/// (POS/src/utils/desktopAuth.js) persists them to Stronghold.
#[tauri::command]
async fn frappe_login(
	base_url: String,
	email: String,
	password: String,
) -> Result<serde_json::Value, String> {
	let client = tauri_plugin_http::reqwest::Client::builder()
		.cookie_store(true)
		.user_agent("pos-next-desktop")
		.build()
		.map_err(|e| format!("client build failed: {e}"))?;

	let base = base_url.trim_end_matches('/');

	let login_body = serde_json::to_string(&serde_json::json!({
		"usr": &email,
		"pwd": &password,
	}))
	.map_err(|e| format!("login body serialize failed: {e}"))?;

	let login_res = client
		.post(format!("{base}/api/method/login"))
		.header("Accept", "application/json")
		.header("Content-Type", "application/json")
		.body(login_body)
		.send()
		.await
		.map_err(|e| format!("login request failed: {e}"))?;

	if !login_res.status().is_success() {
		let status = login_res.status();
		let body = login_res.text().await.unwrap_or_default();
		return Err(format!("Login failed ({status}): {body}"));
	}

	let keys_url = format!(
		"{base}/api/method/frappe.core.doctype.user.user.generate_keys?user={}",
		urlencoding::encode(&email)
	);
	let keys_res = client
		.post(&keys_url)
		.header("Accept", "application/json")
		.send()
		.await
		.map_err(|e| format!("generate_keys request failed: {e}"))?;

	if !keys_res.status().is_success() {
		let status = keys_res.status();
		let body = keys_res.text().await.unwrap_or_default();
		return Err(format!("generate_keys failed ({status}): {body}"));
	}

	let keys_text = keys_res
		.text()
		.await
		.map_err(|e| format!("generate_keys read failed: {e}"))?;
	let keys_payload: serde_json::Value = serde_json::from_str(&keys_text)
		.map_err(|e| format!("generate_keys parse failed: {e} (body: {keys_text})"))?;

	let message = keys_payload
		.get("message")
		.unwrap_or(&keys_payload)
		.clone();

	let api_key = message
		.get("api_key")
		.and_then(|v| v.as_str())
		.ok_or_else(|| "generate_keys response missing api_key".to_string())?;
	let api_secret = message
		.get("api_secret")
		.and_then(|v| v.as_str())
		.ok_or_else(|| "generate_keys response missing api_secret".to_string())?;

	Ok(serde_json::json!({
		"apiKey": api_key,
		"apiSecret": api_secret,
	}))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	tauri::Builder::default()
		.plugin(
			// File-backed log so we can debug a cashier's machine after the
			// fact. Lives at:
			//   Windows: %APPDATA%\<bundle-identifier>\logs\<app-name>.log
			//   Linux:   ~/.config/<bundle-identifier>/logs/
			//   macOS:   ~/Library/Logs/<bundle-identifier>/
			// Rotated when it hits 10 MB; previous logs kept under .log.1 etc.
			tauri_plugin_log::Builder::new()
				.targets([
					tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
					tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
						file_name: Some("pos-next".into()),
					}),
				])
				.level(log::LevelFilter::Info)
				.max_file_size(10_000_000)
				.rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
				.timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
				.build(),
		)
		.plugin(tauri_plugin_shell::init())
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_process::init())
		.plugin(tauri_plugin_store::Builder::default().build())
		.plugin(tauri_plugin_http::init())
		.plugin(tauri_plugin_updater::Builder::new().build())
		.plugin(
			tauri_plugin_stronghold::Builder::new(|password| {
				use std::hash::{DefaultHasher, Hash, Hasher};
				let mut hasher = DefaultHasher::new();
				password.hash(&mut hasher);
				let key = hasher.finish().to_le_bytes();
				key.repeat(4)[..32].to_vec()
			})
			.build(),
		)
		.invoke_handler(tauri::generate_handler![get_app_info, frappe_login])
		.setup(|app| {
			#[cfg(debug_assertions)]
			{
				let window = app.get_webview_window("main").unwrap();
				window.open_devtools();
			}
			Ok(())
		})
		.run(tauri::generate_context!())
		.expect("error while running tauri application");
}
