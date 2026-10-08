// The Rust side is intentionally a thin shell: it only opens a native window
// that loads the local Node GUI server (started by `beforeDevCommand`).
// All application logic lives in TypeScript (src/player-core.ts).

/// Work around WebKitGTK rendering a blank/white window on some Linux setups
/// (commonly Wayland or NVIDIA). These are only set when the user has not
/// already chosen a value, so they can still be overridden.
#[cfg(target_os = "linux")]
fn apply_webkit_workarounds() {
    for key in [
        "WEBKIT_DISABLE_COMPOSITING_MODE",
        "WEBKIT_DISABLE_DMABUF_RENDERER",
    ] {
        if std::env::var_os(key).is_none() {
            std::env::set_var(key, "1");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    apply_webkit_workarounds();

    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running the player GUI");
}
