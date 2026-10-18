# Undertone 專案說明（給 Claude）

## 後台（素材庫）怎麼同步

- `kb/backend.md` 是後台文件，使用者和 Claude 共編。原本放在 claude.ai 的 Doc，2026-10-12 搬到這裡。
- 生成器讀的是 `public/undertone/kb/backend.json`（和原本 claude.ai 上 `kb/backend` 的資料結構一樣）。
- 使用者改了 `backend.md` 後，要把改動整理進 `backend.json`：維持既有欄位結構（styles、refs、pairs、avoid、special、liquidMetal…），`version` 加 1，`updated` 寫日期和這次改了什麼。並在 `backend.md`「生成器怎麼讀後台」那段記下同步日期和版本。
- 生成器的版本紀錄（v18、v19…）也寫在 `backend.md` 最後面，沿用同樣的格式（使用者說／改了什麼／狀態）。
- 每次改版也要把 `public/undertone/index.html` 裡的 `VERSION`（例如 `雙模式 v59`）改成同一個版號，測試紀錄靠它分辨是哪一版做的。

## 生成器

- `public/undertone/index.html` 是單一 HTML 檔（p5.js）。介面和生成邏輯由使用者決定，沒被要求就不要改。
- `window.claude.use(...)` 由 `public/undertone/claude-shim.js` 提供，介面和 claude.ai 的一樣（sample.json、db.collection().doc()/add()/orderBy()、assets.upload/delete、downloads.save）。新功能需要新的介面時，加在 shim 和 `server.mjs`，不要改生成器去配合後端。
- p5.js 和 MediaPipe Hands 放在 `public/undertone/vendor/`，展場沒有穩定網路也能載入。
- 圖片網址是 `/_blob/<id>`，由 `server.mjs` 從 `data/blobs/` 讀出來。
- 公開版 `public/undertone/play.html` 是從 `index.html` 產生的（只多 `window.UT_PUBLIC=true`），不要直接改：改完 `index.html` 一定要跑 `node tools/build-play.mjs`，兩版才會同步。公開版專用的行為寫在 `index.html` 的 `if(UT_PUBLIC){…}` 裡。
- 公開模式（`公開網頁.bat` → `server.mjs --public`）另開對外伺服器（PUBLIC_PORT，預設 8789）走 cloudflared 通道，只放 play.html 和生成需要的 API，不能讀紀錄、不能刪改別人的資料。

## 執行方式

- 在使用者自己的 Windows 電腦上跑：點兩下 `啟動 Undertone.bat` → `server.mjs`（只聽 127.0.0.1:8787）。
- 測試紀錄存在 `data/db/records/*.json`，圖片在 `data/blobs/`。API 金鑰在 `settings.txt`。
- 這個 repo 是公開的：`data/`、`settings.txt`、`undertone-old-data/`、使用者照片都不要 commit。
