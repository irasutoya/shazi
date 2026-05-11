const form = document.querySelector("#loginForm");
const message = document.querySelector("#loginMessage");
const username = document.querySelector("#username");
const password = document.querySelector("#password");

function setMessage(text, type = "neutral") {
  message.textContent = text;
  message.dataset.type = type;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = btoa(`${username.value}:${password.value}`);
  setMessage("正在登录...");

  try {
    const response = await fetch("/api/login", {
      headers: {
        authorization: `Basic ${token}`
      }
    });

    if (!response.ok) {
      throw new Error("账号或密码不正确");
    }

    sessionStorage.setItem("shaziAdminAuth", token);
    window.location.href = "/admin";
  } catch (error) {
    setMessage(error.message, "error");
  }
});
