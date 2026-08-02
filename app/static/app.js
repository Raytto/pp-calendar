"use strict";

const $ = (selector) => document.querySelector(selector);

function monthFromPath(pathname = window.location.pathname) {
  const match = pathname.match(/^\/month\/(\d{4})\/(\d{1,2})\/(\d{1,2})\/?$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const value = new Date(year, month - 1, day);
  if (value.getFullYear() !== year || value.getMonth() !== month - 1 || value.getDate() !== day) return null;
  return new Date(year, month - 1, 1);
}

const initialMonth = monthFromPath() || new Date(new Date().getFullYear(), new Date().getMonth(), 1);
const state = {
  csrf: "",
  calendars: [],
  events: [],
  visibleCalendars: new Set(),
  cursor: initialMonth,
  editingEvent: null,
  selectedEvent: null,
  searchTimer: null,
  monthRequestId: 0,
  selectedDayDate: null,
};

const els = {
  loginView: $("#loginView"), appView: $("#appView"), loginForm: $("#loginForm"),
  loginError: $("#loginError"), monthTitle: $("#monthTitle"), miniTitle: $("#miniTitle"),
  monthGrid: $("#monthGrid"), miniCalendar: $("#miniCalendar"), calendarFilters: $("#calendarFilters"),
  calendarView: $("#calendarView"), searchView: $("#searchView"), searchInput: $("#searchInput"),
  searchSummary: $("#searchSummary"), searchResults: $("#searchResults"), eventDialog: $("#eventDialog"),
  eventForm: $("#eventForm"), eventDialogTitle: $("#eventDialogTitle"), eventTitle: $("#eventTitle"),
  eventDate: $("#eventDate"), eventCalendar: $("#eventCalendar"), eventNotes: $("#eventNotes"),
  eventError: $("#eventError"), deleteEventButton: $("#deleteEventButton"), detailDialog: $("#detailDialog"),
  detailColor: $("#detailColor"), detailTitle: $("#detailTitle"), detailDate: $("#detailDate"),
  detailCalendar: $("#detailCalendar"), detailNotes: $("#detailNotes"), calendarDialog: $("#calendarDialog"),
  calendarManageList: $("#calendarManageList"), calendarForm: $("#calendarForm"),
  calendarError: $("#calendarError"), sidebar: $("#sidebar"), sidebarBackdrop: $("#sidebarBackdrop"),
  accountMenu: $("#accountMenu"), accountButton: $("#accountButton"), mobileAccountButton: $("#mobileAccountButton"),
  mobileMonthStrip: $("#mobileMonthStrip"), themeStatus: $("#themeStatus"), toast: $("#toast"),
  monthJumpDialog: $("#monthJumpDialog"), monthJumpForm: $("#monthJumpForm"), monthJumpInput: $("#monthJumpInput"),
  dayEventsDialog: $("#dayEventsDialog"), dayEventsTitle: $("#dayEventsTitle"), dayEventsWeekday: $("#dayEventsWeekday"),
  dayEventsList: $("#dayEventsList"), dayAddEventButton: $("#dayAddEventButton"),
};

function isoDate(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addDays(value, amount) {
  const result = new Date(value);
  result.setDate(result.getDate() + amount);
  return result;
}

function monthStartGrid(cursor) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  return addDays(first, -((first.getDay() + 6) % 7));
}

function fullDateLabel(value) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(parseDate(value));
}

function readableTextColor(hex) {
  const value = hex.replace("#", "");
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance > 0.58 ? "#15161a" : "#ffffff";
}

function visibleEventCapacity(eventCount) {
  const mobile = window.innerWidth <= 560;
  const rowHeight = els.monthGrid.clientHeight ? els.monthGrid.clientHeight / 6 : (mobile ? 112 : 132);
  const cellPaddingAndHeader = mobile ? 29 : 35;
  const chipStep = mobile ? 22 : 24;
  const moreHeight = mobile ? 16 : 15;
  const withoutOverflow = Math.max(1, Math.floor((rowHeight - cellPaddingAndHeader) / chipStep));
  if (eventCount <= withoutOverflow) return Math.min(eventCount, mobile ? 3 : 4);
  return Math.max(1, Math.min(mobile ? 3 : 4, Math.floor((rowHeight - cellPaddingAndHeader - moreHeight) / chipStep)));
}

async function api(path, options = {}) {
  const init = { credentials: "same-origin", ...options, headers: { ...(options.headers || {}) } };
  if (options.body && typeof options.body !== "string") {
    init.body = JSON.stringify(options.body);
    init.headers["Content-Type"] = "application/json";
  }
  if (options.method && options.method !== "GET") init.headers["X-CSRF-Token"] = state.csrf;
  const response = await fetch(path, init);
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== "/api/login") showLogin();
  if (!response.ok) throw new Error(payload.error || "请求失败，请稍后再试");
  return payload;
}

function showError(element, message = "") {
  element.textContent = message;
  element.hidden = !message;
}

let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.hidden = false;
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2200);
}

function showLogin() {
  state.csrf = "";
  els.appView.hidden = true;
  els.loginView.hidden = false;
  setTimeout(() => $("#loginUsername").focus(), 50);
}

async function showApp(session) {
  state.csrf = session.csrf_token;
  els.loginView.hidden = true;
  els.appView.hidden = false;
  await loadCalendars();
  syncMonthUrl("replace");
  await loadMonth();
}

async function loadCalendars() {
  const payload = await api("/api/calendars");
  const prior = new Set(state.visibleCalendars);
  state.calendars = payload.calendars;
  const saved = JSON.parse(localStorage.getItem("pp-calendar-visible") || "null");
  const savedKnown = JSON.parse(localStorage.getItem("pp-calendar-known") || "null");
  let wanted;
  if (prior.size) wanted = prior;
  else if (!Array.isArray(saved) || !Array.isArray(savedKnown)) wanted = new Set(state.calendars.map((item) => item.id));
  else {
    wanted = new Set(saved);
    const known = new Set(savedKnown);
    state.calendars.forEach((item) => { if (!known.has(item.id)) wanted.add(item.id); });
  }
  state.visibleCalendars = new Set(state.calendars.filter((item) => wanted.has(item.id)).map((item) => item.id));
  localStorage.setItem("pp-calendar-visible", JSON.stringify([...state.visibleCalendars]));
  localStorage.setItem("pp-calendar-known", JSON.stringify(state.calendars.map((item) => item.id)));
  renderCalendarFilters();
  renderEventCalendarOptions();
}

async function loadMonth() {
  const requestId = ++state.monthRequestId;
  const first = monthStartGrid(state.cursor);
  const last = addDays(first, 41);
  const payload = await api(`/api/events?start=${isoDate(first)}&end=${isoDate(last)}`);
  if (requestId !== state.monthRequestId) return;
  state.events = payload.events;
  renderMonth();
  renderMiniCalendar();
  renderMobileMonthStrip();
}

function renderCalendarFilters() {
  els.calendarFilters.replaceChildren();
  state.calendars.forEach((calendar) => {
    const label = document.createElement("label");
    label.className = "filter-row";
    label.style.setProperty("--calendar-color", calendar.color);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = state.visibleCalendars.has(calendar.id);
    input.addEventListener("change", () => {
      if (input.checked) state.visibleCalendars.add(calendar.id);
      else state.visibleCalendars.delete(calendar.id);
      localStorage.setItem("pp-calendar-visible", JSON.stringify([...state.visibleCalendars]));
      renderMonth();
    });
    const check = document.createElement("span");
    check.className = "filter-check";
    check.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.textContent = calendar.name;
    label.append(input, check, name);
    els.calendarFilters.append(label);
  });
}

function renderEventCalendarOptions(selected) {
  els.eventCalendar.replaceChildren();
  state.calendars.forEach((calendar) => {
    const option = document.createElement("option");
    option.value = calendar.id;
    option.textContent = calendar.name;
    option.selected = Number(selected) === calendar.id;
    els.eventCalendar.append(option);
  });
}

function renderMonth() {
  const year = state.cursor.getFullYear();
  const month = state.cursor.getMonth();
  els.monthTitle.textContent = `${year}年${month + 1}月`;
  els.miniTitle.textContent = `${year}年${month + 1}月`;
  const first = monthStartGrid(state.cursor);
  const today = isoDate(new Date());
  const eventMap = new Map();
  state.events.filter((event) => state.visibleCalendars.has(event.calendar_id)).forEach((event) => {
    const bucket = eventMap.get(event.event_date) || [];
    bucket.push(event);
    eventMap.set(event.event_date, bucket);
  });
  els.monthGrid.replaceChildren();
  for (let offset = 0; offset < 42; offset += 1) {
    const current = addDays(first, offset);
    const key = isoDate(current);
    const cell = document.createElement("div");
    cell.className = "day-cell" + (current.getMonth() !== month ? " outside" : "");
    cell.dataset.date = key;
    cell.tabIndex = 0;
    cell.setAttribute("role", "gridcell");
    cell.setAttribute("aria-label", `${fullDateLabel(key)}，新建事件`);
    const numberRow = document.createElement("div");
    numberRow.className = "day-number-row";
    const number = document.createElement("span");
    number.className = "day-number" + (key === today ? " today" : "");
    if (current.getDate() === 1) {
      number.textContent = `${current.getMonth() + 1}月${current.getDate()}日`;
      number.classList.add("month-edge");
    } else number.textContent = current.getDate();
    numberRow.append(number);
    const eventBox = document.createElement("div");
    eventBox.className = "day-events";
    const events = eventMap.get(key) || [];
    const maxVisible = visibleEventCapacity(events.length);
    events.slice(0, maxVisible).forEach((event) => {
      const chip = document.createElement("button");
      chip.className = "event-chip";
      chip.style.setProperty("--event-color", event.calendar_color);
      chip.style.setProperty("--event-text", readableTextColor(event.calendar_color));
      chip.textContent = event.title;
      chip.title = event.title;
      chip.addEventListener("click", (clickEvent) => { clickEvent.stopPropagation(); openDetail(event); });
      eventBox.append(chip);
    });
    if (events.length > maxVisible) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "more-events";
      more.textContent = window.innerWidth <= 560 ? `+${events.length - maxVisible} 项` : `另有 ${events.length - maxVisible} 项`;
      more.title = `另有 ${events.length - maxVisible} 项`;
      more.setAttribute("aria-label", `${fullDateLabel(key)}，另有 ${events.length - maxVisible} 项，查看当天全部事件`);
      more.addEventListener("click", (clickEvent) => {
        clickEvent.stopPropagation();
        openDayEvents(key, events, cell);
      });
      eventBox.append(more);
    }
    cell.append(numberRow, eventBox);
    cell.addEventListener("click", () => openEventEditor(null, key));
    cell.addEventListener("keydown", (event) => {
      if (event.target !== cell) return;
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openEventEditor(null, key); }
    });
    els.monthGrid.append(cell);
  }
}

function renderMobileMonthStrip() {
  els.mobileMonthStrip.replaceChildren();
  for (let offset = -3; offset <= 3; offset += 1) {
    const value = new Date(state.cursor.getFullYear(), state.cursor.getMonth() + offset, 1);
    const button = document.createElement("button");
    button.className = "mobile-month-button" + (offset === 0 ? " active" : "");
    button.type = "button";
    button.textContent = `${value.getMonth() + 1}月`;
    button.title = `${value.getFullYear()}年${value.getMonth() + 1}月`;
    button.setAttribute("aria-current", offset === 0 ? "date" : "false");
    button.addEventListener("click", () => {
      navigateToMonth(value).catch((error) => toast(error.message));
    });
    els.mobileMonthStrip.append(button);
  }
  requestAnimationFrame(() => {
    const active = els.mobileMonthStrip.querySelector(".active");
    if (active) els.mobileMonthStrip.scrollLeft = active.offsetLeft - (els.mobileMonthStrip.clientWidth - active.offsetWidth) / 2;
  });
}

function renderMiniCalendar() {
  const month = state.cursor.getMonth();
  const first = monthStartGrid(state.cursor);
  const today = isoDate(new Date());
  els.miniCalendar.replaceChildren();
  for (let offset = 0; offset < 42; offset += 1) {
    const current = addDays(first, offset);
    const key = isoDate(current);
    const button = document.createElement("button");
    button.className = "mini-day";
    if (current.getMonth() !== month) button.classList.add("outside");
    if (key === today) button.classList.add("today");
    if (current.getDate() === 1 && current.getMonth() === month) button.classList.add("selected");
    button.textContent = current.getDate();
    button.title = fullDateLabel(key);
    button.addEventListener("click", () => openEventEditor(null, key));
    els.miniCalendar.append(button);
  }
}

function monthPath(value = state.cursor) {
  return `/month/${value.getFullYear()}/${value.getMonth() + 1}/1`;
}

function syncMonthUrl(mode = "push") {
  const path = monthPath();
  if (window.location.pathname === path) return;
  window.history[mode === "replace" ? "replaceState" : "pushState"]({ month: path }, "", path);
}

async function navigateToMonth(value, historyMode = "push") {
  state.cursor = new Date(value.getFullYear(), value.getMonth(), 1);
  syncMonthUrl(historyMode);
  await loadMonth();
}

function moveMonth(amount) {
  const value = new Date(state.cursor.getFullYear(), state.cursor.getMonth() + amount, 1);
  navigateToMonth(value).catch((error) => toast(error.message));
}

function openMonthJump() {
  els.monthJumpInput.value = `${state.cursor.getFullYear()}-${String(state.cursor.getMonth() + 1).padStart(2, "0")}`;
  els.monthJumpDialog.showModal();
  els.monthJumpInput.focus();
}

function openEventEditor(event = null, targetDate = null) {
  state.editingEvent = event;
  els.eventDialogTitle.textContent = event ? "编辑事件" : "新建事件";
  els.eventTitle.value = event?.title || "";
  els.eventDate.value = event?.event_date || targetDate || isoDate(new Date());
  els.eventNotes.value = event?.notes || "";
  renderEventCalendarOptions(event?.calendar_id || state.calendars[0]?.id);
  els.deleteEventButton.hidden = !event;
  showError(els.eventError);
  els.eventDialog.showModal();
  els.eventTitle.focus();
}

function openDetail(event) {
  state.selectedEvent = event;
  els.detailColor.style.setProperty("--event-color", event.calendar_color);
  els.detailTitle.textContent = event.title;
  els.detailDate.textContent = fullDateLabel(event.event_date);
  els.detailCalendar.textContent = event.calendar_name;
  els.detailNotes.textContent = event.notes || "没有备注";
  els.detailDialog.showModal();
}

function openDayEvents(eventDate, events, anchor) {
  state.selectedDayDate = eventDate;
  const parsed = parseDate(eventDate);
  els.dayEventsWeekday.textContent = new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(parsed);
  els.dayEventsTitle.textContent = `${parsed.getMonth() + 1}月${parsed.getDate()}日 · ${events.length} 项`;
  els.dayEventsList.replaceChildren();
  events.forEach((event) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "day-agenda-item";
    button.style.setProperty("--event-color", event.calendar_color);
    const color = document.createElement("span");
    color.className = "day-agenda-color";
    const copy = document.createElement("span");
    copy.className = "day-agenda-copy";
    const title = document.createElement("strong");
    title.textContent = event.title;
    const meta = document.createElement("small");
    meta.textContent = event.calendar_name;
    copy.append(title, meta);
    const arrow = document.createElement("span");
    arrow.className = "day-agenda-arrow";
    arrow.textContent = "›";
    button.append(color, copy, arrow);
    button.addEventListener("click", () => {
      els.dayEventsDialog.close();
      openDetail(event);
    });
    els.dayEventsList.append(button);
  });
  els.dayEventsDialog.showModal();
  requestAnimationFrame(() => {
    const dialog = els.dayEventsDialog;
    const rect = anchor.getBoundingClientRect();
    const margin = 12;
    const width = dialog.offsetWidth;
    const height = dialog.offsetHeight;
    const left = Math.max(margin, Math.min(window.innerWidth - width - margin, rect.left + rect.width / 2 - width / 2));
    let top = rect.bottom + 8;
    if (top + height > window.innerHeight - margin) top = Math.max(margin, rect.top - height - 8);
    dialog.style.left = `${left}px`;
    dialog.style.top = `${top}px`;
  });
}

async function saveEvent(event) {
  event.preventDefault();
  const payload = {
    title: els.eventTitle.value.trim(), event_date: els.eventDate.value,
    calendar_id: Number(els.eventCalendar.value), notes: els.eventNotes.value.trim(),
  };
  try {
    if (state.editingEvent) await api(`/api/events/${state.editingEvent.id}`, { method: "PATCH", body: payload });
    else await api("/api/events", { method: "POST", body: payload });
    els.eventDialog.close();
    await loadCalendars();
    await loadMonth();
    toast(state.editingEvent ? "事件已更新" : "事件已创建");
  } catch (error) { showError(els.eventError, error.message); }
}

async function deleteEvent() {
  if (!state.editingEvent || !confirm(`确定删除“${state.editingEvent.title}”吗？`)) return;
  try {
    await api(`/api/events/${state.editingEvent.id}`, { method: "DELETE" });
    els.eventDialog.close();
    await loadCalendars();
    await loadMonth();
    toast("事件已删除");
  } catch (error) { showError(els.eventError, error.message); }
}

function renderCalendarManager() {
  els.calendarManageList.replaceChildren();
  state.calendars.forEach((calendar) => {
    const row = document.createElement("div");
    row.className = "calendar-manage-row";
    const color = document.createElement("input");
    color.type = "color"; color.value = calendar.color;
    const name = document.createElement("input");
    name.type = "text"; name.maxLength = 60; name.value = calendar.name;
    const save = document.createElement("button");
    save.textContent = "保存";
    save.addEventListener("click", async () => {
      try {
        await api(`/api/calendars/${calendar.id}`, { method: "PATCH", body: { name: name.value.trim(), color: color.value } });
        await loadCalendars(); await loadMonth(); renderCalendarManager(); toast("日历已更新");
      } catch (error) { showError(els.calendarError, error.message); }
    });
    const remove = document.createElement("button");
    remove.className = "danger";
    remove.textContent = calendar.event_count ? `${calendar.event_count} 个事件` : "删除";
    remove.disabled = Boolean(calendar.event_count);
    remove.title = calendar.event_count ? "请先移动或删除该日历中的事件" : "删除日历";
    remove.addEventListener("click", async () => {
      if (!confirm(`确定删除日历“${calendar.name}”吗？`)) return;
      try {
        await api(`/api/calendars/${calendar.id}`, { method: "DELETE" });
        await loadCalendars(); await loadMonth(); renderCalendarManager(); toast("日历已删除");
      } catch (error) { showError(els.calendarError, error.message); }
    });
    row.append(color, name, save, remove);
    els.calendarManageList.append(row);
  });
}

async function createCalendar(event) {
  event.preventDefault();
  try {
    const created = await api("/api/calendars", { method: "POST", body: { name: $("#calendarName").value.trim(), color: $("#calendarColor").value } });
    state.visibleCalendars.add(created.calendar.id);
    localStorage.setItem("pp-calendar-visible", JSON.stringify([...state.visibleCalendars]));
    els.calendarForm.reset(); $("#calendarColor").value = "#4856B7";
    await loadCalendars(); renderCalendarManager(); toast("日历已创建");
  } catch (error) { showError(els.calendarError, error.message); }
}

function openSearch() {
  els.calendarView.hidden = true;
  els.searchView.hidden = false;
  els.searchInput.focus();
}

function closeSearch() {
  els.searchView.hidden = true;
  els.calendarView.hidden = false;
}

async function search() {
  const query = els.searchInput.value.trim();
  els.searchResults.replaceChildren();
  if (!query) { els.searchSummary.textContent = "输入关键词，搜索事件标题、备注和所属日历。"; return; }
  try {
    const payload = await api(`/api/events?q=${encodeURIComponent(query)}`);
    els.searchSummary.textContent = `找到 ${payload.events.length} 条与“${query}”相关的记录`;
    if (!payload.events.length) {
      const empty = document.createElement("div"); empty.className = "empty-state"; empty.textContent = "没有找到相关记录";
      els.searchResults.append(empty); return;
    }
    payload.events.forEach((event) => {
      const dateValue = parseDate(event.event_date);
      const button = document.createElement("button");
      button.className = "search-result";
      const dateBox = document.createElement("span"); dateBox.className = "result-date";
      const day = document.createElement("strong"); day.textContent = dateValue.getDate();
      const rest = document.createElement("span"); rest.textContent = `${dateValue.getFullYear()}年${dateValue.getMonth() + 1}月`;
      dateBox.append(day, rest);
      const dot = document.createElement("span"); dot.className = "result-dot"; dot.style.setProperty("--event-color", event.calendar_color);
      const title = document.createElement("span"); title.className = "result-title"; title.textContent = event.title;
      const calendar = document.createElement("span"); calendar.className = "result-calendar"; calendar.textContent = event.calendar_name;
      button.append(dateBox, dot, title, calendar);
      button.addEventListener("click", () => openDetail(event));
      els.searchResults.append(button);
    });
  } catch (error) { els.searchSummary.textContent = error.message; }
}

function closeSidebar() {
  els.sidebar.classList.remove("open");
  els.sidebarBackdrop.hidden = true;
  toggleAccountMenu(false);
}

function toggleAccountMenu(force) {
  const shouldOpen = typeof force === "boolean" ? force : els.accountMenu.hidden;
  els.accountMenu.hidden = !shouldOpen;
  els.accountButton.setAttribute("aria-expanded", String(shouldOpen));
}

function updateThemeControls(eventDetail) {
  const mode = eventDetail?.mode || window.PPCalendarTheme?.getMode() || "system";
  const resolved = eventDetail?.resolved || window.PPCalendarTheme?.resolvedMode(mode) || "light";
  document.querySelectorAll("button[data-theme-mode]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.themeMode === mode));
  });
  const labels = { system: "跟随系统", light: "浅色模式", dark: "深色模式" };
  els.themeStatus.textContent = mode === "system" ? `跟随系统 · 当前${resolved === "dark" ? "深色" : "浅色"}` : labels[mode];
}

document.querySelectorAll(".close-dialog").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault(); showError(els.loginError);
  try {
    const session = await api("/api/login", { method: "POST", body: { username: $("#loginUsername").value, password: $("#loginPassword").value } });
    $("#loginPassword").value = ""; await showApp(session);
  } catch (error) { showError(els.loginError, error.message); }
});
$("#todayButton").addEventListener("click", () => navigateToMonth(new Date()).catch((error) => toast(error.message)));
$("#prevButton").addEventListener("click", () => moveMonth(-1));
$("#nextButton").addEventListener("click", () => moveMonth(1));
$("#monthJumpButton").addEventListener("click", openMonthJump);
els.monthJumpForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const match = els.monthJumpInput.value.match(/^(\d{4})-(\d{2})$/);
  if (!match) return;
  els.monthJumpDialog.close();
  navigateToMonth(new Date(Number(match[1]), Number(match[2]) - 1, 1)).catch((error) => toast(error.message));
});
$("#sidebarCreate").addEventListener("click", () => { closeSidebar(); openEventEditor(); });
els.eventForm.addEventListener("submit", saveEvent);
els.deleteEventButton.addEventListener("click", deleteEvent);
$("#editEventButton").addEventListener("click", () => { const event = state.selectedEvent; els.detailDialog.close(); openEventEditor(event); });
els.dayAddEventButton.addEventListener("click", () => {
  const eventDate = state.selectedDayDate;
  els.dayEventsDialog.close();
  openEventEditor(null, eventDate);
});
els.dayEventsDialog.addEventListener("click", (event) => {
  if (event.target === els.dayEventsDialog) els.dayEventsDialog.close();
});
$("#manageCalendarsButton").addEventListener("click", () => { showError(els.calendarError); renderCalendarManager(); els.calendarDialog.showModal(); });
els.calendarForm.addEventListener("submit", createCalendar);
$("#searchButton").addEventListener("click", openSearch);
$("#closeSearch").addEventListener("click", closeSearch);
els.searchInput.addEventListener("input", () => { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(search, 220); });
els.accountButton.addEventListener("click", () => toggleAccountMenu());
els.mobileAccountButton.addEventListener("click", () => {
  els.sidebar.classList.add("open");
  els.sidebarBackdrop.hidden = false;
  toggleAccountMenu(true);
});
document.querySelectorAll("button[data-theme-mode]").forEach((button) => button.addEventListener("click", () => {
  window.PPCalendarTheme?.setMode(button.dataset.themeMode);
}));
window.addEventListener("ppcalendar-themechange", (event) => updateThemeControls(event.detail));
updateThemeControls();
$("#logoutButton").addEventListener("click", async () => { await api("/api/logout", { method: "POST" }); toggleAccountMenu(false); closeSidebar(); showLogin(); });
$("#menuButton").addEventListener("click", () => { els.sidebar.classList.add("open"); els.sidebarBackdrop.hidden = false; });
$("#mobileFab").addEventListener("click", () => openEventEditor());
els.sidebarBackdrop.addEventListener("click", closeSidebar);
document.addEventListener("click", (event) => {
  if (!els.accountMenu.hidden && !event.target.closest(".sidebar-account") && event.target !== els.mobileAccountButton) toggleAccountMenu(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.searchView.hidden && !document.querySelector("dialog[open]")) closeSearch();
  if (event.key === "/" && els.searchView.hidden && !document.querySelector("dialog[open]")) { event.preventDefault(); openSearch(); }
  if (event.key === "ArrowLeft" && event.altKey) moveMonth(-1);
  if (event.key === "ArrowRight" && event.altKey) moveMonth(1);
});

let touchStartX = null;
els.monthGrid.addEventListener("touchstart", (event) => { touchStartX = event.changedTouches[0].clientX; }, { passive: true });
els.monthGrid.addEventListener("touchend", (event) => {
  if (touchStartX === null) return;
  const difference = event.changedTouches[0].clientX - touchStartX;
  touchStartX = null;
  if (Math.abs(difference) > 70) moveMonth(difference < 0 ? 1 : -1);
}, { passive: true });
window.addEventListener("resize", () => { if (!els.appView.hidden) renderMonth(); });
window.addEventListener("popstate", () => {
  const value = monthFromPath();
  if (!value || els.appView.hidden) return;
  state.cursor = value;
  loadMonth().catch((error) => toast(error.message));
});

(async function bootstrap() {
  try {
    const session = await api("/api/session");
    if (session.authenticated) await showApp(session); else showLogin();
  } catch (_error) { showLogin(); }
})();
