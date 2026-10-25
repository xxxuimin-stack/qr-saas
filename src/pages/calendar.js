// Dashboard → Calendar (salon): walk-ins, shop bookings, home service, next visits, blocked time
import { mountCalendar } from "../calendar.js";
import { openModal, closeModal } from "../ui.js";

export function renderCalendarPage(root, ctx) {
  root.innerHTML = `<div data-cal></div>`;
  const cal = mountCalendar(root.querySelector("[data-cal]"), {
    storeId: ctx.storeId, getStore: () => ctx.store, cur: ctx.store.settings?.currency || "PHP",
    open: (title, node) => openModal({ title: title.replace(/<[^>]+>/g, ""), body: node }), close: closeModal, staffToken: null, meName: () => ctx.ownerName || "Owner",
  });
  return () => cal.destroy();
}
