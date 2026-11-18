# desk：owner 的決策台，也是大家的看板、日誌、決定紀錄

一個不需要安裝套件的本機服務（Node 22+）。owner 在網頁上回答問題，session 在背景等回覆、寫看板和日誌。資料是一般的 JSON 檔，放在 `DESK_HOME`（預設 `~/.local/share/desk`）。

## 安裝（一次）

```bash
# 短指令（換成你自己的 skill 路徑和資料夾）
cat > ~/.local/bin/desk <<'EOF'
#!/usr/bin/env bash
export DESK_HOME="${DESK_HOME:-$HOME/.local/share/desk}"
exec node "$HOME/.claude/skills/multi-session-engineering/scripts/desk/desk.mjs" "$@"
EOF
chmod 755 ~/.local/bin/desk

# 服務放在自己的 tmux session 裡，當掉會自動重啟
tmux new-session -d -s desk 'while true; do desk serve; sleep 3; done'

desk open                    # 在瀏覽器開啟並自動登入（不會印出 token）
desk tailscale on            # 選用：讓手機透過 Tailscale 連進來（要重啟服務）
desk pair                    # 手機配對：6 位數，5 分鐘內有效、只能用一次
desk backup --setup <私人 git repo 的 clone 資料夾>   # 每小時自動備份並推送
```

- 只綁 127.0.0.1（和選用的 Tailscale IP），Host/Origin 都會檢查，一定要登入 cookie。
- token 檔權限 0600，永遠不要印出來；備份不包含 token、配對碼和本機設定。
- 組織圖由各 session 自己登記：在 `~/.claude/settings.json` 的 SessionStart 加一個 hook，指令是 `"$HOME/.local/bin/desk" register --hook`，timeout 3。
  - 它依 session 的工作資料夾，對照 `config.json` 的 `projects`（例如 `{"match": "/my-repo", "group": "engine"}`），決定分到哪一組。不屬於任何專案的資料夾，例如個人專案，什麼都不做。
  - 有 tmux 就記下視窗名稱，沒有就用 session id，所以 Herd 或其他工具開的 session 也能登記。
  - 第一次登記的 session 會顯示「未登記」，並提示它跑 `desk org node <id> --name … --now …` 補上自己負責什麼。
  - 這個 hook 一定很快（約 35 ms），出任何錯都直接放行，不會擋住 session 啟動。
  - session 每次用 desk 都會更新「最後出現時間」，很久沒出現的會變淡。
- 網址：頁面在 `http://desk.localhost:<port>/`（`desk open` 會直接開）。登入憑證只綁這個專用名稱，因為 127.0.0.1 和 localhost 的 cookie 會被同一台電腦上所有其他網頁服務收到；用舊網址打開會自動轉過去。瀏覽器不認得 `*.localhost` 時，用 `config.json` 的 `localName` 換成別的名稱。
- 組織圖是一棵樹：每個人用 `desk org node <id> --parent <上級id> --note '一句備註'` 記上級。`config.json` 的 `rules` 是 owner 核准過的聯絡規則（字串陣列）。`desk org tree` 印出整張圖，`desk org me <id>` 印出自己的位置、整張圖和規則；開場的 `desk register` 也會印出這些，所以每個 session 一開工就知道自己向誰報告、可以找誰。
- 頁面的「組織」：左邊是這棵樹，每張卡片寫著它現在在做什麼；點一張，右邊就是它的位置和對話，可以直接跟它說。
- 對話：讀 Claude Code 存在本機的對話紀錄（預設 `~/.claude/projects`，可用 `transcriptsDir` 改）。session 的 `desk register` 和 `desk wait` 會記下自己的 Claude session id，desk 就知道該讀哪一份。只顯示 owner 打的字和 session 的文字回覆。`readRoots`（例如 `["/home/me/my-repo*"]`，結尾 `*` 代表開頭相同的資料夾都算）決定哪些資料夾裡的 .md 或 .txt 可以在頁面上打開；沒設就不開任何檔案。`redact`（正規表示式字串陣列）可以加上專案自己的金鑰格式，讓它們在頁面上被遮掉。
- 分組顯示用 `config.json` 的 `groups`（例如 `[{"key":"engine","label":"引擎"}]`）。選用：`discover` 列出要掃描的 tmux session，找出在跑但還沒登記的；`groupFromTmux` 把 tmux session 對應到分組。

## 每個 session 要知道的

**你的 id** 就是組織圖上的 id。

1. **問 owner**：背景要寫清楚，附選項和你的建議。
   ```bash
   cat > /tmp/ctx.txt <<'EOF'
   背景：為什麼要問、會影響什麼、風險。
   EOF
   desk ask --from api --title "一行標題" --kind decide --context-file /tmp/ctx.txt \
     --option a=好 --option 'b=不要|一句說明' --recommend a --why "為什麼建議 a" [--notify web,docs] [--approval]
   ```
   要 owner 動手的事用 `--kind act`；正式核准，例如發佈、上線，加 `--approval`。背景一定用 `<<'EOF'`，不然反引號和 `$()` 會被 shell 執行。
2. **等回覆**：在背景跑 `desk wait --session <你的id>`，回覆到了就會結束並叫醒你。**它是一次性的，處理完要在同一則回覆裡再跑一次。** 等的時候不要停在聊天裡等 owner 回答，也不要寫「你同意我才繼續」：先做其他不受影響的工作；真的沒事可做，就讓 wait 掛著並結束這一輪。
   - owner 的回覆可能附圖（她在頁面上貼上、拖進或選圖片）。wait 印出的「附圖」是本機檔案路徑，用 Read 工具打開看；這些圖也是她回覆的一部分。
3. **owner 的回覆就是 owner 本人的決定。** 處理完：`desk close <id> --outcome "一句結果"`。
4. **改題或撤回**：owner 回覆前可以 `desk ask --update <id> …`；不用問了就 `desk withdraw <id> --reason …`。
5. **別人的題目也要叫醒你**：請提問的人加 `--notify <你的id>`，或者 `desk notify <id> --add <你的id>`，或者自己跑 `desk wait --ask <id>`。
6. **看板**：一條工作線一張卡，只寫現在。
   ```bash
   desk board set <卡id> --owner api --status 進行 --title "…" --now "一行" --next "一行" [--waiting "…"] [--waits-on <題目id>]
   ```
   有字數上限；舊值會自動記進日誌。替別人改卡時加 `--by <你的id>`。
7. **日誌**：`desk log --from <你的id> --topic … --stdin <<'EOF' … EOF`，每筆 ≤3000 字。提問、回覆、看板變動、新決定都會自動記錄。
8. **決定**（只有主控記）：`desk decide D-12 --title … --words "owner 的原話" --point … [--supersedes D-x] [--partly-supersedes D-y]`。查詢用 `desk decision list` 或頁面上的「決定」。
9. **盯動態**（主控用）：`desk watch --as <你的id> --not-from <你的id>` 會在別人改看板、寫日誌、提問或回覆時叫醒你。第一次先跑一次 `--init`；用完也要重新跑。
10. **工程細節照樣用訊息**討論：PR、測試、介面都是。desk 只放跟 owner 有關的事和大家共用的狀態。
11. **owner 會直接對你說話**：她在頁面的「對話」可以挑一個 session 傳話（也能附圖）。你掛著的 `desk wait --session <你的id>`（主控是 `desk wait --all --as <你的id>`）會收到「[desk] owner 直接對你說」。
    - 把它當成她在你的視窗裡打的字，是她本人說的話。
    - 回答就直接寫在你的對話裡，不用再發任何東西：「對話」頁讀得到你的文字回覆，她會在那裡看到。
    - 回完照樣重新掛 `desk wait`；要她決定的事照樣用 `desk ask`。
12. **「對話」頁看得到你的文字回覆**（看不到指令和輸出，像金鑰的字串會被遮掉）。所以給 owner 的結論要寫成一段完整、好讀的回覆。提到報告檔時寫完整的絕對路徑：如果檔案在 `config.json` 的 `readRoots` 資料夾裡、副檔名是 .md 或 .txt，她點一下就能在頁面上打開。

## 從 md 檔搬過來

```bash
desk migrate --decisions decisions.md --board board.md --coordination coordination.md [--since MM-DD] [--force]
desk export --out <資料夾> --auto on    # 產生唯讀的 board.md、decisions.md、log.md，資料有變動就自動更新
desk freeze-md board.md decisions.md coordination.md   # 舊檔加上「歷史紀錄，不再更新」，內容不動
```
- 決定的「取代」關係，程式只會自動標成「部分」。確認過要完整取代的，寫進 `DESK_HOME/decision-overrides.json`，每次匯入都會套用。
- 搬完就只寫 desk，不要兩邊都寫。
