import { Bot } from "grammy";
import { ProxyAgent, fetch as undiciFetch } from "undici";

export function createBot(token, proxyUrl) {
  if (!proxyUrl) {
    return new Bot(token);
  }

  const agent = new ProxyAgent(proxyUrl);
  console.log("Используется прокси для Telegram API");

  return new Bot(token, {
    client: {
      fetch: (url, init = {}) => {
        // undici и Node дают разные AbortSignal — убираем конфликт
        const { signal, ...rest } = init;
        const opts = { ...rest, dispatcher: agent };
        if (signal) {
          const ac = new AbortController();
          if (signal.aborted) ac.abort();
          else signal.addEventListener("abort", () => ac.abort(), { once: true });
          opts.signal = ac.signal;
        }
        return undiciFetch(url, opts);
      },
    },
  });
}
