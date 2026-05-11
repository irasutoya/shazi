const app = document.querySelector("#app");

let friends = [];

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

function markdownPlainText(markdown = "") {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`>-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function markdownTitle(markdown = "") {
  const heading = markdown.match(/^#{1,6}\s+(.+)$/m);
  if (heading) return markdownPlainText(heading[1]);
  const firstLine = markdown.split(/\n+/).map((line) => line.trim()).find(Boolean);
  return firstLine ? markdownPlainText(firstLine) : "暂无标题";
}

function markdownExcerpt(markdown = "", limit = 92) {
  const title = markdownTitle(markdown);
  const text = markdownPlainText(markdown).replace(title, "").trim();
  const source = text || markdownPlainText(markdown) || "暂无内容";
  return source.length > limit ? `${source.slice(0, limit)}...` : source;
}

function friendUrl(friend) {
  return `/friend/${encodeURIComponent(friend.name)}`;
}

async function loadFriends() {
  const response = await fetch("/api/friends");
  if (!response.ok) {
    throw new Error("无法读取傻子资料");
  }
  friends = await response.json();
}

function renderHome() {
  app.innerHTML = `
    <section class="friend-list" aria-label="傻子陈列">
      ${friends.length ? friends.map(renderFriendCard).join("") : '<div class="empty-state">暂无傻子资料。</div>'}
    </section>
  `;
}

function renderFriendCard(friend) {
  return `
    <article class="text-card">
      <a href="${friendUrl(friend)}" data-link>
        <h2>${escapeHtml(friend.name)}</h2>
        <h3>${escapeHtml(markdownTitle(friend.markdown))}</h3>
        <p>${escapeHtml(markdownExcerpt(friend.markdown))}</p>
      </a>
    </article>
  `;
}

function renderDetail(slug) {
  const friend = friends.find((item) => item.name === slug || item.slug === slug || item.id === slug);
  if (!friend) {
    app.innerHTML = `
      <section class="empty-state">
        <h1>没有找到这位傻子</h1>
        <a class="primary-link" href="/" data-link>返回傻子陈列</a>
      </section>
    `;
    return;
  }

  app.innerHTML = `
    <article class="profile-page">
      <a class="back-link" href="/" data-link>返回</a>
      <header class="profile-header">
        <h1>${escapeHtml(friend.name)}</h1>
        ${friend.contact ? `<p>${escapeHtml(friend.contact)}</p>` : ""}
      </header>
      <section class="markdown-body">
        ${renderMarkdown(friend.markdown)}
      </section>
    </article>
  `;
}

async function route() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (!friends.length) {
    await loadFriends();
  }

  if (path.startsWith("/friend/")) {
    renderDetail(decodeURIComponent(path.slice("/friend/".length)));
  } else {
    renderHome();
  }

  app.focus({ preventScroll: true });
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-link]");
  if (!link || link.origin !== window.location.origin) return;
  event.preventDefault();
  history.pushState({}, "", link.href);
  route();
});

window.addEventListener("popstate", route);

route().catch((error) => {
  app.innerHTML = `<section class="empty-state"><h1>页面加载失败</h1><p>${escapeHtml(error.message)}</p></section>`;
});
