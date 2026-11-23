/**
 * Standalone runner — starts the Telegram module directly, no Pulse
 * dashboard/HTTP server/observability modules. Config comes from env vars
 * (set via docker-compose's env_file + environment).
 */

import { startTelegram } from "./telegram"

const allowedUsers = (process.env.TELEGRAM_ALLOWED_USERS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number)

await startTelegram({
  enabled: true,
  bot_token: process.env.TELEGRAM_BOT_TOKEN,
  allowed_users: allowedUsers,
  workspace_root: process.env.WORKSPACE_ROOT ?? `${process.env.HOME}/workspace`,
  identity_dir: process.env.IDENTITY_DIR ?? `${process.env.HOME}/identity`,
  inbox_dir: process.env.INBOX_DIR,
  da_name: process.env.DA_NAME,
  principal_name: process.env.PRINCIPAL_NAME,
  sdk_inactivity_ms: process.env.SDK_INACTIVITY_MS ? Number(process.env.SDK_INACTIVITY_MS) : undefined,
  sdk_hard_cap_ms: process.env.SDK_HARD_CAP_MS ? Number(process.env.SDK_HARD_CAP_MS) : undefined,
  max_turns: process.env.MAX_TURNS ? Number(process.env.MAX_TURNS) : undefined,
})
