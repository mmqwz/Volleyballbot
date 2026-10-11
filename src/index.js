import { GrammyError, HttpError } from "grammy";
import { config, isAdmin } from "./config.js";
import { createBot } from "./createBot.js";
import {
  createEvent,
  getEvent,
  getParticipants,
  isJoined,
  joinEvent,
  leaveEvent,
  listActiveEvents,
  setAnnounceMessage,
  setEventStatus,
  closeDb,
} from "./db.js";
import { formatEventCard, formatParticipantList } from "./format.js";
import {
  adminEventKeyboard,
  cancelKeyboard,
  eventActionsKeyboard,
  eventsListKeyboard,
  mainMenu,
} from "./keyboards.js";

const bot = createBot(config.token, config.proxyUrl);

/** @type {Map<number, { step: string, draft: Record<string, unknown> }>} */
const sessions = new Map();

function displayName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || "Игрок";
}

function isAnnounceMessage(ctx, event) {
  const msg = ctx.callbackQuery?.message;
  if (!msg || !event) return false;
  return (
    event.announce_chat_id === msg.chat.id &&
    event.announce_message_id === msg.message_id
  );
}

async function refreshAnnounce(ctx, event) {
  if (!event.announce_chat_id || !event.announce_message_id) return;
  const participants = getParticipants(event.id);
  try {
    await ctx.api.editMessageText(
      event.announce_chat_id,
      event.announce_message_id,
      formatEventCard(event, participants),
      {
        parse_mode: "HTML",
        reply_markup: eventActionsKeyboard(event.id, false, { shared: true }),
      }
    );
  } catch {
    // сообщение могли удалить — игнорируем
  }
}

function helpText(admin) {
  const lines = [
    "🏐 Бот записи на волейбол",
    "",
    "Команды:",
    "/events — список событий",
    "/start — главное меню",
  ];
  if (admin) {
    lines.push(
      "",
      "Админ:",
      "/new_event — создать событие",
      "/admin — панель администратора",
      "",
      "При создании укажите: название, время, место, реквизиты оплаты и лимит мест."
    );
  }
  return lines.join("\n");
}

bot.command("start", async (ctx) => {
  const admin = isAdmin(ctx.from.id);
  sessions.delete(ctx.from.id);
  await ctx.reply(
    `Привет, ${displayName(ctx.from)}!\n\n${helpText(admin)}`,
    { reply_markup: mainMenu(admin) }
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(helpText(isAdmin(ctx.from.id)), {
    reply_markup: mainMenu(isAdmin(ctx.from.id)),
  });
});

bot.command("events", async (ctx) => {
  await showEvents(ctx);
});

bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.reply("Команда только для админов.");
    return;
  }
  await ctx.reply(
    "Админ-панель:\n\n• «➕ Создать событие» или /new_event\n• «🏐 События» — управление и публикация",
    { reply_markup: mainMenu(true) }
  );
});

bot.command("new_event", async (ctx) => {
  await startCreateEvent(ctx);
});

bot.hears("🏐 События", async (ctx) => showEvents(ctx));
bot.hears("ℹ️ Помощь", async (ctx) => {
  await ctx.reply(helpText(isAdmin(ctx.from.id)));
});
bot.hears("➕ Создать событие", async (ctx) => startCreateEvent(ctx));
bot.hears("🛠 Админ", async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.reply("Доступ только для админов.");
    return;
  }
  await ctx.reply(
    "Админ-панель:\n\n• Создайте событие\n• Откройте его в списке\n• Нажмите «Опубликовать», чтобы отправить карточку с кнопками записи",
    { reply_markup: mainMenu(true) }
  );
});

bot.hears("❌ Отмена", async (ctx) => {
  if (!sessions.has(ctx.from.id)) {
    await ctx.reply("Нечего отменять.", {
      reply_markup: mainMenu(isAdmin(ctx.from.id)),
    });
    return;
  }
  sessions.delete(ctx.from.id);
  await ctx.reply("Создание события отменено.", {
    reply_markup: mainMenu(isAdmin(ctx.from.id)),
  });
});

async function startCreateEvent(ctx) {
  if (!isAdmin(ctx.from.id)) {
    await ctx.reply("Создавать события могут только админы.");
    return;
  }
  sessions.set(ctx.from.id, { step: "title", draft: {} });
  await ctx.reply(
    "Создание события.\n\nШаг 1/5 — название (например: «Волейбол в пятницу»)",
    { reply_markup: cancelKeyboard() }
  );
}

async function showEvents(ctx) {
  const events = listActiveEvents();
  if (!events.length) {
    await ctx.reply("Пока нет активных событий.", {
      reply_markup: mainMenu(isAdmin(ctx.from.id)),
    });
    return;
  }
  await ctx.reply("Выберите событие:", {
    reply_markup: eventsListKeyboard(events),
  });
}

async function showEventDetails(ctx, eventId, { edit = false } = {}) {
  const event = getEvent(eventId);
  if (!event || event.status !== "active") {
    const text = "Событие не найдено или уже закрыто.";
    if (edit && ctx.callbackQuery) {
      await ctx.editMessageText(text);
    } else {
      await ctx.reply(text);
    }
    return;
  }

  const participants = getParticipants(eventId);
  const joined = isJoined(eventId, ctx.from.id);
  const text = formatEventCard(event, participants);
  const kb = eventActionsKeyboard(eventId, joined);

  if (isAdmin(ctx.from.id)) {
    kb.row()
      .text("📢 Опубликовать", `publish:${eventId}`)
      .text("🗑 Закрыть", `close:${eventId}`);
  }

  if (edit && ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
}

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const [action, rawId] = data.split(":");
  const eventId = Number(rawId);

  if (!Number.isFinite(eventId)) {
    await ctx.answerCallbackQuery({ text: "Некорректные данные" });
    return;
  }

  if (action === "event") {
    await ctx.answerCallbackQuery();
    await showEventDetails(ctx, eventId, { edit: false });
    return;
  }

  if (action === "refresh") {
    const event = getEvent(eventId);
    if (!event || event.status !== "active") {
      await ctx.answerCallbackQuery({ text: "Событие недоступно", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Список обновлён" });
    if (isAnnounceMessage(ctx, event)) {
      await refreshAnnounce(ctx, event);
    } else {
      await showEventDetails(ctx, eventId, { edit: true });
    }
    return;
  }

  if (action === "join") {
    const result = joinEvent(eventId, ctx.from);
    if (!result.ok) {
      const messages = {
        not_found: "Событие недоступно",
        already: "Вы уже записаны",
        full: "Мест больше нет",
      };
      await ctx.answerCallbackQuery({
        text: messages[result.reason] || "Не удалось записаться",
        show_alert: true,
      });
      return;
    }

    const list = formatParticipantList(result.participants);
    await ctx.answerCallbackQuery({ text: "Вы записаны!" });
    if (isAnnounceMessage(ctx, result.event)) {
      await refreshAnnounce(ctx, result.event);
    } else {
      await showEventDetails(ctx, eventId, { edit: true });
      await refreshAnnounce(ctx, result.event);
    }
    await ctx.reply(
      `✅ ${displayName(ctx.from)} записался(ась).\n\n👥 Актуальный список:\n${list}`
    );
    return;
  }

  if (action === "leave") {
    const result = leaveEvent(eventId, ctx.from.id);
    if (!result.ok) {
      const messages = {
        not_found: "Событие недоступно",
        not_joined: "Вы не были записаны",
      };
      await ctx.answerCallbackQuery({
        text: messages[result.reason] || "Не удалось отписаться",
        show_alert: true,
      });
      return;
    }

    const list = formatParticipantList(result.participants);
    await ctx.answerCallbackQuery({ text: "Вы отписались" });
    if (isAnnounceMessage(ctx, result.event)) {
      await refreshAnnounce(ctx, result.event);
    } else {
      await showEventDetails(ctx, eventId, { edit: true });
      await refreshAnnounce(ctx, result.event);
    }
    await ctx.reply(
      `❌ ${displayName(ctx.from)} отписался(ась).\n\n👥 Новый список участников:\n${list}`
    );
    return;
  }

  if (action === "publish") {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Только для админов", show_alert: true });
      return;
    }
    const event = getEvent(eventId);
    if (!event || event.status !== "active") {
      await ctx.answerCallbackQuery({ text: "Событие недоступно", show_alert: true });
      return;
    }
    const participants = getParticipants(eventId);
    const msg = await ctx.reply(formatEventCard(event, participants), {
      parse_mode: "HTML",
      reply_markup: eventActionsKeyboard(eventId, false, { shared: true }),
    });
    setAnnounceMessage(eventId, msg.chat.id, msg.message_id);
    await ctx.answerCallbackQuery({ text: "Опубликовано" });
    return;
  }

  if (action === "close") {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Только для админов", show_alert: true });
      return;
    }
    setEventStatus(eventId, "closed");
    await ctx.answerCallbackQuery({ text: "Событие закрыто" });
    await ctx.editMessageText("Событие закрыто и больше не принимает записи.");
    return;
  }

  await ctx.answerCallbackQuery();
});

bot.on("message:text", async (ctx, next) => {
  const session = sessions.get(ctx.from.id);
  if (!session) {
    await next();
    return;
  }
  if (!isAdmin(ctx.from.id)) {
    sessions.delete(ctx.from.id);
    await next();
    return;
  }

  const text = ctx.message.text.trim();
  if (text === "❌ Отмена") {
    await next();
    return;
  }

  if (session.step === "title") {
    session.draft.title = text;
    session.step = "time";
    await ctx.reply(
      "Шаг 2/5 — дата и время (например: «Пт 18.10 в 19:00»)",
      { reply_markup: cancelKeyboard() }
    );
    return;
  }

  if (session.step === "time") {
    session.draft.eventTime = text;
    session.step = "place";
    await ctx.reply(
      "Шаг 3/5 — место проведения (адрес / зал)",
      { reply_markup: cancelKeyboard() }
    );
    return;
  }

  if (session.step === "place") {
    session.draft.place = text;
    session.step = "payment";
    await ctx.reply(
      "Шаг 4/5 — реквизиты для оплаты (карта, СБП, телефон, сумма и т.д.)",
      { reply_markup: cancelKeyboard() }
    );
    return;
  }

  if (session.step === "payment") {
    session.draft.paymentDetails = text;
    session.step = "max";
    await ctx.reply(
      "Шаг 5/5 — максимум участников (число). Напишите 0, если без лимита.",
      { reply_markup: cancelKeyboard() }
    );
    return;
  }

  if (session.step === "max") {
    const maxPlayers = Number(text);
    if (!Number.isInteger(maxPlayers) || maxPlayers < 0) {
      await ctx.reply("Введите целое число ≥ 0 (0 = без лимита).", {
        reply_markup: cancelKeyboard(),
      });
      return;
    }

    const event = createEvent({
      title: session.draft.title,
      eventTime: session.draft.eventTime,
      place: session.draft.place,
      paymentDetails: session.draft.paymentDetails,
      maxPlayers,
      createdBy: ctx.from.id,
    });
    sessions.delete(ctx.from.id);

    await ctx.reply("✅ Событие создано!", {
      reply_markup: mainMenu(true),
    });
    await ctx.reply(formatEventCard(event, []), {
      parse_mode: "HTML",
      reply_markup: adminEventKeyboard(event.id),
    });
  }
});

bot.catch((err) => {
  const e = err.error;
  if (e instanceof GrammyError) {
    console.error("Grammy error:", e.description);
  } else if (e instanceof HttpError) {
    const code = e.error?.code || e.error?.cause?.code || "network";
    console.error(`HTTP error: сеть до Telegram недоступна (${code}). Включите VPN или задайте PROXY_URL в .env`);
  } else {
    console.error("Unknown error:", e);
  }
});

async function main() {
  try {
    await bot.api.getMe();
  } catch (err) {
    const code = err?.error?.code || err?.error?.cause?.code || err?.code || "";
    console.error("");
    console.error("Не удалось подключиться к api.telegram.org.");
    console.error(`Причина: ${code || err.message}`);
    console.error("");
    console.error("Что сделать:");
    console.error("1) Включите VPN на компьютере и снова npm start");
    console.error("2) Или укажите прокси в .env: PROXY_URL=http://127.0.0.1:PORT");
    console.error("3) Или задеплойте бота на Railway — там API обычно доступен");
    console.error("");
    process.exit(1);
  }

  try {
    await bot.api.setMyCommands([
      { command: "start", description: "Главное меню" },
      { command: "events", description: "Список событий" },
      { command: "help", description: "Помощь" },
      { command: "new_event", description: "Создать событие (админ)" },
      { command: "admin", description: "Админ-панель" },
    ]);
  } catch {
    console.warn("Не удалось обновить меню команд — продолжаем запуск.");
  }

  process.once("SIGINT", () => {
    closeDb();
    bot.stop();
  });
  process.once("SIGTERM", () => {
    closeDb();
    bot.stop();
  });

  console.log("Волейбольный бот запущен. Ожидаю сообщения...");
  await bot.start();
}

main();
