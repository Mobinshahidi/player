import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { S3StorageProvider } from "../src/storage.js";

class FakeS3Client {
  constructor(private handlers: Record<string, (cmd: any) => any>) {}
  async send(cmd: any): Promise<any> {
    const name = cmd.constructor?.name ?? "";
    const handler = this.handlers[name];
    if (!handler) throw new Error(`Unhandled command: ${name}`);
    return handler(cmd);
  }
}

test("S3StorageProvider basic operations", async () => {
  const client = new FakeS3Client({
    HeadBucketCommand: () => ({}),
    GetObjectCommand: () => ({ Body: Readable.from([Buffer.from("hello")]) }),
    PutObjectCommand: () => ({}),
    DeleteObjectCommand: () => ({}),
    ListObjectsV2Command: () => ({ Contents: [{ Key: "a.json" }, { Key: "b.json" }] }),
    HeadObjectCommand: () => ({ ContentLength: 5, LastModified: new Date(0) }),
  });
  const provider = new S3StorageProvider(
    {
      provider: "other-s3",
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "SECRET_TEST",
      endpointUrl: "https://s3.example.com",
      bucket: "player-test",
      region: "us-east-1",
    },
    client as any,
  );

  await provider.validateAccess();
  const data = await provider.getFile("a.json");
  assert.equal(data?.toString("utf-8"), "hello");
  await provider.putFile("a.json", Buffer.from("hello"));
  await provider.deleteFile("a.json");
  const list = await provider.listFiles("");
  assert.deepEqual(list, ["a.json", "b.json"]);
  const meta = await provider.metadata("a.json");
  assert.equal(meta?.size, 5);
});
