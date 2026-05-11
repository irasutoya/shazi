const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: jsonHeaders
  });
}

function requireAdmin(request, env) {
  const user = env.ADMIN_USER || "admin";
  const password = env.ADMIN_PASSWORD || "change-me";
  const expected = `Basic ${btoa(`${user}:${password}`)}`;
  return request.headers.get("authorization") === expected;
}

function unauthorized() {
  return new Response(JSON.stringify({ error: "需要登录" }), {
    status: 401,
    headers: {
      ...jsonHeaders,
      "www-authenticate": 'Basic realm="shazi.wiki admin"'
    }
  });
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function rowToFriend(row) {
  return {
    id: row.id,
    slug: row.slug,
    order: row.order_index,
    name: row.name,
    contact: row.contact || "",
    markdown: row.markdown || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function listFriends(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM friends ORDER BY order_index ASC, name ASC"
  ).all();
  return results.map(rowToFriend);
}

async function getFriend(env, identifier) {
  const row = await env.DB.prepare(
    "SELECT * FROM friends WHERE id = ? OR name = ? OR slug = ? LIMIT 1"
  ).bind(identifier, identifier, identifier).first();
  return row ? rowToFriend(row) : null;
}

async function nameExists(env, name, id = "") {
  const row = await env.DB.prepare(
    "SELECT id FROM friends WHERE name = ? AND id != ? LIMIT 1"
  ).bind(name, id).first();
  return Boolean(row);
}

async function nextOrder(env) {
  const row = await env.DB.prepare("SELECT COALESCE(MAX(order_index), 0) AS max_order FROM friends").first();
  return Number(row?.max_order || 0) + 1;
}

async function createFriend(request, env) {
  if (!requireAdmin(request, env)) return unauthorized();
  const body = await request.json();
  const name = asString(body.name);

  if (!name) {
    return json({ error: "请填写名字" }, 400);
  }

  if (await nameExists(env, name)) {
    return json({ error: "名字不能重复，因为 URL 会直接使用名字" }, 400);
  }

  const now = new Date().toISOString();
  const friend = {
    id: crypto.randomUUID(),
    slug: name,
    order: await nextOrder(env),
    name,
    contact: asString(body.contact),
    markdown: asString(body.markdown),
    createdAt: now,
    updatedAt: now
  };

  await env.DB.prepare(
    "INSERT INTO friends (id, slug, order_index, name, contact, markdown, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    friend.id,
    friend.slug,
    friend.order,
    friend.name,
    friend.contact,
    friend.markdown,
    friend.createdAt,
    friend.updatedAt
  ).run();

  return json(friend, 201);
}

async function updateFriend(request, env, id) {
  if (!requireAdmin(request, env)) return unauthorized();
  const existing = await getFriend(env, id);
  if (!existing) return json({ error: "Not found" }, 404);

  const body = await request.json();
  const name = asString(body.name);

  if (!name) {
    return json({ error: "请填写名字" }, 400);
  }

  if (await nameExists(env, name, existing.id)) {
    return json({ error: "名字不能重复，因为 URL 会直接使用名字" }, 400);
  }

  const updatedAt = new Date().toISOString();
  const friend = {
    ...existing,
    slug: name,
    name,
    contact: asString(body.contact),
    markdown: asString(body.markdown),
    updatedAt
  };

  await env.DB.prepare(
    "UPDATE friends SET slug = ?, name = ?, contact = ?, markdown = ?, updated_at = ? WHERE id = ?"
  ).bind(friend.slug, friend.name, friend.contact, friend.markdown, friend.updatedAt, existing.id).run();

  return json(friend);
}

async function deleteFriend(request, env, id) {
  if (!requireAdmin(request, env)) return unauthorized();
  const existing = await getFriend(env, id);
  if (!existing) return json({ error: "Not found" }, 404);
  await env.DB.prepare("DELETE FROM friends WHERE id = ?").bind(existing.id).run();
  return json({ ok: true });
}

async function reorderFriends(request, env) {
  if (!requireAdmin(request, env)) return unauthorized();
  const body = await request.json();
  const ids = Array.isArray(body.ids) ? body.ids : [];
  const current = await listFriends(env);
  const currentIds = new Set(current.map((friend) => friend.id));

  if (ids.length !== current.length || ids.some((id) => !currentIds.has(id))) {
    return json({ error: "排序内容无效" }, 400);
  }

  const statements = ids.map((id, index) =>
    env.DB.prepare("UPDATE friends SET order_index = ?, updated_at = ? WHERE id = ?")
      .bind(index + 1, new Date().toISOString(), id)
  );
  await env.DB.batch(statements);
  return json(await listFriends(env));
}

function safeExtension(filename) {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  if (!["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) {
    return "";
  }
  return ext;
}

async function uploadImages(request, env) {
  if (!requireAdmin(request, env)) return unauthorized();
  const formData = await request.formData();
  const files = formData.getAll("images");
  const uploaded = [];

  for (const file of files) {
    if (!(file instanceof File) || !file.type.startsWith("image/")) {
      continue;
    }

    const ext = safeExtension(file.name);
    if (!ext) {
      continue;
    }

    const key = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    await env.UPLOADS.put(key, file.stream(), {
      httpMetadata: {
        contentType: file.type
      }
    });
    uploaded.push({ name: file.name, url: `/uploads/${key}` });
  }

  if (!uploaded.length) {
    return json({ error: "没有找到图片文件" }, 400);
  }

  return json({ files: uploaded }, 201);
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (request.method === "GET" && parts[1] === "login") {
      return requireAdmin(request, env) ? json({ ok: true }) : unauthorized();
    }

    if (request.method === "POST" && parts[1] === "uploads") {
      return uploadImages(request, env);
    }

    if (request.method === "POST" && parts[1] === "reorder") {
      return reorderFriends(request, env);
    }

    if (parts[1] === "friends" && parts.length === 2 && request.method === "GET") {
      return json(await listFriends(env));
    }

    if (parts[1] === "friends" && parts.length === 2 && request.method === "POST") {
      return createFriend(request, env);
    }

    if (parts[1] === "friends" && parts.length === 3) {
      const id = decodeURIComponent(parts[2]);

      if (request.method === "GET") {
        const friend = await getFriend(env, id);
        return friend ? json(friend) : json({ error: "Not found" }, 404);
      }

      if (request.method === "PUT") {
        return updateFriend(request, env, id);
      }

      if (request.method === "DELETE") {
        return deleteFriend(request, env, id);
      }
    }

    return json({ error: "Not found" }, 404);
  } catch (error) {
    return json({ error: error.message || "Server error" }, 500);
  }
}
