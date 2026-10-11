import { InlineKeyboard, Keyboard } from "grammy";

export function mainMenu(isAdminUser) {
  const rows = [["🏐 События"], ["ℹ️ Помощь"]];
  if (isAdminUser) {
    rows.push(["➕ Создать событие"], ["🛠 Админ"]);
  }
  return Keyboard.from(rows).resized().persistent();
}

export function eventsListKeyboard(events) {
  const kb = new InlineKeyboard();
  for (const event of events) {
    kb.text(`🏐 ${event.title}`, `event:${event.id}`).row();
  }
  return kb;
}

export function eventActionsKeyboard(eventId, joined, { shared = false } = {}) {
  const kb = new InlineKeyboard();
  if (shared) {
    kb.text("✅ Записаться", `join:${eventId}`)
      .text("❌ Отписаться", `leave:${eventId}`);
  } else if (joined) {
    kb.text("❌ Отписаться", `leave:${eventId}`);
  } else {
    kb.text("✅ Записаться", `join:${eventId}`);
  }
  kb.row().text("🔄 Обновить список", `refresh:${eventId}`);
  return kb;
}

export function adminEventKeyboard(eventId) {
  return new InlineKeyboard()
    .text("📢 Опубликовать", `publish:${eventId}`)
    .text("🗑 Закрыть", `close:${eventId}`);
}

export function cancelKeyboard() {
  return new Keyboard().text("❌ Отмена").resized().oneTime();
}
