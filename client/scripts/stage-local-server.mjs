import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const client = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = resolve(client, "..", "server");
const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
execFileSync(cargo, ["build", "--release", "--manifest-path", resolve(server, "Cargo.toml")], {
  stdio: "inherit",
});
const source = resolve(server, "target", "release", process.platform === "win32" ? "voicy-server.exe" : "voicy-server");
const target = resolve(client, "src-tauri", "resources", process.platform === "win32" ? "voicy-server.exe" : "voicy-server");
mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(`Staged local server: ${target}`);
