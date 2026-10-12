# Undertone 專案說明（給 Claude）

## 後台（素材庫）怎麼同步

- `kb/backend.md` 是後台文件，使用者和 Claude 共編。原本放在 claude.ai 的 Doc，2026-10-12 搬到這裡。
- 生成器讀的是 `public/undertone/kb/backend.json`（和原本 claude.ai 上 `kb/backend` 的資料結構一樣）。
- 使用者改了 `backend.md` 後，要把改動整理進 `backend.json`：維持既有欄位結構（styles、refs、pairs、avoid、special、liquidMetal…），`version` 加 1，`updated` 寫日期和這次改了什麼。並在 `backend.md`「生成器怎麼讀後台」那段記下同步日期和版本。
- 生成器的版本紀錄（v18、v19…）也寫在 `backend.md` 最後面，沿用同樣的格式（使用者說／改了什麼／狀態）。

## 生成器

- `public/undertone/index.html` 是單一 HTML 檔（p5.js）。介面和生成邏輯由使用者決定，沒被要求就不要改。
- `window.claude.use(...)` 由 `public/undertone/claude-shim.js` 提供，介面和 claude.ai 的一樣（sample.json、db.collection().doc()/add()/orderBy()、assets.upload/delete、downloads.save）。新功能需要新的介面時，加在 shim 和 `worker/index.js`，不要改生成器去配合後端。
- 圖片網址是 `/_blob/<id>`，由 worker 從 D1 讀出來。

## 後端

- `worker/index.js`：Cloudflare Worker，資料存在 D1（`schema.sql`）。
- 密碼、API 金鑰只放 Secret 或 `.dev.vars`，不能寫進 repo。
- 這個 repo 是公開的：測試紀錄、使用者照片不要 commit。
