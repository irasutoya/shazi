const PEOPLE_KEY = "people";
const IMAGE_PREFIX = "img:";
const SESSION_COOKIE = "np_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SITE_COOKIE = "site_unlock";
const SITE_TTL_SECONDS = 7 * 24 * 60 * 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const dataKV = getDataKV(env);
    const imageKV = getImageKV(env);

    try {
      if (!dataKV) return htmlResponse(renderSetupPage(), 500);

      if (request.method === "GET" && url.pathname === "/") {
        if (env.SITE_PASSWORD) {
          const unlocked = await isSiteUnlocked(request, env);
          if (!unlocked) return htmlResponse(renderSiteLockPage("/"));
        }
        return htmlResponse(renderPeoplePage(await loadPeople(dataKV)));
      }

      if (request.method === "POST" && url.pathname === "/unlock") {
        return handleSiteUnlock(request, env);
      }

      if (request.method === "GET" && url.pathname.startsWith("/p/")) {
        if (env.SITE_PASSWORD) {
          const unlocked = await isSiteUnlocked(request, env);
          if (!unlocked) return htmlResponse(renderSiteLockPage(url.pathname));
        }
        const id = decodeURIComponent(url.pathname.slice(3));
        const person = (await loadPeople(dataKV)).find((item) => item.id === id);
        if (!person) return htmlResponse(renderNotFoundPage(), 404);
        return htmlResponse(renderPersonPage(person));
      }

      if (request.method === "GET" && url.pathname === "/admin") {
        const authed = await isAuthed(request, env);
        const people = authed ? await loadPeople(dataKV) : [];
        return htmlResponse(renderAdminPage({ authed, people, hasCredentials: hasAdminCredentials(env) }));
      }

      if (request.method === "POST" && url.pathname === "/admin/login") {
        return handleLogin(request, env);
      }

      if (request.method === "POST" && url.pathname === "/admin/logout") {
        return redirectResponse("/admin", {
          "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
        });
      }

      if (request.method === "GET" && url.pathname === "/api/people") {
        const auth = await requireAuth(request, env);
        if (auth) return auth;
        return jsonResponse({ people: await loadPeople(dataKV) });
      }

      if (request.method === "PUT" && url.pathname === "/api/people") {
        const auth = await requireAuth(request, env);
        if (auth) return auth;
        const body = await readJsonBody(request);
        const people = normalizePeople(body.people || []);
        await savePeople(dataKV, people);
        return jsonResponse({ ok: true, people });
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/api/people/")) {
        const auth = await requireAuth(request, env);
        if (auth) return auth;
        const personId = cleanId(decodeURIComponent(url.pathname.slice("/api/people/".length)));
        if (!personId) return jsonResponse({ ok: false, error: "Invalid personId" }, 400);

        const body = await readJsonBody(request);
        const sourcePeople = Array.isArray(body.people) ? body.people : await loadPeople(dataKV);
        const people = normalizePeople(sourcePeople.filter((person) => cleanId(person.id) !== personId));

        await deleteImagesForPerson(imageKV, personId);
        await savePeople(dataKV, people);
        return jsonResponse({ ok: true, people });
      }

      if (request.method === "GET" && url.pathname === "/api/images") {
        const auth = await requireAuth(request, env);
        if (auth) return auth;
        const personId = cleanId(url.searchParams.get("personId"));
        if (!personId) return jsonResponse({ ok: false, error: "Missing personId" }, 400);
        return jsonResponse({ images: await listImages(imageKV, personId) });
      }

      if (request.method === "POST" && url.pathname === "/api/images") {
        const auth = await requireAuth(request, env);
        if (auth) return auth;
        return handleImageUpload(request, imageKV);
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/api/images/")) {
        const auth = await requireAuth(request, env);
        if (auth) return auth;
        const imagePath = decodeURIComponent(url.pathname.slice("/api/images/".length));
        const parsed = parseImagePath(imagePath);
        if (!parsed) return jsonResponse({ ok: false, error: "Invalid image path" }, 400);
        await imageKV.delete(imageKey(parsed.personId, parsed.imageId));
        return jsonResponse({ ok: true });
      }

      if (request.method === "GET" && url.pathname.startsWith("/i/")) {
        return serveImage(imageKV, decodeURIComponent(url.pathname.slice(3)));
      }

      return htmlResponse(renderNotFoundPage(), 404);
    } catch (error) {
      return jsonResponse({ ok: false, error: error.message || "Server error" }, 500);
    }
  },
};

function getDataKV(env) {
  return env.PROFILE_KV || env.DATA_KV || env.NOTES_KV || env.KV || null;
}

function getImageKV(env) {
  return env.IMAGES_KV || env.IMAGE_KV || getDataKV(env);
}

async function loadPeople(kv) {
  const raw = await kv.get(PEOPLE_KEY);
  if (!raw) return [];
  try {
    return normalizePeople(JSON.parse(raw));
  } catch {
    return [];
  }
}

async function savePeople(kv, people) {
  await kv.put(PEOPLE_KEY, JSON.stringify(people));
}

function normalizePeople(items) {
  const now = new Date().toISOString();
  return (Array.isArray(items) ? items : [])
    .filter((item) => cleanString(item.username, 80) || cleanString(item.contact, 160) || cleanString(item.introMarkdown, 30000))
    .map((item, index) => normalizePerson(item, index, now))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.username.localeCompare(b.username, "zh-CN"));
}

function normalizePerson(input, index, now) {
  return {
    id: cleanId(input.id) || crypto.randomUUID(),
    username: cleanString(input.username, 80) || "未命名",
    contact: cleanString(input.contact, 160),
    introMarkdown: cleanString(input.introMarkdown, 30000),
    sortOrder: Number.isFinite(Number(input.sortOrder)) ? Number(input.sortOrder) : index + 1,
    createdAt: cleanString(input.createdAt, 40) || now,
    updatedAt: now,
  };
}

function cleanId(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

function cleanString(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function handleLogin(request, env) {
  if (!hasAdminCredentials(env)) {
    return htmlResponse(renderAdminPage({ authed: false, people: [], hasCredentials: false }), 403);
  }

  const form = await request.formData();
  const username = String(form.get("username") || "");
  const password = String(form.get("password") || "");
  if (username !== env.ADMIN_USERNAME || password !== env.ADMIN_PASSWORD) {
    return htmlResponse(renderLoginError(), 401);
  }

  const createdAt = Math.floor(Date.now() / 1000);
  const signature = await signSession(`${createdAt}:${env.ADMIN_USERNAME}`, env.ADMIN_PASSWORD);
  const cookie = `${SESSION_COOKIE}=${createdAt}.${signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
  return redirectResponse("/admin", { "Set-Cookie": cookie });
}

async function requireAuth(request, env) {
  if (await isAuthed(request, env)) return null;
  return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
}

async function isAuthed(request, env) {
  if (!hasAdminCredentials(env)) return false;
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!match) return false;

  const [createdAt, signature] = match[1].split(".");
  const age = Math.floor(Date.now() / 1000) - Number(createdAt);
  if (!createdAt || !signature || !Number.isFinite(age) || age < 0 || age > SESSION_TTL_SECONDS) return false;

  const expected = await signSession(`${createdAt}:${env.ADMIN_USERNAME}`, env.ADMIN_PASSWORD);
  return timingSafeEqual(signature, expected);
}

function hasAdminCredentials(env) {
  return Boolean(env.ADMIN_USERNAME && env.ADMIN_PASSWORD);
}

async function isSiteUnlocked(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp(`${SITE_COOKIE}=([^;]+)`));
  if (!match) return false;
  const [payload, signature] = match[1].split(".");
  if (!payload || !signature) return false;
  const expected = await signSession(payload, env.SITE_PASSWORD);
  return timingSafeEqual(signature, expected);
}

async function handleSiteUnlock(request, env) {
  const form = await request.formData();
  const password = String(form.get("password") || "");
  if (password !== env.SITE_PASSWORD) {
    return htmlResponse(renderSiteLockError(String(form.get("redirect") || "/")), 401);
  }
  const payload = `site:${Math.floor(Date.now() / 1000)}`;
  const signature = await signSession(payload, env.SITE_PASSWORD);
  const cookie = `${SITE_COOKIE}=${payload}.${signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SITE_TTL_SECONDS}`;
  const redirect = String(form.get("redirect") || "/");
  return redirectResponse(redirect, { "Set-Cookie": cookie });
}

async function signSession(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(signed)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleImageUpload(request, kv) {
  const form = await request.formData();
  const personId = cleanId(form.get("personId"));
  if (!personId) return jsonResponse({ ok: false, error: "Missing personId" }, 400);

  const files = form.getAll("images").filter((file) => file instanceof File && file.size > 0);
  if (!files.length) return jsonResponse({ ok: false, error: "请选择图片文件" }, 400);

  for (const file of files) {
    if (!file.type.startsWith("image/")) return jsonResponse({ ok: false, error: "只能上传图片" }, 400);
    if (file.size > MAX_IMAGE_BYTES) return jsonResponse({ ok: false, error: "图片不能超过 8MB" }, 400);
  }

  const uploaded = [];
  for (const file of files) {
    const imageId = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const metadata = {
      id: `${personId}/${imageId}`,
      personId,
      imageId,
      filename: file.name || "image",
      contentType: file.type || "application/octet-stream",
      size: file.size,
      createdAt: new Date().toISOString(),
      url: `/i/${personId}/${imageId}`,
    };
    await kv.put(imageKey(personId, imageId), await file.arrayBuffer(), { metadata });
    uploaded.push(metadata);
  }

  return jsonResponse({
    ok: true,
    images: uploaded,
    markdown: uploaded.map((image) => `![${escapeMarkdownAlt(image.filename)}](${image.url})`).join("\n"),
  });
}

async function listImages(kv, personId) {
  const result = await kv.list({ prefix: imagePrefix(personId), limit: 1000 });
  return result.keys
    .map((item) => item.metadata || imageMetadataFromKey(item.name))
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

async function deleteImagesForPerson(kv, personId) {
  let cursor;
  do {
    const result = await kv.list({ prefix: imagePrefix(personId), cursor, limit: 1000 });
    await Promise.all((result.keys || []).map((item) => kv.delete(item.name)));
    cursor = result.list_complete === false ? result.cursor : null;
  } while (cursor);
}

async function serveImage(kv, imagePath) {
  const parsed = parseImagePath(imagePath);
  if (!parsed) return new Response("Image not found", { status: 404 });
  const result = await kv.getWithMetadata(imageKey(parsed.personId, parsed.imageId), "arrayBuffer");
  if (!result.value) return new Response("Image not found", { status: 404 });
  return new Response(result.value, {
    headers: {
      "Content-Type": result.metadata?.contentType || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function imagePrefix(personId) {
  return `${IMAGE_PREFIX}${personId}:`;
}

function imageKey(personId, imageId) {
  return `${imagePrefix(personId)}${imageId}`;
}

function parseImagePath(imagePath) {
  const [personId, imageId] = String(imagePath || "").split("/");
  const cleanPersonId = cleanId(personId);
  const cleanImageId = cleanId(imageId);
  if (!cleanPersonId || !cleanImageId) return null;
  return { personId: cleanPersonId, imageId: cleanImageId };
}

function imageMetadataFromKey(key) {
  const raw = key.slice(IMAGE_PREFIX.length);
  const separator = raw.indexOf(":");
  if (separator < 1) return null;
  const personId = raw.slice(0, separator);
  const imageId = raw.slice(separator + 1);
  return {
    id: `${personId}/${imageId}`,
    personId,
    imageId,
    filename: imageId,
    url: `/i/${personId}/${imageId}`,
  };
}

function renderPeoplePage(people) {
  return pageShell({
    title: "傻子展览馆",
    body: `
      <main class="public-shell">
        <section class="atlas-hero">
          <div>
            <h1>傻子展览馆</h1>
          </div>
        </section>
        ${people.length ? `<nav class="atlas-grid">${people.map((person, index) => renderPersonListItem(person, index)).join("")}</nav>` : `<section class="empty-state">暂无傻子资料。</section>`}
      </main>
    `,
  });
}

function renderPersonListItem(person, index) {
  const summary = summarizeMarkdown(person.introMarkdown);
  return `
    <a class="atlas-card" href="/p/${encodeURIComponent(person.id)}">
      <span class="card-number">${String(index + 1).padStart(2, "0")}</span>
      <span class="card-name">${escapeHtml(person.username)}</span>
      ${person.contact ? `<span class="card-contact">${escapeHtml(person.contact)}</span>` : ""}
      ${summary ? `<span class="card-summary">${escapeHtml(summary)}</span>` : ""}
      <span class="card-action">打开资料</span>
    </a>
  `;
}

function summarizeMarkdown(markdown) {
  return String(markdown || "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[[^\]]+]\([^)]+\)/g, (match) => match.slice(1, match.indexOf("]")))
    .replace(/[#>*_`-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function renderPersonPage(person) {
  return pageShell({
    title: person.username,
    body: `
      <main class="public-shell detail-shell">
        <a class="back-link" href="/">返回傻子展览馆</a>
        <section class="profile-hero">
          <h1>${escapeHtml(person.username)}</h1>
        </section>
        ${person.contact ? `
          <section class="contact-box">
            <span>联系方式</span>
            <strong>${linkifyContact(person.contact)}</strong>
          </section>
        ` : ""}
        <article class="profile-sheet markdown-body">${renderMarkdown(person.introMarkdown || "暂无介绍。")}</article>
      </main>
    `,
  });
}

function renderAdminPage({ authed, people, hasCredentials }) {
  if (!hasCredentials) {
    return pageShell({
      title: "后台未配置",
      body: `
        <main class="public-shell narrow">
          <h1>后台未配置</h1>
          <p class="muted">请先在 Cloudflare Workers 中添加环境变量 <code>ADMIN_USERNAME</code> 和 <code>ADMIN_PASSWORD</code>，再登录后台。</p>
          <p class="muted">KV 绑定名称建议使用 <code>PROFILE_KV</code> 和 <code>IMAGES_KV</code>；也可以只绑定一个 <code>KV</code>。</p>
          <a class="button secondary" href="/">返回首页</a>
        </main>
      `,
    });
  }

  if (!authed) return renderLoginPage();

  return pageShell({
    title: "傻子管理",
    body: `
      <main class="studio-shell">
        <header class="studio-top">
          <div>
            <h1>管理后台</h1>
          </div>
          <div class="top-actions">
            <a class="button ghost" href="/" target="_blank" rel="noreferrer">打开前台</a>
            <form method="post" action="/admin/logout"><button class="button secondary" type="submit">退出</button></form>
          </div>
        </header>

        <section class="studio-grid">
          <aside class="record-panel">
            <div class="panel-head">
              <div>
                <h2>傻子列表</h2>
                <p class="panel-caption">拖动排序，点击编辑</p>
              </div>
              <button id="addPerson" class="icon-button" type="button" title="新增傻子">+</button>
            </div>
            <input id="recordSearch" class="search-input" type="search" placeholder="搜索姓名或联系方式">
            <div id="peopleList" class="record-list"></div>
            <div class="save-block">
              <button id="savePeople" class="button" type="button">保存更改</button>
              <p id="saveStatus" class="status"></p>
            </div>
          </aside>

          <section id="editorPanel" class="canvas-panel"></section>

          <aside class="utility-panel">
            <section class="utility-card">
              <h2>发布</h2>
              <div id="publishTools" class="publish-tools"></div>
            </section>
            <section class="utility-card">
              <h2>图片素材</h2>
              <form id="imageForm" class="upload-form">
                <input name="images" type="file" accept="image/*" multiple required>
                <button class="button secondary" type="submit">上传</button>
              </form>
              <p class="muted">上传后可插入当前 Markdown 光标位置。</p>
              <div id="imageList" class="image-list"><p class="muted empty">加载图片中...</p></div>
            </section>
          </aside>
        </section>
      </main>
      <script>
        window.__PEOPLE__ = ${safeJson(people)};
        ${adminScript()}
      </script>
    `,
  });
}

function renderSiteLockPage(redirect) {
  return pageShell({
    title: "输入密码",
    body: `
      <main class="login-wrap">
        <form class="login-card" method="post" action="/unlock">
          <h1>傻子展览馆</h1>
          <p class="muted">此页面已加密，请输入访问密码。</p>
          <input name="redirect" type="hidden" value="${escapeAttr(redirect || "/")}">
          <label>访问密码<input name="password" type="password" required autofocus></label>
          <button class="button" type="submit">进入</button>
        </form>
      </main>
    `,
  });
}

function renderSiteLockError(redirect) {
  return pageShell({
    title: "密码错误",
    body: `
      <main class="login-wrap">
        <form class="login-card" method="post" action="/unlock">
          <h1>密码错误</h1>
          <p class="error">访问密码不正确。</p>
          <input name="redirect" type="hidden" value="${escapeAttr(redirect || "/")}">
          <label>访问密码<input name="password" type="password" required autofocus></label>
          <button class="button" type="submit">重试</button>
        </form>
      </main>
    `,
  });
}

function renderLoginPage() {
  return pageShell({
    title: "登录后台",
    body: `
      <main class="login-wrap">
        <form class="login-card" method="post" action="/admin/login">
          <h1>登录后台</h1>
          <label>用户名<input name="username" type="text" autocomplete="username" required autofocus></label>
          <label>管理密码<input name="password" type="password" autocomplete="current-password" required></label>
          <button class="button" type="submit">登录</button>
          <a class="plain-link" href="/">返回首页</a>
        </form>
      </main>
    `,
  });
}

function renderLoginError() {
  return pageShell({
    title: "登录失败",
    body: `
      <main class="login-wrap">
        <form class="login-card" method="post" action="/admin/login">
          <h1>登录失败</h1>
          <p class="error">用户名或密码不正确。</p>
          <label>用户名<input name="username" type="text" autocomplete="username" required autofocus></label>
          <label>管理密码<input name="password" type="password" autocomplete="current-password" required></label>
          <button class="button" type="submit">重新登录</button>
        </form>
      </main>
    `,
  });
}

function renderSetupPage() {
  return pageShell({
    title: "KV 未绑定",
    body: `
      <main class="public-shell narrow">
        <h1>KV 未绑定</h1>
        <p class="muted">请为 Worker 绑定 KV 命名空间。推荐绑定：</p>
        <pre><code>PROFILE_KV  存储傻子资料列表
IMAGES_KV   存储图片文件</code></pre>
        <p class="muted">如果只想使用一个 KV，也可以绑定为 <code>KV</code>，资料和图片会共用该命名空间。</p>
      </main>
    `,
  });
}

function renderNotFoundPage() {
  return pageShell({
    title: "页面不存在",
    body: `<main class="public-shell narrow"><h1>页面不存在</h1><p class="muted" style="margin-bottom:24px">你访问的页面不存在或已被删除。</p><a class="button secondary" href="/">返回首页</a></main>`,
  });
}

function pageShell({ title, body }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(title)}</title>
  <style>${styles()}</style>
</head>
<body>${body}<script>${lightboxScript()}</script></body>
</html>`;
}

function lightboxScript() {
  return `
(function(){var o=document.createElement("div");o.className="lightbox-overlay";o.innerHTML='<button class="lightbox-close" aria-label="关闭">\\u2715</button><img class="lightbox-image" src="">';document.body.appendChild(o);var i=o.querySelector(".lightbox-image"),c=o.querySelector(".lightbox-close"),s=1,px=0,py=0,d=!1,sx=0,sy=0,lt=0,lx=0,ly=0;
function w(){var vw=window.innerWidth*.92,iw=i.naturalWidth||vw,ih=i.naturalHeight||window.innerHeight;s=iw>vw?vw/iw:1;px=0;py=0;o.style.alignItems=ih*s>window.innerHeight?"flex-start":"center";u()}
function u(){i.style.transform="translate("+px+"px,"+py+"px) scale("+s+")"}
function n(t){var v=document.querySelector("meta[name=viewport]");v&&v.setAttribute("content","width=device-width,initial-scale=1,maximum-scale=1");document.body.style.overflow="hidden";i.src=t;i.onload=function(){w();setTimeout(function(){o.classList.add("active")},20)};if(i.complete)w()}
function f(){var v=document.querySelector("meta[name=viewport]");v&&v.setAttribute("content","width=device-width,initial-scale=1");document.body.style.overflow="";o.style.alignItems="center";o.classList.remove("active");i.src=""}
c.addEventListener("click",f);o.addEventListener("click",function(t){t.target===o&&f()});document.addEventListener("keydown",function(t){t.key==="Escape"&&o.classList.contains("active")&&f()});
i.addEventListener("wheel",function(t){t.preventDefault();s=Math.max(.5,Math.min(10,s*(t.deltaY>0?.9:1.1)));u()},{passive:false});
i.addEventListener("mousedown",function(t){t.preventDefault();d=!0;sx=t.clientX-px;sy=t.clientY-py;i.classList.add("dragging")});
document.addEventListener("mousemove",function(t){if(!d)return;px=t.clientX-sx;py=t.clientY-sy;u()});document.addEventListener("mouseup",function(){d=!1;i.classList.remove("dragging")});
i.addEventListener("touchstart",function(t){if(t.touches.length===2){var e=t.touches[0].clientX-t.touches[1].clientX,a=t.touches[0].clientY-t.touches[1].clientY;lt=Math.sqrt(e*e+a*a)}else if(t.touches.length===1){lx=t.touches[0].clientX-px;ly=t.touches[0].clientY-py}});
i.addEventListener("touchmove",function(t){if(t.touches.length===2){t.preventDefault();var e=t.touches[0].clientX-t.touches[1].clientX,a=t.touches[0].clientY-t.touches[1].clientY,nd=Math.sqrt(e*e+a*a);if(lt){s=Math.max(.5,Math.min(10,s*(nd/lt)))}lt=nd;u()}else if(t.touches.length===1){px=t.touches[0].clientX-lx;py=t.touches[0].clientY-ly;u()}},{passive:false});
i.addEventListener("touchend",function(){lt=0});
document.addEventListener("click",function(t){var g=t.target.closest(".markdown-body img,.markdown-preview img");if(!g||g.closest(".image-item"))return;var u=g.getAttribute("src");if(u&&!u.startsWith("data:")){t.preventDefault();n(u)}});
})();
`; }

function styles() {
  return `
    :root{color-scheme:light dark;--bg:#f6f8fa;--canvas:#fff;--canvas-subtle:#f3f5f8;--ink:#1f2329;--muted:#636c76;--border:#d1d9e0;--border-muted:#e1e5ea;--accent:#0969da;--accent-fg:#fff;--accent-muted:#ddf4ff;--success:#1f883d;--success-hover:#1a7f37;--success-fg:#fff;--danger:#cf222e;--danger-muted:#ffebe9;--button:#f6f8fa;--button-hover:#eef1f5;--focus:#0969da33;--radius:10px;--radius-sm:6px;--radius-lg:14px;--shadow:0 1px 3px rgba(31,35,40,.04);--shadow-hover:0 4px 16px rgba(31,35,40,.08);--inset:inset 0 1px 0 rgba(208,215,222,.2);--header-height:64px}
    @media (prefers-color-scheme:dark){:root{--bg:#0d1117;--canvas:#151b23;--canvas-subtle:#1c2129;--ink:#f0f6fc;--muted:#9198a1;--border:#3d444d;--border-muted:#30363d;--accent:#4493f8;--accent-fg:#fff;--accent-muted:#1f6feb26;--success:#238636;--success-hover:#2ea043;--success-fg:#fff;--danger:#ff7b72;--danger-muted:#490202;--button:#212830;--button-hover:#262c36;--focus:#4493f866;--shadow:0 0 transparent;--shadow-hover:0 0 transparent;--inset:none}}
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;letter-spacing:.01em;-webkit-font-smoothing:antialiased}
    a{color:var(--accent);text-decoration:none}
    a:hover{text-decoration:underline}
    code,pre,textarea,input{font:inherit}
    code{background:var(--canvas-subtle);border:1px solid var(--border-muted);border-radius:var(--radius-sm);padding:.14rem .38rem;font-family:ui-monospace,SFMono-Regular,SFMono,Consolas,"Liberation Mono",Menlo,monospace;font-size:.86em;letter-spacing:0}
    pre{overflow:auto;background:var(--canvas-subtle);border:1px solid var(--border);border-radius:var(--radius);padding:18px}
    img{max-width:100%;height:auto}
    .public-shell{width:min(1120px,calc(100% - 40px));margin:0 auto;padding:48px 0 80px}
    .narrow{width:min(540px,calc(100% - 40px))}
    .narrow h1{margin-bottom:24px}
    .atlas-hero,.profile-hero{margin-bottom:28px;padding:0 0 24px;border-bottom:1px solid var(--border-muted)}
    .atlas-hero{display:flex;justify-content:space-between;gap:24px;align-items:flex-end}
    h1{font-size:clamp(28px,4.4vw,48px);line-height:1.2;margin:0;font-weight:600;letter-spacing:-.025em}
    h2{font-size:17px;margin:0;font-weight:600;letter-spacing:-.01em}
    .hero-copy{max-width:440px;margin:0;color:var(--muted);font-size:15px}
    .atlas-grid{column-width:300px;column-gap:24px}
    .atlas-card{display:inline-flex;break-inside:avoid;flex-direction:column;width:100%;margin:0 0 24px;padding:24px;min-height:190px;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--canvas);color:var(--ink);text-decoration:none;box-shadow:var(--shadow);transition:border-color .15s,box-shadow .2s,transform .15s}
    .atlas-card:nth-child(3n+1){min-height:240px}
    .atlas-card:nth-child(4n+2){min-height:215px}
    .atlas-card:hover{border-color:var(--accent);box-shadow:var(--shadow-hover);transform:translateY(-3px);text-decoration:none}
    .card-number{display:inline-flex;align-items:center;justify-content:center;width:max-content;min-width:38px;height:24px;margin-bottom:18px;padding:0 10px;border:1px solid var(--border);border-radius:999px;background:var(--canvas-subtle);color:var(--muted);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-weight:600;font-size:12px;letter-spacing:.02em}
    .card-name{color:var(--accent);font-size:18px;line-height:1.3;font-weight:600;overflow-wrap:anywhere;letter-spacing:-.01em}
    .card-contact{margin-top:10px;color:var(--muted);overflow-wrap:anywhere;font-size:14px;line-height:1.5}
    .card-summary{margin-top:14px;color:var(--muted);font-size:14px;line-height:1.6}
    .card-action{margin-top:auto;padding-top:18px;color:var(--muted);font-size:13px;font-weight:500}
    .empty-state,.profile-sheet,.contact-box,.login-card{background:var(--canvas);border:1px solid var(--border);border-radius:var(--radius-lg)}
    .empty-state{padding:32px 24px;color:var(--muted);text-align:center}
    .back-link{display:inline-flex;align-items:center;min-height:36px;margin-bottom:28px;padding:0 14px;border:1px solid var(--border);border-radius:var(--radius);color:var(--muted);font-size:14px;transition:background .12s,border-color .12s}
    .back-link:hover{background:var(--canvas-subtle);border-color:var(--accent);color:var(--accent);text-decoration:none}
    .back-link::before{content:"\\2190";margin-right:6px}
    .contact-box{display:grid;gap:6px;margin:0 0 24px;padding:18px 20px}
    .contact-box span,.muted,.status{color:var(--muted)}
    .contact-box strong{font-size:15px;word-break:break-word;line-height:1.5}
    .profile-sheet{padding:32px}
    .markdown-body{font-size:16px;line-height:1.75}
    .markdown-body p{margin:0 0 1em}
    .markdown-body h1,.markdown-preview h1{font-size:2em;margin:32px 0 18px;padding-bottom:.35em;border-bottom:1px solid var(--border);font-weight:600;letter-spacing:-.02em}
    .markdown-body h2,.markdown-preview h2{font-size:1.5em;margin:28px 0 16px;padding-bottom:.3em;border-bottom:1px solid var(--border);font-weight:600;letter-spacing:-.015em}
    .markdown-body h3,.markdown-preview h3{font-size:1.25em;margin:24px 0 14px;font-weight:600;letter-spacing:-.01em}
    .markdown-body h4,.markdown-preview h4{font-size:1.05em;margin:20px 0 10px;font-weight:600}
    .markdown-body h1:first-child,.markdown-preview h1:first-child{margin-top:0}
    .markdown-body h2:first-child,.markdown-preview h2:first-child{margin-top:0}
    .markdown-body img,.markdown-preview img{display:block;width:240px;height:240px;object-fit:cover;object-position:left top;border-radius:var(--radius-sm);margin:24px 0;border:1px solid var(--border);cursor:zoom-in;transition:transform .15s}
    .markdown-body img:hover,.markdown-preview img:hover{transform:scale(1.02)}
    .preview-image-frame{position:relative;display:block;width:max-content;max-width:100%;margin:24px 0}
    .preview-image-frame img{margin:0}
    .preview-image-controls{position:absolute;top:8px;right:8px;display:flex;gap:6px;align-items:center;padding:6px;border-radius:var(--radius);background:rgba(255,255,255,.92);border:1px solid var(--border);box-shadow:0 6px 18px rgba(31,35,40,.12);backdrop-filter:blur(8px)}
    @media (prefers-color-scheme:dark){.preview-image-controls{background:rgba(21,27,35,.92)}}
    .preview-image-count{min-width:34px;color:var(--muted);font-size:12px;font-weight:600;text-align:center;line-height:1}
    .preview-move-button{min-height:28px;padding:0 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--button);color:var(--ink);font-weight:600;font-size:12px;cursor:pointer}
    .preview-move-button:hover:not(:disabled){background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
    .preview-move-button:disabled{opacity:.45;cursor:not-allowed}
    @media (max-width:480px){.markdown-body img,.markdown-preview img{width:160px;height:160px;margin:4px 14px 12px 0}.preview-image-frame{margin:4px 14px 12px 0}.preview-image-frame img{margin:0}.preview-image-controls{position:static;width:160px;margin-top:6px;justify-content:center}}
    .markdown-body blockquote,.markdown-preview blockquote{margin:24px 0;padding:0 1.2em;border-left:4px solid var(--accent-muted);color:var(--muted)}
    .markdown-body a,.markdown-preview a{font-weight:500}
    .markdown-body pre,.markdown-preview pre{margin:24px 0;background:var(--canvas-subtle);color:var(--ink);border:1px solid var(--border);border-radius:var(--radius);padding:18px;overflow:auto;white-space:pre}
    .markdown-body pre code,.markdown-preview pre code{display:block;background:transparent;border:0;border-radius:0;padding:0;color:inherit;font-size:.9rem;line-height:1.7}
    .markdown-body p code,.markdown-preview p code,.markdown-body li code,.markdown-preview li code{background:var(--canvas-subtle);border:1px solid var(--border-muted);border-radius:var(--radius-sm);padding:.14rem .38rem}
    .markdown-body li{margin:.4em 0}
    .markdown-body ul,.markdown-body ol{padding-left:1.5em}
    .button,.icon-button{display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:var(--radius);font-weight:600;cursor:pointer;text-decoration:none;transition:background .12s,border-color .12s,box-shadow .12s}
    .button{min-height:36px;padding:0 14px;background:var(--success);color:var(--success-fg);box-shadow:var(--shadow);font-size:14px}
    .button:hover{background:var(--success-hover);text-decoration:none}
    .button.secondary,.button.ghost{background:var(--button);color:var(--ink)}
    .button.secondary:hover,.button.ghost:hover{background:var(--button-hover)}
    .button.danger{background:var(--danger-muted);color:var(--danger);border-color:transparent}
    .button.danger:hover{filter:brightness(.94)}
    .icon-button{width:34px;height:34px;background:var(--success);color:var(--success-fg);font-size:20px}
    .studio-shell{width:min(1500px,calc(100% - 32px));margin:0 auto;padding:24px 0 40px}
    .studio-top{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:16px;padding:16px 20px;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--canvas)}
    .studio-top h1{font-size:22px}
    .top-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    .studio-grid{display:grid;grid-template-columns:280px minmax(0,1fr) 320px;gap:16px;align-items:start}
    .record-panel,.canvas-panel,.utility-card{background:var(--canvas);border:1px solid var(--border);border-radius:var(--radius-lg)}
    .record-panel,.utility-panel{position:sticky;top:16px}
    .record-panel{overflow:hidden;align-self:start}
    .panel-head,.save-block{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:16px;border-bottom:1px solid var(--border)}
    .panel-caption{margin:.25rem 0 0;color:var(--muted);font-size:.88rem;line-height:1.4}
    .search-input{margin:12px 16px;width:calc(100% - 32px)}
    .save-block{border-top:1px solid var(--border);border-bottom:0;flex-direction:column}
    .save-block .status{font-size:13px}
    .record-list{display:grid;max-height:calc(100vh - 286px);overflow:auto;padding:6px}
    .record-tab{display:grid;grid-template-columns:26px minmax(0,1fr);gap:8px;align-items:center;margin:2px 6px;padding:10px 12px;border:1px solid transparent;border-radius:var(--radius);background:transparent;color:var(--ink);text-align:left;cursor:pointer;transition:background .1s}
    .record-tab:hover{background:var(--canvas-subtle)}
    .record-tab.active{background:var(--accent-muted);border-color:var(--accent)}
    .record-tab.dragging{opacity:.45}
    .record-tab.drag-over{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
    .record-tab strong,.record-tab small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .record-tab strong{font-size:14px}
    .record-tab small{color:var(--muted);font-size:13px;margin-top:2px}
    .drag-handle{color:var(--muted);font-weight:600;font-size:18px;line-height:1;cursor:grab;opacity:.5;transition:opacity .15s}
    .record-tab:hover .drag-handle{opacity:1}
    .canvas-panel{min-height:650px;padding:24px}
    .editor-empty{display:grid;place-items:center;min-height:360px;color:var(--muted);text-align:center;font-size:15px}
    .editor-header{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)}
    .editor-title{min-width:0}
    .editor-title h2{font-size:20px;overflow-wrap:anywhere;letter-spacing:-.01em}
    .editor-hint{margin:.3rem 0 0;color:var(--muted);font-size:13px}
    .editor-actions{display:flex;gap:8px;flex-wrap:wrap}
    .field-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;margin-bottom:20px}
    label{display:grid;gap:6px;font-weight:600;font-size:14px;letter-spacing:.01em}
    input,textarea{width:100%;border:1px solid var(--border);border-radius:var(--radius);padding:9px 12px;background:var(--canvas);color:var(--ink);box-shadow:var(--inset);font-size:14px;transition:border-color .15s,box-shadow .15s}
    input:focus,textarea:focus{border-color:var(--accent);outline:0;box-shadow:0 0 0 3px var(--focus)}
    textarea{resize:vertical;min-height:360px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;line-height:1.65;font-size:14px}
    .mode-tabs,.editor-toolbar{display:flex;gap:6px;flex-wrap:wrap}
    .mode-tabs{margin:0 0 12px}
    .mode-tab,.tool-button{min-height:32px;padding:0 12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--button);color:var(--ink);font-weight:600;cursor:pointer;font-size:13px;transition:background .1s,color .1s}
    .mode-tab.active,.tool-button:hover{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
    .markdown-editor{border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;background:var(--canvas)}
    .editor-toolbar{padding:8px 10px;border-bottom:1px solid var(--border);background:var(--canvas-subtle)}
    .editor-body textarea{border:0;border-radius:0;min-height:430px;padding:14px}
    .preview-pane{display:none;min-height:430px;padding:24px;background:var(--canvas);overflow:auto}
    .editor-body.previewing textarea,.editor-body.previewing .editor-toolbar{display:none}
    .editor-body.previewing .preview-pane{display:block}
    .utility-panel{display:grid;gap:16px}
    .utility-card{padding:16px}
    .publish-tools{display:grid;gap:10px;margin-top:14px}
    .upload-form{display:grid;gap:10px;margin:14px 0}
    .image-list{display:grid;gap:16px;margin-top:16px;max-height:calc(100vh - 360px);overflow:auto}
    .image-item{display:grid;grid-template-columns:68px minmax(0,1fr);gap:12px;border-top:1px solid var(--border-muted);padding-top:14px}
    .image-item:first-child{border-top:0;padding-top:0}
    .image-item img{width:68px;height:68px;object-fit:cover;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--canvas-subtle)}
    .image-item strong,.image-item code{display:block;overflow-wrap:anywhere}
    .image-item strong{font-size:14px}
    .image-item code{margin:6px 0 10px;font-size:13px}
    .row-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
    .row-actions .button{min-height:30px;padding:0 10px;font-size:13px}
    .login-wrap{min-height:100svh;display:grid;place-items:center;padding:32px;background:var(--bg)}
    .login-card{width:min(400px,100%);padding:32px;text-align:center}
    .login-card h1{font-size:24px;margin:0 0 16px;letter-spacing:-.02em}
    .login-card label{text-align:left;margin-bottom:16px}
    .login-card .muted{margin:0 0 20px;font-size:14px;line-height:1.6}
    .login-card .button{width:100%;margin-top:8px}
    .plain-link{display:inline-block;margin-top:16px;font-size:14px;color:var(--muted)}
    .plain-link:hover{color:var(--accent)}
    .error{color:var(--danger);font-weight:600;font-size:14px;margin:0 0 20px}
    @media (max-width:1120px){
      .studio-grid{grid-template-columns:270px minmax(0,1fr)}
      .utility-panel{grid-column:1 / -1;position:static}
      .image-list{max-height:none}
    }
    @media (max-width:780px){
      body{font-size:15px}
      .public-shell,.studio-shell{width:min(100% - 24px,960px);padding:24px 0 48px}
      h1{font-size:28px}
      .atlas-hero,.studio-top,.editor-header{flex-direction:column;align-items:flex-start}
      .atlas-grid{column-width:auto;columns:1}
      .studio-grid,.field-grid{grid-template-columns:1fr}
      .record-panel,.utility-panel{position:static}
      .record-list{max-height:none}
      .canvas-panel{min-height:0;padding:16px}
      .top-actions,.editor-actions{width:100%}
      .top-actions .button,.top-actions form,.top-actions button,.editor-actions .button{width:100%}
      .editor-body textarea,.preview-pane{min-height:360px}
      .login-card{padding:24px 20px}
    }
    .lightbox-overlay{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;pointer-events:none;opacity:0;transition:opacity .2s;cursor:zoom-out}
    .lightbox-overlay.active{opacity:1;pointer-events:auto}
    .lightbox-image{max-width:92vw;cursor:grab;user-select:none;-webkit-user-select:none;transition:transform .08s;border-radius:6px;box-shadow:0 8px 48px rgba(0,0,0,.45)}
    .lightbox-image.dragging{cursor:grabbing;transition:none}
    .lightbox-close{position:fixed;top:20px;right:20px;width:40px;height:40px;border:0;border-radius:50%;background:rgba(0,0,0,.5);color:#fff;font-size:24px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:10000;transition:background .15s;font-family:inherit}
    .lightbox-close:hover{background:rgba(0,0,0,.75)}
    @media (max-width:480px){
      .lightbox-close{top:14px;right:14px;width:36px;height:36px;font-size:20px}
    }
  `;
}

function adminScript() {
  return `
    let people = Array.isArray(window.__PEOPLE__) ? window.__PEOPLE__ : [];
    let activeId = people[0]?.id || null;
    let activeTextarea = null;
    let viewMode = "write";
    let draggedId = null;
    let dirty = false;

    const peopleList = document.getElementById("peopleList");
    const editorPanel = document.getElementById("editorPanel");
    const addPerson = document.getElementById("addPerson");
    const savePeople = document.getElementById("savePeople");
    const statusEl = document.getElementById("saveStatus");
    const recordSearch = document.getElementById("recordSearch");
    const publishTools = document.getElementById("publishTools");
    const imageForm = document.getElementById("imageForm");
    const imageList = document.getElementById("imageList");

    addPerson.addEventListener("click", () => {
      collectActive();
      const person = {
        id: crypto.randomUUID(),
        username: "新傻子",
        contact: "",
        introMarkdown: "",
        sortOrder: people.length + 1,
        createdAt: new Date().toISOString(),
      };
      people.push(person);
      activeId = person.id;
      viewMode = "write";
      markDirty();
      renderAll();
      refreshImages();
    });

    savePeople.addEventListener("click", saveAll);
    recordSearch.addEventListener("input", renderList);

    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveAll();
      }
    });

    peopleList.addEventListener("click", (event) => {
      const tab = event.target.closest("[data-id]");
      if (!tab) return;
      collectActive();
      activeId = tab.dataset.id;
      viewMode = "write";
      renderAll();
      refreshImages();
    });

    peopleList.addEventListener("dragstart", (event) => {
      const tab = event.target.closest("[data-id]");
      if (!tab) return;
      draggedId = tab.dataset.id;
      tab.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggedId);
    });

    peopleList.addEventListener("dragend", (event) => {
      event.target.closest("[data-id]")?.classList.remove("dragging");
      peopleList.querySelectorAll(".drag-over").forEach((item) => item.classList.remove("drag-over"));
      draggedId = null;
    });

    peopleList.addEventListener("dragover", (event) => {
      const tab = event.target.closest("[data-id]");
      if (!tab || !draggedId || tab.dataset.id === draggedId) return;
      event.preventDefault();
      tab.classList.add("drag-over");
    });

    peopleList.addEventListener("dragleave", (event) => {
      event.target.closest("[data-id]")?.classList.remove("drag-over");
    });

    peopleList.addEventListener("drop", (event) => {
      const tab = event.target.closest("[data-id]");
      if (!tab || !draggedId || tab.dataset.id === draggedId) return;
      event.preventDefault();
      collectActive();
      movePerson(draggedId, tab.dataset.id);
      activeId = draggedId;
      markDirty();
      renderAll(false);
    });

    editorPanel.addEventListener("input", (event) => {
      if (!event.target.matches("input, textarea")) return;
      collectActive();
      markDirty();
      renderList();
      renderPublishTools();
      if (event.target.name === "username") {
        const title = editorPanel.querySelector(".editor-title h2");
        if (title) title.textContent = event.target.value || "未命名";
      }
      if (event.target.name === "introMarkdown") updatePreview(event.target.value);
    });

    editorPanel.addEventListener("focusin", (event) => {
      if (event.target.name === "introMarkdown") activeTextarea = event.target;
    });

    editorPanel.addEventListener("click", (event) => {
      const imageMoveButton = event.target.closest("[data-image-move]");
      const actionButton = event.target.closest("[data-action]");
      const toolButton = event.target.closest("[data-tool]");
      const viewButton = event.target.closest("[data-view]");
      if (imageMoveButton) {
        event.preventDefault();
        moveMarkdownImage(Number(imageMoveButton.dataset.imageIndex), imageMoveButton.dataset.imageMove);
        return;
      }
      if (actionButton) void handleAction(actionButton.dataset.action);
      if (toolButton) applyMarkdownTool(toolButton.dataset.tool);
      if (viewButton) switchView(viewButton.dataset.view);
    });

    publishTools.addEventListener("click", (event) => {
      const actionButton = event.target.closest("[data-action]");
      if (actionButton) void handleAction(actionButton.dataset.action);
    });

    imageForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = imageForm.querySelector("button");
      button.disabled = true;
      button.textContent = "上传中";
      const formData = new FormData(imageForm);
      if (!activeId) {
        alert("请先选择一个傻子");
        button.disabled = false;
        button.textContent = "上传";
        return;
      }
      formData.set("personId", activeId);
      const response = await fetch("/api/images", { method: "POST", body: formData });
      const result = await response.json();
      button.disabled = false;
      button.textContent = "上传";
      if (!result.ok) {
        alert(result.error || "上传失败");
        return;
      }
      insertMarkdown(result.markdown);
      await refreshImages();
      imageForm.reset();
    });

    imageList.addEventListener("click", async (event) => {
      const insert = event.target.closest(".insert-btn");
      const copy = event.target.closest(".copy-btn");
      const del = event.target.closest(".delete-btn");
      if (insert) insertMarkdown(insert.dataset.markdown);
      if (copy) {
        await navigator.clipboard.writeText(copy.dataset.markdown);
        copy.textContent = "已复制";
        setTimeout(() => copy.textContent = "复制", 1200);
      }
      if (del && confirm("确定删除这张图片吗？")) {
        await fetch("/api/images/" + encodeURIComponent(del.dataset.id), { method: "DELETE" });
        await refreshImages();
      }
    });

    window.addEventListener("beforeunload", (event) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    });

    renderAll();
    refreshImages();

    async function saveAll() {
      collectActive();
      normalizeOrder();
      statusEl.textContent = "保存中...";
      const response = await fetch("/api/people", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ people }),
      });
      const result = await response.json();
      if (result.ok) {
        people = result.people || [];
        activeId = people.find((item) => item.id === activeId)?.id || people[0]?.id || null;
        dirty = false;
        renderAll();
        refreshImages();
        statusEl.textContent = "已保存";
      } else {
        statusEl.textContent = result.error || "保存失败";
      }
    }

    async function handleAction(action) {
      collectActive();
      const index = people.findIndex((person) => person.id === activeId);
      if (index < 0) return;
      if (action === "duplicate") {
        const original = people[index];
        const copy = {
          ...original,
          id: crypto.randomUUID(),
          username: (original.username || "未命名") + " 副本",
          createdAt: new Date().toISOString(),
        };
        people.splice(index + 1, 0, copy);
        activeId = copy.id;
        reindexOrder();
        markDirty();
        renderAll(false);
        return;
      }
      if (action === "copyLink") {
        const person = people[index];
        navigator.clipboard.writeText(location.origin + "/p/" + encodeURIComponent(person.id)).catch(() => {});
        statusEl.textContent = "公开链接已复制";
        return;
      }
      if (action === "delete" && confirm("确定删除这个傻子资料吗？")) {
        const deletedId = people[index].id;
        people.splice(index, 1);
        normalizeOrder();
        statusEl.textContent = "删除中...";
        const response = await fetch("/api/people/" + encodeURIComponent(deletedId), {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ people }),
        });
        const result = await response.json();
        if (!result.ok) {
          statusEl.textContent = result.error || "删除失败";
          return;
        }
        people = result.people || [];
        activeId = people[Math.min(index, people.length - 1)]?.id || people[0]?.id || null;
        dirty = false;
        renderAll(false);
        await refreshImages();
        statusEl.textContent = "已删除，图片已清理";
        return;
      }
      normalizeOrder();
      markDirty();
      renderAll();
    }

    function collectActive() {
      const form = editorPanel.querySelector("[data-editor-form]");
      if (!form || !activeId) return;
      const person = people.find((item) => item.id === activeId);
      if (!person) return;
      person.username = form.querySelector('[name="username"]').value;
      person.contact = form.querySelector('[name="contact"]').value;
      person.introMarkdown = form.querySelector('[name="introMarkdown"]').value;
    }

    function normalizeOrder() {
      people.sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0));
      reindexOrder();
    }

    function reindexOrder() {
      people.forEach((person, index) => person.sortOrder = index + 1);
    }

    function movePerson(sourceId, targetId) {
      const from = people.findIndex((person) => person.id === sourceId);
      const to = people.findIndex((person) => person.id === targetId);
      if (from < 0 || to < 0 || from === to) return;
      const [item] = people.splice(from, 1);
      people.splice(to, 0, item);
      reindexOrder();
    }

    function renderAll(shouldSort = true) {
      if (shouldSort) normalizeOrder();
      renderList();
      renderEditor();
      renderPublishTools();
    }

    function renderList() {
      if (!people.length) {
        peopleList.innerHTML = '<div class="empty-state">还没有傻子，点击 + 新建第一条记录。</div>';
        return;
      }
      const query = recordSearch.value.trim().toLowerCase();
      const filtered = people
        .filter((person) => !query || (person.username + " " + person.contact).toLowerCase().includes(query));
      peopleList.innerHTML = filtered.length ? filtered.map((person) => (
        '<button class="record-tab' + (person.id === activeId ? ' active' : '') + '" type="button" draggable="true" data-id="' + escapeAttr(person.id) + '">' +
          '<span class="drag-handle" aria-hidden="true">≡</span>' +
          '<span><strong>' + escapeHtml(person.username || "未命名") + '</strong><small>' + escapeHtml(person.contact || "未填写联系方式") + '</small></span>' +
        '</button>'
      )).join("") : '<div class="empty-state">没有匹配的记录。</div>';
    }

    function renderEditor() {
      const person = people.find((item) => item.id === activeId);
      if (!person) {
        editorPanel.innerHTML = '<div class="editor-empty">选择或新增一条傻子记录。</div>';
        activeTextarea = null;
        return;
      }
      editorPanel.innerHTML = renderEditorForm(person);
      activeTextarea = editorPanel.querySelector('[name="introMarkdown"]');
      updatePreview(person.introMarkdown || "");
    }

    function renderPublishTools() {
      const person = people.find((item) => item.id === activeId);
      if (!person) {
        publishTools.innerHTML = '<p class="muted">选择记录后显示发布工具。</p>';
        return;
      }
      publishTools.innerHTML =
        '<a class="button ghost" href="/p/' + encodeURIComponent(person.id) + '" target="_blank" rel="noreferrer">预览此傻子</a>' +
        '<button class="button secondary" type="button" data-action="copyLink">复制公开链接</button>' +
        '<button class="button secondary" type="button" data-action="duplicate">复制傻子</button>' +
        '<button class="button danger" type="button" data-action="delete">删除傻子</button>';
    }

    function renderEditorForm(person) {
      return '<div data-editor-form>' +
        '<div class="editor-header">' +
          '<div class="editor-title"><h2>' + escapeHtml(person.username || "未命名") + '</h2><p class="editor-hint">拖动左侧列表可调整展示顺序</p></div>' +
          '<div class="editor-actions">' +
            '<button class="button secondary" type="button" data-action="copyLink">复制链接</button>' +
            '<button class="button secondary" type="button" data-action="duplicate">复制傻子</button>' +
          '</div>' +
        '</div>' +
        '<div class="field-grid">' +
          '<label>姓名<input name="username" value="' + escapeAttr(person.username || "") + '" maxlength="80" required></label>' +
          '<label>联系方式<input name="contact" value="' + escapeAttr(person.contact || "") + '" maxlength="160"></label>' +
        '</div>' +
        '<label>详细介绍</label>' +
        '<div class="mode-tabs">' +
          '<button class="mode-tab' + (viewMode === "write" ? " active" : "") + '" type="button" data-view="write">编写</button>' +
          '<button class="mode-tab' + (viewMode === "preview" ? " active" : "") + '" type="button" data-view="preview">预览</button>' +
        '</div>' +
        '<div class="markdown-editor">' +
          '<div class="editor-body' + (viewMode === "preview" ? " previewing" : "") + '">' +
            '<div class="editor-toolbar">' +
              '<button class="tool-button" type="button" data-tool="h1">H1</button>' +
              '<button class="tool-button" type="button" data-tool="h2">H2</button>' +
              '<button class="tool-button" type="button" data-tool="h3">H3</button>' +
              '<button class="tool-button" type="button" data-tool="bold">B</button>' +
              '<button class="tool-button" type="button" data-tool="italic">I</button>' +
              '<button class="tool-button" type="button" data-tool="quote">引用</button>' +
              '<button class="tool-button" type="button" data-tool="list">列表</button>' +
              '<button class="tool-button" type="button" data-tool="link">链接</button>' +
              '<button class="tool-button" type="button" data-tool="image">图片</button>' +
              '<button class="tool-button" type="button" data-tool="code">代码</button>' +
            '</div>' +
            '<textarea name="introMarkdown" rows="18" placeholder="使用 Markdown 编写介绍。">' + escapeHtml(person.introMarkdown || "") + '</textarea>' +
            '<section class="preview-pane"><div id="markdownPreview" class="markdown-preview"></div></section>' +
          '</div>' +
        '</div>' +
      '</div>';
    }

    function switchView(nextMode) {
      collectActive();
      viewMode = nextMode === "preview" ? "preview" : "write";
      renderEditor();
    }

    function applyMarkdownTool(tool) {
      const textarea = activeTextarea || editorPanel.querySelector('[name="introMarkdown"]');
      if (!textarea) return;
      textarea.focus();
      const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
      const fallback = selected || "文本";
      const snippets = {
        h1: "# " + fallback,
        h2: "## " + fallback,
        h3: "### " + fallback,
        bold: "**" + fallback + "**",
        italic: "*" + fallback + "*",
        quote: "> " + fallback,
        list: "- " + fallback,
        link: "[" + fallback + "](https://example.com)",
        image: "![" + fallback + "](/i/image-id)",
        code: "\`\`\`\\n" + (selected || "代码") + "\\n\`\`\`",
      };
      replaceSelection(textarea, snippets[tool] || fallback);
    }

    function insertMarkdown(markdown) {
      const textarea = activeTextarea || editorPanel.querySelector('[name="introMarkdown"]');
      if (!textarea) {
        navigator.clipboard.writeText(markdown).catch(() => {});
        return;
      }
      replaceSelection(textarea, "\\n" + markdown + "\\n");
    }

    function replaceSelection(textarea, text) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
      textarea.selectionStart = textarea.selectionEnd = start + text.length;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.focus();
    }

    function updatePreview(markdown) {
      const preview = document.getElementById("markdownPreview");
      if (!preview) return;
      try {
        preview.innerHTML = renderMarkdown(markdown || "暂无介绍。");
        enhancePreviewImages(preview);
      } catch (error) {
        console.error("Markdown preview failed", error);
        preview.innerHTML = '<p class="muted">预览渲染失败，但内容仍可编辑和保存。</p>';
        const fallback = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = markdown || "";
        fallback.appendChild(code);
        preview.appendChild(fallback);
      }
    }

    function enhancePreviewImages(preview) {
      const images = Array.from(preview.querySelectorAll("img"));
      images.forEach((image, index) => {
        const frame = document.createElement("span");
        frame.className = "preview-image-frame";
        frame.dataset.imageIndex = String(index);
        image.parentNode.insertBefore(frame, image);
        frame.appendChild(image);

        const controls = document.createElement("span");
        controls.className = "preview-image-controls";
        controls.innerHTML =
          '<span class="preview-image-count">' + (index + 1) + '/' + images.length + '</span>' +
          '<button class="preview-move-button" type="button" data-image-move="up" data-image-index="' + index + '"' + (index === 0 ? ' disabled' : '') + '>上移</button>' +
          '<button class="preview-move-button" type="button" data-image-move="down" data-image-index="' + index + '"' + (index === images.length - 1 ? ' disabled' : '') + '>下移</button>';
        frame.appendChild(controls);
      });
    }

    function moveMarkdownImage(imageIndex, direction) {
      const textarea = activeTextarea || editorPanel.querySelector('[name="introMarkdown"]');
      if (!textarea || !Number.isInteger(imageIndex)) return;

      const markdown = textarea.value;
      const tokens = getMarkdownImageTokens(markdown);
      const targetIndex = direction === "up" ? imageIndex - 1 : imageIndex + 1;
      if (targetIndex < 0 || targetIndex >= tokens.length) return;

      const first = tokens[Math.min(imageIndex, targetIndex)];
      const second = tokens[Math.max(imageIndex, targetIndex)];
      const nextMarkdown =
        markdown.slice(0, first.start) +
        second.text +
        markdown.slice(first.end, second.start) +
        first.text +
        markdown.slice(second.end);

      textarea.value = nextMarkdown;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      const nextIndex = targetIndex;
      requestAnimationFrame(() => {
        const nextFrame = document.querySelector('[data-image-index="' + nextIndex + '"]');
        nextFrame?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    }

    function getMarkdownImageTokens(markdown) {
      const regex = /!\\[[^\\]]*\\]\\(\\/i\\/[A-Za-z0-9._~:/?#[\\]@!$&'()*+,;=%-]+\\)/g;
      const tokens = [];
      let match;
      while ((match = regex.exec(markdown))) {
        tokens.push({
          start: match.index,
          end: match.index + match[0].length,
          text: match[0],
        });
      }
      return tokens;
    }

    async function refreshImages() {
      if (!activeId) {
        imageList.innerHTML = '<p class="muted empty">请先选择一个傻子。</p>';
        return;
      }
      const response = await fetch("/api/images?personId=" + encodeURIComponent(activeId));
      const result = await response.json();
      imageList.innerHTML = renderImages(result.images || []);
    }

    function renderImages(images) {
      if (!images.length) return '<p class="muted empty">还没有上传图片。</p>';
      return images.map((image) => {
        const filename = escapeHtml(image.filename || image.id);
        const markdown = "![" + escapeMarkdownAlt(image.filename || "image") + "](" + image.url + ")";
        return '<div class="image-item" data-id="' + escapeAttr(image.id) + '">' +
          '<img src="' + escapeAttr(image.url) + '" alt="' + escapeAttr(image.filename || "image") + '" loading="lazy">' +
          '<div><strong>' + filename + '</strong><code>' + escapeHtml(markdown) + '</code>' +
          '<div class="row-actions"><button class="button secondary insert-btn" type="button" data-markdown="' + escapeAttr(markdown) + '">插入</button>' +
          '<button class="button ghost copy-btn" type="button" data-markdown="' + escapeAttr(markdown) + '">复制</button>' +
          '<button class="button danger delete-btn" type="button" data-id="' + escapeAttr(image.id) + '">删除</button></div></div></div>';
      }).join("");
    }

    ${clientMarkdownScript()}

    function markDirty() {
      dirty = true;
      statusEl.textContent = "有未保存修改";
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(/\\n/g, " ");
    }
    function escapeMarkdownAlt(value) {
      return String(value).replace(/[\\[\\]]/g, "");
    }
  `;
}

function clientMarkdownScript() {
  return String.raw`
    function renderMarkdown(markdown) {
      const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
      const html = [];
      let inCode = false;
      let codeLines = [];
      let listType = null;
      let paragraph = [];

      const flushParagraph = () => {
        if (paragraph.length) {
          html.push("<p>" + inlineMarkdown(paragraph.join(" ")) + "</p>");
          paragraph = [];
        }
      };

      const closeList = () => {
        if (listType) {
          html.push("</" + listType + ">");
          listType = null;
        }
      };

      const openList = (type) => {
        if (listType !== type) {
          closeList();
          html.push("<" + type + ">");
          listType = type;
        }
      };

      for (const line of lines) {
        const trimmed = line.trim();

        if (/^\x60\x60\x60/.test(trimmed)) {
          if (inCode) {
            html.push("<pre><code>" + escapeHtml(codeLines.join("\n")) + "</code></pre>");
            codeLines = [];
            inCode = false;
          } else {
            flushParagraph();
            closeList();
            inCode = true;
          }
          continue;
        }

        if (inCode) {
          codeLines.push(line);
          continue;
        }

        if (!trimmed) {
          flushParagraph();
          closeList();
          continue;
        }

        if (/^---+$/.test(trimmed)) {
          flushParagraph();
          closeList();
          html.push("<hr>");
          continue;
        }

        const heading = line.match(/^(#{1,4})\s+(.+)$/);
        if (heading) {
          flushParagraph();
          closeList();
          const level = Math.min(heading[1].length, 4);
          html.push("<h" + level + ">" + inlineMarkdown(heading[2]) + "</h" + level + ">");
          continue;
        }

        const bullet = line.match(/^\s*[-*]\s+(.+)$/);
        if (bullet) {
          flushParagraph();
          openList("ul");
          html.push("<li>" + inlineMarkdown(bullet[1]) + "</li>");
          continue;
        }

        const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
        if (ordered) {
          flushParagraph();
          openList("ol");
          html.push("<li>" + inlineMarkdown(ordered[1]) + "</li>");
          continue;
        }

        const quote = line.match(/^>\s?(.+)$/);
        if (quote) {
          flushParagraph();
          closeList();
          html.push("<blockquote>" + inlineMarkdown(quote[1]) + "</blockquote>");
          continue;
        }

        closeList();
        paragraph.push(line);
      }

      flushParagraph();
      closeList();
      if (inCode) html.push("<pre><code>" + escapeHtml(codeLines.join("\n")) + "</code></pre>");
      return html.join("\n");
    }

    function inlineMarkdown(text) {
      let html = escapeHtml(text);
      html = html.replace(/!\[([^\]]*)\]\((\/i\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+)\)/g, '<img src="$2" alt="$1">');
      html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
      html = html.replace(/\x60([^\x60]+)\x60/g, "<code>$1</code>");
      html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
      html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
      html = html.replace(/_([^_]+)_/g, "<em>$1</em>");
      html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
      return html;
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[char]));
    }
  `;
}

function renderMarkdown(markdown) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let inCode = false;
  let codeLines = [];
  let listType = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  const openList = (type) => {
    if (listType !== type) {
      closeList();
      html.push(`<${type}>`);
      listType = type;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        flushParagraph();
        closeList();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      flushParagraph();
      closeList();
      html.push("<hr>");
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(heading[1].length, 4);
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      openList("ul");
      html.push(`<li>${inlineMarkdown(bullet[1])}</li>`);
      continue;
    }

    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      openList("ol");
      html.push(`<li>${inlineMarkdown(ordered[1])}</li>`);
      continue;
    }

    const quote = line.match(/^>\s?(.+)$/);
    if (quote) {
      flushParagraph();
      closeList();
      html.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }

    closeList();
    paragraph.push(line);
  }

  flushParagraph();
  closeList();
  if (inCode) html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  return html.join("\n");
}

function inlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/!\[([^\]]*)\]\((\/i\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+)\)/g, '<img src="$2" alt="$1">');
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/_([^_]+)_/g, "<em>$1</em>");
  html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return html;
}

function linkifyContact(contact) {
  const escaped = escapeHtml(contact);
  if (/^mailto:/i.test(contact) || /^tel:/i.test(contact) || /^https?:\/\//i.test(contact)) {
    return `<a href="${escapeAttr(contact)}">${escaped}</a>`;
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
    return `<a href="mailto:${escapeAttr(contact)}">${escaped}</a>`;
  }
  return escaped;
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/\n/g, " ");
}

function escapeMarkdownAlt(value) {
  return String(value).replace(/[\[\]]/g, "");
}

function htmlResponse(html, status = 200, headers = {}) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function redirectResponse(location, headers = {}) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      ...headers,
    },
  });
}
