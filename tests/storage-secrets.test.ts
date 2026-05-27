import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSecretsToml } from "../src/storage.js";

test("parseSecretsToml extracts storage config", () => {
  const raw = `
[storage]
mode = "cloud"
provider = "arvan"

[storage.arvan]
access_key_id = "AKIA_TEST"
secret_access_key = "SECRET_TEST"
endpoint_url = "https://s3.ir-thr-at1.arvanstorage.ir"
bucket = "player-test"
region = "ir-thr-at1"
`;
  const parsed = parseSecretsToml(raw);
  assert.equal(parsed.mode, "cloud");
  assert.equal(parsed.provider, "arvan");
  assert.equal(parsed.providers["arvan"]?.endpointUrl, "https://s3.ir-thr-at1.arvanstorage.ir");
  assert.equal(parsed.providers["arvan"]?.bucket, "player-test");
});
