//! WebView2 asks for microphone access with its own popup on every launch,
//! and that popup can open behind the window, leaving the call hanging
//! until someone finds it. A voice app always needs the mic, so grant it to
//! our own pages up front, the way desktop Discord does. Everything else
//! keeps the default behaviour.

use tauri::WebviewWindow;

#[cfg(windows)]
pub fn allow_microphone(window: &WebviewWindow) {
    use webview2_com::{
        take_pwstr,
        Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
        },
        PermissionRequestedEventHandler,
    };
    use windows_core::PWSTR;

    // Our frontend: the bundled app in release, the Vite server in dev.
    fn ours(uri: &str) -> bool {
        uri.starts_with("http://tauri.localhost/") || uri.starts_with("http://localhost:1420/")
    }

    let result = window.with_webview(|webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            args.PermissionKind(&mut kind)?;
            let mut uri = PWSTR::null();
            args.Uri(&mut uri)?;
            if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE && ours(&take_pwstr(uri)) {
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
            }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_PermissionRequested(&handler, &mut token);
    });
    if let Err(e) = result {
        eprintln!("could not install the microphone permission handler: {e}");
    }
}

#[cfg(not(windows))]
pub fn allow_microphone(_window: &WebviewWindow) {}
