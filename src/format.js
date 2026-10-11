export function formatParticipantList(participants) {
  if (!participants.length) {
    return "Участников пока нет.";
  }
  return participants
    .map((p, i) => {
      const nick = p.username ? ` (@${p.username})` : "";
      const pay = Number(p.paid) === 1 ? "✅" : "⏳";
      return `${i + 1}. ${pay} ${p.full_name}${nick}`;
    })
    .join("\n");
}

export function formatEventCard(event, participants) {
  const count = participants.length;
  const paidCount = participants.filter((p) => Number(p.paid) === 1).length;
  const limit =
    event.max_players > 0 ? `${count}/${event.max_players}` : `${count}`;

  return [
    `🏐 <b>${escapeHtml(event.title)}</b>`,
    "",
    `🕐 <b>Когда:</b> ${escapeHtml(event.event_time)}`,
    `📍 <b>Где:</b> ${escapeHtml(event.place)}`,
    `💳 <b>Оплата:</b>\n${escapeHtml(event.payment_details)}`,
    `👥 <b>Участники (${limit}, оплатили ${paidCount}):</b>`,
    formatParticipantList(participants),
    "",
    "✅ — оплачено · ⏳ — ещё нет",
  ].join("\n");
}

export function participantLabel(p) {
  const nick = p.username ? ` @${p.username}` : "";
  return `${p.full_name}${nick}`;
}

export function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
