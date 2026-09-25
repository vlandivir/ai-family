import { agentBusy, runAgent } from "./agent/run.js";
import { poll, sendMessage } from "./telegram/poll.js";

if (!process.env.TELEGRAM_ALLOWED_USER_IDS?.trim()) {
  console.error("TELEGRAM_ALLOWED_USER_IDS is empty, nobody is allowed");
}

await poll(async (chatId, userId, text) => {
  if (text === "/start") {
    await sendMessage(chatId, "Можно писать задачу.");
    return;
  }
  if (agentBusy()) {
    await sendMessage(chatId, "Уже занят, подожди.");
    return;
  }
  await sendMessage(chatId, "Беру в работу.");
  try {
    const answer = await runAgent(userId, text);
    await sendMessage(chatId, answer);
  } catch (error) {
    await sendMessage(chatId, `Не вышло: ${error.message}`);
  }
});
