(function () {
  var form = document.getElementById("loginForm");
  var passwordField = document.getElementById("accessPassword");
  var message = document.getElementById("loginMessage");
  var title = document.getElementById("loginTitle");
  var params = new URLSearchParams(window.location.search);
  var requestedNext = params.get("next");
  var next = requestedNext === "/admin/" ? "/admin/" : "/";

  title.textContent = next === "/admin/" ? "预约提交系统" : "预约记录";
  document.title = title.textContent;

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    message.textContent = "";

    fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: passwordField.value, next: next })
    }).then(function (response) {
      if (!response.ok) throw new Error("登录失败");
      return response.json();
    }).then(function (result) {
      window.location.assign(result.next === "/admin/" ? "/admin/" : "/");
    }).catch(function () {
      passwordField.value = "";
      passwordField.focus();
      message.textContent = "请重新输入";
    });
  });
})();
