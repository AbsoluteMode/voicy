// Collects the release assets after `tauri build` into client/release/:
//   Voicy-Setup.exe  fixed name, linked from invite pages
//   latest.json      update manifest the in-app updater polls
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const client = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(client, "src-tauri", "tauri.conf.json"), "utf8"));
const nsis = join(client, "src-tauri", "target", "release", "bundle", "nsis");
const setup = join(nsis, `Voicy_${version}_x64-setup.exe`);
const signature = readFileSync(`${setup}.sig`, "utf8").trim();

const out = join(client, "release");
mkdirSync(out, { recursive: true });
copyFileSync(setup, join(out, "Voicy-Setup.exe"));
writeFileSync(
  join(out, "latest.json"),
  JSON.stringify(
    {
      version,
      notes: process.env.RELEASE_NOTES ?? "",
      pub_date: new Date().toISOString(),
      platforms: {
        "windows-x86_64": {
          signature,
          // Versioned URL: the signature belongs to exactly this file.
          url: `https://github.com/AbsoluteMode/voicy/releases/download/v${version}/Voicy-Setup.exe`,
        },
      },
    },
    null,
    2,
  ),
);
console.log(`release/ ready for v${version}`);
