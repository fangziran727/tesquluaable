(function () {
  var cardsRoot = document.getElementById("messageCards");
  var template = document.getElementById("cardTemplate");
  var chatScreen = document.getElementById("chatScreen");
  var campusScreen = document.getElementById("campusScreen");
  var MINUTES_PER_DAY = 24 * 60 * 60 * 1000;
  var HISTORY_DAYS = 7;
  var RESERVATION_DATA_URL = "/api/reservations";
  var RESERVATION_OPTIONS = {
    "深圳校区游泳池-场地1": ["06:30", "16:30", "19:30"],
    "深圳校区健身房-场地1": ["10:00", "12:30", "14:00", "16:00", "18:00", "20:00"]
  };
  var VENUE_ORDER = ["深圳校区游泳池-场地1", "深圳校区健身房-场地1"];
  var DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
  var TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function formatDate(date) {
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate())
    ].join("-");
  }

  function daySerial(date) {
    return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MINUTES_PER_DAY);
  }

  function timeToMinutes(time) {
    var parts = time.split(":");
    return Number(parts[0]) * 60 + Number(parts[1]);
  }

  function parseReservationDate(value) {
    if (typeof value !== "string") return null;
    var match = DATE_PATTERN.exec(value.trim());
    if (!match) return null;
    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);
    var date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }
    return date;
  }

  function normalizeReservation(raw, index) {
    if (!raw || typeof raw !== "object") return null;
    var venue = typeof raw.venue === "string" ? raw.venue.trim() : "";
    var reservationTime = typeof raw.reservationTime === "string" ? raw.reservationTime.trim() : "";
    var sentAt = typeof raw.sentAt === "string" ? raw.sentAt.trim() : "";
    var allowedTimes = RESERVATION_OPTIONS[venue];
    var date = parseReservationDate(raw.date);

    if (!allowedTimes || allowedTimes.indexOf(reservationTime) === -1 || !date) {
      return null;
    }
    if (sentAt && !TIME_PATTERN.test(sentAt)) {
      return null;
    }

    return {
      id: typeof raw.id === "string" ? raw.id : "",
      venue: venue,
      date: date,
      reservationTime: reservationTime,
      sentAt: sentAt || reservationTime,
      sourceIndex: index
    };
  }

  function compareMessages(left, right) {
    var dateDiff = daySerial(left.date) - daySerial(right.date);
    if (dateDiff !== 0) return dateDiff;
    var sentDiff = timeToMinutes(left.sentAt) - timeToMinutes(right.sentAt);
    if (sentDiff !== 0) return sentDiff;
    var venueDiff = VENUE_ORDER.indexOf(left.venue) - VENUE_ORDER.indexOf(right.venue);
    if (venueDiff !== 0) return venueDiff;
    var reservationDiff = timeToMinutes(left.reservationTime) - timeToMinutes(right.reservationTime);
    if (reservationDiff !== 0) return reservationDiff;
    return left.sourceIndex - right.sourceIndex;
  }

  function loadReservations() {
    if (!window.fetch) return Promise.resolve([]);
    return fetch(RESERVATION_DATA_URL, { cache: "no-store" }).then(function (response) {
      if (!response.ok) throw new Error("Reservation data request failed");
      return response.json();
    }).then(function (data) {
      if (!Array.isArray(data)) return [];
      return data.map(normalizeReservation).filter(function (message) {
        return message !== null;
      });
    }).catch(function () {
      return [];
    });
  }

  var WEEKDAY_NAMES = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

  function daysBetween(messageDate, today) {
    var startOfDay = function (date) {
      return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    };
    return Math.round((startOfDay(today) - startOfDay(messageDate)) / MINUTES_PER_DAY);
  }

  function monthDayLabel(date, today) {
    var label = (date.getMonth() + 1) + "月" + date.getDate() + "日";
    if (date.getFullYear() !== today.getFullYear()) {
      label = date.getFullYear() + "年" + label;
    }
    return label;
  }

  function chatTimeLabel(messageDate, sendTime) {
    var today = new Date();
    var daysAgo = daysBetween(messageDate, today);

    if (daysAgo <= 0) {
      return sendTime;
    }
    if (daysAgo === 1) {
      return "昨天 " + sendTime;
    }
    if (daysAgo <= 6) {
      return WEEKDAY_NAMES[messageDate.getDay()] + " " + sendTime;
    }
    return monthDayLabel(messageDate, today) + " " + sendTime;
  }

  function appendTimeLabel(time) {
    var label = document.createElement("div");
    label.className = "message-time";
    label.textContent = time;
    cardsRoot.appendChild(label);
  }

  function appendMessage(message) {
    var fragment = template.content.cloneNode(true);
    var card = fragment.querySelector(".message-card");

    fragment.querySelector(".venue").textContent = message.venue;
    fragment.querySelector(".reservation-time").textContent = formatDate(message.date) + " " + message.reservationTime;
    if (message.id) {
      card.dataset.reservationId = message.id;
    }
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.addEventListener("click", showCampusScreen);
    card.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        showCampusScreen();
      }
    });
    cardsRoot.appendChild(fragment);
  }

  function renderMessages(messages) {
    var today = new Date();
    cardsRoot.textContent = "";

    messages.filter(function (message) {
      var daysAgo = daysBetween(message.date, today);
      return daysAgo >= 0 && daysAgo <= HISTORY_DAYS;
    }).sort(compareMessages).forEach(function (message) {
      appendTimeLabel(chatTimeLabel(message.date, message.sentAt));
      appendMessage(message);
    });
  }

  function loadAndRenderMessages() {
    return loadReservations().then(function (messages) {
      renderMessages(messages);
      scheduleScrollToBottom();
    });
  }

  function showCampusScreen(updateHash) {
    chatScreen.classList.add("is-hidden");
    campusScreen.classList.remove("is-hidden");
    setThemeColor("#ffffff");
    campusScreen.querySelector(".campus-content").scrollTop = 0;
    if (updateHash !== false && window.location.hash !== "#campus") {
      window.location.hash = "campus";
    }
  }

  function showChatScreen() {
    campusScreen.classList.add("is-hidden");
    chatScreen.classList.remove("is-hidden");
    setThemeColor("#f0f1f5");
    if (window.location.hash === "#campus") {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    scheduleScrollToBottom();
  }

  document.querySelectorAll("[data-return-chat]").forEach(function (button) {
    button.addEventListener("click", showChatScreen);
  });

  function setThemeColor(color) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute("content", color);
    }
  }

  setThemeColor("#f0f1f5");

  function blockPinchZoom() {
    document.addEventListener("gesturestart", function (event) {
      event.preventDefault();
    });
    document.addEventListener("gesturechange", function (event) {
      event.preventDefault();
    });
    document.addEventListener("gestureend", function (event) {
      event.preventDefault();
    });
    document.addEventListener("touchmove", function (event) {
      if (event.touches && event.touches.length > 1) {
        event.preventDefault();
      }
    }, { passive: false });
  }

  function currentKeyboardInset() {
    var vv = window.visualViewport;
    var measured = vv && vv.height ? vv.height : 0;
    var layoutHeight = window.innerHeight;
    if (measured > 0 && measured < layoutHeight) {
      return Math.round(layoutHeight - measured);
    }
    var isTouch = ("ontouchstart" in window) ||
      (typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 0);
    var activeTag = document.activeElement ? document.activeElement.tagName : "";
    if (isTouch && (activeTag === "INPUT" || activeTag === "TEXTAREA")) {
      return Math.round(Math.min(layoutHeight * 0.45, 420));
    }
    return 0;
  }

  var lastKeyboardInset = null;
  var viewportRafId = null;

  function startViewportRaf() {
    if (viewportRafId !== null) return;
    function step() {
      if (window.scrollY > 0 || document.documentElement.scrollTop > 0) {
        window.scrollTo(0, 0);
      }
      syncViewport();
      viewportRafId = requestAnimationFrame(step);
    }
    viewportRafId = requestAnimationFrame(step);
  }

  function stopViewportRaf() {
    if (viewportRafId !== null) {
      cancelAnimationFrame(viewportRafId);
      viewportRafId = null;
    }
  }

  function resetKeyboardInset() {
    lastKeyboardInset = 0;
    document.documentElement.style.setProperty("--keyboard-inset", "0px");
  }

  function syncViewport() {
    var inset = currentKeyboardInset();
    var rootStyle = document.documentElement.style;
    if (inset !== lastKeyboardInset) {
      lastKeyboardInset = inset;
      rootStyle.setProperty("--keyboard-inset", inset + "px");
    }
  }

  syncViewport();
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncViewport);
  }
  window.addEventListener("resize", syncViewport);
  document.addEventListener("focusin", function () {
    var active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
      scheduleScrollToBottom();
    }
    startViewportRaf();
    setTimeout(syncViewport, 250);
  });
  document.addEventListener("focusout", function () {
    resetKeyboardInset();
    setTimeout(syncViewport, 100);
    setTimeout(stopViewportRaf, 120);
  });
  setInterval(syncViewport, 250);

  var emojiPanel = document.querySelector(".emoji-panel");
  var morePanel = document.querySelector(".more-panel");
  var inputField = document.querySelector(".input-field");

  if (inputField) {
    inputField.addEventListener("touchstart", function (event) {
      var isTouch = ("ontouchstart" in window) ||
        (typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 0);
      if (!isTouch) return;
      var layoutHeight = window.innerHeight;
      var estimate = Math.round(Math.min(layoutHeight * 0.45, 420));
      lastKeyboardInset = estimate;
      document.documentElement.style.setProperty("--keyboard-inset", estimate + "px");
      if (event.cancelable) {
        event.preventDefault();
      }
      scheduleScrollToBottom();
      startViewportRaf();
      inputField.focus({ preventScroll: true });
    }, { passive: false });
  }

  function closeInputPanels() {
    if (emojiPanel) emojiPanel.classList.remove("panel-open");
    if (morePanel) morePanel.classList.remove("panel-open");
  }

  function openInputPanel(kind) {
    var target = kind === "emoji" ? emojiPanel : morePanel;
    var other = kind === "emoji" ? morePanel : emojiPanel;
    if (!target) return;
    var opening = !target.classList.contains("panel-open");
    if (other) other.classList.remove("panel-open");
    target.classList.toggle("panel-open", opening);
    if (opening) {
      scheduleScrollToBottom();
      if (document.activeElement === inputField && inputField) {
        inputField.blur();
      }
    } else if (inputField) {
      inputField.focus({ preventScroll: true });
    }
  }

  var emojiButton = document.querySelector(".emoji-button");
  var plusButton = document.querySelector(".plus-button");
  var voiceButton = document.querySelector(".voice-button");
  if (emojiButton) emojiButton.addEventListener("click", function () { openInputPanel("emoji"); });
  if (plusButton) plusButton.addEventListener("click", function () { openInputPanel("more"); });
  if (voiceButton) voiceButton.addEventListener("click", closeInputPanels);

  if (inputField) {
    inputField.addEventListener("click", closeInputPanels);
  }

  function scrollMessagesToBottom() {
    var area = document.querySelector(".message-area");
    if (!area) return;
    var start = area.scrollTop;
    var startTime = null;
    var duration = 280;
    function step(now) {
      if (startTime === null) startTime = now;
      var progress = Math.min(1, (now - startTime) / duration);
      var eased = 1 - Math.pow(1 - progress, 3);
      var target = Math.max(0, area.scrollHeight - area.clientHeight);
      area.scrollTop = start + (target - start) * eased;
      if (progress < 1) {
        requestAnimationFrame(step);
      }
    }
    requestAnimationFrame(step);
  }

  function scheduleScrollToBottom() {
    scrollMessagesToBottom();
  }

  var messageArea = document.querySelector(".message-area");
  if (messageArea) {
    var messageTouchStarted = false;
    messageArea.addEventListener("touchstart", function () {
      messageTouchStarted = true;
    }, { passive: true });
    messageArea.addEventListener("touchmove", function () {
      if (!messageTouchStarted) return;
      messageTouchStarted = false;
      closeInputPanels();
      if (document.activeElement === inputField && inputField) {
        inputField.blur();
      }
      resetKeyboardInset();
    }, { passive: true });
    messageArea.addEventListener("touchend", function () {
      messageTouchStarted = false;
    }, { passive: true });
    messageArea.addEventListener("touchcancel", function () {
      messageTouchStarted = false;
    }, { passive: true });
    messageArea.addEventListener("click", function (event) {
      var target = event.target;
      if (target && target.closest && target.closest(".message-card")) return;
      closeInputPanels();
      if (document.activeElement === inputField && inputField) {
        inputField.blur();
      }
      resetKeyboardInset();
    });
  }

  var emojiGrid = document.getElementById("emojiGrid");
  if (emojiGrid) {
    var emojiSet = [
      "😀","😁","😂","🤣","😊","😇","🙂","😉",
      "😍","🥰","😘","😜","🤪","😎","🤩","🥳",
      "😢","😭","😤","😡","🤯","😱","🥶","🤒",
      "👍","👎","👏","🙏","💪","🤝","✌️","🤞",
      "❤️","🧡","💛","💚","💙","💜","🖤","💯",
      "🎉","🎊","🔥","✨","⭐","🌹","🍀","🐶"
    ];
    emojiSet.forEach(function (emoji) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = emoji;
      button.setAttribute("aria-label", "表情 " + emoji);
      button.addEventListener("click", function () {
        if (inputField) {
          inputField.value += emoji;
          inputField.focus({ preventScroll: true });
        }
      });
      emojiGrid.appendChild(button);
    });
  }

  if (/[?&]debug=1/.test(window.location.search)) {
    var debugEl = document.createElement("div");
    debugEl.style.cssText = "position:fixed;top:calc(var(--shell-top, 0px) + 60px);left:8px;z-index:99999;padding:6px 8px;border-radius:4px;background:rgba(0,0,0,.78);color:#fff;font:11px/1.4 monospace;pointer-events:none;";
    debugEl.textContent = "debug";
    document.body.appendChild(debugEl);
    var minVvTop = Infinity;
    var maxVvTop = -Infinity;
    var minHdrTop = Infinity;
    var maxHdrTop = -Infinity;
    function updateDebug() {
      var vv = window.visualViewport;
      var header = document.querySelector(".chat-header");
      var shell = document.querySelector(".phone-shell");
      var hb = header ? header.getBoundingClientRect() : null;
      var sb = shell ? shell.getBoundingClientRect() : null;
      var vvTop = vv && typeof vv.offsetTop === "number" ? Math.round(vv.offsetTop) : 0;
      var hdrTop = hb ? Math.round(hb.top) : -1;
      if (vvTop < minVvTop) minVvTop = vvTop;
      if (vvTop > maxVvTop) maxVvTop = vvTop;
      if (hdrTop < minHdrTop) minHdrTop = hdrTop;
      if (hdrTop > maxHdrTop) maxHdrTop = hdrTop;
      debugEl.textContent = [
        "innerH=" + Math.round(window.innerHeight),
        "vvH=" + Math.round(vv ? vv.height : 0),
        "vvTop=" + vvTop + "(" + minVvTop + "-" + maxVvTop + ")",
        "hdrTop=" + hdrTop + "(" + minHdrTop + "-" + maxHdrTop + ")",
        "shellTop=" + Math.round(sb ? sb.top : -1),
        "shellH=" + Math.round(sb ? sb.height : -1)
      ].join(" | ");
    }
    setInterval(updateDebug, 150);
    document.addEventListener("focusin", function () { setTimeout(updateDebug, 0); });
    document.addEventListener("focusout", function () { setTimeout(updateDebug, 0); });
  }

  blockPinchZoom();
  loadAndRenderMessages();

  if (window.location.hash === "#campus") {
    showCampusScreen(false);
  }
})();
