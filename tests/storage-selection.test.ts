import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStorageSelection, type StorageSecretsFile } from "../src/storage.js";

test("resolveStorageSelection uses secrets config for cloud", () => {
  const secrets: StorageSecretsFile = {
    mode: "cloud",
    provider: "aws-s3",
    providers: {
      "aws-s3": {
        accessKeyId: "AKIA_TEST",
        secretAccessKey: "SECRET_TEST",
        bucket: "player-test",
        endpointUrl: "https://s3.us-east-1.amazonaws.com",
        region: "us-east-1",
      },
    },
  };
  const selection = resolveStorageSelection({ secrets });
  assert.equal(selection.mode, "cloud");
  assert.equal(selection.provider, "aws-s3");
  assert.equal(selection.errors.length, 0);
  assert.ok(selection.s3);
  assert.equal(selection.s3?.bucket, "player-test");
});

test("resolveStorageSelection warns when secrets missing", () => {
  const selection = resolveStorageSelection({
    config: { mode: "cloud", provider: "cloudflare-r2" },
  });
  assert.equal(selection.mode, "cloud");
  assert.ok(selection.errors.length > 0);
});
