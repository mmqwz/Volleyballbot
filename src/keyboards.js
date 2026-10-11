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
  kb.row()
    .text("💳 Я оплатил", `payself:${eventId}`)
    .text("👥 Оплата за нескольких", `paymulti:${eventId}`);
  kb.row().text("🔄 Обновить", `refresh:${eventId}`);
  return kb;
}

export function payMultiKeyboard(eventId, unpaidParticipants, selectedIds) {
  const selected = new Set(selectedIds.map(Number));
  const kb = new InlineKeyboard();

  for (const p of unpaidParticipants) {
    const mark = selected.has(Number(p.user_id)) ? "☑️" : "⬜️";
    const name = p.full_name.slice(0, 28);
    kb.text(`${mark} ${name}`, `paytog:${eventId}:${p.user_id}`).row();
  }

  kb.text("✅ Подтвердить оплату", `payok:${eventId}`).row();
  kb.text("❌ Отмена", `paycancel:${eventId}`);
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
