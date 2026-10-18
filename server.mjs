// Undertone 本機伺服器：在自己的電腦上跑生成器。
// 送出 public/ 的網頁，並提供 claude-shim.js 用的 API：呼叫 Claude、存測試紀錄和圖片。
// 資料存在 data/ 資料夾；API 金鑰讀 settings.txt。生成器只接受本機連線；
// 另外開一個手機上傳用的小伺服器（同一個 Wi-Fi 的手機掃 QR code 傳照片），只收照片、不給看任何資料。
import http from "node:http";
import { readFile, writeFile, mkdir, readdir, rm, copyFile, rename, stat } from "node:fs/promises";
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync, renameSync, readdirSync, copyFileSync, cpSync, chmodSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { exec, spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const OLD_DATA = path.join(ROOT, "undertone-old-data");
const PORT = 8787;
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BLOB_RE = /^[0-9a-f]{32}$/;
const MAX_IMAGES = 6;
const MAX_BODY = 30 * 1024 * 1024;

/* ---------- 設定 ---------- */

// 解壓縮到新的資料夾時：這裡沒有金鑰（settings.txt）或紀錄（data），就從舊版資料夾自動複製過來，不用每次重貼。
// 啟動檔會先用 --migrate 跑一次，再決定要不要打開記事本。
function migrateFromOld() {
  const here = path.join(ROOT, "settings.txt");
  const hasKey = f => { try { return /^\s*ANTHROPIC_API_KEY\s*=\s*["']?sk-/m.test(readFileSync(f, "utf8")); } catch { return false; } };
  if (hasKey(here) && existsSync(DATA)) return;
  const old = findOldCopies()[0];
  if (!old) return;
  if (!hasKey(here)) { copyFileSync(path.join(old, "settings.txt"), here); console.log(`已從舊版資料夾複製 settings.txt（金鑰和安全碼）：${old}`); }
  if (!existsSync(path.join(DATA, "db")) && existsSync(path.join(old, "data"))) {
    try { cpSync(path.join(old, "data"), DATA, { recursive: true }); console.log(`已從舊版資料夾複製 data（測試紀錄和照片）：${old}`); }
    catch (e) { console.log(`複製舊版的 data 沒有成功（${e.message}），可以自己把舊資料夾的 data 複製過來。`); }
  }
  for (const f of ["cloudflared.exe", "cloudflared"]) if (!existsSync(path.join(ROOT, f)) && existsSync(path.join(old, f))) { try { copyFileSync(path.join(old, f), path.join(ROOT, f)); } catch {} }
}
try { migrateFromOld(); } catch (e) { console.log("找舊版設定時出錯：" + e.message); }
if (process.argv.includes("--migrate")) process.exit(0);

function loadSettings() {
  const file = path.join(ROOT, "settings.txt");
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2]) out[m[1]] = m[2];
  }
  return out;
}
const settings = loadSettings();
// 貼上時常多了引號、空白或換行，先清掉
const rawKey = (settings.ANTHROPIC_API_KEY || "").replace(/["'“”‘’\s]/g, "");
const API_KEY = rawKey && !rawKey.includes("...") ? rawKey : "";
const MODEL = settings.CLAUDE_MODEL || "claude-opus-5-5";
const EFFORT = settings.CLAUDE_EFFORT || "medium";
const DAILY_LIMIT = parseInt(settings.DAILY_AI_LIMIT || "300", 10);
// 展覽安全碼：展覽時打開測試紀錄、離開展覽模式都要輸入
const EXPO_PIN = (settings.EXPO_PIN || "1829").trim();
const KIOSK = process.argv.includes("--kiosk");
// 公開模式（公開網頁.bat）：展覽結束後讓不能來的人在網路上玩。另開一個只對外的伺服器（PUBLIC_PORT），
// 只給公開版頁面 play.html 和生成需要的 API；看不到測試紀錄、別人的照片，也不能刪改東西。用 cloudflared 通道對外。
const PUBLIC_MODE = process.argv.includes("--public");
const PUBLIC_PORT = parseInt(settings.PUBLIC_PORT || "8789", 10);
// 每個人（IP）每天最多呼叫 Claude 幾次（一組大約 2～5 次），免得儲值金被少數人用光；全部人的上限還是 DAILY_AI_LIMIT
const PUBLIC_PER_IP = parseInt(settings.PUBLIC_PER_IP || "40", 10);
// 示範模式：不呼叫 Claude、不花錢，回假的設計結果，用來調介面。用「調介面（不花錢）.bat」開，或 settings.txt 寫 AI_MODE=demo
const DEMO = process.argv.includes("--demo") || /^demo$/i.test((settings.AI_MODE || "").trim());
// 省錢模式：展覽用（展覽啟動.bat 預設開）。生成器的提案改用規則、元素用素材庫，只有讀照片和用說的修改才呼叫 Claude，
// 而且思考深度用 SAVE_EFFORT（預設 low）。settings.txt 寫 AI_MODE=full 可以關掉。
const SAVE = !DEMO && !process.argv.includes("--public") && (process.argv.includes("--save") || /^save$/i.test((settings.AI_MODE || "").trim())) && !/^full$/i.test((settings.AI_MODE || "").trim());
const SAVE_EFFORT = settings.SAVE_EFFORT || "low";
// 手機上傳：用哪個埠、電腦的區網位址（不填就自動找）、要不要在 QR 旁邊放 Wi-Fi 的 QR
const PHONE_PORT = parseInt(settings.PHONE_PORT || "8788", 10);
const PHONE_HOST = (settings.PHONE_HOST || "").trim();
const PHONE_WIFI = settings.PHONE_WIFI_SSID ? { ssid: settings.PHONE_WIFI_SSID, pass: settings.PHONE_WIFI_PASS || "" } : null;
// ANTHROPIC_BASE_URL 只在測試時接假的 API 用。
const client = API_KEY ? new Anthropic({ apiKey: API_KEY, baseURL: settings.ANTHROPIC_BASE_URL || undefined }) : null;

/* ---------- 路由 ---------- */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const p = decodeURIComponent(url.pathname);
    if (p.startsWith("/api/")) return await api(req, res, p, url);
    if (p.startsWith("/_blob/")) return await getBlob(res, p.slice(7));
    return await serveStatic(res, p);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, { error: "server_error" }, 500);
  }
});

async function api(req, res, p, url) {
  const method = req.method;
  let m0;
  if (p === "/api/me") return json(res, { ok: true });
  if (p === "/api/limits") return json(res, { images: true, maxImages: MAX_IMAGES, demo: DEMO, save: SAVE });
  if (p === "/api/ai" && method === "POST") return ai(req, res);
  if (p === "/api/unlock" && method === "POST") return unlock(req, res);
  if (p === "/api/phone" && method === "POST") return phoneStart(res);
  if (p === "/api/share" && method === "POST") return shareStart(req, res);
  if ((m0 = p.match(/^\/api\/phone\/([0-9a-f]{32})(?:\/(\d+))?$/))) return phoneRoute(req, res, m0[1], m0[2]);

  let m;
  if (p === "/api/blob" && method === "POST") return putBlob(req, res, randomBytes(16).toString("hex"));
  if ((m = p.match(/^\/api\/blob\/([0-9a-f]{32})$/))) {
    if (method === "PUT") return putBlob(req, res, m[1]);
    if (method === "DELETE") { await removeBlob(m[1]); return json(res, { ok: true }); }
  }
  if ((m = p.match(/^\/api\/db\/([^/]+)(?:\/([^/]+))?$/))) {
    const [, col, id] = m;
    if (!NAME_RE.test(col) || (id && !NAME_RE.test(id))) return json(res, { error: "bad_name" }, 400);
    return id ? docRoute(req, res, col, id) : collectionRoute(req, res, col, url);
  }
  return json(res, { error: "not_found" }, 404);
}

/* ---------- 公開模式的對外伺服器 ---------- */
const PUB_FIELDS = new Set(["like", "match", "catch", "comment", "tryon", "feedback", "feedbackAt"]);
const pubCalls = new Map();
const visitor = req => String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
const publicServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const p = decodeURIComponent(url.pathname), method = req.method;
    res.setHeader("X-Robots-Tag", "noindex");
    if (p === "/" || p === "/undertone" || p === "/undertone/" || p === "/undertone/index.html") { res.writeHead(302, { Location: "/undertone/play.html" }); return res.end(); }
    if (method === "GET" && (p === "/undertone/play.html" || p === "/undertone/claude-shim.js" || p === "/undertone/kb/backend.json" || /^\/undertone\/(vendor|media)\//.test(p))) return await serveStatic(res, p);
    if (method === "GET" && p.startsWith("/_blob/")) return await getBlob(res, p.slice(7));
    if (p === "/api/me" || p === "/api/limits") return api(req, res, p, url);
    if (p === "/api/ai" && method === "POST") {
      const ip = visitor(req), day = new Date().toISOString().slice(0, 10), k = day + "|" + ip, n = (pubCalls.get(k) || 0) + 1;
      if (pubCalls.size > 50000) pubCalls.clear();
      pubCalls.set(k, n);
      if (n > PUBLIC_PER_IP) return json(res, { error: "daily_limit" }, 429);
      return ai(req, res);
    }
    if (p === "/api/blob" && method === "POST") {
      if (+(req.headers["content-length"] || 0) > 12 * 1024 * 1024) return json(res, { error: "too_large" }, 413);
      return putBlob(req, res, randomBytes(16).toString("hex"));
    }
    if (p === "/api/db/records" && method === "POST") {
      const data = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const id = [...randomBytes(20)].map(x => "abcdefghijklmnopqrstuvwxyz0123456789"[x % 36]).join("");
      await writeJson(docFile("records", id), { ...data, source: "public", createdAt: Date.now() });
      return json(res, { id });
    }
    let m;
    if ((m = p.match(/^\/api\/db\/records\/([a-z0-9]{20})$/)) && method === "PATCH") {
      // 只能改自己剛做的那一組（6 小時內、公開版做的），而且只能改評分、感想、試戴照片、留言
      const f = docFile("records", m[1]), data = await readJson(f, null);
      if (!data || data.source !== "public" || Date.now() - (data.createdAt || 0) > 6 * 3600 * 1000) return json(res, { error: "forbidden" }, 403);
      const patch = JSON.parse((await readBody(req)).toString("utf8") || "{}"), ok = {};
      for (const [key, v] of Object.entries(patch)) if (PUB_FIELDS.has(key)) ok[key] = typeof v === "string" ? v.slice(0, 2000) : v;
      await writeJson(f, { ...data, ...ok });
      return json(res, { id: m[1] });
    }
    if (p === "/api/db/feedback" && method === "POST") {
      const d = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const id = [...randomBytes(20)].map(x => "abcdefghijklmnopqrstuvwxyz0123456789"[x % 36]).join("");
      await writeJson(docFile("feedback", id), { text: String(d.text || "").slice(0, 2000), record: /^[a-z0-9]{20}$/.test(d.record || "") ? d.record : null, createdAt: Date.now() });
      return json(res, { id });
    }
    if (p.startsWith("/api/")) return json(res, { error: "forbidden" }, 403);
    return notFound(res);
  } catch (e) {
    console.error("公開網頁：", e.message);
    if (!res.headersSent) json(res, { error: "server_error" }, 500);
  }
});

/* ---------- Claude ---------- */

// 今天的呼叫次數：同時好幾個請求進來（生成時元素、甲面、雕塑會一起畫）也要一個一個算，不會算少或寫壞檔案
let usageLock = Promise.resolve();
function bumpUsage(day) {
  const p = usageLock.then(async () => {
    const usage = await readJson(path.join(DATA, "usage.json"), {});
    usage[day] = (usage[day] || 0) + 1;
    await writeJson(path.join(DATA, "usage.json"), usage);
    return usage[day];
  });
  usageLock = p.catch(() => {});
  return p;
}

async function ai(req, res) {
  if (DEMO) return demoReply(req, res);
  if (!client) return json(res, { error: "no_api_key" }, 500);
  const body = JSON.parse((await readBody(req)).toString("utf8") || "null");
  if (!body || typeof body.prompt !== "string" || !body.prompt) return json(res, { error: "bad_request" }, 400);

  const day = new Date().toISOString().slice(0, 10);
  const count = await bumpUsage(day);
  if (count > DAILY_LIMIT) return json(res, { error: "daily_limit" }, 429);
  console.log(`Claude 呼叫：今天第 ${count} 次（上限 ${DAILY_LIMIT}）`);

  const content = [];
  for (const im of Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : []) {
    if (!im || typeof im.data !== "string" || !/^image\/(png|jpeg|gif|webp)$/.test(im.media_type)) continue;
    content.push({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } });
  }
  content.push({ type: "text", text: body.prompt });

  // 用串流接收：圖多、想得久的時候不會因為連線太久被切斷。
  // 回覆被截斷或不是 JSON 時自動再試一次。
  // 生成器可以指定這次要想多深：畫甲面、雕塑、元素這種畫圖工作用 low，回得快很多；沒指定就用設定的深度。
  const effort = ["low", "medium", "high"].includes(body.effort) ? body.effort : (SAVE ? SAVE_EFFORT : EFFORT);
  const task = String(body.task || "").slice(0, 20);
  // 網頁那邊等太久放棄了（關掉連線），這邊也跟著停，不再繼續花錢
  let stream = null, gaveUp = false;
  res.on("close", () => { if (!res.writableEnded) { gaveUp = true; if (stream) stream.abort(); } });
  const ask = () => {
    stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: SAVE ? 16000 : 32000,
      output_config: { effort },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content }],
    });
    return stream.finalMessage();
  };
  const t0 = Date.now();
  const took = () => `${((Date.now() - t0) / 1000).toFixed(1)} 秒`;

  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let msg;
    try {
      msg = await ask();
    } catch (e) {
      if (gaveUp) { console.log(`Claude ${task || '呼叫'}：網頁等太久先放棄了（${took()}），這次停掉`); return; }
      console.error(`Claude API 錯誤（第 ${attempt} 次）：`, e.message);
      if (e instanceof Anthropic.AuthenticationError) return json(res, { error: "bad_api_key", detail: e.message }, 500);
      if (e instanceof Anthropic.PermissionDeniedError) return json(res, { error: "no_permission", detail: e.message }, 500);
      if (e instanceof Anthropic.BadRequestError) return json(res, { error: "bad_request", detail: e.message }, 400);
      last = { error: e instanceof Anthropic.RateLimitError ? "rate_limited" : e instanceof Anthropic.APIConnectionError || !(e instanceof Anthropic.APIError) ? "network" : "api_error", detail: e.message };
      continue;
    }
    if (msg.stop_reason === "refusal") { console.error("Claude 拒絕回答這個請求"); return json(res, { error: "refused" }, 422); }
    const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
    const result = parseJson(text);
    if (result !== undefined) { console.log(`Claude ${task || '回覆'}：${took()}（思考深度 ${effort}）`); return json(res, { result, stop_reason: msg.stop_reason }); }
    console.error(`Claude 回覆不是完整的 JSON（第 ${attempt} 次，stop_reason=${msg.stop_reason}）：`, text.slice(0, 300));
    if (gaveUp) return;
    last = { error: msg.stop_reason === "max_tokens" ? "too_long" : "bad_json", detail: text.slice(0, 500) };
  }
  return json(res, last, last.error === "rate_limited" ? 429 : 502);
}

// 展覽安全碼：比對 settings.txt 的 EXPO_PIN。打錯會等一下才回，避免一直亂猜。
async function unlock(req, res) {
  const body = JSON.parse((await readBody(req)).toString("utf8") || "null") || {};
  if (!EXPO_PIN) return json(res, { error: "no_pin" }, 400);
  const a = Buffer.from(String(body.pin || "")), b = Buffer.from(EXPO_PIN);
  if (a.length === b.length && timingSafeEqual(a, b)) return json(res, { ok: true });
  await new Promise(r => setTimeout(r, 1500));
  return json(res, { error: "wrong_pin" }, 403);
}

/* ---------- 手機上傳 ---------- */
// 生成器按「用手機上傳」→ 開一個 20 分鐘有效的上傳碼，QR code 指到 http://電腦區網位址:8788/u/上傳碼。
// 手機傳上來的照片先放 data/phone/<上傳碼>/，生成器每隔一下來拿，拿到後和本機上傳的照片一樣處理。
const PHONE_DIR = path.join(DATA, "phone");
const PHONE_TTL = 20 * 60 * 1000, PHONE_MAX = 3, PHONE_MAX_BYTES = 15 * 1024 * 1024;
const phoneSessions = new Map();

function lanAddress() {
  if (PHONE_HOST) return PHONE_HOST;
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/vethernet|vmware|virtualbox|hyper-v|wsl|loopback|docker|tailscale|zerotier/i.test(name)) continue;
    for (const a of list || []) {
      if (a.family !== "IPv4" || a.internal || a.address.startsWith("169.254.")) continue;
      const rank = a.address.startsWith("192.168.") ? 0 : a.address.startsWith("10.") ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 2 : 3;
      found.push([rank, a.address]);
    }
  }
  found.sort((x, y) => x[0] - y[0]);
  return found.length ? found[0][1] : null;
}

// 不同網路也能上傳：資料夾裡有 cloudflared（Cloudflare 的免費通道程式）就自動開一條臨時的公開網址，
// 手機用自己的 4G／5G 也連得到，只會通到手機上傳頁。沒有就只能用同一個 Wi-Fi。
let TUNNEL = null, tunnelStarting = false;
// 解壓縮到新的資料夾時，金鑰（settings.txt）和紀錄（data）還在舊資料夾。往上找兩層，有就在視窗上提醒。
function findOldCopies() {
  const found = [], seen = new Set([path.resolve(ROOT)]);
  const look = (dir, depth) => {
    if (depth < 0 || found.length >= 3) return;
    let list = [];
    try { list = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of list) {
      if (!d.isDirectory() || /^(node_modules|\.|data$|public$|runtime$)/.test(d.name)) continue;
      const sub = path.join(dir, d.name);
      if (seen.has(path.resolve(sub))) continue; seen.add(path.resolve(sub));
      const f = path.join(sub, "settings.txt");
      try { if (/^\s*ANTHROPIC_API_KEY\s*=\s*\S+/m.test(readFileSync(f, "utf8")) && existsSync(path.join(sub, "server.mjs"))) { found.push(sub); continue; } } catch {}
      look(sub, depth - 1);
    }
  };
  look(path.dirname(ROOT), 1);
  look(path.dirname(path.dirname(ROOT)), 2);
  return found;
}

// cloudflared：手機不用同一個 Wi-Fi 也能掃 QR code（上傳照片、存試戴照片）。沒有或壞掉就自己下載一份並檢查，斷了會自己重開。
const CF_NAME = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
const CF_URL = process.platform === "win32" ? `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-${process.arch === "ia32" ? "386" : "amd64"}.exe`
  : process.platform === "linux" ? `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${process.arch === "arm64" ? "arm64" : "amd64"}` : null;
function cfCheck(f) {
  try {
    const size = statSync(f).size, head = Buffer.alloc(4), fd = openSync(f, "r");
    readSync(fd, head, 0, 4, 0); closeSync(fd);
    const ok = f.endsWith(".exe") || process.platform === "win32" ? head.toString("latin1", 0, 2) === "MZ" : head[0] === 0x7f && head.toString("latin1", 1, 4) === "ELF";
    return size < 5e6 ? `檔案只有 ${Math.round(size / 1024)} KB，沒下載完整` : ok ? null : "不是可以執行的程式檔";
  } catch (e) { return e.message; }
}
async function ensureCloudflared() {
  const exe = path.join(ROOT, CF_NAME);
  if (existsSync(exe)) {
    const why = cfCheck(exe);
    if (!why) return exe;
    try { renameSync(exe, exe + ".bad"); } catch {}
    console.log(`手機掃碼：通道程式 cloudflared 壞掉了（${why}），重新下載…`);
  }
  if (!CF_URL) return null;
  console.log("手機掃碼：正在下載通道程式 cloudflared（約 30 MB，第一次才需要）…");
  try {
    const r = await fetch(CF_URL, { redirect: "follow", signal: AbortSignal.timeout(180000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const part = exe + ".part";
    writeFileSync(part, Buffer.from(await r.arrayBuffer()));
    const why = cfCheck(part);
    if (why) { await rm(part, { force: true }); throw new Error(why); }
    renameSync(part, exe);
    if (process.platform !== "win32") chmodSync(exe, 0o755);
    console.log("手機掃碼：通道程式下載好了。");
    return exe;
  } catch (e) {
    console.log(`手機掃碼：通道程式下載失敗（${e.message}），先用同一個 Wi-Fi。可以重新啟動再試一次，或確認這台電腦連得上 github.com。`);
    return null;
  }
}
async function startTunnel() {
  tunnelStarting = true;
  const exe = await ensureCloudflared();
  if (!exe) { tunnelStarting = false; return; }
  runTunnel(exe);
}
let tunnelRetry = 0;
function runTunnel(exe) {
  if (!tunnelRetry) console.log("手機掃碼：正在開不用同一個 Wi-Fi 的通道（cloudflared）…");
  tunnelStarting = true;
  let cf;
  try {
    cf = spawn(exe, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${PUBLIC_MODE ? PUBLIC_PORT : PHONE_PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    tunnelStarting = false;
    try { renameSync(exe, exe + ".bad"); } catch {}
    console.log(`手機掃碼：通道程式開不起來（${e.code || e.message}），先用同一個 Wi-Fi；下次啟動會重新下載。`);
    return;
  }
  const read = buf => {
    const m = String(buf).match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !TUNNEL) {
      TUNNEL = m[0]; tunnelStarting = false; tunnelRetry = 0;
      if (PUBLIC_MODE) {
        const link = `${TUNNEL}/undertone/play.html`;
        console.log(`\n================================================\n  公開網頁開好了，把這個網址分享出去：\n  ${link}\n================================================\n（網址也存在「公開網址.txt」。關掉這個視窗、或電腦睡著，網頁就打不開；重新開會換一個新網址。）\n`);
        writeFile(path.join(ROOT, "公開網址.txt"), link + "\r\n").catch(() => {});
      } else console.log(`手機掃碼：通道開好了，手機不用連同一個 Wi-Fi 也能用（${TUNNEL}）。`);
    }
  };
  cf.stdout.on("data", read); cf.stderr.on("data", read);
  cf.on("error", e => { tunnelStarting = false; console.log("手機掃碼：通道程式開不起來（" + e.message + "），先用同一個 Wi-Fi。"); });
  cf.on("exit", () => {
    const was = TUNNEL; TUNNEL = null; tunnelStarting = false;
    if (shuttingDown) return;
    // 展覽一整天，網路晃一下通道就會斷：等一下自己重開，最多連續試 20 次
    if (tunnelRetry++ < 20) { if (was) console.log("手機掃碼：通道斷了，10 秒後重新連線…"); setTimeout(() => runTunnel(exe), 10000); }
    else console.log("手機掃碼：通道一直連不上，先用同一個 Wi-Fi。");
  });
  tunnelProc = cf;
}
let shuttingDown = false, tunnelProc = null;
process.on("exit", () => { shuttingDown = true; if (tunnelProc) tunnelProc.kill(); });

async function phoneStart(res) {
  // 通道剛啟動還沒好時，等它最多 12 秒
  for (let i = 0; i < 24 && tunnelStarting && !TUNNEL; i++) await new Promise(r => setTimeout(r, 500));
  const host = lanAddress();
  if (!phoneServerUp || (!host && !TUNNEL)) return json(res, { error: "no_lan" }, 503);
  const token = randomBytes(16).toString("hex");
  phoneSessions.set(token, { created: Date.now(), items: [] });
  json(res, { token, url: TUNNEL ? `${TUNNEL}/u/${token}` : `http://${host}:${PHONE_PORT}/u/${token}`, wifi: TUNNEL ? null : PHONE_WIFI, remote: !!TUNNEL, max: PHONE_MAX });
}

async function phoneRoute(req, res, token, n) {
  const ses = phoneSessions.get(token);
  if (req.method === "DELETE") { phoneSessions.delete(token); await rm(path.join(PHONE_DIR, token), { recursive: true, force: true }); return json(res, { ok: true }); }
  if (!ses) return json(res, { error: "expired" }, 404);
  if (n === undefined) return json(res, { items: ses.items.map((it, i) => ({ n: i, type: it.type })) });
  const it = ses.items[+n];
  if (!it) return notFound(res);
  res.writeHead(200, { "Content-Type": it.type, "Cache-Control": "no-store" });
  res.end(await readFile(it.file));
}

/* ---------- 試戴照片存到手機 ---------- */
// 生成器把拍好的試戴照片送來，存成 data/share/<碼>.<副檔名>，QR code 指到手機頁 /d/<碼>（有通道就走通道，不用同一個 Wi-Fi）。
// 檔名就是碼，重新開伺服器也還在；放 3 天後自動清掉。
const SHARE_DIR = path.join(DATA, "share"), SHARE_TTL = 3 * 24 * 3600 * 1000;
async function shareStart(req, res) {
  const type = (req.headers["content-type"] || "").split(";")[0];
  if (!/^image\/(jpeg|png|webp)$/.test(type)) return json(res, { error: "bad_type" }, 415);
  const body = await readBody(req);
  if (!body.length || body.length > PHONE_MAX_BYTES) return json(res, { error: "too_large" }, 413);
  for (let i = 0; i < 24 && tunnelStarting && !TUNNEL; i++) await new Promise(r => setTimeout(r, 500));
  const host = lanAddress();
  if (!phoneServerUp || (!host && !TUNNEL)) return json(res, { error: "no_lan" }, 503);
  const token = randomBytes(16).toString("hex");
  await mkdir(SHARE_DIR, { recursive: true });
  await writeFile(path.join(SHARE_DIR, `${token}.${type.split("/")[1]}`), body);
  json(res, { url: TUNNEL ? `${TUNNEL}/d/${token}` : `http://${host}:${PHONE_PORT}/d/${token}`, wifi: TUNNEL ? null : PHONE_WIFI, remote: !!TUNNEL });
}
async function shareFile(token) {
  for (const ext of ["png", "jpeg", "webp"]) { const f = path.join(SHARE_DIR, `${token}.${ext}`); if (existsSync(f)) return { file: f, type: "image/" + ext, ext }; }
  return null;
}
setInterval(async () => {
  try { for (const f of await readdir(SHARE_DIR)) { const st = await stat(path.join(SHARE_DIR, f)); if (Date.now() - st.mtimeMs > SHARE_TTL) await rm(path.join(SHARE_DIR, f), { force: true }); } } catch {}
}, 60 * 60 * 1000).unref();
const SHARE_PAGE = t => `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>UNDERTONE 試戴照片</title>
<style>body{margin:0;background:#EDEDED;color:#161616;font-family:"Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif}main{max-width:560px;margin:0 auto;padding:28px 18px 40px}
.mark{letter-spacing:.34em;font-size:18px;margin:0 0 20px}img{width:100%;border-radius:16px;display:block;background:#fff}p{color:#6E6E6E;line-height:1.6}
a{display:flex;align-items:center;justify-content:center;min-height:56px;margin-top:16px;border-radius:14px;background:#161616;color:#fff;text-decoration:none;font-size:17px}</style></head>
<body><main><p class="mark">UNDERTONE</p><img src="/d/${t}/img" alt="試戴照片"><p>長按照片就能存到相簿，或按下面的按鈕下載。這張照片放 3 天後會刪掉。</p><a href="/d/${t}/img?dl=1">下載照片</a></main></body></html>`;

// 過期的上傳碼和照片定時清掉
setInterval(() => {
  const now = Date.now();
  for (const [t, ses] of phoneSessions) if (now - ses.created > PHONE_TTL) { phoneSessions.delete(t); rm(path.join(PHONE_DIR, t), { recursive: true, force: true }).catch(() => {}); }
}, 60 * 1000).unref();

// 區網上的手機只能用這個伺服器：打開上傳頁、送照片，其他一律 404
let phoneServerUp = false;
const PHONE_PAGE = path.join(ROOT, "phone", "upload.html");
const phoneServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x"), pn = url.pathname;
    const d = pn.match(/^\/d\/([0-9a-f]{32})(\/img)?$/);
    if (d && req.method === "GET") {
      const f = await shareFile(d[1]);
      if (!f) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("這張照片已經過期或不存在了。"); }
      if (!d[2]) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); return res.end(SHARE_PAGE(d[1])); }
      const h = { "Content-Type": f.type, "Cache-Control": "no-store" };
      if (url.searchParams.has("dl")) h["Content-Disposition"] = `attachment; filename="UNDERTONE-tryon.${f.ext}"`;
      res.writeHead(200, h); return res.end(await readFile(f.file));
    }
    const m = pn.match(/^\/u\/([0-9a-f]{32})$/);
    const ses = m && phoneSessions.get(m[1]);
    if (!m) return notFound(res);
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(await readFile(PHONE_PAGE));
    }
    if (req.method !== "POST") return notFound(res);
    if (!ses || Date.now() - ses.created > PHONE_TTL) return json(res, { error: "expired" }, 410);
    if (ses.items.length >= PHONE_MAX) return json(res, { error: "full" }, 409);
    const type = (req.headers["content-type"] || "").split(";")[0];
    if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) return json(res, { error: "bad_type" }, 415);
    const body = await readBody(req);
    if (!body.length || body.length > PHONE_MAX_BYTES) return json(res, { error: "too_large" }, 413);
    await mkdir(path.join(PHONE_DIR, m[1]), { recursive: true });
    const file = path.join(PHONE_DIR, m[1], `${ses.items.length}.${type.split("/")[1]}`);
    await writeFile(file, body);
    ses.items.push({ type, file });
    json(res, { ok: true, count: ses.items.length, max: PHONE_MAX });
  } catch (e) {
    console.error("手機上傳：", e.message);
    if (!res.headersSent) json(res, { error: "server_error" }, 500);
  }
});
phoneServer.on("error", e => console.log(`手機上傳沒有開成（${e.code}），用手機傳照片的功能不能用。`));

// 示範模式的假回覆：欄位和真的一樣，內容隨機挑，等一下才回，看得到等待畫面
const pick = a => a[Math.floor(Math.random() * a.length)];
async function demoReply(req, res) {
  await readBody(req);
  await new Promise(r => setTimeout(r, 1200 + Math.random() * 1200));
  const pal = pick([["#F2C6D0", "#FFFFFF", "#C9A0FF", "#E8D7D0"], ["#141414", "#C9CDD3", "#6E7278", "#E8D7D0"], ["#F3E3C3", "#9CC3E6", "#A8C3A0", "#B07A3C"], ["#2B2B3A", "#8FD3FF", "#D7B8FF", "#E9EEF4"]]);
  json(res, { result: {
    summary: "（示範模式）這是假的解析，用來調介面，沒有呼叫 Claude。",
    colors: pal, bgColors: [], aes: pick(["韓系", "日系", "黑金屬", "未來感"]), fits: true,
    elements: [...new Set([pick(["heart", "star", "pearl", "bow"]), pick(["chain", "drip", "stud", "cross"])])], others: [], keywords: ["示範"],
    say: pick(["（示範模式）今天用透亮的果凍底配一點銀色小飾品，乾淨又有亮點。", "（示範模式）黑色亮面加液態銀，短方圓甲，酷一點但不會太重。", "（示範模式）奶白底配淡淡的星星和小珍珠，輕快不甜膩。"]),
    why: {}, basis: ["示範模式"], newTry: [],
  }, stop_reason: "end_turn", demo: true });
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

/* ---------- 測試紀錄：data/db/<collection>/<id>.json ---------- */

const colDir = col => path.join(DATA, "db", col);
const docFile = (col, id) => path.join(colDir(col), id + ".json");

async function collectionRoute(req, res, col, url) {
  if (req.method === "GET") {
    const files = existsSync(colDir(col)) ? (await readdir(colDir(col))).filter(f => f.endsWith(".json")) : [];
    const docs = [];
    for (const f of files) {
      const data = await readJson(path.join(colDir(col), f), null);
      if (data) docs.push({ id: f.slice(0, -5), data });
    }
    const t = d => (typeof d.data.createdAt === "number" ? d.data.createdAt : 0);
    docs.sort((a, b) => t(a) - t(b) || a.id.localeCompare(b.id));
    if (url.searchParams.get("dir") === "desc") docs.reverse();
    return json(res, { docs });
  }
  if (req.method === "POST") {
    const data = JSON.parse((await readBody(req)).toString("utf8"));
    const id = [...randomBytes(20)].map(x => "abcdefghijklmnopqrstuvwxyz0123456789"[x % 36]).join("");
    await writeJson(docFile(col, id), data);
    return json(res, { id });
  }
  return json(res, { error: "method" }, 405);
}

async function docRoute(req, res, col, id) {
  const f = docFile(col, id);
  switch (req.method) {
    case "GET": {
      const data = await readJson(f, null);
      return data ? json(res, { id, data }) : json(res, { error: "not_found" }, 404);
    }
    case "PUT":
      await writeJson(f, JSON.parse((await readBody(req)).toString("utf8")));
      return json(res, { id });
    case "PATCH": {
      const data = await readJson(f, null);
      if (!data) return json(res, { error: "not_found" }, 404);
      await writeJson(f, { ...data, ...JSON.parse((await readBody(req)).toString("utf8")) });
      return json(res, { id });
    }
    case "DELETE":
      await rm(f, { force: true });
      return json(res, { ok: true });
  }
  return json(res, { error: "method" }, 405);
}

/* ---------- 圖片：data/blobs/<id>.png|jpg ---------- */

const EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };
const blobDir = path.join(DATA, "blobs");

async function findBlob(id) {
  for (const [type, ext] of Object.entries(EXT)) {
    const f = path.join(blobDir, id + ext);
    if (existsSync(f)) return { f, type };
  }
  return null;
}

async function putBlob(req, res, id) {
  const type = (req.headers["content-type"] || "").split(";")[0];
  if (!EXT[type]) return json(res, { error: "not_image" }, 415);
  const buf = await readBody(req);
  await removeBlob(id);
  await mkdir(blobDir, { recursive: true });
  await writeFile(path.join(blobDir, id + EXT[type]), buf);
  return json(res, { id });
}

async function removeBlob(id) {
  const b = await findBlob(id);
  if (b) await rm(b.f, { force: true });
}

async function getBlob(res, id) {
  const b = BLOB_RE.test(id) && (await findBlob(id));
  if (!b) return notFound(res);
  res.writeHead(200, { "Content-Type": b.type, "Cache-Control": "private, max-age=31536000, immutable" });
  res.end(await readFile(b.f));
}

/* ---------- 靜態檔案 ---------- */

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
  ".wasm": "application/wasm", ".data": "application/octet-stream", ".binarypb": "application/octet-stream",
  ".tflite": "application/octet-stream", ".txt": "text/plain; charset=utf-8",
};

async function serveStatic(res, p) {
  let f = path.normalize(path.join(PUBLIC, p));
  if (f !== PUBLIC && !f.startsWith(PUBLIC + path.sep)) return notFound(res);
  try {
    if ((await stat(f)).isDirectory()) {
      if (!p.endsWith("/")) { res.writeHead(301, { Location: p + "/" }); return res.end(); }
      f = path.join(f, "index.html");
    }
    const buf = await readFile(f);
    res.writeHead(200, { "Content-Type": MIME[path.extname(f).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(buf);
  } catch {
    notFound(res);
  }
}

/* ---------- 共用 ---------- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", c => {
      n += c.length;
      if (n > MAX_BODY) { reject(new Error("too_large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(f, fallback) {
  try { return JSON.parse(await readFile(f, "utf8")); } catch { return fallback; }
}

async function writeJson(f, data) {
  await mkdir(path.dirname(f), { recursive: true });
  // 每次用不同的暫存檔名：同時有兩個請求寫同一個檔時，才不會互相搶走對方的暫存檔而出錯
  const tmp = `${f}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 1));
  await rename(tmp, f);
}

function json(res, obj, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

/* ---------- 第一次啟動：搬入 claude.ai 的舊紀錄 ---------- */

async function importOldData() {
  const recDir = path.join(OLD_DATA, "records");
  if (!existsSync(recDir) || existsSync(path.join(DATA, "imported.txt"))) return;
  let nb = 0, nr = 0;
  const srcBlobs = path.join(OLD_DATA, "blobs");
  if (existsSync(srcBlobs)) {
    await mkdir(blobDir, { recursive: true });
    for (const f of await readdir(srcBlobs)) {
      if (!/^[0-9a-f]{32}\.(png|jpg)$/.test(f)) continue;
      await copyFile(path.join(srcBlobs, f), path.join(blobDir, f));
      nb++;
    }
  }
  await mkdir(colDir("records"), { recursive: true });
  for (const f of await readdir(recDir)) {
    if (!/^[A-Za-z0-9_-]+\.json$/.test(f)) continue;
    await copyFile(path.join(recDir, f), path.join(colDir("records"), f));
    nr++;
  }
  await writeFile(path.join(DATA, "imported.txt"), `從 claude.ai 搬入 ${nr} 筆紀錄、${nb} 張圖片：${new Date().toLocaleString()}\n`);
  console.log(`已搬入舊的測試紀錄：${nr} 筆、圖片 ${nb} 張。`);
}

/* ---------- 啟動 ---------- */

await mkdir(DATA, { recursive: true });
await importOldData();
server.on("error", e => {
  if (e.code === "EADDRINUSE") {
    console.log(`Undertone 好像已經開著了（${PORT} 埠被占用），直接打開瀏覽器。`);
    if (DEMO) console.log("⚠ 已經開著的那個不是示範模式，會花到 API。要調介面不花錢，先關掉另一個黑色視窗再開一次。");
    openBrowser();
    setTimeout(() => process.exit(0), 1500);
  } else throw e;
});
server.listen(PORT, "127.0.0.1", () => {
  // 先開瀏覽器再印訊息：Windows 的命令視窗被點到進入「選取」模式時，印字會卡住整個程式。
  if (process.argv.includes("--open")) openBrowser();
  const link = `http://localhost:${PORT}/undertone/`;
  console.log(`\nUndertone 已啟動：${link}`);
  if (DEMO) console.log("示範模式：不會呼叫 Claude，不花錢。設計結果是假的，只用來調介面。");
  if (SAVE) console.log(`省錢模式：提案用後台規則、元素用素材庫，只有讀照片和用說的修改才呼叫 Claude（思考深度 ${SAVE_EFFORT}）。`);
  else console.log(client ? `Claude 模型：${MODEL}（思考深度 ${EFFORT}，每天最多 ${DAILY_LIMIT} 次）` : "⚠ 還沒設定 API 金鑰（settings.txt），AI 功能不能用。");
  if (!client) for (const dir of findOldCopies()) console.log(`   找到舊版的資料夾：${dir}\n   把裡面的 settings.txt 和 data 資料夾複製到這個資料夾（${ROOT}），再重新點兩下啟動檔。`);
  // 開啟時先確認金鑰能不能用（查模型資料，不花錢）
  if (client && !DEMO) client.models.retrieve(MODEL).then(
    () => console.log("✓ API 金鑰可以用"),
    e => console.error(e instanceof Anthropic.AuthenticationError
      ? `✗ API 金鑰不對或已失效（開頭 ${API_KEY.slice(0, 10)}…，共 ${API_KEY.length} 個字）。到 https://console.anthropic.com/settings/keys 重新建立一把，貼進 settings.txt 後重新啟動。`
      : e instanceof Anthropic.NotFoundError ? `✗ 找不到模型 ${MODEL}，檢查 settings.txt 的 CLAUDE_MODEL。`
      : `✗ 檢查金鑰時出錯：${e.message}`));
  if (PUBLIC_MODE) {
    publicServer.listen(PUBLIC_PORT, "127.0.0.1", () => {
      console.log(`公開模式：每個人每天最多呼叫 Claude ${PUBLIC_PER_IP} 次，全部人加起來每天最多 ${DAILY_LIMIT} 次（settings.txt 的 PUBLIC_PER_IP、DAILY_AI_LIMIT 可以改）。`);
      console.log(`自己看測試紀錄和訪客留言：${link}`);
      startTunnel();
    });
    publicServer.on("error", e => console.log(`公開網頁沒有開成（${e.code}）。`));
    console.log("要關掉時，直接關這個視窗。\n");
    return;
  }
  rm(PHONE_DIR, { recursive: true, force: true }).catch(() => {});
  phoneServer.listen(PHONE_PORT, "0.0.0.0", () => {
    phoneServerUp = true;
    startTunnel();
    const host = lanAddress();
    if (!tunnelStarting) console.log(host ? `手機上傳：同一個 Wi-Fi 的手機掃生成器上的 QR code 就能傳照片（${host}:${PHONE_PORT}）。Windows 問要不要允許時，勾「私人網路」。` : "手機上傳：這台電腦沒有連上 Wi-Fi 或區網，用手機傳照片的功能暫時不能用。");
  });
  console.log("要關掉時，直接關這個視窗。\n");
});

function openBrowser() {
  const link = `http://localhost:${PORT}/undertone/`;
  if (KIOSK && process.platform === "win32") return openKiosk(link + "?expo=1");
  const cmd = process.platform === "win32" ? `start "" "${link}"` : process.platform === "darwin" ? `open "${link}"` : `xdg-open "${link}"`;
  exec(cmd, () => {});
}

// 展覽用：全螢幕、沒有網址列和分頁（kiosk）。用獨立的瀏覽器設定檔（data/kiosk-browser），
// 平常開著的瀏覽器不受影響，鏡頭權限允許一次之後就會記住。
function openKiosk(link) {
  const env = process.env, cands = [
    [path.join(env.ProgramFiles || "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"), false],
    [path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"), false],
    [path.join(env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"), false],
    [path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"), true],
    [path.join(env.ProgramFiles || "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe"), true],
  ];
  const found = cands.find(([f]) => existsSync(f));
  if (!found) { console.log("找不到 Chrome 或 Edge，改用一般視窗打開（可以按 F11 全螢幕）。"); exec(`start "" "${link}"`, () => {}); return; }
  const [exe, edge] = found;
  const args = [`--kiosk`, link, `--user-data-dir=${path.join(DATA, "kiosk-browser")}`, "--no-first-run", "--no-default-browser-check",
    "--disable-pinch", "--overscroll-history-navigation=0", "--disable-features=Translate", "--disable-session-crashed-bubble"];
  if (edge) args.push("--edge-kiosk-type=fullscreen");
  spawn(exe, args, { detached: true, stdio: "ignore" }).unref();
}
