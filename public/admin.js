const listEl = document.querySelector("#adminList");
const countEl = document.querySelector("#friendCount");
const form = document.querySelector("#friendForm");
const messageEl = document.querySelector("#formMessage");
const headingEl = document.querySelector("#editorHeading");
const deleteButton = document.querySelector("#deleteButton");
const previewButton = document.querySelector("#previewButton");
const newFriendButton = document.querySelector("#newFriendButton");
const logoutButton = document.querySelector("#logoutButton");
const markdownPreview = document.querySelector("#markdownPreview");

const fields = {
  id: document.querySelector("#friendId"),
  name: document.querySelector("#name"),
  contact: document.querySelector("#contact"),
  markdown: document.querySelector("#markdown")
};

let friends = [];
let selectedId = "";
let draggedId = "";

function authToken() {
  return sessionStorage.getItem("shaziAdminAuth");
}

function requireLogin() {
  if (!authToken()) {
    window.location.replace("/login");
    return false;
  }
  return true;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value = "") {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function renderInline(text = "") {
  let html = escapeHtml(text);
  html = html.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => {
    return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" loading="lazy">`;
  });
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    return `<a href="${escapeAttr(href)}" target="_blank" rel="noreferrer">${label}</a>`;
  });
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return html;
}

function renderMarkdown(markdown = "") {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let list = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    blocks.push(`<p>${paragraph.map(renderInline).join("<br>")}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (!list.length) return;
    blocks.push(`<ul>${list.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`);
    list = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length + 1;
      blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      list.push(bullet[1]);
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  return blocks.length ? blocks.join("") : "<p>暂无内容。</p>";
}

function setMessage(text, type = "neutral") {
  messageEl.textContent = text;
  messageEl.dataset.type = type;
}

function updatePreview() {
  markdownPreview.innerHTML = renderMarkdown(fields.markdown.value);
}

async function api(path, options = {}) {
  const token = authToken();
  const response = await fetch(path, {
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Basic ${token}` } : {}),
      ...(options.headers || {})
    },
    ...options
  });

  if (response.status === 401) {
    sessionStorage.removeItem("shaziAdminAuth");
    window.location.replace("/login");
    throw new Error("请重新登录");
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "请求失败");
  }
  return payload;
}

async function uploadImages(files) {
  const token = authToken();
  const formData = new FormData();
  for (const file of files) {
    formData.append("images", file);
  }

  const response = await fetch("/api/uploads", {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Basic ${token}` } : {})
    },
    body: formData
  });

  if (response.status === 401) {
    sessionStorage.removeItem("shaziAdminAuth");
    window.location.replace("/login");
    throw new Error("请重新登录");
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "图片上传失败");
  }
  return payload.files || [];
}

async function loadFriends() {
  friends = await api("/api/friends");
  if (!selectedId && friends[0]) {
    selectedId = friends[0].id;
  }
  renderList();
  fillForm(friends.find((friend) => friend.id === selectedId));
}

function renderList() {
  countEl.textContent = friends.length;
  listEl.innerHTML = friends.length
    ? friends.map((friend) => `
      <button class="admin-list-item ${friend.id === selectedId ? "is-active" : ""}" type="button" draggable="true" data-id="${escapeHtml(friend.id)}">
        <span class="drag-handle" aria-hidden="true">≡</span>
        <span>
          <strong>${escapeHtml(friend.name)}</strong>
          <small>${escapeHtml(friend.contact || "未填写联系方式")}</small>
        </span>
      </button>
    `).join("")
    : '<div class="empty-list">还没有傻子资料。</div>';
}

function fillForm(friend) {
  const isEditing = Boolean(friend);
  const data = friend || {};

  selectedId = data.id || "";
  fields.id.value = data.id || "";
  fields.name.value = data.name || "";
  fields.contact.value = data.contact || "";
  fields.markdown.value = data.markdown || "";

  headingEl.textContent = isEditing ? `编辑 ${data.name}` : "新建傻子资料";
  deleteButton.disabled = !isEditing;
  previewButton.disabled = !isEditing;
  setMessage(isEditing ? "正在编辑已有资料。" : "填写后保存即可创建新资料。");
  renderList();
  updatePreview();
}

function collectPayload() {
  return {
    name: fields.name.value,
    contact: fields.contact.value,
    markdown: fields.markdown.value
  };
}

function moveFriend(dragId, targetId, placeBefore) {
  if (!dragId || !targetId || dragId === targetId) return false;
  const dragIndex = friends.findIndex((friend) => friend.id === dragId);
  const targetIndex = friends.findIndex((friend) => friend.id === targetId);
  if (dragIndex < 0 || targetIndex < 0) return false;

  const [dragged] = friends.splice(dragIndex, 1);
  const currentTargetIndex = friends.findIndex((friend) => friend.id === targetId);
  friends.splice(placeBefore ? currentTargetIndex : currentTargetIndex + 1, 0, dragged);
  return true;
}

async function saveOrder() {
  const ordered = await api("/api/reorder", {
    method: "POST",
    body: JSON.stringify({ ids: friends.map((friend) => friend.id) })
  });
  friends = ordered;
  renderList();
  setMessage("排序已保存。", "success");
}

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const current = textarea.value;
  const before = current.slice(0, start);
  const after = current.slice(end);
  const prefix = before && !before.endsWith("\n") ? "\n" : "";
  const suffix = after && !text.endsWith("\n") ? "\n" : "";
  textarea.value = `${before}${prefix}${text}${suffix}${after}`;
  const next = start + prefix.length + text.length;
  textarea.focus();
  textarea.setSelectionRange(next, next);
  updatePreview();
}

function wrapSelection(textarea, marker) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = textarea.value.slice(start, end) || "文字";
  textarea.setRangeText(`${marker}${selected}${marker}`, start, end, "end");
  textarea.focus();
  updatePreview();
}

document.querySelector(".markdown-toolbar").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.insert) {
    insertAtCursor(fields.markdown, button.dataset.insert);
  }
  if (button.dataset.wrap) {
    wrapSelection(fields.markdown, button.dataset.wrap);
  }
});

document.querySelector("#imageUpload").addEventListener("change", async (event) => {
  try {
    const files = [...(event.currentTarget.files || [])];
    if (!files.length) return;
    setMessage("正在上传图片...");
    const uploaded = await uploadImages(files);
    const markdown = uploaded
      .map((file) => `![${file.name}](${file.url})`)
      .join("\n\n");
    insertAtCursor(fields.markdown, markdown);
    event.currentTarget.value = "";
    setMessage("图片已上传并插入 Markdown。", "success");
  } catch (error) {
    setMessage(error.message, "error");
  }
});

fields.markdown.addEventListener("input", updatePreview);

listEl.addEventListener("click", (event) => {
  if (draggedId) return;
  const button = event.target.closest("[data-id]");
  if (!button) return;
  const friend = friends.find((item) => item.id === button.dataset.id);
  fillForm(friend);
});

listEl.addEventListener("dragstart", (event) => {
  const button = event.target.closest("[data-id]");
  if (!button) return;
  draggedId = button.dataset.id;
  event.dataTransfer.effectAllowed = "move";
  button.classList.add("is-dragging");
});

listEl.addEventListener("dragend", () => {
  listEl.querySelectorAll(".is-dragging").forEach((item) => item.classList.remove("is-dragging"));
  draggedId = "";
});

listEl.addEventListener("dragover", (event) => {
  if (!draggedId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
});

listEl.addEventListener("drop", async (event) => {
  event.preventDefault();
  const target = event.target.closest("[data-id]");
  if (!target || !draggedId) return;
  const rect = target.getBoundingClientRect();
  const placeBefore = event.clientY < rect.top + rect.height / 2;
  const moved = moveFriend(draggedId, target.dataset.id, placeBefore);
  draggedId = "";
  if (!moved) return;

  try {
    renderList();
    await saveOrder();
  } catch (error) {
    setMessage(error.message, "error");
    await loadFriends();
  }
});

newFriendButton.addEventListener("click", () => {
  fillForm(null);
});

logoutButton.addEventListener("click", () => {
  sessionStorage.removeItem("shaziAdminAuth");
  window.location.href = "/login";
});

previewButton.addEventListener("click", () => {
  const friend = friends.find((item) => item.id === selectedId);
  if (friend) {
    window.open(`/friend/${encodeURIComponent(friend.name)}`, "_blank", "noopener");
  }
});

deleteButton.addEventListener("click", async () => {
  const friend = friends.find((item) => item.id === selectedId);
  if (!friend) return;
  const ok = window.confirm(`确定删除 ${friend.name} 的资料吗？`);
  if (!ok) return;

  try {
    await api(`/api/friends/${encodeURIComponent(friend.id)}`, { method: "DELETE" });
    friends = friends.filter((item) => item.id !== friend.id);
    selectedId = friends[0]?.id || "";
    fillForm(friends[0]);
    await saveOrder();
    setMessage("资料已删除。", "success");
  } catch (error) {
    setMessage(error.message, "error");
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage("正在保存...");

  try {
    const payload = collectPayload();
    const id = fields.id.value;
    const saved = id
      ? await api(`/api/friends/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(payload)
      })
      : await api("/api/friends", {
        method: "POST",
        body: JSON.stringify(payload)
      });

    const index = friends.findIndex((item) => item.id === saved.id);
    if (index >= 0) {
      friends[index] = saved;
    } else {
      friends.push(saved);
    }
    friends.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    selectedId = saved.id;
    fillForm(saved);
    setMessage("资料已保存。", "success");
  } catch (error) {
    setMessage(error.message, "error");
  }
});

if (requireLogin()) {
  loadFriends().catch((error) => {
    listEl.innerHTML = `<div class="empty-list">${escapeHtml(error.message)}</div>`;
    setMessage(error.message, "error");
  });
}
