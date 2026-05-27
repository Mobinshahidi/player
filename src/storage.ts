import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { Readable } from "stream";
import * as toml from "@iarna/toml";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export type StorageMode = "local" | "cloud";
export type StorageProviderName =
  | "arvan"
  | "aws-s3"
  | "cloudflare-r2"
  | "other-s3";

export interface StorageConfigFile {
  mode: StorageMode;
  provider?: StorageProviderName;
}

export interface S3ProviderConfig {
  provider: StorageProviderName;
  accessKeyId: string;
  secretAccessKey: string;
  endpointUrl?: string;
  bucket: string;
  region?: string;
  forcePathStyle?: boolean;
}

export interface StorageSecretsFile {
  mode?: StorageMode;
  provider?: StorageProviderName;
  providers: Partial<Record<StorageProviderName, Partial<S3ProviderConfig>>>;
}

export interface StorageSelection {
  mode: StorageMode;
  provider?: StorageProviderName;
  s3?: S3ProviderConfig;
  warnings: string[];
  errors: string[];
  source: "secrets" | "config" | "env" | "default";
  secretsPath?: string | null;
}

export interface StorageProvider {
  getFile(key: string): Promise<Buffer | null>;
  putFile(key: string, data: Buffer, contentType?: string): Promise<void>;
  deleteFile(key: string): Promise<void>;
  listFiles(prefix?: string): Promise<string[]>;
  metadata(key: string): Promise<FileInfo | null>;
  validateAccess?(): Promise<void>;
}

export interface FileInfo {
  size: number;
  lastModified?: Date;
  etag?: string;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeMode(input?: string): StorageMode | null {
  if (!input) return null;
  const v = input.trim().toLowerCase();
  if (v === "local") return "local";
  if (v === "cloud") return "cloud";
  return null;
}

export function normalizeProviderName(input?: string): StorageProviderName | null {
  if (!input) return null;
  const v = input.trim().toLowerCase();
  if (v === "arvan" || v === "arvancloud") return "arvan";
  if (v === "aws" || v === "aws-s3" || v === "aws_s3" || v === "s3")
    return "aws-s3";
  if (
    v === "cloudflare" ||
    v === "cloudflare-r2" ||
    v === "cloudflare_r2" ||
    v === "r2"
  )
    return "cloudflare-r2";
  if (
    v === "other" ||
    v === "other-s3" ||
    v === "other_s3" ||
    v === "s3-compatible" ||
    v === "s3_compatible"
  )
    return "other-s3";
  return null;
}

export function readStorageConfig(filePath: string): StorageConfigFile | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    if (!raw || typeof raw !== "object") return null;
    const mode = normalizeMode(String(raw.mode ?? ""));
    if (!mode) return null;
    const provider = normalizeProviderName(String(raw.provider ?? "")) ?? undefined;
    return { mode, provider };
  } catch {
    return null;
  }
}

export function writeStorageConfig(filePath: string, config: StorageConfigFile): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(config, null, 2));
}

export function findSecretsFile(paths: string[]): string | null {
  for (const p of paths) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

export function parseSecretsToml(text: string): StorageSecretsFile {
  const parsed = toml.parse(text) as any;
  const storage = parsed?.storage ?? {};
  const mode = normalizeMode(readString(storage.mode));
  const provider = normalizeProviderName(readString(storage.provider));
  const providers: StorageSecretsFile["providers"] = {};
  const mapping: Record<StorageProviderName, string> = {
    "arvan": "arvan",
    "aws-s3": "aws_s3",
    "cloudflare-r2": "cloudflare_r2",
    "other-s3": "other_s3",
  };
  for (const [name, key] of Object.entries(mapping)) {
    const block = storage?.[key];
    if (!block || typeof block !== "object") continue;
    providers[name as StorageProviderName] = {
      accessKeyId: readString(block.access_key_id),
      secretAccessKey: readString(block.secret_access_key),
      endpointUrl: readString(block.endpoint_url),
      bucket: readString(block.bucket),
      region: readString(block.region),
    };
  }
  return { mode: mode ?? undefined, provider: provider ?? undefined, providers };
}

export function readSecretsFile(filePath: string): StorageSecretsFile {
  const raw = readFileSync(filePath, "utf-8");
  return parseSecretsToml(raw);
}

export function checkSecretsFilePermissions(filePath: string): string | null {
  try {
    const st = statSync(filePath);
    if ((st.mode & 0o077) !== 0) {
      return `Secrets file permissions are too open: ${filePath}. Restrict to 600.`;
    }
  } catch {}
  return null;
}

export function readEnvConfig(env: NodeJS.ProcessEnv): {
  mode?: StorageMode;
  provider?: StorageProviderName;
  s3?: Partial<S3ProviderConfig>;
} {
  const mode = normalizeMode(env.PLAYER_STORAGE_MODE);
  const provider = normalizeProviderName(env.PLAYER_STORAGE_PROVIDER);
  const envS3KeyId = readString(env.PLAYER_S3_ACCESS_KEY_ID);
  const envS3Secret = readString(env.PLAYER_S3_SECRET_ACCESS_KEY);
  const envS3Bucket = readString(env.PLAYER_S3_BUCKET);
  const envS3Endpoint = readString(env.PLAYER_S3_ENDPOINT_URL);
  const envS3Region = readString(env.PLAYER_S3_REGION);
  if (envS3KeyId && envS3Secret && envS3Bucket) {
    return {
      mode: mode ?? "cloud",
      provider: provider ?? "other-s3",
      s3: {
        accessKeyId: envS3KeyId,
        secretAccessKey: envS3Secret,
        bucket: envS3Bucket,
        endpointUrl: envS3Endpoint,
        region: envS3Region,
      },
    };
  }
  const arvanAccess = readString(env.PLAYER_ARVAN_ACCESS_KEY);
  const arvanSecret = readString(env.PLAYER_ARVAN_SECRET_KEY);
  const arvanBucket = readString(env.PLAYER_ARVAN_BUCKET);
  if (arvanAccess && arvanSecret && arvanBucket) {
    const arvanRegion = readString(env.PLAYER_ARVAN_REGION) ?? "ir-thr-at1";
    const arvanEndpoint =
      readString(env.PLAYER_ARVAN_ENDPOINT_URL) ??
      `https://s3.${arvanRegion}.arvanstorage.ir`;
    return {
      mode: mode ?? "cloud",
      provider: "arvan",
      s3: {
        accessKeyId: arvanAccess,
        secretAccessKey: arvanSecret,
        bucket: arvanBucket,
        endpointUrl: arvanEndpoint,
        region: arvanRegion,
      },
    };
  }
  return { mode: mode ?? undefined, provider: provider ?? undefined };
}

function buildS3Config(
  provider: StorageProviderName,
  raw: Partial<S3ProviderConfig> | undefined,
): { config?: S3ProviderConfig; errors: string[] } {
  const errors: string[] = [];
  const accessKeyId = readString(raw?.accessKeyId);
  const secretAccessKey = readString(raw?.secretAccessKey);
  const bucket = readString(raw?.bucket);
  const endpointUrl = readString(raw?.endpointUrl);
  const region = readString(raw?.region);
  if (!accessKeyId) errors.push("access_key_id");
  if (!secretAccessKey) errors.push("secret_access_key");
  if (!bucket) errors.push("bucket");
  if (provider !== "aws-s3" && !endpointUrl) errors.push("endpoint_url");
  if (provider === "aws-s3" && !region) errors.push("region");
  if (errors.length) return { errors };
  return {
    errors,
    config: {
      provider,
      accessKeyId: accessKeyId!,
      secretAccessKey: secretAccessKey!,
      bucket: bucket!,
      endpointUrl,
      region: region ?? (provider === "cloudflare-r2" ? "auto" : "us-east-1"),
      forcePathStyle: provider !== "aws-s3",
    },
  };
}

export function resolveStorageSelection(input: {
  config?: StorageConfigFile | null;
  secrets?: StorageSecretsFile | null;
  env?: ReturnType<typeof readEnvConfig> | null;
  secretsPath?: string | null;
}): StorageSelection {
  const warnings: string[] = [];
  const errors: string[] = [];
  const source: StorageSelection["source"] = input.secrets?.mode || input.secrets?.provider
    ? "secrets"
    : input.config?.mode || input.config?.provider
      ? "config"
      : input.env?.mode || input.env?.provider
        ? "env"
        : "default";
  const mode =
    input.secrets?.mode ?? input.config?.mode ?? input.env?.mode ?? "local";
  const provider =
    input.secrets?.provider ??
    input.config?.provider ??
    input.env?.provider ??
    undefined;
  let s3Config: S3ProviderConfig | undefined;
  if (mode === "cloud") {
    if (!provider) {
      errors.push("storage.provider");
    } else {
      const secretProvider = input.secrets?.providers?.[provider];
      const envProvider = input.env?.s3;
      const raw = secretProvider ?? envProvider;
      if (!raw) {
        errors.push("secrets_file_missing");
      } else {
        const built = buildS3Config(provider, raw);
        if (built.errors.length) {
          errors.push(...built.errors.map((e) => `${provider}.${e}`));
        } else {
          s3Config = built.config;
        }
      }
    }
  }
  if (mode === "cloud" && !input.secrets && !input.env?.s3) {
    warnings.push("Cloud mode selected but no secrets file found.");
  }
  return {
    mode,
    provider,
    s3: s3Config,
    warnings,
    errors,
    source,
    secretsPath: input.secretsPath ?? null,
  };
}

export class LocalStorageProvider implements StorageProvider {
  constructor(private baseDir: string) {}

  private resolvePath(key: string): string {
    return join(this.baseDir, key);
  }

  async getFile(key: string): Promise<Buffer | null> {
    const p = this.resolvePath(key);
    if (!existsSync(p)) return null;
    return readFileSync(p);
  }

  async putFile(key: string, data: Buffer): Promise<void> {
    const p = this.resolvePath(key);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
  }

  async deleteFile(key: string): Promise<void> {
    const p = this.resolvePath(key);
    if (!existsSync(p)) return;
    unlinkSync(p);
  }

  async listFiles(prefix = ""): Promise<string[]> {
    const dir = this.resolvePath(prefix);
    if (!existsSync(dir)) return [];
    const entries = await new Promise<string[]>((resolve) => {
      import("fs").then((fs) => {
        fs.readdir(dir, { withFileTypes: true }, (err, files) => {
          if (err) return resolve([]);
          resolve(
            files
              .filter((f) => f.isFile())
              .map((f) => (prefix ? join(prefix, f.name) : f.name)),
          );
        });
      });
    });
    return entries;
  }

  async metadata(key: string): Promise<FileInfo | null> {
    const p = this.resolvePath(key);
    if (!existsSync(p)) return null;
    const st = statSync(p);
    return { size: st.size, lastModified: st.mtime };
  }
}

export class S3StorageProvider implements StorageProvider {
  private client: S3Client;
  private bucket: string;
  private region: string;

  constructor(private cfg: S3ProviderConfig, client?: S3Client) {
    this.bucket = cfg.bucket;
    this.region = cfg.region ?? "us-east-1";
    this.client =
      client ??
      new S3Client({
        region: this.region,
        endpoint: cfg.endpointUrl,
        credentials: {
          accessKeyId: cfg.accessKeyId,
          secretAccessKey: cfg.secretAccessKey,
        },
        forcePathStyle: cfg.forcePathStyle ?? false,
      });
  }

  async validateAccess(): Promise<void> {
    await this.client.send(
      new HeadBucketCommand({ Bucket: this.bucket }),
    );
  }

  async getFile(key: string): Promise<Buffer | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!res.Body) return null;
      return await streamToBuffer(res.Body as Readable);
    } catch (e: any) {
      const code = e?.$metadata?.httpStatusCode;
      if (code === 404 || e?.name === "NoSuchKey") return null;
      throw e;
    }
  }

  async putFile(
    key: string,
    data: Buffer,
    contentType = "application/json",
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
      }),
    );
  }

  async deleteFile(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async listFiles(prefix = ""): Promise<string[]> {
    const res = await this.client.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix }),
    );
    return (
      res.Contents?.map((c) => c.Key).filter((k): k is string => !!k) ?? []
    );
  }

  async metadata(key: string): Promise<FileInfo | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        size: res.ContentLength ?? 0,
        lastModified: res.LastModified,
        etag: res.ETag,
      };
    } catch (e: any) {
      const code = e?.$metadata?.httpStatusCode;
      if (code === 404 || e?.name === "NotFound") return null;
      throw e;
    }
  }
}

export class StorageService {
  constructor(
    public mode: StorageMode,
    public providerName: StorageProviderName | null,
    private remote: StorageProvider | null,
  ) {}

  isCloudEnabled(): boolean {
    return this.mode === "cloud" && !!this.remote;
  }

  disableRemote(): void {
    this.remote = null;
  }

  async validateRemoteAccess(): Promise<void> {
    if (!this.remote?.validateAccess) return;
    await this.remote.validateAccess();
  }

  async getRemoteFile(key: string): Promise<Buffer | null> {
    if (!this.remote) return null;
    return this.remote.getFile(key);
  }

  async putRemoteFile(
    key: string,
    data: Buffer,
    contentType?: string,
  ): Promise<void> {
    if (!this.remote) return;
    await this.remote.putFile(key, data, contentType);
  }

  async deleteRemoteFile(key: string): Promise<void> {
    if (!this.remote) return;
    await this.remote.deleteFile(key);
  }

  async listRemoteFiles(prefix = ""): Promise<string[]> {
    if (!this.remote) return [];
    return this.remote.listFiles(prefix);
  }

  async remoteMetadata(key: string): Promise<FileInfo | null> {
    if (!this.remote) return null;
    return this.remote.metadata(key);
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
