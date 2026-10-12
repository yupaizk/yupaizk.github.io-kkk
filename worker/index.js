// Undertone 後端：密碼登入、Claude API 代理、測試紀錄（D1）和圖片（D1）。
// 靜態檔案（/、/undertone/…）由 Cloudflare 直接送出，只有 /api/* 和 /_blob/* 會進到這裡。
import Anthropic from "@anthropic-ai/sdk";

const COOKIE = "ut_session";
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BLOB = 1900 * 1024; // D1 一列最多 2MB
const MAX_IMAGES = 6;

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (e) {
      console.error(e);
      return json({ error: "server_error" }, 500);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (!path.startsWith("/api/") && !path.startsWith("/_blob/")) return new Response("Not found", { status: 404 });
  if (path === "/api/login" && method === "POST") return login(request, env);
  if (path === "/api/logout" && method === "POST") return logout();

  if (!(await authed(request, env))) return json({ error: "not_granted" }, 401);

  if (path === "/api/me") return json({ ok: true });
  if (path === "/api/limits") return json({ images: true, maxImages: MAX_IMAGES });
  if (path === "/api/ai" && method === "POST") return ai(request, env);

  let m;
  if ((m = path.match(/^\/_blob\/([0-9a-f]{32})$/)) && method === "GET") return getBlob(env, m[1]);
  if (path === "/api/blob" && method === "POST") return putBlob(request, env, newId());
  if ((m = path.match(/^\/api\/blob\/([0-9a-f]{32})$/))) {
    if (method === "PUT") return putBlob(request, env, m[1]);
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM blobs WHERE id = ?").bind(m[1]).run();
      return json({ ok: true });
    }
  }

  if ((m = path.match(/^\/api\/db\/([^/]+)(?:\/([^/]+))?$/))) {
    const [, col, id] = m;
    if (!NAME_RE.test(col) || (id && !NAME_RE.test(id))) return json({ error: "bad_name" }, 400);
    return id ? docRoute(request, env, col, id) : collectionRoute(request, env, col, url);
  }

  return json({ error: "not_found" }, 404);
}

/* ---------- 登入 ---------- */

async function sessionToken(env) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.APP_PASSWORD),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("undertone-session-v1"));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function authed(request, env) {
  if (!env.APP_PASSWORD) return false;
  const c = request.headers.get("Cookie") || "";
  const m = c.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{64})`));
  return !!m && timingSafeEqual(m[1], await sessionToken(env));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function login(request, env) {
  if (!env.APP_PASSWORD) return json({ error: "no_password_set" }, 500);
  const { password } = await request.json().catch(() => ({}));
  if (typeof password !== "string" || !timingSafeEqual(password, env.APP_PASSWORD)) {
    await new Promise(r => setTimeout(r, 800));
    return json({ error: "wrong_password" }, 401);
  }
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return json({ ok: true }, 200, {
    "Set-Cookie": `${COOKIE}=${await sessionToken(env)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}`,
  });
}

function logout() {
  return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
}

/* ---------- Claude ---------- */

async function ai(request, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "no_api_key" }, 500);
  const body = await request.json().catch(() => null);
  if (!body || typeof body.prompt !== "string" || !body.prompt) return json({ error: "bad_request" }, 400);
  const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];

  const limit = parseInt(env.DAILY_AI_LIMIT || "300", 10);
  const day = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare(
    "INSERT INTO usage (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1 RETURNING n",
  ).bind(day).first();
  if (row.n > limit) return json({ error: "daily_limit" }, 429);

  const content = [];
  for (const im of images) {
    if (!im || typeof im.data !== "string" || !/^image\/(png|jpeg|gif|webp)$/.test(im.media_type)) continue;
    content.push({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } });
  }
  content.push({ type: "text", text: body.prompt });

  // ANTHROPIC_BASE_URL 只在本機測試時用來接假的 API；正式環境不要設。
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined });
  let msg;
  try {
    msg = await client.beta.messages.create({
      model: env.CLAUDE_MODEL || "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: env.CLAUDE_EFFORT || "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content }],
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: "rate_limited" }, 429);
    if (e instanceof Anthropic.AuthenticationError) return json({ error: "bad_api_key" }, 500);
    if (e instanceof Anthropic.BadRequestError) return json({ error: "bad_request", detail: e.message }, 400);
    if (e instanceof Anthropic.APIError) return json({ error: "api_error", detail: e.message }, 502);
    throw e;
  }

  if (msg.stop_reason === "refusal") return json({ error: "refused" }, 422);
  const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
  const result = parseJson(text);
  if (result === undefined) return json({ error: "bad_json", text: text.slice(0, 2000) }, 502);
  return json({ result, stop_reason: msg.stop_reason });
}

// 回覆應該只有一個 JSON；容許前後多了說明文字或 ``` 圍起來。
function parseJson(text) {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(t); } catch {}
  const starts = [t.indexOf("{"), t.indexOf("[")].filter(i => i >= 0);
  if (!starts.length) return undefined;
  const s = Math.min(...starts);
  const e = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (e <= s) return undefined;
  try { return JSON.parse(t.slice(s, e + 1)); } catch { return undefined; }
}

/* ---------- 資料庫 ---------- */

async function collectionRoute(request, env, col, url) {
  if (request.method === "GET") {
    const desc = url.searchParams.get("dir") === "desc";
    const { results } = await env.DB.prepare(
      `SELECT id, data FROM docs WHERE collection = ? ORDER BY created_at ${desc ? "DESC" : "ASC"}, id`,
    ).bind(col).all();
    return json({ docs: results.map(r => ({ id: r.id, data: JSON.parse(r.data) })) });
  }
  if (request.method === "POST") {
    const data = await request.json();
    const id = newId(20);
    await env.DB.prepare("INSERT INTO docs (collection, id, data, created_at) VALUES (?, ?, ?, ?)")
      .bind(col, id, JSON.stringify(data), createdAt(data)).run();
    return json({ id });
  }
  return json({ error: "method" }, 405);
}

async function docRoute(request, env, col, id) {
  const get = () => env.DB.prepare("SELECT data FROM docs WHERE collection = ? AND id = ?").bind(col, id).first();
  switch (request.method) {
    case "GET": {
      const r = await get();
      return r ? json({ id, data: JSON.parse(r.data) }) : json({ error: "not_found" }, 404);
    }
    case "PUT": {
      const data = await request.json();
      await env.DB.prepare(
        "INSERT INTO docs (collection, id, data, created_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, created_at = excluded.created_at",
      ).bind(col, id, JSON.stringify(data), createdAt(data)).run();
      return json({ id });
    }
    case "PATCH": {
      const patch = await request.json();
      const r = await get();
      if (!r) return json({ error: "not_found" }, 404);
      const data = { ...JSON.parse(r.data), ...patch };
      await env.DB.prepare("UPDATE docs SET data = ? WHERE collection = ? AND id = ?")
        .bind(JSON.stringify(data), col, id).run();
      return json({ id });
    }
    case "DELETE":
      await env.DB.prepare("DELETE FROM docs WHERE collection = ? AND id = ?").bind(col, id).run();
      return json({ ok: true });
  }
  return json({ error: "method" }, 405);
}

const createdAt = d => (d && typeof d.createdAt === "number" ? d.createdAt : Date.now());

/* ---------- 圖片 ---------- */

async function putBlob(request, env, id) {
  const type = (request.headers.get("Content-Type") || "application/octet-stream").split(";")[0];
  if (!/^image\//.test(type)) return json({ error: "not_image" }, 415);
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BLOB) return json({ error: "too_large" }, 413);
  await env.DB.prepare(
    "INSERT INTO blobs (id, type, data, created_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET type = excluded.type, data = excluded.data",
  ).bind(id, type, buf, Date.now()).run();
  return json({ id });
}

async function getBlob(env, id) {
  const r = await env.DB.prepare("SELECT type, data FROM blobs WHERE id = ?").bind(id).first();
  if (!r) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(r.data), {
    headers: { "Content-Type": r.type, "Cache-Control": "private, max-age=31536000, immutable" },
  });
}

/* ---------- 共用 ---------- */

function newId(len = 32) {
  const b = crypto.getRandomValues(new Uint8Array(len));
  return len === 32
    ? [...b.slice(0, 16)].map(x => x.toString(16).padStart(2, "0")).join("")
    : [...b].map(x => "abcdefghijklmnopqrstuvwxyz0123456789"[x % 36]).join("");
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}
