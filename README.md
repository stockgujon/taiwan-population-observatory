# 島嶼人口觀測站（GitHub 靜態版）

這是把原本 Next.js + Cloudflare Worker/D1 版本，改寫成**純靜態 HTML/CSS/JS**、可直接放上 GitHub Pages 的版本。畫面、文字、計算公式、顏色語意都依照 `IMPLEMENTATION_SPEC.md` 沿用原站設計；技術棧因為平台不同而改變（見下方「與原站的差異」）。

## 目錄結構

```
index.html                        主頁面（單頁）
assets/
  style.css                       樣式（OKLCH 色票沿用 globals.css）
  app.js                          前端邏輯與 Chart.js 圖表渲染
  favicon.svg
data/
  population.json                 每日排程寫入的「共用快取」——瀏覽器唯一會讀取的資料來源
  population-time-machine.json    人口時間機靜態資料（1992–2075），懶載入
lib/
  population-fallback.json        建置時的官方資料快照，同步失敗時的最後防線
data-sources/
  ndc-five-age-population-1992-2075.csv   國發會推估原始 CSV（供重新產生時間機資料用）
scripts/
  sync-population.mjs             每日排程腳本（GitHub Actions 執行）
  generate-time-machine.mjs       重新產生 population-time-machine.json（手動執行，非每日）
.github/workflows/
  sync-population.yml             每日 03:00（台北時間）自動執行同步並 commit
```

## 核心設計：如何做到「網站抓取不會太負擔」

原站的規則是「訪客只能讀共用快取，只有後端排程能真正打政府資料源，且 20 小時內不重複抓」。靜態版用同樣的精神，只是把「共用快取」從 Cloudflare D1 換成**repo 裡的一個 JSON 檔**：

1. `GitHub Actions` 排程（`cron: '0 19 * * *'`，UTC 19:00 = 台北 03:00）每天執行一次 `scripts/sync-population.mjs`。
2. 這支腳本才會呼叫戶政司 API 與內政統計查詢網，彙整成 `data/population.json`，然後由 Actions 自動 commit 回 repo。
3. 網站本身（`index.html` + `app.js`）**只會 fetch 同源的 `data/population.json`**，不管訪客按多少次「檢查更新」、重新整理幾次頁面，都不會觸發任何政府網站的請求——因為它本來就沒有能力發出那個請求（純前端、無後端）。
4. 腳本內建 20 小時保護（讀取上次成功的 `syncedAt`，不到 20 小時就直接跳過），就算你手動重跑 workflow 或改動排程時間，也不會誤觸真正的資料源太多次。
5. 若當天官方來源失敗，腳本會保留前一份資料、標示 `stale: true` 並寫入 `syncWarning`，不會清空或讓網站空白。第一次還沒有任何資料時，repo 已經內建 `lib/population-fallback.json`（原站建置時查證的快照）當作起始值。

結論：**這個架構對政府資料源的請求量，比一般「使用者一操作就打 API」的做法更輕，一天最多一次**，且失敗、追趕、防止暴衝的邏輯都在 GitHub Actions 這端處理完，前端是完全被動的靜態檔案。

## 部署到 GitHub Pages

1. 建一個新的 GitHub repo，把這個資料夾整個推上去（`main` 分支）。
2. Repo 設定 → Pages → Source 選 `Deploy from a branch`，Branch 選 `main` / `/ (root)`。
3. Repo 設定 → Actions → General → Workflow permissions，確認選的是 **Read and write permissions**（`sync-population.yml` 需要 `contents: write` 才能把每天的新資料 commit 回去）。
4. 手動觸發一次 workflow（Actions 分頁 → Sync population data → Run workflow）確認能成功抓取、commit；之後就會照每天 03:00（台北時間）自動跑。

不需要資料庫、不需要任何後端伺服器、不需要付費方案。

## 與原站的差異（依 MASTER_PROMPT 要求列出）

因為平台從「Next.js + Cloudflare D1 + Worker cron」換成「純靜態 + GitHub Actions」，以下項目**必然**不同，但產品行為（畫面、文字、公式、色彩語意）刻意保持一致：

- **共用快取**：D1 資料表 → repo 內的 `data/population.json`（一樣是單一 cache key 的概念，只是用檔案取代資料列）。
- **每日排程**：Cloudflare Cron Trigger → GitHub Actions `schedule`，時間同樣是 UTC `0 19 * * *`（台北 03:00）。
- **20 小時防護**：原本比對 D1 的 `synced_at` 欄位；靜態版把同一個時間戳記存進 JSON 本身的 `syncedAt` 欄位（多出來的欄位，不影響前端顯示邏輯）。
- **圖表庫**：React + Recharts → 原生 JS + Chart.js（CDN 引入）。畫面呈現（金字塔對稱、tooltip 顯示絕對值、出生橘線/死亡藍線、推估虛線）都比照原本規格重建，但不是像素級同一套元件，可能有些微視覺差異（見下方「已知細節差異」）。
- **框架**：React 元件 → 原生 DOM 操作（無建置流程，開啟 `index.html` 即可預覽，不需要 npm build）。
- **API 路由**：`/api/population` 這個 Next.js API route 拿掉了，因為靜態網站沒有伺服器可以跑。「檢查更新」按鈕改成重新 fetch 同一個靜態 JSON 檔（在 GitHub Pages 的 CDN 快取更新後，訪客按下去就能看到當天的新資料），效果等同但不會有伺服器端 fallback-seed 那段邏輯（因為靜態版本一開始就把 `lib/population-fallback.json` 的內容直接放進 `data/population.json` 當初始值了，等於已經做過那個「首次寫入」的動作）。

## 已知細節差異／之後可以再優化的地方

這些是為了先求「架構可行、功能到位」而做的簡化，畫面精神一致但非逐像素相同：

- **人口時間機的「推估起點參考線」與「目前選取年份參考線」**：原站用 Recharts 的 `ReferenceLine`（整條垂直虛線）。靜態版用 Chart.js（沒有內建 annotation 外掛，為了不多引入一個 CDN 相依套件）改成在對應年份放大的資料點（dot）來標示，能看出位置但不是整條參考線。之後若要 1:1 還原，可以引入 `chartjs-plugin-annotation`。
- **字體**：改用 Google Fonts 的 Noto Sans TC（原站用 next/font 自架字型檔），視覺上應該一致，但依賴 Google Fonts CDN 可用性。
- **金字塔橫條圖的類別軸排序**：依 Chart.js 文件，水平長條圖預設會由上到下依陣列順序排列，已依此排出「由高齡到低齡」；建議部署後實際比對一次畫面確認順序正確。
- 尚未做自動化的「桌面 / 平板 / 手機無水平溢位」逐項複查，僅在本機以 390px（手機）、1440px（桌面）截圖檢查過主要區塊；建議部署後再用真機或瀏覽器開發工具跑一次平板寬度（約 768–1024px）。

## 本機預覽

不需要建置，任何靜態伺服器都可以：

```bash
python3 -m http.server 8000
# 開瀏覽器 http://localhost:8000/
```

## 手動測試 / 重新產生資料

```bash
# 強制重新同步一次（略過 20 小時保護，本機測試用）
node scripts/sync-population.mjs --force

# 國發會發布新版人口推估時，重新產生時間機資料
node scripts/generate-time-machine.mjs
```

`sync-population.mjs` 需要能連上 `ris.gov.tw` 與 `statis.moi.gov.tw`；這兩個網域在部分沙盒/公司網路环境可能被擋，但 GitHub Actions 的 runner 是一般網路環境，正常可以連。**建議部署後務必手動觸發一次 workflow，確認實際抓取成功**，因為本次交付是依照 `source/app/api/population/route.ts` 的邏輯逐行移植，但受限於開發環境沒有對外連線，未能在真正打到政府 API 的情況下端對端驗證。

## 驗收對照（`IMPLEMENTATION_SPEC.md` 第 11 節）

- [x] 頁面順序與固定文字一致（無「本月三個人口觀察」）。
- [x] 月線 60 個月、年線 1994 至今、YTD 標示。
- [x] 人口金字塔左右對稱、tooltip 顯示絕對值。
- [x] 增加榜紅色／減少榜綠色，各 10 筆，人數/百分比切換，百分比門檻三檔。
- [x] 時間機滑桿、三情境、金字塔＋長期軌跡＋觀察文字同步更新，懶載入（IntersectionObserver, rootMargin 360px）。
- [x] 首頁與「檢查更新」都只讀靜態 JSON，不會觸發政府來源請求。
- [x] 排程 20 小時保護、失敗保留舊資料＋`stale`、首次快照，皆在 `sync-population.mjs` 內實作。
- [ ] 手機／平板／桌面「零水平溢位」— 已抽測，建議部署後再全面複查（見上方「已知差異」）。
- [ ] 實際打政府 API 的端對端驗證 — 待你在有網路的環境（本機或 GitHub Actions）跑一次確認。
