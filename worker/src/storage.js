import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { downloadTelegramFile, telegramDownloadLimit } from "./telegram/poll.js";

let client;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is empty`);
  return value;
}

function s3() {
  client ||= new S3Client({
    region: "fsn1",
    endpoint: required("HETZNER_S3_ENDPOINT"),
    credentials: {
      accessKeyId: required("HETZNER_S3_ACCESS_KEY"),
      secretAccessKey: required("HETZNER_S3_SECRET_KEY"),
    },
    forcePathStyle: true,
  });
  return client;
}

export async function putObject(key, bytes, contentType) {
  await s3().send(new PutObjectCommand({
    Bucket: required("HETZNER_S3_BUCKET"),
    Key: key,
    Body: bytes,
    ContentLength: bytes.length,
    ContentType: contentType,
  }));
}

export async function materializeObject(key, destination) {
  const response = await s3().send(new GetObjectCommand({
    Bucket: required("HETZNER_S3_BUCKET"), Key: key,
  }));
  if (!response.Body) throw new Error("stored attachment has no body");
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, Buffer.from(await response.Body.transformToByteArray()));
}

export function safeFileName(name) {
  return String(name || "file").replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "file";
}

export async function archiveAttachments(message, jobId, existing = [], {
  download = downloadTelegramFile,
  upload = putObject,
} = {}) {
  const artifacts = Array.isArray(existing) ? [...existing] : [];
  for (const [index, file] of (message.files || []).entries()) {
    if (artifacts.some((item) => item.sourceIndex === index && item.kind !== "location")) continue;
    const name = safeFileName(file.name);
    const base = { sourceIndex: index, kind: file.kind || "document", name,
      mimeType: file.mimeType || "application/octet-stream", size: file.size ?? null };
    if (file.size > telegramDownloadLimit) {
      artifacts.push({ ...base, status: "unavailable", reason: "telegram_download_limit" });
      continue;
    }
    let bytes;
    try {
      bytes = await download(file.id);
    } catch (error) {
      if (/file.*(?:too big|exceeds 20 MB)/i.test(String(error.message || error))) {
        artifacts.push({ ...base, status: "unavailable", reason: "telegram_download_limit" });
        continue;
      }
      throw error;
    }
    const objectKey = `telegram-inbox/${jobId}/${index}-${name}`;
    await upload(objectKey, bytes, base.mimeType);
    artifacts.push({ ...base, size: bytes.length, status: "stored", objectKey });
  }
  if (message.location && !artifacts.some((item) => item.kind === "location")) {
    const objectKey = `telegram-inbox/${jobId}/location.json`;
    const bytes = Buffer.from(JSON.stringify(message.location));
    await upload(objectKey, bytes, "application/json");
    artifacts.push({ kind: "location", status: "stored", objectKey,
      ...message.location });
  }
  return artifacts;
}
