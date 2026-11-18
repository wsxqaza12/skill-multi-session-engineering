# multi-session-engineering

一個 Claude Code skill：用多個 Claude Code session 加 Codex worker 平行做工程，同時不犧牲品質。2026-10 在 [Cairn](https://github.com/Cairn-ink/cairn-memory) 記憶引擎和它的產品整合上實際跑過。

A Claude Code skill for parallel engineering with several Claude Code sessions and Codex workers, without giving up review quality. Battle-tested in October 2026 on the Cairn memory engine.

## 內容重點
- **組織**：一個主控帶 3–5 條工作線，超過就往下分一層。主控不做實作。
- **desk**：本機的決策台（`scripts/desk`，Node、零相依）。owner 在網頁上回答問題，回覆幾秒內就叫醒提問的 session。看板、日誌、決定紀錄也都在 desk 上，有字數上限，不會長成流水帳。
- **品質**：每份改動都經非作者審查，只有 P0/P1 擋合併。修正輪有上限。推之前要推導測試清單並跑完。合併前有檢查表。
- **派工**：`scripts/dispatch` 負責派 Codex worker 和等待；派工和審查各有 brief 範本。
- **決定**：owner 的原話照抄；要改就新增一條取代。
- **踩過的坑**：exit code、heredoc、反引號、等待腳本、封閉驗證器、壓力測試成本等。

## 安裝
```bash
git clone https://github.com/wsxqaza12/skill-multi-session-engineering ~/.claude/skills/multi-session-engineering
```
Claude Code 會自動載入。說「照我們的協作方式」「開 session 分工」「派 worker」「任務板」時就會用到。

## 授權
MIT
