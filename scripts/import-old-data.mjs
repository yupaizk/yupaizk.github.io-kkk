// 把 claude.ai 舊版匯出的測試紀錄和圖片搬進新網站。
// 用法：node scripts/import-old-data.mjs <資料夾> <網址> <密碼>
//   例：node scripts/import-old-data.mjs ./undertone-old-data https://undertone.xxx.workers.dev 我的密碼
// 資料夾裡要有 records/<id>.json 和 blobs/<id>.png|jpg。重複執行沒關係，會覆蓋成同一份。
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const [dir, site, password] = process.argv.slice(2);
if (!dir || !site || !password) {
  console.error("用法：node scripts/import-old-data.mjs <資料夾> <網址> <密碼>");
  process.exit(1);
}
const base = site.replace(/\/+$/, "");

const login = await fetch(base + "/api/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password }),
});
if (!login.ok) {
  console.error("登入失敗：", login.status, await login.text());
  process.exit(1);
}
const cookie = login.headers.get("set-cookie").split(";")[0];

async function send(method, p, body, type) {
  const r = await fetch(base + p, { method, headers: { Cookie: cookie, "Content-Type": type }, body });
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${await r.text()}`);
}

const blobDir = path.join(dir, "blobs");
const blobs = await readdir(blobDir);
let n = 0;
for (const f of blobs) {
  const m = f.match(/^([0-9a-f]{32})\.(png|jpe?g)$/);
  if (!m) continue;
  await send("PUT", `/api/blob/${m[1]}`, await readFile(path.join(blobDir, f)), m[2] === "png" ? "image/png" : "image/jpeg");
  process.stdout.write(`\r圖片 ${++n}/${blobs.length}`);
}
console.log();

const recDir = path.join(dir, "records");
const recs = (await readdir(recDir)).filter(f => f.endsWith(".json"));
n = 0;
for (const f of recs) {
  const id = f.replace(/\.json$/, "");
  await send("PUT", `/api/db/records/${id}`, await readFile(path.join(recDir, f), "utf8"), "application/json");
  process.stdout.write(`\r紀錄 ${++n}/${recs.length}`);
}
console.log("\n完成。");
