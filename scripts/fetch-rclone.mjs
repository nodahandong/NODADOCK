// Downloads the rclone binary that CloudDock bundles, and names it the way
// Tauri expects for an external binary: src-tauri/binaries/rclone-<target-triple>[.exe]
//
//   node scripts/fetch-rclone.mjs                 # for this machine
//   node scripts/fetch-rclone.mjs aarch64-apple-darwin
//   RCLONE_VERSION=v1.71.1 node scripts/fetch-rclone.mjs
import { execSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const triple = process.argv[2] || /host: (\S+)/.exec(execSync("rustc -vV").toString())[1];
const map = {
  "x86_64-pc-windows-msvc": "windows-amd64",
  "aarch64-pc-windows-msvc": "windows-arm64",
  "x86_64-apple-darwin": "osx-amd64",
  "aarch64-apple-darwin": "osx-arm64",
  "x86_64-unknown-linux-gnu": "linux-amd64",
  "aarch64-unknown-linux-gnu": "linux-arm64",
};
const platform = map[triple];
if (!platform) throw new Error(`No rclone build for ${triple}`);

const version = process.env.RCLONE_VERSION;
const url = version
  ? `https://downloads.rclone.org/${version}/rclone-${version}-${platform}.zip`
  : `https://downloads.rclone.org/rclone-current-${platform}.zip`;
const exe = triple.includes("windows") ? ".exe" : "";
const outDir = join(import.meta.dirname, "..", "src-tauri", "binaries");
const out = join(outDir, `rclone-${triple}${exe}`);

console.log(`Downloading ${url}`);
const res = await fetch(url);
if (!res.ok) throw new Error(`Download failed: ${res.status}`);
const work = mkdtempSync(join(tmpdir(), "rclone-"));
const zip = join(work, "rclone.zip");
writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
// bsdtar (Windows 10+, macOS) reads zip files; Linux usually has unzip.
execSync(process.platform === "linux" ? `unzip -q "${zip}" -d "${work}"` : `tar -xf "${zip}" -C "${work}"`);
const folder = readdirSync(work).find((f) => f.startsWith("rclone-"));
mkdirSync(outDir, { recursive: true });
copyFileSync(join(work, folder, `rclone${exe}`), out);
if (!exe) chmodSync(out, 0o755);
rmSync(work, { recursive: true, force: true });
console.log(`Saved ${out}`);
if (!existsSync(out)) process.exit(1);
