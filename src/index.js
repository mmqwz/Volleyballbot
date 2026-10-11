import { GrammyError, HttpError } from "grammy";
import { config, isAdmin } from "./config.js";
import { createBot } from "./createBot.js";
import {
  clearEphemeral,
  createEvent,
  getEvent,
  getParticipants,
  isJoined,
  joinEvent,
  leaveEvent,
  listActiveEvents,
  listEphemeral,
  markPaid,
  removeEphemeral,
  setAnnounceMessage,
  setEventStatus,
  trackEphemeral,
  closeDb,
} from "./db.js";
import { formatEventCard, participantLabel } from "./format.js";
import {
  adminEventKeyboard,
  cancelKeyboard,
  eventActionsKeyboard,
  eventsListKeyboard,
  mainMenu,
  payMultiKeyboard,
} from "./keyboards.js";

const bot = createBot(config.token, config.proxyUrl);

/** @type {Map<number, { step: string, draft?: Record<string, unknown>, eventId?: number, selected?: number[] }>} */
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

async function safeDelete(api, chatId, messageId) {
  if (!chatId || !messageId) return;
  try {
    await api.deleteMessage(chatId, messageId);
  } catch {
    // уже удалено / нет прав
  }
}

/** Удаляет служебные сообщения бота, карточку события не трогает */
async function purgeEphemeral(ctx, event, chatId) {
  if (!event || !chatId) return;
  const ids = listEphemeral(event.id, chatId);
  const keep = Number(event.announce_message_id);
  for (const messageId of ids) {
    if (messageId === keep) continue;
    await safeDelete(ctx.api, chatId, messageId);
  }
  clearEphemeral(event.id, chatId);
}

async function sendEphemeral(ctx, event, text, extra = {}) {
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
  if (!chatId || !event) {
    return ctx.reply(text, extra);
  }
  await purgeEphemeral(ctx, event, chatId);
  const msg = await ctx.api.sendMessage(chatId, text, extra);
  if (msg.message_id !== event.announce_message_id) {
    trackEphemeral(event.id, chatId, msg.message_id);
  }
  return msg;
}

async function refreshAnnounce(ctx, event) {
  if (!event?.announce_chat_id || !event?.announce_message_id) return;
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
  } catch (err) {
    const desc = err?.description || "";
    if (!String(desc).includes("message is not modified")) {
      // ignore other edit errors
    }
  }
}

async function syncEventView(ctx, event) {
  const fresh = getEvent(event.id);
  if (!fresh) return;
  if (isAnnounceMessage(ctx, fresh)) {
    await refreshAnnounce(ctx, fresh);
    return;
  }
  // личная карточка — обновим её, если это не announce
  const participants = getParticipants(fresh.id);
  const joined = isJoined(fresh.id, ctx.from.id);
  const kb = eventActionsKeyboard(fresh.id, joined);
  if (isAdmin(ctx.from.id)) {
    kb.row()
      .text("📢 Опубликовать", `publish:${fresh.id}`)
      .text("🗑 Закрыть", `close:${fresh.id}`);
  }
  try {
    await ctx.editMessageText(formatEventCard(fresh, participants), {
      parse_mode: "HTML",
      reply_markup: kb,
    });
  } catch {
    // ignore
  }
  await refreshAnnounce(ctx, fresh);
}

function helpText(admin) {
  const lines = [
    "🏐 Бот записи на волейбол",
    "",
    "Команды:",
    "/events — список событий",
    "/start — главное меню",
    "",
    "В карточке события:",
    "• Записаться / Отписаться",
    "• 💳 Я оплатил — отметить оплату за себя",
    "• 👥 Оплата за нескольких — выбрать, за кого перевели",
  ];
  if (admin) {
    lines.push(
      "",
      "Админ:",
      "/new_event — создать событие",
      "/admin — панель администратора"
    );
  }
  return lines.join("\n");
}

function unpaidOf(eventId) {
  return getParticipants(eventId).filter((p) => Number(p.paid) !== 1);
}

function payPickerText(event, selectedIds) {
  const unpaid = unpaidOf(event.id);
  const selected = new Set(selectedIds.map(Number));
  const names = unpaid
    .filter((p) => selected.has(Number(p.user_id)))
    .map((p) => `• ${participantLabel(p)}`);

  return [
    `💳 <b>Оплата за нескольких</b>`,
    `Событие: ${event.title}`,
    "",
    "Отметьте участников, за которых вы перевели деньги.",
    "Можно выбрать только тех, кто записан и ещё не оплатил.",
    "",
    names.length ? `<b>Выбрано:</b>\n${names.join("\n")}` : "<i>Никто не выбран</i>",
    "",
    "Потом нажмите «Подтвердить оплату».",
  ].join("\n");
}

bot.command("start", async (ctx) => {
  const admin = isAdmin(ctx.from.id);
  sessions.delete(ctx.from.id);
  await ctx.reply(`Привет, ${displayName(ctx.from)}!\n\n${helpText(admin)}`, {
    reply_markup: mainMenu(admin),
  });
});

bot.command("help", async (ctx) => {
  await ctx.reply(helpText(isAdmin(ctx.from.id)), {
    reply_markup: mainMenu(isAdmin(ctx.from.id)),
  });
});

bot.command("events", async (ctx) => showEvents(ctx));

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

bot.command("new_event", async (ctx) => startCreateEvent(ctx));

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
    "Админ-панель:\n\n• Создайте событие\n• Опубликуйте карточку\n• Игроки записываются и отмечают оплату",
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
  await ctx.reply("Отменено.", {
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

async function showEventDetails(ctx, eventId) {
  const event = getEvent(eventId);
  if (!event || event.status !== "active") {
    await sendEphemeral(ctx, event || { id: eventId }, "Событие не найдено или уже закрыто.");
    return;
  }

  const participants = getParticipants(eventId);
  const joined = isJoined(eventId, ctx.from.id);
  const kb = eventActionsKeyboard(eventId, joined);
  if (isAdmin(ctx.from.id)) {
    kb.row()
      .text("📢 Опубликовать", `publish:${eventId}`)
      .text("🗑 Закрыть", `close:${eventId}`);
  }

  await sendEphemeral(ctx, event, formatEventCard(event, participants), {
    parse_mode: "HTML",
    reply_markup: kb,
  });
}

async function openPayMulti(ctx, event) {
  const unpaid = unpaidOf(event.id);
  if (!unpaid.length) {
    await ctx.answerCallbackQuery({
      text: "Некого отмечать — все уже оплатили или список пуст",
      show_alert: true,
    });
    return;
  }
  if (!isJoined(event.id, ctx.from.id)) {
    await ctx.answerCallbackQuery({
      text: "Сначала запишитесь на событие",
      show_alert: true,
    });
    return;
  }

  sessions.set(ctx.from.id, {
    step: "pay_multi",
    eventId: event.id,
    selected: [],
  });

  await ctx.answerCallbackQuery();
  await sendEphemeral(ctx, event, payPickerText(event, []), {
    parse_mode: "HTML",
    reply_markup: payMultiKeyboard(event.id, unpaid, []),
  });
}

async function updatePayMultiMessage(ctx, event, selected) {
  const unpaid = unpaidOf(event.id);
  const text = payPickerText(event, selected);
  const kb = payMultiKeyboard(event.id, unpaid, selected);
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  } catch (err) {
    const desc = String(err?.description || "");
    if (!desc.includes("message is not modified")) {
      await sendEphemeral(ctx, event, text, {
        parse_mode: "HTML",
        reply_markup: kb,
      });
    }
  }
}

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const parts = data.split(":");
  const action = parts[0];
  const eventId = Number(parts[1]);
  const extraId = parts[2] !== undefined ? Number(parts[2]) : null;

  if (!Number.isFinite(eventId)) {
    await ctx.answerCallbackQuery({ text: "Некорректные данные" });
    return;
  }

  const event = getEvent(eventId);

  if (action === "event") {
    await ctx.answerCallbackQuery();
    // удалим сообщение со списком событий, если это не карточка announce
    const msg = ctx.callbackQuery.message;
    if (msg && (!event || msg.message_id !== event.announce_message_id)) {
      await safeDelete(ctx.api, msg.chat.id, msg.message_id);
      removeEphemeral(msg.chat.id, msg.message_id);
    }
    await showEventDetails(ctx, eventId);
    return;
  }

  if (!event || event.status !== "active") {
    await ctx.answerCallbackQuery({
      text: "Событие недоступно",
      show_alert: true,
    });
    return;
  }

  if (action === "refresh") {
    await ctx.answerCallbackQuery({ text: "Обновлено" });
    await syncEventView(ctx, event);
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
    await ctx.answerCallbackQuery({ text: "Вы записаны!" });
    await syncEventView(ctx, result.event);
    const chatId = ctx.callbackQuery.message.chat.id;
    await purgeEphemeral(ctx, result.event, chatId);
    // короткий тост уже в callback; список виден в карточке события
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
    const sess = sessions.get(ctx.from.id);
    if (sess?.step === "pay_multi" && sess.eventId === eventId) {
      sessions.delete(ctx.from.id);
    }
    await ctx.answerCallbackQuery({ text: "Вы отписались" });
    await syncEventView(ctx, result.event);
    await purgeEphemeral(ctx, result.event, ctx.callbackQuery.message.chat.id);
    return;
  }

  if (action === "payself") {
    const result = markPaid(eventId, [ctx.from.id], ctx.from.id);
    if (!result.ok) {
      const messages = {
        not_found: "Событие недоступно",
        payer_not_joined: "Сначала запишитесь на событие",
        already_paid: "Вы уже отмечены как оплатившие",
        empty: "Некого отмечать",
        invalid_selection: "Вы не записаны на это событие",
      };
      await ctx.answerCallbackQuery({
        text: messages[result.reason] || "Не удалось отметить оплату",
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Оплата за себя отмечена ✅" });
    await syncEventView(ctx, result.event);
    await purgeEphemeral(ctx, result.event, ctx.callbackQuery.message.chat.id);
    return;
  }

  if (action === "paymulti") {
    await openPayMulti(ctx, event);
    return;
  }

  if (action === "paytog") {
    if (!Number.isFinite(extraId)) {
      await ctx.answerCallbackQuery({ text: "Некорректный выбор" });
      return;
    }
    let sess = sessions.get(ctx.from.id);
    if (!sess || sess.step !== "pay_multi" || sess.eventId !== eventId) {
      sess = { step: "pay_multi", eventId, selected: [] };
      sessions.set(ctx.from.id, sess);
    }

    // проверка: можно выбрать только неоплаченного участника
    const unpaid = unpaidOf(eventId);
    const target = unpaid.find((p) => Number(p.user_id) === extraId);
    if (!target) {
      await ctx.answerCallbackQuery({
        text: "Нельзя: человек не записан или уже оплатил",
        show_alert: true,
      });
      await updatePayMultiMessage(ctx, event, sess.selected || []);
      return;
    }

    const set = new Set((sess.selected || []).map(Number));
    if (set.has(extraId)) set.delete(extraId);
    else set.add(extraId);
    sess.selected = [...set];
    sessions.set(ctx.from.id, sess);

    await ctx.answerCallbackQuery({
      text: set.has(extraId) ? "Добавлено в список" : "Убрано из списка",
    });
    await updatePayMultiMessage(ctx, event, sess.selected);
    return;
  }

  if (action === "payok") {
    const sess = sessions.get(ctx.from.id);
    if (!sess || sess.step !== "pay_multi" || sess.eventId !== eventId) {
      await ctx.answerCallbackQuery({
        text: "Сессия выбора устарела. Откройте оплату заново",
        show_alert: true,
      });
      return;
    }

    const selected = (sess.selected || []).map(Number);
    if (!selected.length) {
      await ctx.answerCallbackQuery({
        text: "Выберите хотя бы одного участника",
        show_alert: true,
      });
      return;
    }

    // повторная проверка перед записью
    const unpaidIds = new Set(unpaidOf(eventId).map((p) => Number(p.user_id)));
    const bad = selected.filter((id) => !unpaidIds.has(id));
    if (bad.length) {
      await ctx.answerCallbackQuery({
        text: "Проверка не пройдена: есть неверные или уже оплаченные",
        show_alert: true,
      });
      sess.selected = selected.filter((id) => unpaidIds.has(id));
      sessions.set(ctx.from.id, sess);
      await updatePayMultiMessage(ctx, event, sess.selected);
      return;
    }

    const result = markPaid(eventId, selected, ctx.from.id);
    if (!result.ok) {
      const messages = {
        payer_not_joined: "Сначала запишитесь на событие",
        invalid_selection: "В выборе есть незаписанные люди",
        already_paid: "Кто-то из выбранных уже оплатил",
        empty: "Список пуст",
      };
      await ctx.answerCallbackQuery({
        text: messages[result.reason] || "Оплата не принята",
        show_alert: true,
      });
      return;
    }

    sessions.delete(ctx.from.id);
    const paidNames = result.participants
      .filter((p) => result.paidIds.includes(Number(p.user_id)))
      .map((p) => participantLabel(p))
      .join(", ");

    await ctx.answerCallbackQuery({ text: "Оплата подтверждена ✅" });
    await syncEventView(ctx, result.event);
    await purgeEphemeral(ctx, result.event, ctx.callbackQuery.message.chat.id);

    // короткое служебное — и сразу в ephemeral (потом сотрётся следующим действием)
    await sendEphemeral(
      ctx,
      result.event,
      `💳 ${displayName(ctx.from)} отметил(а) оплату за:\n${paidNames}`
    );
    return;
  }

  if (action === "paycancel") {
    sessions.delete(ctx.from.id);
    await ctx.answerCallbackQuery({ text: "Отменено" });
    await purgeEphemeral(ctx, event, ctx.callbackQuery.message.chat.id);
    await syncEventView(ctx, event);
    return;
  }

  if (action === "publish") {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({
        text: "Только для админов",
        show_alert: true,
      });
      return;
    }
    const participants = getParticipants(eventId);
    const chatId = ctx.callbackQuery.message.chat.id;
    await purgeEphemeral(ctx, event, chatId);
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
      await ctx.answerCallbackQuery({
        text: "Только для админов",
        show_alert: true,
      });
      return;
    }
    setEventStatus(eventId, "closed");
    sessions.delete(ctx.from.id);
    await ctx.answerCallbackQuery({ text: "Событие закрыто" });
    try {
      await ctx.editMessageText(
        "Событие закрыто и больше не принимает записи."
      );
    } catch {
      // ignore
    }
    return;
  }

  await ctx.answerCallbackQuery();
});

bot.on("message:text", async (ctx, next) => {
  const session = sessions.get(ctx.from.id);
  if (!session || session.step === "pay_multi") {
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
    await ctx.reply("Шаг 2/5 — дата и время (например: «Пт 18.10 в 19:00»)", {
      reply_markup: cancelKeyboard(),
    });
    return;
  }

  if (session.step === "time") {
    session.draft.eventTime = text;
    session.step = "place";
    await ctx.reply("Шаг 3/5 — место проведения (адрес / зал)", {
      reply_markup: cancelKeyboard(),
    });
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
    const card = await ctx.reply(formatEventCard(event, []), {
      parse_mode: "HTML",
      reply_markup: adminEventKeyboard(event.id),
    });
    setAnnounceMessage(event.id, card.chat.id, card.message_id);
  }
});

bot.catch((err) => {
  const e = err.error;
  if (e instanceof GrammyError) {
    if (String(e.description || "").includes("message is not modified")) return;
    if (e.error_code === 409) {
      console.error(
        "409 Conflict: запущен второй экземпляр бота. Оставьте только один."
      );
      return;
    }
    console.error("Grammy error:", e.description);
  } else if (e instanceof HttpError) {
    const code = e.error?.code || e.error?.cause?.code || "network";
    console.error(
      `HTTP error: сеть до Telegram недоступна (${code}). VPN или PROXY_URL в .env`
    );
  } else {
    console.error("Unknown error:", e);
  }
});

async function main() {
  try {
    await bot.api.getMe();
  } catch (err) {
    const code = err?.error?.code || err?.error?.cause?.code || err?.code || "";
    console.error("Не удалось подключиться к api.telegram.org.");
    console.error(`Причина: ${code || err.message}`);
    console.error("VPN / PROXY_URL / хостинг — см. README в чате.");
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
