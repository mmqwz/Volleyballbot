import "dotenv/config";

const token = process.env.BOT_TOKEN?.trim();
if (!token) {
  console.error("Не задан BOT_TOKEN. Скопируйте .env.example в .env и укажите токен.");
  process.exit(1);
}

const adminIds = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s))
  .filter((n) => Number.isFinite(n));

if (adminIds.length === 0) {
  console.warn(
    "ADMIN_IDS пуст — никто не сможет создавать события. Укажите свой Telegram ID в .env"
  );
}

export const config = {
  token,
  adminIds,
  /** HTTP/HTTPS/SOCKS прокси, например http://127.0.0.1:7890 */
  proxyUrl:
    process.env.PROXY_URL?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    "",
};

export function isAdmin(userId) {
  return config.adminIds.includes(Number(userId));
}
