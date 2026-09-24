// Downloads the noise-suppression model files into public/ns so they ship
// inside the app instead of loading from a third-party CDN at runtime.
// Hashes are pinned; a mismatch fails the build.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "ns");

const ASSETS = [
  {
    // wasm-bindgen build of libDF matching deepfilternet3-noise-filter@1.3.0.
    path: "dfn3/df_bg.wasm",
    url: "https://cdn.mezon.ai/AI/models/datas/noise_suppression/deepfilternet3/v3/pkg/df_bg.wasm",
    sha256: "440b5d12b6ea7d95008736f844221d7874ee15de5cb10d3015002470fdba0432",
  },
  {
    // Upstream DeepFilterNet3 model (MIT/Apache-2.0).
    // Not .gz: static servers would add Content-Encoding and the browser
    // would hand the model over already unpacked.
    path: "dfn3/DeepFilterNet3_onnx.tgz.bin",
    url: "https://github.com/Rikorose/DeepFilterNet/raw/main/models/DeepFilterNet3_onnx.tar.gz",
    sha256: "c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616",
  },
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

for (const asset of ASSETS) {
  const file = join(root, asset.path);
  if (existsSync(file) && sha256(readFileSync(file)) === asset.sha256) continue;
  console.log(`fetching ${asset.url}`);
  const res = await fetch(asset.url);
  if (!res.ok) throw new Error(`${asset.url}: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== asset.sha256) throw new Error(`${asset.path}: sha256 ${got}, expected ${asset.sha256}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, buf);
}
