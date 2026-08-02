"use strict";

const $ = (selector) => document.querySelector(selector);
const STANDARD_CALENDAR_COLORS = [
  "#AD1457", "#F4511E", "#E4C441", "#0B8043", "#3F51B5", "#8E24AA",
  "#D81B60", "#EF6C00", "#C0CA33", "#009688", "#7986CB", "#795548",
  "#D50000", "#F09300", "#7CB342", "#039BE5", "#B39DDB", "#616161",
  "#E67C73", "#F6BF26", "#33B679", "#4285F4", "#9E69AF", "#A79B8E",
];
const SIDEBAR_WIDTH_KEY = "pp-calendar-sidebar-width";
const SIDEBAR_WIDTH_DEFAULT = 280;
const SIDEBAR_WIDTH_MIN = 220;
const SIDEBAR_WIDTH_MAX = 520;
const MONTH_CACHE_TTL_MS = 60_000;

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
  searchPage: 1,
  searchRequestId: 0,
  searchController: null,
  monthRequestId: 0,
  monthCache: new Map(),
  monthInflight: new Map(),
  renderedMonthKey: null,
  selectedDayDate: null,
  optionsCalendarId: null,
};

const els = {
  loginView: $("#loginView"), appView: $("#appView"), loginForm: $("#loginForm"),
  loginError: $("#loginError"), monthTitle: $("#monthTitle"), miniTitle: $("#miniTitle"),
  monthGrid: $("#monthGrid"), miniCalendar: $("#miniCalendar"), calendarFilters: $("#calendarFilters"),
  calendarView: $("#calendarView"), searchView: $("#searchView"), searchInput: $("#searchInput"),
  searchSummary: $("#searchSummary"), searchResults: $("#searchResults"), searchPagination: $("#searchPagination"), eventDialog: $("#eventDialog"),
  eventForm: $("#eventForm"), eventDialogTitle: $("#eventDialogTitle"), eventTitle: $("#eventTitle"),
  eventDate: $("#eventDate"), eventCalendar: $("#eventCalendar"), eventNotes: $("#eventNotes"),
  eventCalendarButton: $("#eventCalendarButton"), eventCalendarName: $("#eventCalendarName"),
  eventCalendarColor: $("#eventCalendarColor"), eventCalendarMenu: $("#eventCalendarMenu"),
  eventError: $("#eventError"), deleteEventButton: $("#deleteEventButton"), detailDialog: $("#detailDialog"),
  detailColor: $("#detailColor"), detailTitle: $("#detailTitle"), detailDate: $("#detailDate"),
  detailCalendar: $("#detailCalendar"), detailNotes: $("#detailNotes"), calendarDialog: $("#calendarDialog"),
  calendarManageList: $("#calendarManageList"), calendarForm: $("#calendarForm"),
  calendarError: $("#calendarError"), sidebar: $("#sidebar"), sidebarBackdrop: $("#sidebarBackdrop"),
  accountMenu: $("#accountMenu"), accountButton: $("#accountButton"), mobileAccountButton: $("#mobileAccountButton"),
  themeStatus: $("#themeStatus"), toast: $("#toast"),
  monthJumpDialog: $("#monthJumpDialog"), monthJumpForm: $("#monthJumpForm"), monthJumpInput: $("#monthJumpInput"),
  dayEventsDialog: $("#dayEventsDialog"), dayEventsTitle: $("#dayEventsTitle"), dayEventsWeekday: $("#dayEventsWeekday"),
  dayEventsList: $("#dayEventsList"), dayAddEventButton: $("#dayAddEventButton"),
  calendarOptionsMenu: $("#calendarOptionsMenu"), calendarOptionsTitle: $("#calendarOptionsTitle"),
  calendarVisibilityAction: $("#calendarVisibilityAction"), calendarOptionsPalette: $("#calendarOptionsPalette"),
  calendarCreatePalette: $("#calendarCreatePalette"), sidebarScrollRegion: $("#sidebarScrollRegion"),
  sidebarResizer: $("#sidebarResizer"),
};

function normalizeSidebarWidth(value) {
  const width = Number(value);
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, Math.round(width)));
}

function storedSidebarWidth() {
  try {
    const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return stored === null ? SIDEBAR_WIDTH_DEFAULT : normalizeSidebarWidth(stored);
  }
  catch (_error) { return SIDEBAR_WIDTH_DEFAULT; }
}

function setSidebarWidth(value, persist = true) {
  const width = normalizeSidebarWidth(value);
  els.appView.style.setProperty("--sidebar-width", `${width}px`);
  els.sidebarResizer.setAttribute("aria-valuenow", String(width));
  if (persist) {
    try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width)); }
    catch (_error) { /* Browser privacy settings may disable storage. */ }
  }
  return width;
}

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

function monthCursor(value, offset = 0) {
  return new Date(value.getFullYear(), value.getMonth() + offset, 1);
}

function monthKey(value) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}`;
}

function monthRange(value) {
  const first = monthStartGrid(value);
  return { first, last: addDays(first, 41) };
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
  const styles = getComputedStyle(els.monthGrid);
  const numberValue = (name, fallback) => {
    const parsed = Number.parseFloat(styles.getPropertyValue(name));
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const rowHeight = els.monthGrid.clientHeight ? els.monthGrid.clientHeight / 6 : 132;
  const cellPaddingAndHeader = numberValue("--cell-header-space", 35);
  const chipHeight = numberValue("--event-chip-height", 21);
  const gap = numberValue("--event-row-gap", 3);
  const chipStep = chipHeight + gap;
  const moreHeight = numberValue("--more-events-height", 20);
  const availableHeight = Math.max(0, rowHeight - cellPaddingAndHeader);
  const withoutOverflow = Math.max(1, Math.floor((availableHeight + gap) / chipStep));
  if (eventCount <= withoutOverflow) return eventCount;
  return Math.max(1, Math.floor((availableHeight - moreHeight) / chipStep));
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
  state.searchController?.abort();
  state.searchController = null;
  invalidateMonthCache();
  state.calendars = [];
  state.events = [];
  state.renderedMonthKey = null;
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

function readStoredArray(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return Array.isArray(value) ? value : null;
  } catch (_error) {
    return null;
  }
}

function writeStoredJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch (_error) { /* Browser privacy settings may disable storage. */ }
}

async function loadCalendars() {
  const payload = await api("/api/calendars");
  const prior = new Set(state.visibleCalendars);
  state.calendars = payload.calendars;
  const saved = readStoredArray("pp-calendar-visible");
  const savedKnown = readStoredArray("pp-calendar-known");
  let wanted;
  if (prior.size) wanted = prior;
  else if (!Array.isArray(saved) || !Array.isArray(savedKnown)) wanted = new Set(state.calendars.map((item) => item.id));
  else {
    wanted = new Set(saved);
    const known = new Set(savedKnown);
    state.calendars.forEach((item) => { if (!known.has(item.id)) wanted.add(item.id); });
  }
  state.visibleCalendars = new Set(state.calendars.filter((item) => wanted.has(item.id)).map((item) => item.id));
  saveVisibleCalendars();
  writeStoredJson("pp-calendar-known", state.calendars.map((item) => item.id));
  renderCalendarFilters();
  renderEventCalendarOptions();
}

function renderMonthData(events) {
  state.events = events;
  state.renderedMonthKey = monthKey(state.cursor);
  renderMonth();
  renderMiniCalendar();
}

function pruneMonthWindow(center) {
  const allowed = new Set([-1, 0, 1].map((offset) => monthKey(monthCursor(center, offset))));
  [...state.monthCache.keys()].forEach((key) => { if (!allowed.has(key)) state.monthCache.delete(key); });
  [...state.monthInflight.entries()].forEach(([key, request]) => {
    if (!allowed.has(key)) {
      request.controller.abort();
      state.monthInflight.delete(key);
    }
  });
}

function invalidateMonthCache() {
  state.monthInflight.forEach((request) => request.controller.abort());
  state.monthInflight.clear();
  state.monthCache.clear();
  state.monthRequestId += 1;
}

async function requestMonth(value, force = false) {
  const key = monthKey(value);
  const cached = state.monthCache.get(key);
  if (!force && cached && Date.now() - cached.loadedAt < MONTH_CACHE_TTL_MS) return cached.events;
  const existing = state.monthInflight.get(key);
  if (existing && !force) return existing.promise;
  if (existing) existing.controller.abort();

  const controller = new AbortController();
  const { first, last } = monthRange(value);
  const promise = api(`/api/events?start=${isoDate(first)}&end=${isoDate(last)}`, { signal: controller.signal })
    .then((payload) => {
      const entry = { events: payload.events, loadedAt: Date.now() };
      state.monthCache.set(key, entry);
      return entry.events;
    });
  state.monthInflight.set(key, { controller, promise });
  try {
    return await promise;
  } finally {
    if (state.monthInflight.get(key)?.promise === promise) state.monthInflight.delete(key);
  }
}

function prefetchAdjacentMonths(center) {
  [-1, 1].forEach((offset) => {
    requestMonth(monthCursor(center, offset)).catch((error) => {
      if (error.name !== "AbortError") console.warn("相邻月份预取失败", error);
    });
  });
}

async function loadMonth({ force = false } = {}) {
  const requestId = ++state.monthRequestId;
  const cursor = monthCursor(state.cursor);
  const key = monthKey(cursor);
  pruneMonthWindow(cursor);
  const cached = state.monthCache.get(key);
  if (cached) renderMonthData(cached.events);
  else if (state.renderedMonthKey !== key) renderMonthData([]);
  try {
    const events = await requestMonth(cursor, force);
    if (requestId !== state.monthRequestId || key !== monthKey(state.cursor)) return;
    renderMonthData(events);
    pruneMonthWindow(cursor);
    prefetchAdjacentMonths(cursor);
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  }
}

function showCalendar(calendarId) {
  if (state.visibleCalendars.has(calendarId)) return;
  state.visibleCalendars.add(calendarId);
  saveVisibleCalendars();
  renderCalendarFilters();
}

function showSavedEvent(savedEvent) {
  showCalendar(savedEvent.calendar_id);
  state.events = state.events.filter((event) => event.id !== savedEvent.id);
  const first = isoDate(monthStartGrid(state.cursor));
  const last = isoDate(addDays(monthStartGrid(state.cursor), 41));
  if (savedEvent.event_date >= first && savedEvent.event_date <= last) state.events.push(savedEvent);
  state.events.sort((left, right) => right.event_date.localeCompare(left.event_date) || right.id - left.id);
  renderMonth();
}

function saveVisibleCalendars() {
  writeStoredJson("pp-calendar-visible", [...state.visibleCalendars]);
}

function renderStandardColorPalette(container, selectedColor, onSelect) {
  container.replaceChildren();
  STANDARD_CALENDAR_COLORS.forEach((color, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "standard-color-option";
    button.style.setProperty("--palette-color", color);
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(color === selectedColor));
    button.setAttribute("aria-label", `标准颜色 ${index + 1}`);
    button.title = color;
    button.addEventListener("click", () => onSelect(color));
    container.append(button);
  });
}

function setCalendarCreateColor(color) {
  $("#calendarColor").value = color;
  renderStandardColorPalette(els.calendarCreatePalette, color, setCalendarCreateColor);
}

function closeCalendarOptions() {
  els.calendarOptionsMenu.hidden = true;
  state.optionsCalendarId = null;
  els.calendarFilters.querySelectorAll(".calendar-row-more").forEach((button) => button.setAttribute("aria-expanded", "false"));
}

function openCalendarOptions(calendar, anchor) {
  closeCalendarOptions();
  state.optionsCalendarId = calendar.id;
  els.calendarOptionsTitle.textContent = calendar.name;
  els.calendarVisibilityAction.textContent = state.visibleCalendars.has(calendar.id) ? "隐藏此日历" : "显示此日历";
  renderStandardColorPalette(els.calendarOptionsPalette, calendar.color, (color) => updateCalendarColor(calendar.id, color));
  anchor.setAttribute("aria-expanded", "true");
  els.calendarOptionsMenu.hidden = false;
  requestAnimationFrame(() => {
    const anchorBox = anchor.getBoundingClientRect();
    const width = els.calendarOptionsMenu.offsetWidth;
    const height = els.calendarOptionsMenu.offsetHeight;
    const margin = 8;
    let left = anchorBox.right + 6;
    if (left + width > window.innerWidth - margin) left = anchorBox.left - width - 6;
    left = Math.max(margin, Math.min(window.innerWidth - width - margin, left));
    let top = anchorBox.top - 10;
    if (top + height > window.innerHeight - margin) top = window.innerHeight - height - margin;
    els.calendarOptionsMenu.style.left = `${left}px`;
    els.calendarOptionsMenu.style.top = `${Math.max(margin, top)}px`;
  });
}

async function updateCalendarColor(calendarId, color) {
  const calendar = state.calendars.find((item) => item.id === calendarId);
  if (!calendar || calendar.color === color) { closeCalendarOptions(); return; }
  try {
    await api(`/api/calendars/${calendarId}`, { method: "PATCH", body: { color } });
    invalidateMonthCache();
    closeCalendarOptions();
    await loadCalendars();
    await loadMonth({ force: true });
    refreshSearchIfVisible();
    toast("日历颜色已更新");
  } catch (error) {
    toast(error.message);
  }
}

function renderCalendarFilters() {
  closeCalendarOptions();
  els.calendarFilters.replaceChildren();
  state.calendars.forEach((calendar) => {
    const row = document.createElement("div");
    row.className = "filter-row";
    row.dataset.calendarId = calendar.id;
    row.style.setProperty("--calendar-color", calendar.color);
    const label = document.createElement("label");
    label.className = "filter-toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = state.visibleCalendars.has(calendar.id);
    input.addEventListener("change", () => {
      if (input.checked) state.visibleCalendars.add(calendar.id);
      else state.visibleCalendars.delete(calendar.id);
      saveVisibleCalendars();
      renderMonth();
    });
    const check = document.createElement("span");
    check.className = "filter-check";
    check.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "filter-name";
    name.textContent = calendar.name;
    label.append(input, check, name);
    const more = document.createElement("button");
    more.type = "button";
    more.className = "calendar-row-more";
    more.textContent = "⋮";
    more.title = `“${calendar.name}”的选项`;
    more.setAttribute("aria-label", `“${calendar.name}”的选项`);
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      if (state.optionsCalendarId === calendar.id && !els.calendarOptionsMenu.hidden) closeCalendarOptions();
      else openCalendarOptions(calendar, more);
    });
    row.append(label, more);
    els.calendarFilters.append(row);
  });
}

function renderEventCalendarOptions(selected) {
  const selectedId = Number(selected || els.eventCalendar.value || state.calendars[0]?.id);
  els.eventCalendar.replaceChildren();
  els.eventCalendarMenu.replaceChildren();
  state.calendars.forEach((calendar) => {
    const option = document.createElement("option");
    option.value = calendar.id;
    option.textContent = calendar.name;
    option.selected = selectedId === calendar.id;
    els.eventCalendar.append(option);

    const menuOption = document.createElement("button");
    menuOption.type = "button";
    menuOption.className = "calendar-select-option";
    menuOption.dataset.calendarId = calendar.id;
    menuOption.setAttribute("role", "option");
    menuOption.style.setProperty("--calendar-color", calendar.color);
    const color = document.createElement("span");
    color.className = "calendar-option-color";
    color.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "calendar-option-name";
    name.textContent = calendar.name;
    const check = document.createElement("span");
    check.className = "calendar-option-check";
    check.setAttribute("aria-hidden", "true");
    menuOption.append(color, name, check);
    menuOption.addEventListener("click", () => {
      selectEventCalendar(calendar.id);
      toggleEventCalendarMenu(false);
      els.eventCalendarButton.focus();
    });
    els.eventCalendarMenu.append(menuOption);
  });
  selectEventCalendar(selectedId);
}

function selectEventCalendar(calendarId) {
  const calendar = state.calendars.find((item) => item.id === Number(calendarId)) || state.calendars[0];
  if (!calendar) return;
  els.eventCalendar.value = String(calendar.id);
  els.eventCalendarName.textContent = calendar.name;
  els.eventCalendarColor.style.setProperty("--calendar-color", calendar.color);
  els.eventCalendarMenu.querySelectorAll(".calendar-select-option").forEach((option) => {
    option.setAttribute("aria-selected", String(Number(option.dataset.calendarId) === calendar.id));
  });
}

function toggleEventCalendarMenu(force) {
  const shouldOpen = typeof force === "boolean" ? force : els.eventCalendarMenu.hidden;
  els.eventCalendarMenu.hidden = !shouldOpen;
  els.eventCalendarButton.setAttribute("aria-expanded", String(shouldOpen));
  if (shouldOpen) requestAnimationFrame(() => {
    const selected = els.eventCalendarMenu.querySelector('[aria-selected="true"]');
    selected?.scrollIntoView({ block: "nearest" });
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
      more.setAttribute("aria-haspopup", "dialog");
      more.setAttribute("aria-controls", "dayEventsDialog");
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
  toggleEventCalendarMenu(false);
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
  const editing = Boolean(state.editingEvent);
  let savedEvent;
  try {
    const result = editing
      ? await api(`/api/events/${state.editingEvent.id}`, { method: "PATCH", body: payload })
      : await api("/api/events", { method: "POST", body: payload });
    savedEvent = result.event;
  } catch (error) {
    showError(els.eventError, error.message);
    return;
  }
  showSavedEvent(savedEvent);
  invalidateMonthCache();
  els.eventDialog.close();
  toast(editing ? "事件已更新" : "事件已创建");
  try {
    await loadCalendars();
    await loadMonth({ force: true });
    refreshSearchIfVisible();
  } catch (_error) {
    toast("事件已保存；后台刷新暂时失败");
  }
}

async function deleteEvent() {
  if (!state.editingEvent || !confirm(`确定删除“${state.editingEvent.title}”吗？`)) return;
  try {
    await api(`/api/events/${state.editingEvent.id}`, { method: "DELETE" });
    invalidateMonthCache();
    els.eventDialog.close();
    await loadCalendars();
    await loadMonth({ force: true });
    refreshSearchIfVisible();
    toast("事件已删除");
  } catch (error) { showError(els.eventError, error.message); }
}

function renderCalendarManager() {
  els.calendarManageList.replaceChildren();
  state.calendars.forEach((calendar) => {
    const row = document.createElement("div");
    row.className = "calendar-manage-row";
    row.dataset.calendarId = calendar.id;
    const color = document.createElement("span");
    color.className = "calendar-manage-color";
    color.style.setProperty("--calendar-color", calendar.color);
    const name = document.createElement("input");
    name.type = "text"; name.maxLength = 60; name.value = calendar.name;
    const save = document.createElement("button");
    save.textContent = "保存";
    save.addEventListener("click", async () => {
      try {
        await api(`/api/calendars/${calendar.id}`, { method: "PATCH", body: { name: name.value.trim() } });
        invalidateMonthCache();
        await loadCalendars(); await loadMonth({ force: true }); renderCalendarManager(); refreshSearchIfVisible(); toast("日历已更新");
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
        await loadCalendars(); renderCalendarManager(); toast("日历已删除");
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
    saveVisibleCalendars();
    els.calendarForm.reset(); setCalendarCreateColor("#3F51B5");
    await loadCalendars(); renderCalendarManager(); toast("日历已创建");
  } catch (error) { showError(els.calendarError, error.message); }
}

function openSearch() {
  els.calendarView.hidden = true;
  els.searchView.hidden = false;
  $("#mobileFab").hidden = true;
  if (window.matchMedia("(max-width: 900px)").matches) closeSidebar();
  els.searchInput.focus();
}

function closeSearch() {
  state.searchController?.abort();
  state.searchController = null;
  state.searchRequestId += 1;
  els.searchView.hidden = true;
  els.calendarView.hidden = false;
  $("#mobileFab").hidden = false;
}

function searchPageItems(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const pages = [...new Set([1, total, current - 1, current, current + 1].filter((page) => page >= 1 && page <= total))].sort((a, b) => a - b);
  const items = [];
  pages.forEach((page, index) => {
    if (index && page - pages[index - 1] > 1) items.push("ellipsis");
    items.push(page);
  });
  return items;
}

function renderSearchPagination(pagination) {
  els.searchPagination.replaceChildren();
  els.searchPagination.hidden = !pagination || pagination.total_pages <= 1;
  if (els.searchPagination.hidden) return;
  const addButton = (label, targetPage, disabled = false, current = false) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.disabled = disabled;
    if (current) button.setAttribute("aria-current", "page");
    button.addEventListener("click", () => {
      search(targetPage);
      els.searchView.scrollTo({ top: 0, behavior: "smooth" });
    });
    els.searchPagination.append(button);
  };
  addButton("上一页", pagination.page - 1, !pagination.has_previous);
  searchPageItems(pagination.page, pagination.total_pages).forEach((item) => {
    if (item === "ellipsis") {
      const ellipsis = document.createElement("span");
      ellipsis.textContent = "…";
      ellipsis.setAttribute("aria-hidden", "true");
      els.searchPagination.append(ellipsis);
    } else addButton(String(item), item, false, item === pagination.page);
  });
  addButton("下一页", pagination.page + 1, !pagination.has_next);
}

async function search(page = 1) {
  const query = els.searchInput.value.trim();
  state.searchController?.abort();
  state.searchController = null;
  const requestId = ++state.searchRequestId;
  state.searchPage = page;
  els.searchResults.replaceChildren();
  renderSearchPagination(null);
  if (!query) { els.searchSummary.textContent = "输入关键词，搜索事件标题、备注和所属日历。"; return; }
  const controller = new AbortController();
  state.searchController = controller;
  try {
    const payload = await api(`/api/events?q=${encodeURIComponent(query)}&page=${page}&page_size=100`, { signal: controller.signal });
    if (requestId !== state.searchRequestId) return;
    const pagination = payload.pagination;
    if (pagination.total_pages > 0 && pagination.page > pagination.total_pages) {
      await search(pagination.total_pages);
      return;
    }
    const pageLabel = pagination.total_pages > 1 ? ` · 第 ${pagination.page}/${pagination.total_pages} 页` : "";
    els.searchSummary.textContent = `找到 ${pagination.total} 条与“${query}”相关的记录${pageLabel}`;
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
    renderSearchPagination(pagination);
  } catch (error) {
    if (error.name !== "AbortError") els.searchSummary.textContent = error.message;
  } finally {
    if (state.searchController === controller) state.searchController = null;
  }
}

function refreshSearchIfVisible() {
  if (!els.searchView.hidden && els.searchInput.value.trim()) search(state.searchPage);
}

function closeSidebar() {
  closeCalendarOptions();
  els.sidebar.classList.remove("open");
  els.sidebarBackdrop.hidden = true;
  $("#menuButton").setAttribute("aria-expanded", "false");
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

let sidebarResize = null;
function beginSidebarResize(event) {
  if (window.matchMedia("(max-width: 900px)").matches) return;
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  sidebarResize = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startWidth: Number(els.sidebarResizer.getAttribute("aria-valuenow")) || SIDEBAR_WIDTH_DEFAULT,
  };
  document.documentElement.classList.add("sidebar-resizing");
}

function moveSidebarResize(event) {
  if (!sidebarResize || sidebarResize.pointerId !== event.pointerId) return;
  setSidebarWidth(sidebarResize.startWidth + event.clientX - sidebarResize.startX);
}

function endSidebarResize(event) {
  if (!sidebarResize || sidebarResize.pointerId !== event.pointerId) return;
  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  sidebarResize = null;
  document.documentElement.classList.remove("sidebar-resizing");
  scheduleMonthRender();
}

function resizeSidebarWithKeyboard(event) {
  const delta = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
  if (!delta && event.key !== "Home") return;
  event.preventDefault();
  const current = Number(els.sidebarResizer.getAttribute("aria-valuenow")) || SIDEBAR_WIDTH_DEFAULT;
  setSidebarWidth(event.key === "Home" ? SIDEBAR_WIDTH_DEFAULT : current + delta);
  scheduleMonthRender();
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
els.calendarOptionsMenu.querySelectorAll("[data-calendar-action]").forEach((button) => button.addEventListener("click", () => {
  const calendarId = state.optionsCalendarId;
  if (!calendarId) return;
  if (button.dataset.calendarAction === "only") {
    closeCalendarOptions();
    state.visibleCalendars = new Set([calendarId]);
    saveVisibleCalendars();
    renderCalendarFilters();
    renderMonth();
  } else if (button.dataset.calendarAction === "visibility") {
    const visible = state.visibleCalendars.has(calendarId);
    closeCalendarOptions();
    if (visible) state.visibleCalendars.delete(calendarId);
    else state.visibleCalendars.add(calendarId);
    saveVisibleCalendars();
    renderCalendarFilters();
    renderMonth();
  } else if (button.dataset.calendarAction === "manage") {
    closeCalendarOptions();
    showError(els.calendarError);
    renderCalendarManager();
    els.calendarDialog.showModal();
    requestAnimationFrame(() => els.calendarManageList.querySelector(`[data-calendar-id="${calendarId}"] input`)?.focus());
  }
}));
els.eventCalendarButton.addEventListener("click", () => toggleEventCalendarMenu());
els.eventCalendarButton.addEventListener("keydown", (event) => {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault();
  toggleEventCalendarMenu(true);
  const options = [...els.eventCalendarMenu.querySelectorAll(".calendar-select-option")];
  const selectedIndex = Math.max(0, options.findIndex((option) => option.getAttribute("aria-selected") === "true"));
  options[event.key === 'ArrowUp' ? Math.max(0, selectedIndex - 1) : selectedIndex]?.focus();
});
els.eventCalendarMenu.addEventListener("keydown", (event) => {
  const options = [...els.eventCalendarMenu.querySelectorAll(".calendar-select-option")];
  const current = options.indexOf(document.activeElement);
  let target = null;
  if (event.key === 'ArrowDown') target = options[Math.min(options.length - 1, current + 1)];
  if (event.key === 'ArrowUp') target = options[Math.max(0, current - 1)];
  if (event.key === 'Home') target = options[0];
  if (event.key === 'End') target = options.at(-1);
  if (event.key === 'Escape') return;
  if (target) { event.preventDefault(); target.focus(); }
});
els.eventDialog.addEventListener("close", () => toggleEventCalendarMenu(false));
els.eventDialog.addEventListener("cancel", (event) => {
  if (els.eventCalendarMenu.hidden) return;
  event.preventDefault();
  toggleEventCalendarMenu(false);
  els.eventCalendarButton.focus();
});
$("#manageCalendarsButton").addEventListener("click", () => { showError(els.calendarError); renderCalendarManager(); els.calendarDialog.showModal(); });
els.calendarForm.addEventListener("submit", createCalendar);
$("#sidebarSearch").addEventListener("click", openSearch);
$("#closeSearch").addEventListener("click", closeSearch);
els.searchInput.addEventListener("input", () => { clearTimeout(state.searchTimer); state.searchPage = 1; state.searchTimer = setTimeout(() => search(1), 220); });
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
$("#menuButton").addEventListener("click", () => {
  els.sidebar.classList.add("open");
  els.sidebarBackdrop.hidden = false;
  $("#menuButton").setAttribute("aria-expanded", "true");
});
$("#sidebarCloseButton").addEventListener("click", closeSidebar);
$("#mobileFab").addEventListener("click", () => openEventEditor());
els.sidebarBackdrop.addEventListener("click", closeSidebar);
els.sidebarResizer.addEventListener("pointerdown", beginSidebarResize);
els.sidebarResizer.addEventListener("pointermove", moveSidebarResize);
els.sidebarResizer.addEventListener("pointerup", endSidebarResize);
els.sidebarResizer.addEventListener("pointercancel", endSidebarResize);
els.sidebarResizer.addEventListener("dblclick", () => { setSidebarWidth(SIDEBAR_WIDTH_DEFAULT); scheduleMonthRender(); });
els.sidebarResizer.addEventListener("keydown", resizeSidebarWithKeyboard);
document.addEventListener("click", (event) => {
  if (!els.accountMenu.hidden && !event.target.closest(".sidebar-account") && event.target !== els.mobileAccountButton) toggleAccountMenu(false);
  if (!els.eventCalendarMenu.hidden && !event.target.closest(".calendar-select-field")) toggleEventCalendarMenu(false);
  if (!els.calendarOptionsMenu.hidden && !event.target.closest("#calendarOptionsMenu") && !event.target.closest(".calendar-row-more")) closeCalendarOptions();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.calendarOptionsMenu.hidden) { closeCalendarOptions(); return; }
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
let resizeRenderFrame;
function scheduleMonthRender() {
  cancelAnimationFrame(resizeRenderFrame);
  if (!els.calendarOptionsMenu.hidden) closeCalendarOptions();
  resizeRenderFrame = requestAnimationFrame(() => { if (!els.appView.hidden) renderMonth(); });
}
window.addEventListener("resize", scheduleMonthRender);
window.visualViewport?.addEventListener("resize", scheduleMonthRender);
if (window.ResizeObserver) new ResizeObserver(scheduleMonthRender).observe(els.monthGrid);
els.sidebarScrollRegion.addEventListener("scroll", closeCalendarOptions, { passive: true });
let focusRefreshTimer;
function refreshMonthAfterReturning() {
  if (document.hidden || els.appView.hidden) return;
  clearTimeout(focusRefreshTimer);
  focusRefreshTimer = setTimeout(() => loadMonth().catch((error) => toast(error.message)), 120);
}
window.addEventListener("focus", refreshMonthAfterReturning);
document.addEventListener("visibilitychange", refreshMonthAfterReturning);
window.addEventListener("popstate", () => {
  const value = monthFromPath();
  if (!value || els.appView.hidden) return;
  state.cursor = value;
  loadMonth().catch((error) => toast(error.message));
});

setSidebarWidth(storedSidebarWidth(), false);
setCalendarCreateColor("#3F51B5");

(async function bootstrap() {
  try {
    const session = await api("/api/session");
    if (session.authenticated) await showApp(session); else showLogin();
  } catch (_error) { showLogin(); }
})();
