import { rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export function parseWhisperOutput(stdout) {
  return String(stdout || "")
    .split("\n")
    .map((line) => line.replace(/^\[[0-9:.,\s>-]+\]\s*/, "").trim())
    .filter((line) => line && !/^(whisper_|ggml_)/i.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function splitVoiceAnswer(text) {
  const match = String(text || "").match(/<<<TRANSCRIPT>>>([\s\S]*?)<<<END>>>/);
  if (!match) return { transcript: null, answer: String(text || "").trim() };
  return {
    transcript: match[1].trim(),
    answer: String(text).replace(match[0], "").replace(/\n{3,}/g, "\n\n").trim(),
  };
}

export function storedVoicePaths(artifacts, filePaths) {
  return (artifacts || [])
    .filter((item) => item.kind === "voice" && item.status === "stored")
    .map((item) => (filePaths || []).find((path) => path.endsWith(`${item.sourceIndex}-${item.name}`)))
    .filter(Boolean);
}

export function voiceInstruction(raw) {
  return [
    "Это голосовое сообщение. Сырая расшифровка:",
    raw,
    "Сначала исправь расшифровку. Поправь сбои распознавания и то, что во фразе можно поправить, в том числе по смыслу. Не приписывай человеку то, чего он не говорил. Если фраза уже ясна, оставь её почти как есть.",
    "Исправленный текст — только сказанное, без перевода и без ответа — положи в блок:",
    "<<<TRANSCRIPT>>>",
    "текст",
    "<<<END>>>",
    "После блока ответь на исправленный текст по правилам этой темы. Блок в ответ не копируй: бот отправит расшифровку отдельным сообщением, а твой текст придёт ответом на неё.",
  ].join("\n");
}

export async function transcribeVoice(filePath, {
  run = exec,
  bin = process.env.WHISPER_BIN || "whisper-cli",
  model = process.env.WHISPER_MODEL || "/var/lib/ai-family/models/ggml-small.bin",
  ffmpeg = process.env.FFMPEG_BIN || "ffmpeg",
} = {}) {
  const wav = `${filePath}.wav`;
  const options = { timeout: 180_000, maxBuffer: 10 * 1024 * 1024 };
  try {
    await run(ffmpeg, ["-y", "-i", filePath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], options);
    const { stdout } = await run(bin, ["-m", model, "-f", wav, "-l", "auto", "-nt", "-np"], options);
    return parseWhisperOutput(stdout);
  } finally {
    await rm(wav, { force: true });
  }
}
