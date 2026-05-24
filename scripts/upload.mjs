#!/usr/bin/env node
/**
 * upload.mjs
 *
 * Reads fingerprints.json, splits it into chunks of CHUNK_SIZE,
 * and uploads each chunk + a meta key to Cloudflare KV via the REST API.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=<token> \
 *   CLOUDFLARE_ACCOUNT_ID=<account_id> \
 *   KV_NAMESPACE_ID=<namespace_id> \
 *   node scripts/upload.mjs [path/to/fingerprints.json]
 *
 * Or with wrangler env vars already set:
 *   node scripts/upload.mjs
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// ─── Config ───────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 100; // fingerprints per KV value (~2.3 MB each)
const CONCURRENCY = 5; // parallel KV write requests
const API_BASE = "https://api.cloudflare.com/client/v4";

const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const NAMESPACE_ID = process.env.KV_NAMESPACE_ID;
const FP_FILE = process.argv[2]
  ? resolve(process.argv[2])
  : resolve("fingerprints.json");

// ─── Validation ───────────────────────────────────────────────────────────────

if (!API_TOKEN || !ACCOUNT_ID || !NAMESPACE_ID) {
  console.error(
    "❌  Missing environment variables.\n" +
      "   Required: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, KV_NAMESPACE_ID"
  );
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Write a single KV key using the Cloudflare REST API */
async function putKV(key, value) {
  const url = `${API_BASE}/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`KV PUT failed for key "${key}": ${res.status} ${body}`);
  }
}

/** Run tasks with bounded concurrency */
async function pool(tasks, concurrency) {
  const results = [];
  const executing = new Set();

  for (const task of tasks) {
    const p = Promise.resolve().then(task);
    results.push(p);
    executing.add(p);
    p.finally(() => executing.delete(p));

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log(`📂  Reading ${FP_FILE} …`);
let fingerprints;
try {
  fingerprints = JSON.parse(readFileSync(FP_FILE, "utf8"));
} catch (err) {
  console.error(`❌  Failed to read fingerprints file: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(fingerprints)) {
  console.error("❌  fingerprints.json must be a JSON array");
  process.exit(1);
}

const total = fingerprints.length;
const chunks = Math.ceil(total / CHUNK_SIZE);

console.log(`✅  Loaded ${total} fingerprints → ${chunks} chunks of ${CHUNK_SIZE}`);
console.log(`🚀  Uploading to KV namespace ${NAMESPACE_ID} …\n`);

let done = 0;

const tasks = Array.from({ length: chunks }, (_, i) => async () => {
  const chunkData = fingerprints.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
  const key = `fp:chunk:${i}`;
  await putKV(key, JSON.stringify(chunkData));
  done++;
  process.stdout.write(
    `\r  Chunk ${done}/${chunks} uploaded  (${Math.round((done / chunks) * 100)}%)`
  );
});

await pool(tasks, CONCURRENCY);

// Write meta key last
const meta = {
  count: total,
  chunkSize: CHUNK_SIZE,
  chunks,
  uploadedAt: new Date().toISOString(),
};
await putKV("fp:meta", JSON.stringify(meta));

console.log(`\n\n✅  Done! ${total} fingerprints in ${chunks} chunks.\n`);
console.log(`   Meta key written: fp:meta`);
console.log(`   Chunk keys: fp:chunk:0 … fp:chunk:${chunks - 1}`);
