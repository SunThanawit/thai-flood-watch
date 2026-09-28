// Runs on the owner's machine (a Thai IP) every 10 minutes via Task Scheduler:
// builds the Bangkok pump + road-flood snapshots, which Thai government sites
// only serve to Thai IPs, and uploads them to the dashboard API.
//
//   node scripts/relay.mjs          (reads the admin key from api/.admin-key)
import { execFile } from "node:child_process";
import { readFile, appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const API = "https://thai-flood-watch-api.vercel.app/api/snapshot";
const OUT_DIR = join(tmpdir(), "thai-flood-relay");
const LOG = join(OUT_DIR, "relay.log");

const JOBS = [
  { name: "pumps", script: "scripts/build-pumps.mjs", file: "pumps.json" },
  { name: "floodalert", script: "scripts/build-floodalert.mjs", file: "floodalert.json" },
];

async function log(line) {
  const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Bangkok" });
  console.log(line);
  try {
    // Keep the log small: start over once it passes ~200 KB
    const size = await stat(LOG).then((s) => s.size, () => 0);
    if (size > 200_000) await writeFile(LOG, "");
    await appendFile(LOG, `${stamp}  ${line}\n`);
  } catch { /* logging is best-effort */ }
}

await mkdir(OUT_DIR, { recursive: true });
const key = (await readFile(join(ROOT, "api", ".admin-key"), "utf8")).trim();

for (const job of JOBS) {
  try {
    const { stdout } = await run(process.execPath, [join(ROOT, job.script)], {
      cwd: ROOT,
      env: { ...process.env, OUT_DIR },
      timeout: 150_000,
    });
    const body = await readFile(join(OUT_DIR, job.file), "utf8");
    const res = await fetch(`${API}?name=${job.name}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Admin-Key": key },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const reply = await res.text();
    await log(`${job.name}: ${res.ok ? "uploaded" : `upload failed ${res.status} ${reply}`} · ${stdout.trim()}`);
  } catch (err) {
    await log(`${job.name}: FAILED ${String(err.stderr || err.message).trim().slice(0, 300)}`);
  }
}
