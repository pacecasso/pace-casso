import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-secret-material";
delete process.env.BLOB_READ_WRITE_TOKEN; // force the filesystem backend

async function main(): Promise<void> {
  const { saveJobRecord, loadJobRecord, newJobId, jobStepToken, jobStoreConfigured } =
    await import("./routeJobStore");

  assert.ok(jobStoreConfigured(), "fs fallback counts as configured outside production");

  const id = newJobId();
  assert.match(id, /^[0-9a-f]{32}$/, "job ids are 32 hex chars");

  // roundtrip
  const record = { status: "running", email: "x@y.z", nested: { chain: [[40.7, -74.0]] } };
  await saveJobRecord(id, record);
  const loaded = await loadJobRecord<typeof record>(id);
  assert.deepStrictEqual(loaded, record, "encrypt/decrypt roundtrip preserves the record");

  // stored bytes are ciphertext — the email must not appear in plaintext
  const raw = await fs.readFile(path.join(process.cwd(), ".route-jobs", `${id}.bin`));
  assert.ok(!raw.includes(Buffer.from("x@y.z")), "job data is encrypted at rest");

  // tampering is detected (GCM auth tag) and read as missing, not garbage
  const flipped = Buffer.from(raw);
  flipped[flipped.length - 1] ^= 0xff;
  await fs.writeFile(path.join(process.cwd(), ".route-jobs", `${id}.bin`), flipped);
  assert.strictEqual(await loadJobRecord(id), null, "tampered record reads as null");

  // invalid ids never touch the store
  assert.strictEqual(await loadJobRecord("../../etc/passwd"), null);
  await assert.rejects(() => saveJobRecord("not-a-job-id", {}), /bad job id/);

  // step tokens are stable per job and differ across jobs
  assert.strictEqual(jobStepToken(id), jobStepToken(id));
  assert.notStrictEqual(jobStepToken(id), jobStepToken(newJobId()));

  await fs.rm(path.join(process.cwd(), ".route-jobs", `${id}.bin`), { force: true });
  console.log("routeJobStore tests ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
