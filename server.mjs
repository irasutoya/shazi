import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  mkdir,
  readFile,
  rename,
  stat,
  writeFile
} from "node:fs/promises";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads");
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "friends.json");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const MAX_BODY_BYTES = 30 * 1024 * 1024;

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"]
]);

async function ensureDataFile() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(UPLOAD_DIR, { recursive: true });
  try {
    await stat(DATA_FILE);
  } catch {
    await writeFile(DATA_FILE, "[]\n", "utf8");
  }
}

async function readFriends() {
  await ensureDataFile();
  const raw = await readFile(DATA_FILE, "utf8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

async function writeFriends(friends) {
  await ensureDataFile();
  const tmpFile = `${DATA_FILE}.${Date.now()}.tmp`;
  await writeFile(tmpFile, `${JSON.stringify(friends, null, 2)}\n`, "utf8");
  await rename(tmpFile, DATA_FILE);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
}

function notFound(res) {
  sendJson(res, 404, { error: "Not found" });
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("请求内容过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function parseJsonBody(req) {
  const body = await collectBody(req);
  try {
    const raw = body.toString("utf8");
    return raw ? JSON.parse(raw) : {};
  } catch {
    const error = new Error("JSON 内容无效");
    error.status = 400;
    throw error;
  }
}

function authOk(req) {
  const auth = req.headers.authorization || "";
  const expected = `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`).toString("base64")}`;
  return auth === expected;
}

function requireAdmin(req, res) {
  if (authOk(req)) {
    return true;
  }

  send(res, 401, JSON.stringify({ error: "需要登录" }), {
    "www-authenticate": 'Basic realm="shazi.wiki admin"',
    "content-type": "application/json; charset=utf-8"
  });
  return false;
}

function asString(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sanitizeFriend(input, friends, existing) {
  const now = new Date().toISOString();
  const id = existing?.id || randomUUID();
  const name = asString(input.name);

  if (!name) {
    const error = new Error("请填写名字");
    error.status = 400;
    throw error;
  }

  const duplicate = friends.find((friend) => friend.id !== id && friend.name === name);
  if (duplicate) {
    const error = new Error("名字不能重复，因为 URL 会直接使用名字");
    error.status = 400;
    throw error;
  }

  const markdown =
    asString(input.markdown) ||
    asString(input.description) ||
    asString(input.bio) ||
    asString(input.summary);

  return {
    id,
    slug: name,
    order: existing?.order ?? Math.max(0, ...friends.map((friend) => asNumber(friend.order))) + 1,
    name,
    contact: asString(input.contact),
    markdown,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

function sortFriends(friends) {
  return [...friends].sort((a, b) => {
    const orderDiff = asNumber(a.order) - asNumber(b.order);
    return orderDiff || a.name.localeCompare(b.name, "zh-Hans-CN");
  });
}

function headerEnd(buffer, start) {
  return buffer.indexOf(Buffer.from("\r\n\r\n"), start);
}

function parseMultipart(buffer, boundary) {
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = buffer.indexOf(boundaryBuffer);

  while (cursor !== -1) {
    cursor += boundaryBuffer.length;

    if (buffer[cursor] === 45 && buffer[cursor + 1] === 45) {
      break;
    }

    if (buffer[cursor] === 13 && buffer[cursor + 1] === 10) {
      cursor += 2;
    }

    const endOfHeaders = headerEnd(buffer, cursor);
    if (endOfHeaders === -1) {
      break;
    }

    const headers = buffer.slice(cursor, endOfHeaders).toString("utf8");
    const dataStart = endOfHeaders + 4;
    const nextBoundary = buffer.indexOf(boundaryBuffer, dataStart);
    if (nextBoundary === -1) {
      break;
    }

    const dataEnd = nextBoundary - 2;
    parts.push({
      headers,
      data: buffer.slice(dataStart, Math.max(dataStart, dataEnd))
    });
    cursor = nextBoundary;
  }

  return parts;
}

function safeUploadName(filename) {
  const ext = path.extname(filename || "").toLowerCase();
  const allowed = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
  if (!allowed.has(ext)) {
    const error = new Error("只能上传图片");
    error.status = 400;
    throw error;
  }
  return `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;
}

async function handleUpload(req, res) {
  if (!requireAdmin(req, res)) return;

  const contentType = req.headers["content-type"] || "";
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) {
    sendJson(res, 400, { error: "上传内容无效" });
    return;
  }

  const buffer = await collectBody(req);
  const boundary = match[1] || match[2];
  const files = [];

  for (const part of parseMultipart(buffer, boundary)) {
    const disposition = part.headers.match(/content-disposition:[^\r\n]+/i)?.[0] || "";
    const filename = disposition.match(/filename="([^"]*)"/i)?.[1];
    const type = part.headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || "";

    if (!filename || !type.startsWith("image/")) {
      continue;
    }

    const safeName = safeUploadName(filename);
    const filePath = path.join(UPLOAD_DIR, safeName);
    await writeFile(filePath, part.data);
    files.push({ url: `/uploads/${safeName}`, name: filename });
  }

  if (!files.length) {
    sendJson(res, 400, { error: "没有找到图片文件" });
    return;
  }

  sendJson(res, 201, { files });
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  const friends = await readFriends();

  if (req.method === "GET" && parts.length === 2 && parts[1] === "login") {
    if (!requireAdmin(req, res)) return;
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && parts.length === 2 && parts[1] === "uploads") {
    await handleUpload(req, res);
    return;
  }

  if (req.method === "POST" && parts.length === 2 && parts[1] === "reorder") {
    if (!requireAdmin(req, res)) return;
    const body = await parseJsonBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const existingIds = new Set(friends.map((friend) => friend.id));

    if (ids.length !== friends.length || ids.some((id) => !existingIds.has(id))) {
      sendJson(res, 400, { error: "排序内容无效" });
      return;
    }

    const byId = new Map(friends.map((friend) => [friend.id, friend]));
    const next = ids.map((id, index) => ({
      ...byId.get(id),
      order: index + 1,
      updatedAt: new Date().toISOString()
    }));
    await writeFriends(next);
    sendJson(res, 200, sortFriends(next));
    return;
  }

  if (req.method === "GET" && parts.length === 2 && parts[1] === "friends") {
    sendJson(res, 200, sortFriends(friends));
    return;
  }

  if (req.method === "GET" && parts.length === 3 && parts[1] === "friends") {
    const name = decodeURIComponent(parts[2]);
    const friend = friends.find((item) => item.name === name || item.slug === name || item.id === name);
    if (!friend) {
      notFound(res);
      return;
    }
    sendJson(res, 200, friend);
    return;
  }

  if (req.method === "POST" && parts.length === 2 && parts[1] === "friends") {
    if (!requireAdmin(req, res)) return;
    const body = await parseJsonBody(req);
    const friend = sanitizeFriend(body, friends);
    await writeFriends([...friends, friend]);
    sendJson(res, 201, friend);
    return;
  }

  if (req.method === "PUT" && parts.length === 3 && parts[1] === "friends") {
    if (!requireAdmin(req, res)) return;
    const id = decodeURIComponent(parts[2]);
    const existing = friends.find((item) => item.id === id || item.slug === id);

    if (!existing) {
      notFound(res);
      return;
    }

    const body = await parseJsonBody(req);
    const updated = sanitizeFriend(body, friends, existing);
    const next = friends.map((item) => (item.id === existing.id ? updated : item));
    await writeFriends(next);
    sendJson(res, 200, updated);
    return;
  }

  if (req.method === "DELETE" && parts.length === 3 && parts[1] === "friends") {
    if (!requireAdmin(req, res)) return;
    const id = decodeURIComponent(parts[2]);
    const next = friends.filter((item) => item.id !== id && item.slug !== id);

    if (next.length === friends.length) {
      notFound(res);
      return;
    }

    await writeFriends(next);
    sendJson(res, 200, { ok: true });
    return;
  }

  notFound(res);
}

async function serveFile(res, filePath) {
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    notFound(res);
    return;
  }

  try {
    const body = await readFile(filePath);
    const contentType = mimeTypes.get(path.extname(filePath)) || "application/octet-stream";
    const cacheControl = /^text\/(html|css|javascript)/.test(contentType)
      ? "no-store"
      : "public, max-age=3600";
    send(res, 200, body, {
      "content-type": contentType,
      "cache-control": cacheControl
    });
  } catch {
    notFound(res);
  }
}

async function handleStatic(req, res, url) {
  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    await serveFile(res, path.join(PUBLIC_DIR, "admin.html"));
    return;
  }

  if (url.pathname === "/login" || url.pathname === "/login/") {
    await serveFile(res, path.join(PUBLIC_DIR, "login.html"));
    return;
  }

  if (url.pathname === "/") {
    await serveFile(res, path.join(PUBLIC_DIR, "index.html"));
    return;
  }

  const requestedPath = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const filePath = path.join(PUBLIC_DIR, requestedPath);

  try {
    const stats = await stat(filePath);
    if (stats.isFile()) {
      await serveFile(res, filePath);
      return;
    }
  } catch {
    // Pretty profile URLs are handled by the SPA fallback below.
  }

  await serveFile(res, path.join(PUBLIC_DIR, "index.html"));
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    await handleStatic(req, res, url);
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || "Server error" });
  }
}

await ensureDataFile();

createServer(handleRequest).listen(PORT, () => {
  console.log(`shazi.wiki is running at http://localhost:${PORT}`);
  if (ADMIN_PASSWORD === "change-me") {
    console.log("Admin login: admin / change-me. Set ADMIN_USER and ADMIN_PASSWORD before deployment.");
  }
});
