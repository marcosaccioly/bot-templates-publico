/**
 * Runner standalone do bot de __CLIENT_NAME__ — sem Pulse, sem dashboard.
 * Toda a config vem de env (docker-compose env_file + environment).
 */
import { startTelegramRepoBot } from "./telegram-repobot"

await startTelegramRepoBot({
  enabled: true,
  model: process.env.BOT_MODEL ?? "claude-sonnet-5",
  fallback_model: process.env.BOT_FALLBACK_MODEL ?? "claude-opus-4-8",
  // 15 (default) corta no meio montar um documento + PDF (lição do tenant-c,
  // 25/09). O teto de parede (sdk_hard_cap_ms) segue como trava de custo.
  max_turns: Number(process.env.BOT_MAX_TURNS ?? 40),
  sdk_inactivity_ms: Number(process.env.BOT_SDK_INACTIVITY_MS ?? 180000),
  sdk_hard_cap_ms: Number(process.env.BOT_SDK_HARD_CAP_MS ?? 900000),
})
