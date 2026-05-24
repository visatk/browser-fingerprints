#!/usr/bin/env tsx
/**
 * Fingerprints KV Seed Script
 * ----------------------------
 * Reads fingerprints.json and uploads each fingerprint to Cloudflare KV
 * in batches via `wrangler kv bulk put`.
 *
 * Usage:
 *   npx tsx scripts/seed.ts [options]
 *
 * Options:
 *   --file <path>       Path to fingerprints.json (default: ./fingerprints.json)
 *   --namespace <id>    KV Namespace ID (overrides wrangler.jsonc)
 *   --batch-size <n>    Fingerprints per batch file (default: 500)
 *   --generate-only     Only generate bulk JSON files, don't run wrangler
 *   --start <n>         Start index (for resuming, default: 0)
 *   --end <n>           End index exclusive (default: all)
 *   --env <name>        Wrangler environment (default: none / production)
 *   --preview           Target the preview KV namespace
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join, resolve } from "path";

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const getArg = (flag: string): string | undefined => {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
};
const hasFlag = (flag: string) => args.includes(flag);

const FINGERPRINTS_FILE = resolve(getArg("--file") ?? "./fingerprints.json");
const BATCH_SIZE = parseInt(getArg("--batch-size") ?? "500", 10);
const GENERATE_ONLY = hasFlag("--generate-only");
const START_INDEX = parseInt(getArg("--start") ?? "0", 10);
const WRANGLER_ENV = getArg("--env");
const PREVIEW = hasFlag("--preview");
const NAMESPACE_ID = getArg("--namespace");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(`[seed] ${msg}`);
}

function runWrangler(bulkFile: string, binding: string) {
  const envFlag = WRANGLER_ENV ? `--env ${WRANGLER_ENV}` : "";
  const previewFlag = PREVIEW ? "--preview" : "";
  const nsFlag = NAMESPACE_ID ? `--namespace-id ${NAMESPACE_ID}` : `--binding ${binding}`;

  const cmd = `npx wrangler kv bulk put "${bulkFile}" ${nsFlag} ${envFlag} ${previewFlag}`.trim();
  log(`Running: ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(FINGERPRINTS_FILE)) {
    console.error(`[seed] ERROR: File not found: ${FINGERPRINTS_FILE}`);
    console.error(`[seed] Usage: npx tsx scripts/seed.ts --file /path/to/fingerprints.json`);
    process.exit(1);
  }

  log(`Loading fingerprints from ${FINGERPRINTS_FILE}...`);
  const raw = readFileSync(FINGERPRINTS_FILE, "utf-8");
  const fingerprints: unknown[] = JSON.parse(raw);
  log(`Loaded ${fingerprints.length} fingerprints.`);

  const endIndex = Math.min(
    parseInt(getArg("--end") ?? String(fingerprints.length), 10),
    fingerprints.length
  );

  const total = endIndex - START_INDEX;
  const batchCount = Math.ceil(total / BATCH_SIZE);

  log(`Seeding indices ${START_INDEX}–${endIndex - 1} (${total} fingerprints, ${batchCount} batches of ${BATCH_SIZE})`);

  // Temp directory for batch files
  const tmpDir = join(process.cwd(), ".seed-tmp");
  mkdirSync(tmpDir, { recursive: true });

  let uploaded = 0;

  for (let batch = 0; batch < batchCount; batch++) {
    const batchStart = START_INDEX + batch * BATCH_SIZE;
    const batchEnd = Math.min(batchStart + BATCH_SIZE, endIndex);

    log(`Batch ${batch + 1}/${batchCount}: indices ${batchStart}–${batchEnd - 1}`);

    // Build KV bulk payload: [{ key, value }]
    const payload: Array<{ key: string; value: string }> = [];

    for (let i = batchStart; i < batchEnd; i++) {
      payload.push({
        key: `fp:${i}`,
        value: JSON.stringify(fingerprints[i]),
      });
    }

    // On the last batch, add the count meta key
    if (batchEnd === endIndex) {
      payload.push({
        key: "meta:count",
        value: String(endIndex),
      });
      log(`Added meta:count = ${endIndex}`);
    }

    const bulkFile = join(tmpDir, `batch-${batch}.json`);
    writeFileSync(bulkFile, JSON.stringify(payload));

    if (!GENERATE_ONLY) {
      try {
        runWrangler(bulkFile, "FINGERPRINTS_KV");
        uploaded += batchEnd - batchStart;
        log(`✓ Batch ${batch + 1} uploaded (${uploaded}/${total} total)`);
      } catch (err) {
        console.error(`[seed] ERROR in batch ${batch + 1}:`, err);
        console.error(`[seed] Bulk file preserved at: ${bulkFile}`);
        console.error(`[seed] Resume with: npx tsx scripts/seed.ts --start ${batchStart}`);
        process.exit(1);
      } finally {
        // Clean up only on success
        if (existsSync(bulkFile)) {
          try { unlinkSync(bulkFile); } catch {}
        }
      }
    } else {
      log(`Generated batch file: ${bulkFile}`);
    }
  }

  if (!GENERATE_ONLY) {
    log(`✅ Done! ${uploaded} fingerprints seeded to KV.`);
    log(`   meta:count = ${endIndex}`);
    // Cleanup tmp dir
    try {
      const { rmdirSync } = await import("fs");
      rmdirSync(tmpDir, { recursive: true } as Parameters<typeof rmdirSync>[1]);
    } catch {}
  } else {
    log(`✅ Batch files generated in ${tmpDir}. Run without --generate-only to upload.`);
  }
}

main().catch((err) => {
  console.error("[seed] Fatal error:", err);
  process.exit(1);
});
