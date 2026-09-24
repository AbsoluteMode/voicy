//! `GET /join/{code}`: what a friend sees after clicking an invite link.
//! It opens the app through `voicy://`, or offers the download and puts the
//! link on the clipboard so the freshly installed app picks it up.

use axum::{
    extract::{Path, State},
    http::header,
    response::{Html, IntoResponse},
};

use crate::SharedState;

const DOWNLOAD_URL: &str = "https://github.com/AbsoluteMode/voicy/releases/latest/download/Voicy-Setup.exe";

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

pub async fn page(State(s): State<SharedState>, Path(code): Path<String>) -> impl IntoResponse {
    let headers = [
        (header::REFERRER_POLICY, "no-referrer"),
        (header::CACHE_CONTROL, "no-store"),
        (header::HeaderName::from_static("x-robots-tag"), "noindex"),
    ];
    // Codes are base64url; anything else cannot be an invite.
    let code = if !code.is_empty() && code.len() <= 64 && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        code
    } else {
        String::new()
    };
    let host = &s.cfg.public_host;
    let html = TEMPLATE
        .replace("{{name}}", &escape(&s.server_name()))
        .replace("{{https}}", &escape(&format!("https://{host}/join/{code}")))
        .replace("{{app}}", &escape(&format!("voicy://join/{host}/{code}")))
        .replace("{{download}}", DOWNLOAD_URL);
    (headers, Html(html))
}

const TEMPLATE: &str = r##"<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Приглашение в Voicy</title>
<style>
  :root { color-scheme: dark; font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0d0f13; color: #e8eaf0; padding: 16px; box-sizing: border-box; }
  .card { width: min(440px, 100%); background: #14171d; border: 1px solid #262b35; border-radius: 18px; padding: 32px 28px; text-align: center; }
  .logo { width: 64px; height: 64px; border-radius: 20px; margin: 0 auto 18px; display: grid; place-items: center; font-size: 30px; font-weight: 700; background: #7c6cff; color: #fff; }
  .small { color: #8b92a3; margin: 0 0 4px; }
  h1 { font-size: 26px; margin: 0 0 24px; word-break: break-word; }
  .btn { display: block; width: 100%; box-sizing: border-box; border: none; border-radius: 12px; padding: 15px; font: inherit; font-weight: 650; font-size: 16px; cursor: pointer; text-decoration: none; margin-top: 10px; }
  .primary { background: #7c6cff; color: #fff; }
  .primary:hover { background: #9b8fff; }
  .ghost { background: #1b1f27; color: #e8eaf0; }
  .ghost:hover { background: #262b35; }
  ol { text-align: left; color: #8b92a3; line-height: 1.6; padding-left: 20px; margin: 22px 0 0; font-size: 14px; }
  .ok { color: #2ee59d; font-size: 14px; min-height: 20px; margin-top: 12px; }
  .status { color: #e8eaf0; background: #1b1f27; border-radius: 10px; padding: 12px; margin-bottom: 8px; font-size: 14px; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">V</div>
  <p class="small">Тебя зовут в голосовой чат</p>
  <h1>{{name}}</h1>
  <div class="status" id="status">Открываем Voicy…</div>
  <a class="btn primary" id="open" href="{{app}}">Открыть в Voicy</a>
  <a class="btn ghost" id="download" href="{{download}}">Скачать Voicy для Windows</a>
  <div class="ok" id="ok"></div>
  <ol id="steps" hidden>
    <li>Запусти скачанный установщик.</li>
    <li>Voicy откроется и сам подхватит приглашение.</li>
    <li>Нажми «Войти».</li>
  </ol>
</div>
<script>
  const invite = "{{https}}";
  const status = document.getElementById("status");
  const ok = document.getElementById("ok");

  // The link travels to a freshly installed app through the clipboard.
  const copyInvite = () =>
    navigator.clipboard
      ? navigator.clipboard.writeText(invite).then(() => { ok.textContent = "Приглашение скопировано"; }).catch(() => {})
      : Promise.resolve();

  // If the app is installed, launching voicy:// takes focus away from the
  // page. If nothing happens, it is not installed: download it instead.
  let left = false;
  window.addEventListener("blur", () => { left = true; });
  document.addEventListener("visibilitychange", () => { if (document.hidden) left = true; });

  function tryOpen() {
    left = false;
    location.href = "{{app}}";
    setTimeout(() => {
      if (left) {
        status.textContent = "Voicy открыт, эту вкладку можно закрыть.";
      } else {
        status.textContent = "Voicy не установлен, скачиваем установщик.";
        document.getElementById("steps").hidden = false;
        copyInvite().finally(() => { location.href = "{{download}}"; });
      }
    }, 2000);
  }

  document.getElementById("download").addEventListener("click", copyInvite);
  tryOpen();
</script>
</body>
</html>
"##;
