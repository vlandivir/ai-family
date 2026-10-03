import assert from "node:assert/strict";
import { test } from "node:test";
import { attachments } from "../src/telegram/poll.js";
import {
  parseWhisperOutput,
  splitVoiceAnswer,
  storedVoicePaths,
  transcribeVoice,
  voiceInstruction,
} from "../src/voice.js";

test("voice notes are marked separately from other audio", () => {
  const files = attachments({ voice: { file_id: "1", file_unique_id: "u", file_size: 12 } });
  assert.equal(files.length, 1);
  assert.equal(files[0].kind, "voice");
  assert.equal(files[0].name, "voice.ogg");
});

test("whisper output drops timestamps and keeps the words", () => {
  const text = parseWhisperOutput("[00:00:00.000 --> 00:00:01.200]  Zdravo\n[00:00:01.200 --> 00:00:02.000]   kako si\n");
  assert.equal(text, "Zdravo kako si");
});

test("voice answer splits the corrected transcript from the reply", () => {
  const spoken = splitVoiceAnswer("Вступление\n<<<TRANSCRIPT>>>\nHoću da idem.\n<<<END>>>\n\nХочу пойти.");
  assert.equal(spoken.transcript, "Hoću da idem.");
  assert.equal(spoken.answer, "Вступление\n\nХочу пойти.");
});

test("a reply without a transcript block stays intact", () => {
  assert.deepEqual(splitVoiceAnswer("Просто ответ"), { transcript: null, answer: "Просто ответ" });
});

test("only stored voice files are transcribed", () => {
  const paths = storedVoicePaths([
    { kind: "voice", status: "stored", sourceIndex: 0, name: "voice.ogg" },
    { kind: "photo", status: "stored", sourceIndex: 1, name: "photo.jpg" },
    { kind: "voice", status: "unavailable", sourceIndex: 2, name: "voice.ogg" },
  ], ["/inbox/job/0-voice.ogg", "/inbox/job/1-photo.jpg"]);
  assert.deepEqual(paths, ["/inbox/job/0-voice.ogg"]);
});

test("transcription converts the note and reads whisper text", async () => {
  const calls = [];
  const text = await transcribeVoice("/tmp/note.ogg", {
    bin: "whisper-cli",
    model: "/models/ggml-small.bin",
    ffmpeg: "ffmpeg",
    run: async (command, args) => {
      calls.push([command, args]);
      return { stdout: command === "ffmpeg" ? "" : "  zdravo svete\n" };
    },
  });
  assert.equal(text, "zdravo svete");
  assert.deepEqual(calls[0][0], "ffmpeg");
  assert.deepEqual(calls[1], ["whisper-cli", ["-m", "/models/ggml-small.bin", "-f", "/tmp/note.ogg.wav", "-l", "auto", "-nt", "-np"]]);
});

test("voice instruction asks to correct the transcript before answering", () => {
  const text = voiceInstruction("хочу да идем");
  assert.match(text, /хочу да идем/);
  assert.match(text, /по смыслу/);
  assert.match(text, /<<<TRANSCRIPT>>>/);
});
