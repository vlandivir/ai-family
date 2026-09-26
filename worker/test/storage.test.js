import assert from "node:assert/strict";
import { test } from "node:test";
import { archiveAttachments } from "../src/storage.js";
import { messageContent, telegramDownloadLimit } from "../src/telegram/poll.js";

test("accepts location-only messages and classifies incoming media", () => {
  const location = { latitude: 44.8, longitude: 20.4 };
  assert.deepEqual(messageContent({ location }), { text: "", files: [], location });
  const content = messageContent({
    caption: "смотри",
    photo: [{ file_id: "small", file_size: 1 }, { file_id: "large", file_size: 2 }],
    video: { file_id: "video", file_size: 10 },
    document: { file_id: "file", file_name: "notes.pdf", mime_type: "application/pdf" },
  });
  assert.equal(content.text, "смотри");
  assert.deepEqual(content.files.map((item) => item.kind), ["document", "photo", "video"]);
  assert.equal(content.files[1].id, "large");
});

test("archives photo, video and location with stable keys", async () => {
  const uploaded = [];
  const message = {
    files: [
      { id: "photo-id", name: "photo.jpg", kind: "photo", mimeType: "image/jpeg", size: 3 },
      { id: "video-id", name: "clip.mp4", kind: "video", mimeType: "video/mp4", size: 4 },
    ],
    location: { latitude: 44.8, longitude: 20.4 },
  };
  const deps = {
    download: async (id) => Buffer.from(id === "photo-id" ? "abc" : "film"),
    upload: async (key, bytes, mimeType) => uploaded.push({ key, bytes, mimeType }),
  };
  const artifacts = await archiveAttachments(message, "job-1", [], deps);
  assert.deepEqual(artifacts.map((item) => item.objectKey), [
    "telegram-inbox/job-1/0-photo.jpg",
    "telegram-inbox/job-1/1-clip.mp4",
    "telegram-inbox/job-1/location.json",
  ]);
  assert.deepEqual(artifacts.map((item) => item.kind), ["photo", "video", "location"]);
  assert.deepEqual(uploaded.map((item) => item.mimeType), ["image/jpeg", "video/mp4", "application/json"]);
  assert.deepEqual(JSON.parse(uploaded[2].bytes.toString()), message.location);
  assert.deepEqual(await archiveAttachments(message, "job-1", artifacts, deps), artifacts);
  assert.equal(uploaded.length, 3);
});

test("records oversized Telegram files without downloading or uploading them", async () => {
  const artifacts = await archiveAttachments({
    files: [{ id: "large", name: "large.mp4", kind: "video", size: telegramDownloadLimit + 1 }],
  }, "job-2", [], {
    download: async () => assert.fail("oversized file must not be downloaded"),
    upload: async () => assert.fail("oversized file must not be uploaded"),
  });
  assert.equal(artifacts[0].status, "unavailable");
  assert.equal(artifacts[0].reason, "telegram_download_limit");
});
