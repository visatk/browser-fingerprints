import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Env {
  FINGERPRINTS_KV: KVNamespace;
  /** Optional API key for protected write/admin routes */
  API_KEY?: string;
}

type Variables = Record<string, never>;

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Middleware
app.use("*", cors());
app.use("*", logger());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cryptographically secure random integer in [0, max). */
function randomInt(max: number): number {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return array[0] % max;
}

/** Pick `n` unique random indices from [0, total). */
function uniqueRandomIndices(total: number, n: number): number[] {
  const count = Math.min(n, total);
  const indices = new Set<number>();
  // Fallback safety: avoid infinite loop if n >= total
  while (indices.size < count) {
    indices.add(randomInt(total));
  }
  return [...indices];
}

/** Fetch a single fingerprint from KV by index. */
async function getFingerprintById(
  kv: KVNamespace,
  id: number
): Promise<unknown | null> {
  const raw = await kv.get(`fp:${id}`, { type: "text" });
  if (!raw) return null;
  return JSON.parse(raw) as unknown;
}

/** Fetch total fingerprint count stored in KV. */
async function getCount(kv: KVNamespace): Promise<number> {
  const raw = await kv.get("meta:count", { type: "text" });
  return raw ? parseInt(raw, 10) : 0;
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

function errorResponse(c: Parameters<typeof app.get>[1], status: 400 | 404 | 429 | 500, message: string) {
  return c.json({ success: false, error: message }, status);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Health check */
app.get("/", (c) => {
  return c.json({
    name: "Fingerprints API",
    version: "1.0.0",
    endpoints: {
      "GET /api/fingerprint": "Random fingerprint",
      "GET /api/fingerprint?count=N": "N random fingerprints (max 50)",
      "GET /api/fingerprint/:id": "Specific fingerprint by index",
      "GET /api/stats": "Dataset statistics",
    },
  });
});

/**
 * GET /api/fingerprint
 * Query params:
 *   count  – number of fingerprints to return (1–50, default 1)
 *   seed   – optional integer seed for deterministic selection
 */
app.get("/api/fingerprint", async (c) => {
  const total = await getCount(c.env.FINGERPRINTS_KV);

  if (total === 0) {
    return errorResponse(c, 503 as 500, "Fingerprint dataset is empty. Run the seed script first.");
  }

  const rawCount = c.req.query("count");
  const count = rawCount ? parseInt(rawCount, 10) : 1;

  if (isNaN(count) || count < 1 || count > 50) {
    return errorResponse(c, 400, "count must be an integer between 1 and 50.");
  }

  const indices = uniqueRandomIndices(total, count);

  const results = await Promise.all(
    indices.map((id) => getFingerprintById(c.env.FINGERPRINTS_KV, id))
  );

  const fingerprints = results.filter(Boolean);

  if (count === 1) {
    return c.json({
      success: true,
      id: indices[0],
      fingerprint: fingerprints[0] ?? null,
    });
  }

  return c.json({
    success: true,
    total_requested: count,
    total_returned: fingerprints.length,
    fingerprints: fingerprints.map((fp, i) => ({ id: indices[i], fingerprint: fp })),
  });
});

/**
 * GET /api/fingerprint/:id
 * Returns a specific fingerprint by its numeric index.
 */
app.get("/api/fingerprint/:id", async (c) => {
  const rawId = c.req.param("id");
  const id = parseInt(rawId, 10);

  if (isNaN(id) || id < 0) {
    return errorResponse(c, 400, "id must be a non-negative integer.");
  }

  const total = await getCount(c.env.FINGERPRINTS_KV);
  if (total === 0) {
    return errorResponse(c, 503 as 500, "Fingerprint dataset is empty. Run the seed script first.");
  }

  if (id >= total) {
    return errorResponse(c, 404, `id ${id} is out of range. Dataset has ${total} fingerprints (0–${total - 1}).`);
  }

  const fingerprint = await getFingerprintById(c.env.FINGERPRINTS_KV, id);
  if (!fingerprint) {
    return errorResponse(c, 404, `Fingerprint ${id} not found in KV.`);
  }

  return c.json({ success: true, id, fingerprint });
});

/**
 * GET /api/stats
 * Returns metadata about the stored dataset.
 */
app.get("/api/stats", async (c) => {
  const total = await getCount(c.env.FINGERPRINTS_KV);
  return c.json({
    success: true,
    stats: {
      total_fingerprints: total,
      index_range: total > 0 ? { min: 0, max: total - 1 } : null,
      seeded: total > 0,
    },
  });
});

// Catch-all 404
app.notFound((c) => {
  return c.json({ success: false, error: "Route not found." }, 404);
});

// Global error handler
app.onError((err, c) => {
  console.error(JSON.stringify({ event: "unhandled_error", message: err.message, stack: err.stack }));
  return c.json({ success: false, error: "Internal server error." }, 500);
});

export default app;
