(function () {
  var form = document.getElementById("reservationForm");
  var venueField = document.getElementById("venue");
  var dateField = document.getElementById("date");
  var timeField = document.getElementById("reservationTime");
  var pushDateField = document.getElementById("pushDate");
  var sentAtField = document.getElementById("sentAt");
  var statusLine = document.getElementById("statusLine");
  var reservationList = document.getElementById("reservationList");
  var reservationCount = document.getElementById("reservationCount");
  var refreshButton = document.getElementById("refreshButton");
  var template = document.getElementById("reservationItemTemplate");
  var options = {};
  var reservations = [];

  function setStatus(message, state) {
    statusLine.textContent = message || "";
    if (state) {
      statusLine.dataset.state = state;
    } else {
      delete statusLine.dataset.state;
    }
  }

  function escapeText(value) {
    return typeof value === "string" ? value : "";
  }

  function formatCreatedAt(value) {
    if (!value) return "";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString("zh-CN", { hour12: false });
  }

  function populateVenues() {
    venueField.textContent = "";
    Object.keys(options).forEach(function (venue) {
      var option = document.createElement("option");
      option.value = venue;
      option.textContent = venue;
      venueField.appendChild(option);
    });
    updateTimeOptions();
  }

  function updateTimeOptions() {
    var times = options[venueField.value] || [];
    timeField.textContent = "";
    times.forEach(function (time) {
      var option = document.createElement("option");
      option.value = time;
      option.textContent = time;
      timeField.appendChild(option);
    });
  }

  function renderReservations() {
    reservationList.textContent = "";
    reservationCount.textContent = "共 " + reservations.length + " 条预约";
    if (!reservations.length) {
      var empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "还没有预约记录";
      reservationList.appendChild(empty);
      return;
    }

    reservations.slice().sort(function (left, right) {
      return (left.date + left.reservationTime).localeCompare(right.date + right.reservationTime);
    }).forEach(function (reservation) {
      var fragment = template.content.cloneNode(true);
      fragment.querySelector(".item-venue").textContent = escapeText(reservation.venue);
      fragment.querySelector(".item-time").textContent = "活动时间 " + escapeText(reservation.date) + " " + escapeText(reservation.reservationTime);
      fragment.querySelector(".item-push-time").textContent = "推送时间 " + escapeText(reservation.pushDate || reservation.date) + " " + escapeText(reservation.sentAt);
      fragment.querySelector(".item-meta").textContent = reservation.createdAt ? "系统录入时间 " + formatCreatedAt(reservation.createdAt) : "系统录入时间未知";
      var deleteButton = fragment.querySelector(".danger-action");
      deleteButton.addEventListener("click", function () {
        deleteReservation(reservation);
      });
      reservationList.appendChild(fragment);
    });
  }

  function redirectToLogin() {
    window.location.replace("/login?next=%2Fadmin%2F");
  }

  function loadOptions() {
    return fetch("/api/options", { cache: "no-store" }).then(function (response) {
      if (response.status === 401) {
        redirectToLogin();
        throw new Error("请先登录");
      }
      if (!response.ok) throw new Error("读取预约选项失败");
      return response.json();
    }).then(function (data) {
      options = data.venues || {};
      populateVenues();
    });
  }

  function loadReservations() {
    return fetch("/api/reservations", { cache: "no-store" }).then(function (response) {
      if (response.status === 401) {
        redirectToLogin();
        throw new Error("请先登录");
      }
      if (!response.ok) throw new Error("读取预约列表失败");
      return response.json();
    }).then(function (data) {
      reservations = Array.isArray(data) ? data : [];
      renderReservations();
    });
  }

  function readError(response) {
    if (response.status === 401) {
      redirectToLogin();
      return Promise.reject(new Error("请先登录"));
    }
    return response.json().then(function (data) {
      throw new Error(data.error || "请求失败");
    }).catch(function (error) {
      if (error.message && error.message !== "Unexpected end of JSON input") throw error;
      throw new Error("请求失败");
    });
  }

  function createReservation(event) {
    event.preventDefault();
    setStatus("正在保存……");
    var payload = {
      venue: venueField.value,
      date: dateField.value,
      reservationTime: timeField.value,
      pushDate: pushDateField.value,
      sentAt: sentAtField.value
    };
    fetch("/api/reservations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }).then(function (response) {
      if (!response.ok) return readError(response);
      return response.json();
    }).then(function () {
      setStatus("预约已保存，展示页会读取这条记录。", "success");
      sentAtField.value = "";
      return loadReservations();
    }).catch(function (error) {
      setStatus(error.message, "error");
    });
  }

  function deleteReservation(reservation) {
    if (!window.confirm("确定删除这条预约记录吗？\n" + reservation.venue + "，活动时间 " + reservation.date + " " + reservation.reservationTime + "，推送时间 " + (reservation.pushDate || reservation.date) + " " + reservation.sentAt)) {
      return;
    }
    setStatus("正在删除……");
    fetch("/api/reservations/" + encodeURIComponent(reservation.id), {
      method: "DELETE",
      headers: {}
    }).then(function (response) {
      if (!response.ok) return readError(response);
      return response.json();
    }).then(function () {
      setStatus("预约记录已删除。", "success");
      return loadReservations();
    }).catch(function (error) {
      setStatus(error.message, "error");
    });
  }

  function localDateValue() {
    var now = new Date();
    var year = now.getFullYear();
    var month = String(now.getMonth() + 1).padStart(2, "0");
    var day = String(now.getDate()).padStart(2, "0");
    return year + "-" + month + "-" + day;
  }

  venueField.addEventListener("change", updateTimeOptions);
  form.addEventListener("submit", createReservation);
  refreshButton.addEventListener("click", function () {
    setStatus("正在刷新……");
    loadReservations().then(function () {
      setStatus("预约列表已刷新。", "success");
    }).catch(function (error) {
      setStatus(error.message, "error");
    });
  });

  dateField.value = localDateValue();
  pushDateField.value = localDateValue();
  Promise.all([loadOptions(), loadReservations()]).catch(function (error) {
    setStatus(error.message, "error");
  });
})();
