# multi-session-engineering

一個 Claude Code skill：用多個 Claude Code session 加 Codex worker 平行做工程，同時不犧牲品質。2026-10 在 [Cairn](https://github.com/Cairn-ink/cairn-memory) 記憶引擎和它的產品整合上實際跑過。

A Claude Code skill for parallel engineering with several Claude Code sessions and Codex workers, without giving up review quality. Battle-tested in October 2026 on the Cairn memory engine.

## 內容重點
- **組織**：一個主控帶 3–5 條工作線，超過就往下分一層。主控不做實作。
- **溝通**：進度寫在共用任務板，訊息只用於三種情況：要決定、卡住、介面變動。
- **品質**：先寫合約，修改用版本化增補。每份改動都經非作者審查（兩軸，低風險一軸）和修正輪，原生驗收、CI 全綠才合併。
- **決定**：owner 的決定保留原話（決定紀錄）。數字要附出處，沒有數據前的因果判斷只能稱為假設。
- **硬上限**：修正超過 3 輪或卡住半天，交給主控決定換做法、縮範圍或停掉。
- **量測**：在安靜時段跑，先登記協定，不放寬門檻。
- **踩過的坑**：exit code、heredoc、等待腳本路徑、SQLite 原生 fd 鎖等。

## 安裝
```bash
git clone https://github.com/wsxqaza12/skill-multi-session-engineering ~/.claude/skills/multi-session-engineering
```
Claude Code 會自動載入。說「照我們的協作方式」「開 session 分工」「派 worker」「任務板」時就會用到。

## 授權
MIT
