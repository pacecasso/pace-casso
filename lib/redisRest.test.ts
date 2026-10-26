import assert from "node:assert";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-secret-material";
process.env.KV_REST_API_URL = "https://fake-redis.test/";
process.env.KV_REST_API_TOKEN = "tok";
// Blob is set too: Redis must win, and nothing may touch Blob
process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_fake_fake";

/** an in-memory stand-in for the Upstash REST endpoint: SET/GET/ZADD/ZREM/ZRANGE */
const kv = new Map<string, string>();
const z = new Map<string, number>();
const seen: string[][] = [];
globalThis.fetch = (async (url: string, init: RequestInit) => {
  assert.strictEqual(url, "https://fake-redis.test", "trailing slash stripped");
  assert.strictEqual((init.headers as Record<string, string>).Authorization, "Bearer tok");
  const cmd = JSON.parse(String(init.body)) as string[];
  seen.push(cmd);
  let result: unknown = null;
  switch (cmd[0]) {
    case "SET":
      kv.set(cmd[1], cmd[2]);
      result = "OK";
      break;
    case "GET":
      result = kv.get(cmd[1]) ?? null;
      break;
    case "ZADD":
      if (!z.has(cmd[4])) z.set(cmd[4], Number(cmd[3]));
      break;
    case "ZREM":
      z.delete(cmd[2]);
      break;
    case "ZRANGE":
      result = [...z.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k);
      break;
    default:
      return new Response(JSON.stringify({ error: `unknown ${cmd[0]}` }), { status: 400 });
  }
  return new Response(JSON.stringify({ result }), { status: 200 });
}) as typeof fetch;

async function main(): Promise<void> {
  const { redis, redisConfigured } = await import("./redisRest");
  const { saveJobRecord, loadJobRecord, newJobId, jobStoreConfigured } = await import("./routeJobStore");
  const { enqueue, dequeue, queuedIds, setQueueFlag } = await import("./drawJob");

  assert.ok(redisConfigured());
  assert.ok(jobStoreConfigured());

  // job records round-trip, encrypted, with an expiry
  const id = newJobId();
  const record = { status: "queued", email: "x@y.z" };
  await saveJobRecord(id, record);
  assert.deepStrictEqual(await loadJobRecord(id), record);
  const stored = kv.get(`route-jobs:${id}`)!;
  assert.ok(!Buffer.from(stored, "base64").includes(Buffer.from("x@y.z")), "encrypted at rest");
  const set = seen.find((c) => c[0] === "SET")!;
  assert.deepStrictEqual(set.slice(3), ["EX", String(60 * 24 * 3600)], "records expire");
  assert.strictEqual(await loadJobRecord(newJobId()), null, "missing record reads as null");

  // queue: oldest first, enqueue twice keeps the first position, dequeue removes
  const a = newJobId();
  const b = newJobId();
  await enqueue(a);
  await new Promise((r) => setTimeout(r, 5));
  await enqueue(b);
  await enqueue(a);
  assert.deepStrictEqual(await queuedIds(), [a, b]);
  await dequeue(a);
  assert.deepStrictEqual(await queuedIds(), [b]);
  await dequeue(b);
  assert.deepStrictEqual(await queuedIds(), []);

  // no flag blob on Redis
  assert.strictEqual(await setQueueFlag(false), null);

  // Redis errors surface as exceptions
  await assert.rejects(() => redis(["NOPE"]), /Redis NOPE: unknown NOPE/);

  console.log("redisRest tests ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
