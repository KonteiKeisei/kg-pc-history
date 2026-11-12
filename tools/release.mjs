// A clean, versioned release: only what Foundry loads, in dist/kg-pc-history-<version>/kg-pc-history,
// plus dist/kg-pc-history-<version>.zip. Sets the version and download URL in module.json first.
//   node tools/release.mjs 0.2.0
// Then attach dist/kg-pc-history-<version>.zip and module.json to the GitHub release v<version>.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ID = "kg-pc-history";
const REPO = "https://github.com/KonteiKeisei/kg-pc-history";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
if ( !/^\d+\.\d+\.\d+$/.test(version ?? "") ) {
  console.error("Usage: node tools/release.mjs <major.minor.patch>");
  process.exit(1);
}

// What the live module needs. Tools and dist stay out.
const SHIP = ["module.json", "scripts", "styles", "templates", "README.md", "CHANGELOG.md", "LICENSE"];

const manifestPath = join(ROOT, "module.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.version = version;
manifest.download = `${REPO}/releases/download/v${version}/${ID}-${version}.zip`;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const base = join(ROOT, "dist", `${ID}-${version}`);
const out = join(base, ID);
rmSync(base, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for ( const item of SHIP ) {
  const from = join(ROOT, item);
  if ( !existsSync(from) ) continue;
  cpSync(from, join(out, item), { recursive: true });
}

const zip = join(ROOT, "dist", `${ID}-${version}.zip`);
rmSync(zip, { force: true });
// tar writes forward-slash paths; PowerShell 5's Compress-Archive writes backslashes that break Linux hosts
const z = spawnSync("tar", ["-a", "-c", "-f", zip, "-C", base, ID], { stdio: "inherit" });
console.log(`${ID} ${version}: ${out}${z.status === 0 ? `, ${zip}` : ", zip not made"}`);
