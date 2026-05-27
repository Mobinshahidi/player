import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageProvider } from "../src/storage.js";

test("LocalStorageProvider put/get/delete/list", async () => {
  const root = mkdtempSync(join(tmpdir(), "player-local-"));
  const provider = new LocalStorageProvider(root);
  const key = "progress.json";
  await provider.putFile(key, Buffer.from("hello"));
  const out = await provider.getFile(key);
  assert.equal(out?.toString("utf-8"), "hello");
  const list = await provider.listFiles("");
  assert.ok(list.includes(key));
  const meta = await provider.metadata(key);
  assert.equal(meta?.size, 5);
  await provider.deleteFile(key);
  const missing = await provider.getFile(key);
  assert.equal(missing, null);
  rmSync(root, { recursive: true, force: true });
});
