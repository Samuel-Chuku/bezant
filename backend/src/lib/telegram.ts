// Thin wrapper over the Telegram Bot API. No SDK — just HTTPS calls.
//
// If TELEGRAM_BOT_TOKEN is unset every function is a no-op, so local dev and
// deployments that haven't configured the bot keep working (Telegram alerts
// simply stay off).
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const api = (method: string) => `https://api.telegram.org/bot${TOKEN}/${method}`;

export function telegramEnabled(): boolean {
  return Boolean(TOKEN);
}

// Cached getMe().username — used to build the `t.me/<bot>?start=<token>`
// deep link so the frontend never needs the token or the username.
let cachedUsername: string | null = null;
export async function getBotUsername(): Promise<string | null> {
  if (cachedUsername) return cachedUsername;
  if (!TOKEN) return null;
  try {
    const res = await fetch(api('getMe'));
    const data = (await res.json()) as { ok: boolean; result?: { username?: string } };
    cachedUsername = data.ok && data.result?.username ? data.result.username : null;
    return cachedUsername;
  } catch {
    return null;
  }
}

export async function sendTelegramMessage(chatId: string, text: string): Promise<boolean> {
  if (!TOKEN) return false;
  try {
    const res = await fetch(api('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Register the webhook so Telegram pushes /start updates to our backend.
// `secret` is echoed back by Telegram in the X-Telegram-Bot-Api-Secret-Token
// header, which the webhook route verifies.
export async function setTelegramWebhook(url: string, secret?: string): Promise<boolean> {
  if (!TOKEN) return false;
  try {
    const res = await fetch(api('setWebhook'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        secret_token: secret || undefined,
        allowed_updates: ['message'],
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
