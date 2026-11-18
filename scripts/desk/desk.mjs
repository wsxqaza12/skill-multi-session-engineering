#!/usr/bin/env node
// desk: the owner's local decision page + a small CLI for sessions.
// No dependencies. Data lives in DESK_HOME (default: ~/.local/share/desk).
// Server binds 127.0.0.1 only; every request needs the token cookie; POSTs need a same-origin Origin.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.DESK_HOME || path.join(os.homedir(), '.local', 'share', 'desk');
const DIRS = ['asks', 'answers', 'board', 'decisions', 'deliveries', 'archive', 'board-removed', 'log', 'seen', 'images', 'messages'];
const DEFAULT_PORT = 7801;

// ---------- limits (counted in characters, not bytes) ----------
const LIMIT = {
  askTitle: 60, askContext: 2000, optionKey: 20, optionLabel: 30, optionNote: 80, options: 6, recommendText: 300,
  answerText: 2000, outcome: 300,
  boardTitle: 40, boardNow: 80, boardNext: 80, boardWaiting: 30, boardStatus: 10, owner: 20,
  decisionTitle: 60, decisionWords: 2000, decisionPoint: 140, decisionPoints: 3,
  nodeNow: 80, nodeName: 30, nodeTmux: 40,
  logText: 3000, logTopic: 30, messageText: 4000,
};
const len = (s) => [...String(s ?? '')].length;
class UsageError extends Error {}
function check(name, value, max, { required = false } = {}) {
  if (value == null || value === '') { if (required) throw new UsageError(`${name} 是必填`); return; }
  if (typeof value !== 'string') throw new UsageError(`${name} 必須是文字`);
  const n = len(value);
  if (n > max) throw new UsageError(`${name} 太長：${n} 字，上限 ${max} 字。看板和決定只寫重點；細節寫進日誌。`);
}
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
function checkId(name, id) { if (!ID_RE.test(String(id || ''))) throw new UsageError(`${name} 只能用英數字、. _ -，最多 80 字：${id}`); }

// ---------- storage ----------
function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  for (const d of DIRS) fs.mkdirSync(path.join(HOME, d), { recursive: true, mode: 0o700 });
}
function p(...parts) { return path.join(HOME, ...parts); }
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function listJson(dir) {
  let names = [];
  try { names = fs.readdirSync(p(dir)); } catch { return []; }
  return names.filter((n) => n.endsWith('.json')).map((n) => readJson(p(dir, n))).filter(Boolean);
}
function logEvent(event) {
  fs.appendFileSync(p('events.jsonl'), JSON.stringify({ at: nowIso(), ...event }) + '\n', { mode: 0o600 });
}
// ---------- work log (replaces coordination.md) ----------
function writeLog(entry) {
  const at = entry.at || nowIso();
  const e = { id: `l-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`, at, ...entry };
  fs.appendFileSync(p('log', `${at.slice(0, 7)}.jsonl`), JSON.stringify(e) + '\n', { mode: 0o600 });
  return e.id;
}
let logCache = { key: '', entries: [] };
function readAllLog() {
  let files = [];
  try { files = fs.readdirSync(p('log')).filter((f) => f.endsWith('.jsonl')).sort(); } catch { return []; }
  const key = files.map((f) => { const st = fs.statSync(p('log', f)); return `${f}:${st.size}:${st.mtimeMs}`; }).join('|');
  if (key === logCache.key) return logCache.entries;
  const entries = [];
  for (const f of files) {
    for (const line of fs.readFileSync(p('log', f), 'utf8').split('\n')) { if (!line) continue; try { entries.push(JSON.parse(line)); } catch {} }
  }
  entries.sort((a, b) => String(b.at).localeCompare(String(a.at)) || String(b.id).localeCompare(String(a.id)));
  logCache = { key, entries };
  return entries;
}
function queryLog({ q = '', from = '', day = '', before = '', limit = 50 } = {}) {
  const needle = String(q).trim().toLowerCase();
  const out = []; let more = false;
  for (const e of readAllLog()) {
    if (before) {
      const bar = before.lastIndexOf('|'); const bAt = bar >= 0 ? before.slice(0, bar) : before; const bId = bar >= 0 ? before.slice(bar + 1) : '';
      const at = String(e.at);
      if (at > bAt || (at === bAt && (!bId || String(e.id) >= bId))) continue;
    }
    if (from && e.from !== from) continue;
    if (day && !String(e.at).startsWith(day)) continue;
    if (needle && !(`${e.text} ${e.from} ${e.topic || ''}`.toLowerCase().includes(needle))) continue;
    if (out.length >= limit) { more = true; break; }
    out.push(e);
  }
  return { entries: out, more };
}
function nowIso() {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(off / 60)}:${pad(off % 60)}`;
}
function token() {
  const file = p('token');
  let t = null;
  try { t = fs.readFileSync(file, 'utf8').trim(); } catch {}
  if (!t || t.length < 32) {
    t = crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  }
  try { fs.chmodSync(file, 0o600); } catch {}
  return t;
}
function config() { return readJson(p('config.json'), {}) || {}; }
const OWNER = () => config().owner || 'owner';   // the person who answers (set in config.json)
const LEAD = () => config().lead || 'lead';      // the coordinator session id
function port() { return Number(process.env.DESK_PORT || config().port || DEFAULT_PORT); }
function org() { return readJson(p('org.json'), { lines: [], nodes: [] }) || { lines: [], nodes: [] }; }
function nodeById(id) { return org().nodes.find((n) => n.id === id); }
function labelOf(id) { const n = nodeById(id); return n ? (n.tmux || n.name || id) : id; }
// Serialize read-modify-write of org.json across processes (several sessions can start at once).
// Cross-process lock: a file created with O_EXCL; a lock older than 10 s is treated as stale.
function withLock(lock, fn, { waitMs = 2000, onBusy = null } = {}) {
  const deadline = Date.now() + waitMs; let fd = null;
  while (fd === null) {
    try { fd = fs.openSync(lock, 'wx'); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.unlinkSync(lock); } catch {}
      if (Date.now() > deadline) { if (onBusy) return onBusy(); throw new UsageError('正忙，稍後再試'); }
      const t = Date.now() + 25; while (Date.now() < t) { /* brief spin */ }
    }
  }
  try { return fn(); } finally { try { fs.closeSync(fd); fs.unlinkSync(lock); } catch {} }
}
function withOrgLock(fn) { return withLock(p('org.lock'), fn, { onBusy: () => { throw new UsageError('組織圖正忙，稍後再試'); } }); }
function touchSeen(id) {
  if (!id || !ID_RE.test(String(id))) return;
  try { fs.mkdirSync(p('seen'), { recursive: true }); fs.writeFileSync(p('seen', `${id}.json`), JSON.stringify({ at: nowIso() }) + '\n', { mode: 0o600 }); } catch {}
}
function readSeen() {
  const out = {};
  try { for (const f of fs.readdirSync(p('seen'))) if (f.endsWith('.json')) { const j = readJson(p('seen', f)); if (j && j.at) out[f.slice(0, -5)] = j.at; } } catch {}
  return out;
}

// ---------- arg parsing ----------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key, val;
      if (eq > 0) { key = a.slice(2, eq); val = a.slice(eq + 1); }
      else { key = a.slice(2); const nx = argv[i + 1]; if (nx === undefined || nx.startsWith('--')) val = true; else { val = nx; i++; } }
      if (out[key] === undefined) out[key] = val;
      else if (Array.isArray(out[key])) out[key].push(val);
      else out[key] = [out[key], val];
    } else out._.push(a);
  }
  return out;
}
const arr = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
function textArg(args, key) {
  const fileKey = `${key}-file`;
  if (args[fileKey]) return fs.readFileSync(String(args[fileKey]), 'utf8').replace(/\s+$/, '');
  const v = args[key];
  return v === undefined || v === true ? undefined : String(v);
}

function idList(name, v) {
  const ids = arr(v).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
  ids.forEach((x) => checkId(name, x));
  return Array.from(new Set(ids));
}
// ---------- asks ----------
function newAskId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `a-${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}
function parseOptions(args) {
  return arr(args.option).map((raw) => {
    const s = String(raw);
    const eq = s.indexOf('=');
    if (eq <= 0) throw new UsageError(`--option 格式是 key=標籤 或 key=標籤|說明：${s}`);
    const key = s.slice(0, eq); const rest = s.slice(eq + 1);
    const bar = rest.indexOf('|');
    const label = bar >= 0 ? rest.slice(0, bar) : rest; const note = bar >= 0 ? rest.slice(bar + 1) : undefined;
    checkId('option key', key); check('option key', key, LIMIT.optionKey);
    check('option 標籤', label, LIMIT.optionLabel, { required: true }); check('option 說明', note, LIMIT.optionNote);
    return note ? { key, label, note } : { key, label };
  });
}
function cmdAskUpdate(args) {
  const id = String(args.update); checkId('--update', id);
  const file = p('asks', `${id}.json`); const ask = readJson(file);
  if (!ask) throw new UsageError(`找不到 ${id}`);
  if (ask.status !== 'open') throw new UsageError(`${id} 已經${ask.status === 'withdrawn' ? '撤回' : '處理完'}了，不能再改`);
  if (fs.existsSync(p('answers', `${id}.json`))) throw new UsageError(`${OWNER()} 已經回覆 ${id} 了；內容要變就 desk withdraw 後重問`);
  const changed = [];
  const title = textArg(args, 'title'); if (title !== undefined) { check('--title', title, LIMIT.askTitle, { required: true }); ask.title = title; changed.push('標題'); }
  const context = textArg(args, 'context'); if (context !== undefined) { check('--context', context, LIMIT.askContext); ask.context = context; changed.push('背景'); }
  if (args.option !== undefined) { const o = parseOptions(args); if (o.length > LIMIT.options) throw new UsageError(`選項最多 ${LIMIT.options} 個`); ask.options = o; changed.push('選項'); }
  if (args.recommend !== undefined) { ask.recommend = String(args.recommend); changed.push('建議'); }
  if (ask.recommend && !ask.options.some((o) => o.key === ask.recommend)) throw new UsageError(`--recommend ${ask.recommend} 不在選項裡`);
  const why = textArg(args, 'why'); if (why !== undefined) { check('--why', why, LIMIT.recommendText); ask.recommendText = why; changed.push('建議理由'); }
  if (args.notify !== undefined) { const n = idList('--notify', args.notify).filter((x) => x !== ask.from); if (n.length) ask.notify = n; else delete ask.notify; changed.push('通知對象'); }
  if (args.kind !== undefined) { ask.kind = args.kind === 'act' ? 'act' : 'decide'; changed.push('類型'); }
  if (args.approval !== undefined) { ask.approval = args.approval !== 'false'; changed.push('正式核准'); }
  if (!changed.length) throw new UsageError('沒有要改的欄位');
  ask.updatedAt = nowIso();
  writeJson(file, ask); logEvent({ type: 'ask-updated', askId: id, fields: changed });
  writeLog({ from: ask.from, kind: 'ask', text: `改了問題（${id}）${ask.title}：${changed.join('、')}` });
  console.log(`updated ${id}: ${changed.join('、')}`);
}
function cmdWithdraw(args) {
  const id = String(args._[1] || ''); checkId('ask id', id);
  const reason = textArg(args, 'reason'); check('--reason', reason, LIMIT.outcome, { required: true });
  const file = p('asks', `${id}.json`); const ask = readJson(file);
  if (!ask) throw new UsageError(`找不到 ${id}`);
  if (ask.status !== 'open') throw new UsageError(`${id} 已經不是待回覆的狀態`);
  ask.status = 'withdrawn'; ask.outcome = reason; ask.closedAt = nowIso();
  writeJson(file, ask); logEvent({ type: 'withdrawn', askId: id });
  writeLog({ from: ask.from, kind: 'ask', text: `撤回（${id}）${ask.title}：${reason}` });
  console.log(`withdrawn ${id}`);
}
function cmdAsk(args) {
  if (args.update !== undefined) return cmdAskUpdate(args);
  const from = String(args.from || ''); checkId('--from', from);
  const title = textArg(args, 'title'); check('--title', title, LIMIT.askTitle, { required: true });
  const context = textArg(args, 'context'); check('--context', context, LIMIT.askContext);
  const kind = args.kind === 'act' ? 'act' : 'decide';
  const options = parseOptions(args);
  if (options.length > LIMIT.options) throw new UsageError(`選項最多 ${LIMIT.options} 個`);
  const recommend = args.recommend === undefined ? undefined : String(args.recommend);
  if (recommend && !options.some((o) => o.key === recommend)) throw new UsageError(`--recommend ${recommend} 不在選項裡`);
  const recommendText = textArg(args, 'why'); check('--why', recommendText, LIMIT.recommendText);
  const notify = idList('--notify', args.notify).filter((x) => x !== from);
  const id = args.id ? String(args.id) : newAskId(); checkId('--id', id);
  ensureHome();
  if (fs.existsSync(p('asks', `${id}.json`))) throw new UsageError(`已經有 ${id} 這題了`);
  const ask = { id, from, title, kind, approval: Boolean(args.approval), context: context || '', options, recommend: recommend || null,
    recommendText: recommendText || '', ...(notify.length ? { notify } : {}), status: 'open', createdAt: nowIso() };
  writeJson(p('asks', `${id}.json`), ask);
  logEvent({ type: 'asked', askId: id, from });
  touchSeen(from);
  writeLog({ from, kind: 'ask', text: `問 ${OWNER()}（${id}）：${title}${notify.length ? `\n回覆也送給：${notify.join('、')}` : ''}` });
  console.log(id);
}
function cmdNotify(args) {
  const id = String(args._[1] || ''); checkId('ask id', id);
  const file = p('asks', `${id}.json`); const ask = readJson(file);
  if (!ask) throw new UsageError(`找不到 ${id}`);
  const add = idList('--add', args.add); const rm = new Set(idList('--remove', args.remove));
  ask.notify = Array.from(new Set([...(ask.notify || []), ...add])).filter((x) => !rm.has(x) && x !== ask.from);
  if (!ask.notify.length) delete ask.notify;
  writeJson(file, ask); logEvent({ type: 'notify', askId: id, notify: ask.notify || [] });
  console.log(`${id} notify: ${(ask.notify || []).join(',') || '-'}`);
}
function cmdClose(args) {
  const id = String(args._[1] || ''); checkId('ask id', id);
  const outcome = textArg(args, 'outcome'); check('--outcome', outcome, LIMIT.outcome, { required: true });
  const file = p('asks', `${id}.json`); const ask = readJson(file);
  if (!ask) throw new UsageError(`找不到 ${id}`);
  ask.status = 'closed'; ask.outcome = outcome; ask.closedAt = nowIso();
  writeJson(file, ask); logEvent({ type: 'closed', askId: id });
  writeLog({ from: ask.from, kind: 'ask', text: `已處理（${id}）${ask.title}：${outcome}` });
  console.log(`closed ${id}`);
}
function cmdList(args) {
  ensureHome();
  const asks = listJson('asks').filter((a) => (!args.open || a.status !== 'closed') && (!args.from || a.from === args.from))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const answers = Object.fromEntries(listJson('answers').map((a) => [a.askId, a]));
  for (const a of asks) {
    const ans = answers[a.id];
    const st = a.status === 'withdrawn' ? '已撤回' : a.status === 'closed' ? '已處理' : ans ? '已回覆' : '等回覆';
    console.log(`${a.id}\t${st}\t${a.from} ${labelOf(a.from)}${a.notify ? `（也送給 ${a.notify.join('、')}）` : ''}\t${a.title}`);
  }
}

// ---------- answers + delivery ----------
function deliveries(consumer) { return readJson(p('deliveries', `${consumer}.json`), {}) || {}; }
function pendingFor(consumer, { all = false, session = null, askId = null } = {}) {
  const asks = Object.fromEntries(listJson('asks').map((a) => [a.id, a]));
  const got = deliveries(consumer);
  const mine = (a) => a.from === session || (a.notify || []).includes(session);
  return listJson('answers')
    .filter((ans) => asks[ans.askId] && (askId ? ans.askId === askId : (all || mine(asks[ans.askId]))))
    .filter((ans) => (got[ans.askId] || 0) < (ans.rev || 1))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .map((ans) => ({ ans, ask: asks[ans.askId] }));
}
function formatDelivery({ ans, ask }, consumer) {
  const lines = [
    `[desk] ${OWNER()} 回覆了 ${ask.id}（${labelOf(ask.from)} 問的：${ask.title}）${(ans.rev || 1) > 1 ? `——這是第 ${ans.rev} 版，取代先前的回覆` : ''}`,
  ];
  if (consumer && consumer !== ask.from && (ask.notify || []).includes(consumer)) lines.push(`你被列為要知道這個回覆的人（提問的是 ${labelOf(ask.from)}；處理完由提問的人 close）。`);
  if (ans.choiceLabel || ans.choice) lines.push(`選擇：${ans.choiceLabel || ans.choice}（${ans.choice}）`);
  if (ans.text) lines.push(`補充：${ans.text}`);
  const imgs = (ans.images || []).filter((x) => IMG_ID_RE.test(x));
  if (imgs.length) lines.push(`附圖 ${imgs.length} 張（用 Read 工具打開看）：`, ...imgs.map((x) => `  ${p('images', x)}`));
  lines.push(`時間：${ans.at}`);
  lines.push(`來源：desk 頁面上 owner 本人的回覆。處理完用 desk close ${ask.id} --outcome "…" 標成已處理。`);
  return lines.join('\n');
}
// Direct messages the owner sends from the page to one session.
function pendingMessages(consumer) {
  const got = deliveries(consumer);
  return listJson('messages').filter((m) => m.to === consumer && !got[`msg:${m.id}`]).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
function formatMessage(m) {
  const lines = [`[desk] ${OWNER()} 直接對你說（從 desk 頁面傳來，等同她在你的視窗裡打字）：`, m.text || '（只傳了圖）'];
  const imgs = (m.images || []).filter((x) => IMG_ID_RE.test(x));
  if (imgs.length) lines.push(`附圖 ${imgs.length} 張（用 Read 工具打開看）：`, ...imgs.map((x) => `  ${p('images', x)}`));
  lines.push(`時間：${m.at}（訊息編號 ${m.id}；同一個編號收過就不用再處理）`);
  lines.push(`怎麼回：直接在你的對話裡回答，她會在 desk 的「對話」頁看到你的回覆；要她決定的事照樣用 desk ask。回完記得重新掛 desk wait。`);
  return lines.join('\n');
}
function markMessagesDelivered(consumer, msgs) {
  if (!msgs.length) return;
  const got = deliveries(consumer);
  for (const m of msgs) { got[`msg:${m.id}`] = new Date().toISOString(); logEvent({ type: 'message-delivered', id: m.id, consumer }); }
  writeJson(p('deliveries', `${consumer}.json`), got);
}
function markDelivered(consumer, items, { asker }) {
  if (!items.length) return;
  const got = deliveries(consumer);
  for (const { ans, ask } of items) {
    got[ans.askId] = ans.rev || 1;
    logEvent({ type: 'delivered', askId: ans.askId, rev: ans.rev || 1, consumer, toAsker: asker ? ask.from === consumer : false, toRecipient: asker ? (ask.from === consumer || (ask.notify || []).includes(consumer)) : false });
  }
  writeJson(p('deliveries', `${consumer}.json`), got);
}
function writeAll(text) {
  const buf = Buffer.from(text); let off = 0;
  while (off < buf.length) {
    try { off += fs.writeSync(1, buf, off); }
    catch (e) { if (e.code !== 'EAGAIN') throw e; const t = Date.now() + 10; while (Date.now() < t) { /* stdout is full; retry */ } }
  }
}
async function cmdWait(args) {
  ensureHome();
  const all = Boolean(args.all);
  const session = args.session ? String(args.session) : null;
  const askId = args.ask ? String(args.ask) : null;
  if (askId) { checkId('--ask', askId); if (!readJson(p('asks', `${askId}.json`))) throw new UsageError(`找不到 ${askId}`); }
  if (!all && !session && !askId) throw new UsageError('desk wait 需要 --session <你的 id>（例如 api）、--ask <題目 id>，或 --all --as <名稱>');
  const consumer = all ? String(args.as || `${LEAD()}-log`) : (session || `w-${askId}`); checkId('consumer', consumer);
  touchSeen(session || (all ? String(args.as || '') : ''));
  bindSession(session || (all ? String(args.as || '') : ''));
  const timeoutMs = args.timeout ? Number(args.timeout) * 1000 : 0;
  const peek = Boolean(args.peek);
  const deadline = timeoutMs ? Date.now() + timeoutMs : Infinity;
  // Print, then record, under a per-consumer lock: two waiters for one consumer never both print an item, and an
  // interrupted waiter can at worst repeat one (each carries a stable id), never lose it.
  const tryOnce = () => withLock(p('deliveries', `${consumer}.lock`), () => {
    const items = pendingFor(consumer, { all, session, askId });
    const msgs = askId ? [] : pendingMessages(consumer);
    if (!items.length && !msgs.length) return false;
    writeAll([...msgs.map(formatMessage), ...items.map((it) => formatDelivery(it, consumer))].join('\n\n') + '\n'); // throws on a closed pipe: nothing recorded
    if (!peek) { markDelivered(consumer, items, { asker: !all && !askId ? true : Boolean(session) }); markMessagesDelivered(consumer, msgs); }
    return true;
  }, { onBusy: () => false });
  if (tryOnce()) return 0;
  if (peek && !timeoutMs) { console.log('（沒有新的回覆）'); return 0; }
  return await new Promise((resolve) => {
    let done = false; let watcher = null; let timer = null;
    const finish = (code) => { if (done) return; done = true; try { watcher?.close(); } catch {} clearInterval(timer); resolve(code); };
    const poke = () => { if (done) return; if (tryOnce()) finish(0); else if (Date.now() > deadline) finish(3); };
    try { watcher = fs.watch(p('answers'), () => setTimeout(poke, 150)); } catch {}
    try { const w2 = fs.watch(p('messages'), () => setTimeout(poke, 150)); const w1 = watcher; watcher = { close: () => { try { w1?.close(); } catch {} w2.close(); } }; } catch {}
    timer = setInterval(poke, 2000);
  });
}

// ---------- board ----------
function cmdBoard(args) {
  ensureHome();
  const sub = args._[1];
  if (sub === 'list' || !sub) {
    for (const c of listJson('board').sort((a, b) => String(a.owner).localeCompare(String(b.owner)))) {
      console.log(`${c.id}\t${labelOf(c.owner)}\t${c.status || ''}\t${c.title}\t現在：${c.now || ''}${c.next ? `\t下一步：${c.next}` : ''}${c.waitingOn ? `\t等：${c.waitingOn}` : ''}${c.waitsOn ? `\t等回覆：${c.waitsOn.join(',')}` : ''}`);
    }
    return;
  }
  const id = String(args._[2] || ''); checkId('card id', id);
  const file = p('board', `${id}.json`);
  if (sub === 'rm') {
    const old = readJson(file); if (!old) throw new UsageError(`找不到看板卡 ${id}`);
    writeJson(p('board-removed', `${id}.${Date.now()}.json`), old); fs.unlinkSync(file);
    logEvent({ type: 'board-removed', id, card: old }); console.log(`removed ${id}`); return;
  }
  if (sub !== 'set') throw new UsageError('desk board list | set <id> ... | rm <id>');
  const old = readJson(file) || {};
  const card = { ...old, id };
  const fields = { owner: ['--owner', LIMIT.owner], title: ['--title', LIMIT.boardTitle], now: ['--now', LIMIT.boardNow],
    next: ['--next', LIMIT.boardNext], waitingOn: ['--waiting', LIMIT.boardWaiting], status: ['--status', LIMIT.boardStatus] };
  for (const [k, [flag, max]] of Object.entries(fields)) {
    const v = textArg(args, flag.slice(2)); if (v === undefined) continue;
    check(flag, v, max); card[k] = v;
  }
  if (args['clear-waiting']) delete card.waitingOn;
  if (args['waits-on'] !== undefined) {
    const ids = args['waits-on'] === true ? [] : idList('--waits-on', args['waits-on']);
    for (const a of ids) if (!fs.existsSync(p('asks', `${a}.json`))) throw new UsageError(`--waits-on：找不到題目 ${a}`);
    if (ids.length) card.waitsOn = ids; else delete card.waitsOn;
  }
  if (!card.owner) throw new UsageError('--owner 是必填（例如 api）');
  if (!card.title) throw new UsageError('--title 是必填');
  if (!card.now) throw new UsageError('--now 是必填（一行：現在在做什麼）');
  delete card.migrated;
  card.updatedAt = nowIso();
  writeJson(file, card);
  logEvent({ type: 'board-set', id, before: old.id ? { now: old.now, next: old.next, status: old.status, waitingOn: old.waitingOn } : null });
  const changes = [];
  if (JSON.stringify(old.waitsOn || []) !== JSON.stringify(card.waitsOn || [])) changes.push(`等 ${OWNER()} 回覆：${(card.waitsOn || []).join('、') || '（無）'}`);
  for (const [k, name] of [['status', '狀態'], ['now', '現在'], ['next', '下一步'], ['waitingOn', '等']]) {
    if ((old[k] || '') !== (card[k] || '')) changes.push(old.id ? `${name}：${old[k] || '（空）'} → ${card[k] || '（空）'}` : `${name}：${card[k] || '（空）'}`);
  }
  const by = args.by ? String(args.by) : card.owner; checkId('--by', by); touchSeen(by);
  if (changes.length) writeLog({ from: by, kind: 'board', topic: id, text: `看板「${card.title}」${old.id ? '' : '（新卡）'}${by !== card.owner ? `（${by} 代 ${card.owner} 更新）` : ''}\n${changes.join('\n')}` });
  console.log(`set ${id}`);
}

// ---------- decisions ----------
function decisionFile(id) { return p('decisions', `${id}.json`); }
function cmdDecide(args) {
  ensureHome();
  const id = String(args._[1] || ''); if (!/^D-\d{2,4}$/.test(id)) throw new UsageError('決定編號要像 D-12');
  if (fs.existsSync(decisionFile(id))) throw new UsageError(`${id} 已經存在；要改就用 desk decision supersede`);
  const title = textArg(args, 'title'); check('--title', title, LIMIT.decisionTitle, { required: true });
  const words = textArg(args, 'words'); check('--words', words, LIMIT.decisionWords, { required: true });
  const points = arr(args.point).map(String);
  if (points.length > LIMIT.decisionPoints) throw new UsageError(`重點最多 ${LIMIT.decisionPoints} 點`);
  points.forEach((x, i) => check(`--point ${i + 1}`, x, LIMIT.decisionPoint));
  const where = textArg(args, 'where'); check('--where', where, 60);
  const card = { id, num: Number(id.slice(2)), date: textArg(args, 'date') || nowIso().slice(0, 16).replace('T', ' '), where: where || '',
    title, words, points, status: 'active', createdAt: nowIso() };
  writeJson(decisionFile(id), card);
  for (const old of arr(args.supersedes)) supersede(String(old), id, false);
  for (const old of arr(args['partly-supersedes'])) supersede(String(old), id, true);
  logEvent({ type: 'decided', id });
  writeLog({ from: LEAD(), kind: 'decision', topic: id, text: `記下 ${id}：${title}` });
  console.log(`decided ${id}`);
}
function supersede(oldId, byId, partial) {
  const f = decisionFile(oldId); const old = readJson(f);
  if (!old) throw new UsageError(`找不到 ${oldId}`);
  if (partial) { old.partlyBy = Array.from(new Set([...(old.partlyBy || []), byId])); }
  else { old.status = 'superseded'; old.supersededBy = byId; }
  writeJson(f, old); logEvent({ type: partial ? 'partly-superseded' : 'superseded', id: oldId, by: byId });
}
function cmdDecision(args) {
  ensureHome();
  const sub = args._[1];
  if (sub === 'supersede') { supersede(String(args._[2]), String(args.by), Boolean(args.partial)); console.log('ok'); return; }
  if (sub === 'reactivate') {
    const f = decisionFile(String(args._[2])); const d = readJson(f); if (!d) throw new UsageError('找不到');
    d.status = 'active'; delete d.supersededBy; writeJson(f, d); logEvent({ type: 'reactivated', id: d.id }); console.log('ok'); return;
  }
  if (sub === 'list' || !sub) {
    for (const d of listJson('decisions').sort((a, b) => b.num - a.num)) console.log(`${d.id}\t${d.status}${d.supersededBy ? `→${d.supersededBy}` : ''}\t${d.date}\t${d.title}`);
    return;
  }
  throw new UsageError('desk decision list | supersede <D-x> --by <D-y> [--partial] | reactivate <D-x>');
}

function cmdLog(args) {
  ensureHome();
  const sub = args._[1];
  if (sub === 'list') {
    const r = queryLog({ q: args.q || '', from: args.from || '', day: args.day || '', limit: Number(args.limit || 30) });
    for (const e of r.entries.slice().reverse()) console.log(`${e.at.slice(5, 16).replace('T', ' ')}\t${e.from}\t${e.kind || 'note'}\t${String(e.text).split('\n')[0].slice(0, 160)}`);
    if (r.more) console.log('（還有更早的，加 --limit 或 --q 篩選）');
    return;
  }
  const from = String(args.from || ''); checkId('--from', from);
  let text = textArg(args, 'text');
  if (args.stdin) text = fs.readFileSync(0, 'utf8').replace(/\s+$/, '');
  check('日誌內容', text, LIMIT.logText, { required: true });
  const topic = args.topic === undefined ? undefined : String(args.topic); check('--topic', topic, LIMIT.logTopic);
  touchSeen(from);
  const id = writeLog({ from, kind: 'note', ...(topic ? { topic } : {}), text });
  console.log(id);
}

// ---------- org ----------
// The org chart as text: who reports to whom. Every session gets it (and its own place) at start.
function treeText() {
  const o = org(); const kids = {};
  for (const n of o.nodes) (kids[n.parent || ''] = kids[n.parent || ''] || []).push(n);
  const root = o.nodes.find((n) => n.line === 'root');
  const out = [`${OWNER()}（owner）`];
  const walk = (pid, pre) => { const list = (kids[pid] || []).filter((n) => n !== root); list.forEach((n, i) => { const last = i === list.length - 1; out.push(`${pre}${last ? '└─ ' : '├─ '}${n.tmux || n.id}［${n.id}］${n.name || ''}${n.note ? `｜${n.note}` : ''}`); walk(n.id, pre + (last ? '   ' : '│  ')); }); };
  walk(root ? root.id : '', '');
  const loose = o.nodes.filter((n) => n !== root && (root ? !n.parent : false));
  if (loose.length) out.push(`還沒放進樹的：${loose.map((n) => n.tmux || n.id).join('、')}`);
  return out.join('\n');
}
function placeText(id, { tree = true } = {}) {
  const o = org(); const n = o.nodes.find((x) => x.id === id); if (!n) return '';
  const nm = (x) => { const m = o.nodes.find((y) => y.id === x); return !m || m.line === 'root' ? OWNER() : `${m.tmux || m.id}［${m.id}］`; };
  const lines = [`desk 組織圖：你是 ${n.tmux || n.id}［${n.id}］${n.name ? `（${n.name}）` : ''}，向 ${n.parent ? nm(n.parent) : OWNER()} 報告。`];
  const kids = o.nodes.filter((x) => x.parent === id).map((x) => nm(x.id));
  if (kids.length) lines.push(`你帶：${kids.join('、')}。`);
  if (n.note) lines.push(`你的備註：${n.note}`);
  if (tree) lines.push('整張組織圖：', treeText());
  const rules = (Array.isArray(config().rules) ? config().rules : []).map(String).filter(Boolean);
  if (rules.length) { lines.push(`聯絡規則（${OWNER()} 核准）：`); rules.forEach((r, i) => lines.push(`${i + 1}. ${r}`)); }
  return lines.join('\n');
}
function cmdOrg(args) {
  ensureHome();
  const sub = args._[1];
  const o = org();
  if (sub === 'show' || !sub) { console.log(JSON.stringify(o, null, 2)); return; }
  if (sub === 'tree') { console.log(treeText()); return; }
  if (sub === 'me') { const id = String(args.id || args._[2] || ''); checkId('id', id); if (!nodeById(id)) throw new UsageError(`組織圖上沒有 ${id}`); console.log(placeText(id)); return; }
  if (sub === 'node') return withOrgLock(() => cmdOrgNode(args));
  if (sub === 'rm') return withOrgLock(() => { const o2 = org(); o2.nodes = o2.nodes.filter((x) => x.id !== args._[2]); o2.updatedAt = nowIso(); writeJson(p('org.json'), o2); console.log('ok'); });
  if (sub === 'load') { const v = JSON.parse(fs.readFileSync(String(args._[2]), 'utf8')); v.updatedAt = nowIso(); withOrgLock(() => writeJson(p('org.json'), v)); console.log('ok'); return; }
  throw new UsageError('desk org show | tree | me <id> | node <id> [--now … --parent … --note …] | rm <id> | load <file.json>');
}
function cmdOrgNode(args) {
  const o = org();
  {
    const id = String(args._[2] || ''); checkId('node id', id);
    const n = o.nodes.find((x) => x.id === id) || { id };
    for (const [k, flag, max] of [['now', 'now', LIMIT.nodeNow], ['name', 'name', LIMIT.nodeName], ['tmux', 'tmux', LIMIT.nodeTmux], ['line', 'line', 20], ['parent', 'parent', 20], ['group', 'group', 20], ['where', 'where', 40], ['note', 'note', 80]]) {
      const v = textArg(args, flag); if (v === undefined) continue; check(`--${flag}`, v, max); n[k] = v;
    }
    if (args.lead !== undefined) n.lead = args.lead === true || args.lead === 'true';
    if (n.tmux) {
      const norm = (x) => String(x || '').replace(/\s+/g, '');
      const clash = o.nodes.find((x) => x !== n && x.id !== id && norm(x.tmux) === norm(n.tmux));
      if (clash && !args.force) throw new UsageError(`tmux 標籤 ${n.tmux} 已經是 ${clash.id}（${clash.name || ''}）在用；請確認自己的視窗名稱：tmux display-message -p -t "$TMUX_PANE" '#S「#W」'（一定要加 -t "$TMUX_PANE"，不然會拿到別的視窗），或加 --force`);
      const running = discoverSessions();
      if (running.length && !running.some((r) => norm(r.tmux) === norm(n.tmux))) console.error(`注意：現在沒有找到正在跑的 ${n.tmux}；請確認視窗名稱`);
    }
    if (!o.nodes.includes(n)) o.nodes.push(n);
    if (n.unregistered && n.name) delete n.unregistered;
    o.updatedAt = nowIso(); writeJson(p('org.json'), o); logEvent({ type: 'org-node', id }); touchSeen(id); console.log(`node ${id}`); return;
  }
}

// ---------- server ----------
function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function cookieToken(req) {
  const m = /(?:^|;\s*)desk_token=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
// Find tmux windows (in the configured tmux sessions) that run Claude Code or Codex, so the org chart can show who is missing.
let discoverCache = { at: 0, list: [] };
function discoverSessions() {
  const want = config().discover;
  if (!Array.isArray(want) || !want.length) return [];
  if (Date.now() - discoverCache.at < 60000) return discoverCache.list;
  const list = [];
  try {
    const panes = execFileSync('tmux', ['list-panes', '-a', '-F', '#{session_name}\t#{window_name}\t#{pane_pid}\t#{window_index}'], { encoding: 'utf8', timeout: 5000 }).trim().split('\n');
    const ps = execFileSync('ps', ['-e', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n');
    const kids = new Map(); const comm = new Map();
    for (const line of ps) { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line); if (!m) continue; comm.set(m[1], m[3].trim()); if (!kids.has(m[2])) kids.set(m[2], []); kids.get(m[2]).push(m[1]); }
    const agentUnder = (pid, depth = 0) => { for (const k of kids.get(pid) || []) { const c = comm.get(k); if (c === 'claude' || c === 'codex') return { c, pid: k }; if (depth < 4) { const r = agentUnder(k, depth + 1); if (r) return r; } } return null; };
    const seen = new Set();
    for (const row of panes) {
      const [sess, win, pid, idx] = row.split('\t');
      if (!want.includes(sess)) continue;
      const label = `${sess}「${win.trim()}」`;
      const agent = agentUnder(pid);
      if (!agent) continue;
      if (seen.has(label)) { const prev = list.find((x) => x.tmux === label); if (prev) prev.ambiguous = true; continue; }
      seen.add(label); list.push({ tmux: label, session: sess, window: win.trim(), index: Number(idx), agent: agent.c, pid: agent.pid });
    }
  } catch {}
  discoverCache = { at: Date.now(), list };
  return list;
}
// Remember which Claude Code session (transcript) a desk id belongs to. Run by the session itself.
// True when the caller's tmux window runs more than one Claude/Codex agent: its label then names no single session.
function windowIsShared() {
  if (!process.env.TMUX_PANE) return false;
  try {
    const pids = execFileSync('tmux', ['list-panes', '-t', process.env.TMUX_PANE, '-F', '#{pane_pid}'], { encoding: 'utf8', timeout: 800 }).trim().split('\n').filter(Boolean);
    if (pids.length < 2) return false;
    const rows = execFileSync('ps', ['-e', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 800 }).trim().split('\n');
    const kids = new Map(); const comm = new Map();
    for (const line of rows) { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line); if (!m) continue; comm.set(m[1], m[3].trim()); if (!kids.has(m[2])) kids.set(m[2], []); kids.get(m[2]).push(m[1]); }
    const hasAgent = (pid, d = 0) => (kids.get(pid) || []).some((k) => comm.get(k) === 'claude' || comm.get(k) === 'codex' || (d < 4 && hasAgent(k, d + 1)));
    return pids.filter((x) => comm.get(x) === 'claude' || comm.get(x) === 'codex' || hasAgent(x)).length > 1;
  } catch { return false; }
}
function callerPaneLabel() {
  if (!process.env.TMUX_PANE) return null;
  try { return execFileSync('tmux', ['display-message', '-p', '-t', process.env.TMUX_PANE, '#S「#W」'], { encoding: 'utf8', timeout: 800 }).trim() || null; } catch { return null; }
}
// Remember which Claude Code session (transcript) a desk id belongs to — only when the caller provably is that node:
// its own tmux pane carries the node's label, or the node has no tmux label at all.
function bindSession(id) {
  const sid = String(process.env.CLAUDE_CODE_SESSION_ID || '');
  if (!id || !SID_RE.test(sid)) return;
  const norm = (x) => String(x || '').replace(/\s+/g, '');
  try {
    const here = callerPaneLabel(); const shared = windowIsShared();
    withOrgLock(() => {
      const o = org(); const n = o.nodes.find((x) => x.id === id); if (!n || (n.sessionIds || [])[0] === sid) return;
      if (n.tmux) {
        if (!here || shared || norm(here) !== norm(n.tmux)) return;
        if (discoverSessions().some((d) => d.ambiguous && norm(d.tmux) === norm(n.tmux))) return;
      }
      n.sessionIds = [sid, ...(n.sessionIds || []).filter((x) => x !== sid)].slice(0, 5);
      o.updatedAt = nowIso(); writeJson(p('org.json'), o);
    });
  } catch {}
}

// ---------- conversations: read-only view of Claude Code transcripts ----------
const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const projectsDir = () => String(config().transcriptsDir || path.join(os.homedir(), '.claude', 'projects'));
const sessionsDir = () => path.join(os.homedir(), '.claude', 'sessions');
let projDirs = { at: 0, list: [] };
const transcriptBySid = new Map();
function findTranscript(sid) {
  const hit = transcriptBySid.get(sid); if (hit && fs.existsSync(hit) && canon(hit).startsWith(canon(projectsDir()) + path.sep)) return hit;
  if (hit) transcriptBySid.delete(sid);
  if (Date.now() - projDirs.at > 60000 || projDirs.root !== projectsDir()) { try { projDirs = { at: Date.now(), root: projectsDir(), list: fs.readdirSync(projectsDir()) }; } catch { projDirs = { at: Date.now(), root: projectsDir(), list: [] }; } }
  for (const d of projDirs.list) { const f = path.join(projectsDir(), d, `${sid}.jsonl`); if (fs.existsSync(f)) { transcriptBySid.set(sid, f); return f; } }
  return null;
}
function transcriptFor(n) {
  // Self-reported ids first (desk register / desk wait record them); the tmux pane's process is only a fallback,
  // because an attached client pane can belong to another session.
  const ids = (n.sessionIds || []).filter((x) => SID_RE.test(x)); const norm = (x) => String(x || '').replace(/\s+/g, '');
  const pane = n.tmux ? discoverSessions().find((d) => d.agent === 'claude' && !d.ambiguous && norm(d.tmux) === norm(n.tmux)) : null;
  if (pane && /^\d+$/.test(String(pane.pid))) { const j = readJson(path.join(sessionsDir(), `${pane.pid}.json`)); if (j && SID_RE.test(String(j.sessionId || '')) && !ids.includes(String(j.sessionId))) ids.push(String(j.sessionId)); }
  for (const sid of ids) { const f = findTranscript(sid); if (f) return f; }
  return null;
}
const SECRET_RES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g, /\bgh[pousr]_[A-Za-z0-9]{20,}/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g, /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, /\bAIza[0-9A-Za-z_-]{30,}/g,
];
let REDACT_EXACT = [];
const extraRedact = () => (Array.isArray(config().redact) ? config().redact.map(String).filter((x) => x && x.length <= 200) : []); // project token formats // secrets this process knows exactly (the desk token)
function redact(s) {
  let t = String(s);
  for (const x of REDACT_EXACT) if (x && x.length >= 16) t = t.split(x).join('［已遮蔽］');
  for (const re of SECRET_RES) t = t.replace(re, '［已遮蔽］');
  for (const src of extraRedact()) { try { t = t.replace(new RegExp(src, 'g'), '［已遮蔽］'); } catch {} }
  return t
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+\/=-]{12,}/gi, '$1［已遮蔽］')
    .replace(/\b(authorization\s*[:=]\s*)(?!bearer\b)[^\s'"]{12,}/gi, '$1［已遮蔽］')
    .replace(/\b(desk_token=)[^;\s'"]+/gi, '$1［已遮蔽］')
    .replace(/([?&](?:t|token|key|access_token|api_key)=)[A-Za-z0-9._-]{12,}/gi, '$1［已遮蔽］')
    .replace(/\b((?:api[_-]?key|secret|password|passwd|token)["']?\s*[:=]\s*["']?)[A-Za-z0-9._\/+=-]{12,}/gi, '$1［已遮蔽］');
}
// Open a file and prove the opened descriptor is a regular file inside one of `roots` (canonical paths).
// Returns { fd, real, st } (caller closes fd), { tooLarge: true }, or null.
const canon = (x) => { try { return fs.realpathSync(x); } catch { return path.resolve(x); } };
function rootsFrom(list) {
  return (Array.isArray(list) ? list : []).map(String).map((r) => {
    if (r.endsWith('/*')) return { prefix: false, path: canon(r.slice(0, -2)) };
    if (r.endsWith('*')) { const base = r.slice(0, -1); return { prefix: true, path: path.join(canon(path.dirname(base)), path.basename(base)) }; }
    return { prefix: false, path: canon(r.replace(/\/+$/, '')) };
  });
}
function openContained(file, roots, { exts = null, maxBytes = Infinity, noFollow = false, deny = [] } = {}) {
  let fd = null;
  try {
    if (!(noFollow ? fs.lstatSync(file) : fs.statSync(file)).isFile()) throw new Error('not a file');
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (noFollow ? fs.constants.O_NOFOLLOW : 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error('not a file');
    const real = fs.realpathSync(file); const st2 = fs.statSync(real);
    if (st2.ino !== st.ino || st2.dev !== st.dev) throw new Error('changed under us');
    if (exts && !exts.some((x) => real.toLowerCase().endsWith(x))) throw new Error('type');
    if (deny.some((d) => real === d || real.startsWith(d + path.sep))) throw new Error('denied');
    if (!roots.some((r) => (r.prefix ? real.startsWith(r.path) : real.startsWith(r.path + path.sep)))) throw new Error('outside');
    if (st.size > maxBytes) { fs.closeSync(fd); return { tooLarge: true }; }
    return { fd, real, st };
  } catch { if (fd !== null) { try { fs.closeSync(fd); } catch {} } return null; }
}
function readFd(fd, size) { const buf = Buffer.alloc(size); let off = 0; while (off < size) { const n = fs.readSync(fd, buf, off, size - off, off); if (!n) break; off += n; } return buf.subarray(0, off); }
// One transcript line → null, or { kind: 'you' | 'trigger' | 'reply', at, text, images, label }.
function convoEntry(d) {
  if (!d || d.isSidechain || d.isMeta || d.isCompactSummary || d.isApiErrorMessage) return null;
  const at = String(d.timestamp || '');
  if (d.type === 'assistant') {
    const blocks = Array.isArray(d.message?.content) ? d.message.content : [];
    const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n').trim();
    return text ? { kind: 'reply', at, text: clip(redact(text), 60000) } : null;
  }
  if (d.type !== 'user') return null;
  const c = d.message?.content; let parts = []; let images = 0;
  if (typeof c === 'string') parts = [c];
  else if (Array.isArray(c)) { for (const b of c) { if (!b) continue; if (b.type === 'tool_result') return null; if (b.type === 'text') parts.push(b.text || ''); if (b.type === 'image') images++; } }
  else return null;
  let t = parts.join('\n').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  let marks = 0; t = t.replace(/\[Image(?: #\d+)?: source: [^\]]*\]/g, () => { marks++; return ''; }); images = Math.max(images, marks);
  t = t.replace(/<pasted_content[^>]*>\n?/g, '').replace(/\n?<\/pasted_content[^>]*>/g, '').trim();
  if (!t && !images) return null;
  if (t.startsWith('<task-notification')) return { kind: 'trigger', at, label: '背景工作回報' };
  if (t.startsWith('<cross-session-message')) { const m = /from-name="([^"]{1,60})"/.exec(t); return { kind: 'trigger', at, label: `其他 session 傳話${m ? `（${m[1]}）` : ''}` }; }
  if (t.startsWith('<command-name>')) { const m = /<command-name>([^<]{1,60})<\/command-name>/.exec(t); const a = /<command-args>([\s\S]{0,500}?)<\/command-args>/.exec(t); return m ? { kind: 'you', at, text: redact(`${m[1]} ${a ? a[1] : ''}`.trim()), images: 0 } : null; }
  if (/^</.test(t) || t.startsWith('[SYSTEM NOTIFICATION') || t.startsWith('This session is being continued') || t.startsWith('Caveat:')) return null;
  return { kind: 'you', at, text: clip(redact(t), 20000), images };
}
// Read a transcript backwards from byte offset `before` until `want` turns are complete (or a byte cap).
// Read a transcript backwards from byte offset `before` until `want` turns are complete (or a byte budget).
// Records over MAX_RECORD are skipped unparsed; the cursor always moves down, even inside one huge record.
const MAX_RECORD = 4 * 1024 * 1024;
function readConvo(file, { before = null, want = 8, maxBytes = 8 * 1024 * 1024 } = {}) {
  const o = openContained(file, [{ prefix: false, path: canon(projectsDir()) }], { exts: ['.jsonl'], noFollow: true });
  if (!o || o.tooLarge) return null;
  const { fd, st } = o;
  const end0 = before == null ? st.size : Math.max(0, Math.min(Number(before) || 0, st.size));
  let pos = end0; let carry = Buffer.alloc(0); let read = 0; let entries = []; let startOff = end0;
  let dropTail = false; if (before != null && end0 > 0) { const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, end0 - 1); dropTail = b[0] !== 10; }
  let firstChunk = true;
  const isStart = (e) => e.kind === 'you' || e.kind === 'trigger';
  try {
    while (pos > 0 && read < maxBytes) {
      const n = Math.min(1024 * 1024, pos); pos -= n; read += n;
      const buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, pos);
      const data = Buffer.concat([buf, carry]);
      let cut = 0;
      if (pos > 0) {
        const nl = data.indexOf(10);
        if (nl < 0) { carry = data.length > MAX_RECORD ? Buffer.alloc(0) : data; continue; }
        cut = nl + 1;
      }
      carry = Buffer.from(data.subarray(0, cut));
      const chunk = []; let ls = cut;
      while (ls < data.length) {
        let le = data.indexOf(10, ls); if (le < 0) le = data.length;
        if (le > ls && le - ls <= MAX_RECORD && !(firstChunk && dropTail && le === data.length)) {
          const line = data.subarray(ls, le);
          const head = line.subarray(0, 40).toString('latin1');
          if (!/^\{"type":"(?!user"|assistant")/.test(head)) { try { const e = convoEntry(JSON.parse(line.toString('utf8'))); if (e) { e.off = pos + ls; chunk.push(e); } } catch {} }
        }
        ls = le + 1;
      }
      firstChunk = false;
      entries = chunk.concat(entries); startOff = pos + cut;
      const starts = entries.filter(isStart);
      if (starts.length > want) { const keep = starts[starts.length - want]; entries = entries.filter((e) => e.off >= keep.off); startOff = keep.off; break; }
    }
    if (pos > 0 && startOff >= end0) startOff = pos; // budget ran out inside one long record: continue below it
  } finally { fs.closeSync(fd); }
  const seen = new Set();
  entries = entries.filter((e) => { const k = `${e.kind}|${e.at}|${(e.text || e.label || '').slice(0, 80)}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { entries, cursor: startOff > 0 ? startOff : null, size: st.size, mtime: st.mtime.toISOString(), sid: path.basename(o.real, '.jsonl') };
}
// Merge transcript entries and the owner's desk messages by real instants (Date.parse, never string order).
// A desk message sits where it was delivered; one not delivered yet goes last and collects no replies.
function buildTurns(entries, msgs) {
  let last = 0;
  const ent = entries.map((e, i) => { let t = Date.parse(e.at); if (!Number.isFinite(t)) t = last; last = t; return { ...e, t, i }; });
  const dm = msgs.map((m, k) => ({ kind: 'you', source: 'desk', t: m.t, at: m.at, text: m.text, deskImages: m.images || [], id: m.id, deliveredAt: m.deliveredAt || null, i: ent.length + k }));
  const items = ent.concat(dm).sort((a, b) => (a.t === b.t ? a.i - b.i : (a.t < b.t ? -1 : 1)));
  const turns = []; let cur = null;
  for (const e of items) {
    if (e.kind === 'you') {
      cur = { at: e.at, you: e.text, source: e.source || 'session', images: e.images || 0, deskImages: e.deskImages || [], msgId: e.id || null, delivered: e.source === 'desk' ? Boolean(e.deliveredAt) : undefined, replies: [] };
      turns.push(cur);
      if (e.source === 'desk' && !e.deliveredAt) cur = null;
    } else if (e.kind === 'trigger') { if (cur && cur.source === 'desk' && !cur.replies.length) continue; cur = { at: e.at, trigger: e.label, replies: [] }; turns.push(cur); }
    else { if (!cur) { cur = { at: e.at, trigger: '更早的對話', replies: [] }; turns.push(cur); } cur.replies.push({ at: e.at, text: e.text }); }
  }
  return turns.filter((t) => t.you != null || t.replies.length);
}
const convoSummaryCache = new Map();
function convoSummary(n) {
  const f = transcriptFor(n); if (!f) return null;
  let st; try { st = fs.statSync(f); } catch { return null; }
  const key = `${canon(projectsDir())}|${f}:${st.size}:${st.mtimeMs}`; const c = convoSummaryCache.get(n.id);
  if (c && c.key === key) return c.v;
  let v = { at: st.mtime.toISOString() };
  try {
    const rc = readConvo(f, { want: 1e9, maxBytes: 4 * 1024 * 1024 }); const entries = rc ? rc.entries : [];
    const lastYou = [...entries].reverse().find((e) => e.kind === 'you'); const lastReply = [...entries].reverse().find((e) => e.kind === 'reply');
    v = { at: st.mtime.toISOString(), you: lastYou ? clip(lastYou.text, 120) : null, youAt: lastYou?.at || null, reply: lastReply ? clip(lastReply.text.split('\n').filter((l) => !/^\s*(\|?\s*:?-{2,}[-|:\s]*|```.*|~~~.*)$/.test(l)).join(' ').replace(/[#*`>|]/g, ' ').replace(/\s+/g, ' ').trim(), 200) : null, replyAt: lastReply?.at || null };
  } catch {}
  convoSummaryCache.set(n.id, { key, v });
  return v;
}
let listenCache = { at: 0, set: new Set() };
function listeners() {
  if (Date.now() - listenCache.at < 5000) return listenCache.set;
  const set = new Set();
  try {
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      let cmd; try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
      if (!cmd.includes('desk.mjs')) continue;
      const a = cmd.split('\0');
      if (!a.includes('wait') || a.some((x) => x === '--ask' || x.startsWith('--ask=') || x === '--peek' || (x.startsWith('--peek=') && !/^--peek=(|false|0)$/.test(x)))) continue; // --ask waiters get no direct messages
      // Only waiters on this desk: compare their DESK_HOME (read in-process, never printed).
      let home = path.join(os.homedir(), '.local', 'share', 'desk');
      try { const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find((x) => x.startsWith('DESK_HOME=')); if (env) home = env.slice('DESK_HOME='.length); } catch { continue; }
      if (canon(home) !== canon(HOME)) continue;
      const val = (k) => { const i = a.indexOf(k); if (i > 0 && a[i + 1] && !a[i + 1].startsWith('--')) return a[i + 1]; const eq = a.find((x) => x.startsWith(k + '=')); return eq ? eq.slice(k.length + 1) : null; };
      const allMode = a.some((x) => x === '--all' || x.startsWith('--all='));
      if (allMode) { const as = val('--as'); if (as) set.add(as); } else { const s = val('--session'); if (s) set.add(s); }
    }
  } catch {}
  listenCache = { at: Date.now(), set }; return set;
}
// Report files mentioned in replies: only .md/.txt under configured readRoots ("/dir" or "/dir-prefix*").
// Report files mentioned in replies: only .md/.txt under configured readRoots ("/dir" or "/dir-prefix*"), never DESK_HOME.
function readReport(raw) {
  const roots = rootsFrom(config().readRoots); if (!roots.length) return null;
  const want = String(raw || ''); if (!path.isAbsolute(want)) return null;
  const pre = canon(want); if (!roots.some((r) => (r.prefix ? pre.startsWith(r.path) : pre.startsWith(r.path + path.sep)))) return null;
  const o = openContained(want, roots, { exts: ['.md', '.markdown', '.txt'], maxBytes: 2 * 1024 * 1024, deny: [canon(HOME)] });
  if (!o) return null; if (o.tooLarge) return { tooLarge: true };
  try { return { real: o.real, mtime: o.st.mtime.toISOString(), text: readFd(o.fd, o.st.size).toString('utf8') }; } finally { fs.closeSync(o.fd); }
}

function stateForPage() {
  const asks = listJson('asks');
  const answers = Object.fromEntries(listJson('answers').map((a) => [a.askId, a]));
  const delivered = {}; const deliveredTo = {};
  for (const a of asks) {
    const ans = answers[a.id]; if (!ans) continue;
    const recips = [a.from, ...(a.notify || [])];
    deliveredTo[a.id] = recips.filter((r) => (deliveries(r)[a.id] || 0) >= (ans.rev || 1));
    if (deliveredTo[a.id].includes(a.from)) delivered[a.id] = true;
  }
  const lastDelivery = {};
  try {
    const lines = fs.readFileSync(p('events.jsonl'), 'utf8').trim().split('\n').slice(-2000);
    for (const l of lines) { try { const e = JSON.parse(l); if (e.type === 'delivered' && e.toAsker) lastDelivery[e.askId] = e.at; } catch {} }
  } catch {}
  const decisions = listJson('decisions').map(({ full, ...rest }) => ({ ...rest, hasFull: Boolean(full) }));
  const placed = new Set(org().nodes.map((n) => String(n.tmux || '').replace(/\s+/g, '')));
  const running = discoverSessions();
  const unplaced = running.filter((d) => !placed.has(d.tmux.replace(/\s+/g, '')));
  const { title, brand } = config();
  const ui = {
    title: (typeof title === 'string' && title.trim()) || '決策台',
    brand: (typeof brand === 'string' && brand.trim()) || 'desk',
  };
  const listening = [...listeners()];
  return { now: nowIso(), owner: OWNER(), ui, listening, unplaced, running, seen: readSeen(), rules: Array.isArray(config().rules) ? config().rules.map(String) : [], groups: config().groups || null, groupFromTmux: config().groupFromTmux || null, org: org(), asks, answers, delivered, deliveredTo, lastDelivery, board: listJson('board'), decisions };
}
// Pasted images: server-named files under images/, raster types only (no SVG), checked by magic bytes.
const IMG_ID_RE = /^\d{8}-[0-9a-f]{12}\.(png|jpg|webp|gif)$/;
const IMG_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const IMG_MAX = 10 * 1024 * 1024;
const MAX_IMAGES_PER_ANSWER = 6;
function imageMagicOk(ext, b) {
  if (ext === 'png') return b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === 'jpg') return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (ext === 'gif') return b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'));
  if (ext === 'webp') return b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}
function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
// Uploaded images that no current answer references are removed after a day.
function sweepImages() {
  let names = []; try { names = fs.readdirSync(p('images')); } catch { return; }
  const keep = new Set(); for (const a of [...listJson('answers'), ...listJson('messages')]) for (const x of (a.images || [])) keep.add(x);
  for (const n of names) {
    if (keep.has(n)) continue;
    try { if (Date.now() - fs.statSync(p('images', n)).mtimeMs > 24 * 3600 * 1000) fs.unlinkSync(p('images', n)); } catch {}
  }
}
function readBody(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Frame-Options': 'DENY', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function serve(args) {
  ensureHome();
  const PORT = Number(args.port || port());
  const TOKEN = token();
  REDACT_EXACT = [TOKEN];
  const ts = (config().tailscale || null);
  // Cookies ignore ports, so a login cookie on 127.0.0.1 or localhost would also go to every other local web service.
  // The desk keeps its login on its own name (default desk.localhost, which browsers resolve to this machine).
  const LOCAL = localName();
  const legacyHosts = new Set(['127.0.0.1', 'localhost'].filter((h) => h !== LOCAL).map((h) => `${h}:${PORT}`));
  const hostNames = [LOCAL, '127.0.0.1', 'localhost', ...(ts ? [ts.ip, ...(ts.names || [])] : [])];
  const allowedHosts = new Set(hostNames.map((h) => `${h}:${PORT}`));
  const allowedOrigins = new Set(hostNames.map((h) => `http://${h}:${PORT}`));
  const clients = new Set();
  let pending = null;
  let exportTimer = null;
  const scheduleExport = () => { const dir = config().exportDir; if (!dir || exportTimer) return; exportTimer = setTimeout(() => { exportTimer = null; try { exportMarkdown(dir); } catch (e) { console.error('[desk] export failed:', e.message); } }, 10000); };
  const notify = () => { scheduleExport(); if (pending) return; pending = setTimeout(() => { pending = null; for (const c of clients) { try { c.write('event: changed\ndata: 1\n\n'); } catch {} } }, 200); };
  for (const d of ['asks', 'answers', 'board', 'decisions', 'deliveries', 'log', 'messages']) { try { fs.mkdirSync(p(d), { recursive: true }); fs.watch(p(d), notify); } catch {} }
  try { fs.watch(HOME, (ev, name) => { if (name === 'org.json' || name === 'events.jsonl') notify(); }); } catch {}
  setInterval(() => { for (const c of clients) { try { c.write(': ping\n\n'); } catch {} } }, 25000);
  const backupTick = () => {
    const b = config().backup; if (!b || !b.dir) return;
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'backup'], { stdio: 'ignore', env: { ...process.env, DESK_HOME: HOME } });
    child.on('error', () => {});
  };
  setTimeout(backupTick, 60000);
  setTimeout(sweepImages, 5000); setInterval(sweepImages, 3600 * 1000);
  setInterval(backupTick, Math.max(10, Number((config().backup || {}).everyMinutes || 60)) * 60000);

  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(String(req.headers.host || ''))) return send(res, 421, { error: 'host' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (legacyHosts.has(String(req.headers.host || ''))) {
        const clear = { 'Set-Cookie': 'desk_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' };
        if (req.method !== 'GET') return send(res, 421, { error: 'host', message: `請改用 http://${LOCAL}:${PORT}/` }, 'application/json; charset=utf-8', clear);
        // A valid old cookie moves the owner over without logging in again; everything else just redirects.
        const target = url.pathname === '/' && safeEqual(cookieToken(req) || '', TOKEN) ? `/login?t=${TOKEN}` : req.url;
        return send(res, 303, '', 'text/plain', { ...clear, Location: `http://${LOCAL}:${PORT}${target}` });
      }
      if (req.method === 'GET' && url.pathname === '/pair') return send(res, 200, fs.readFileSync(path.join(APP_DIR, 'pair.html')), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/pair.js') return send(res, 200, fs.readFileSync(path.join(APP_DIR, 'pair.js')), 'text/javascript; charset=utf-8');
      if (req.method === 'POST' && url.pathname === '/api/pair') {
        if (!allowedOrigins.has(String(req.headers.origin || ''))) return send(res, 403, { error: 'origin' });
        const body = JSON.parse(await readBody(req, 1024));
        const code = String(body.code || '').replace(/\D/g, '');
        const pf = p('pair.json'); const pair = readJson(pf);
        if (!pair || Date.now() > pair.expires) { try { fs.unlinkSync(pf); } catch {} return send(res, 410, { error: 'expired', message: '配對碼過期了。請在電腦的終端機重新執行 desk pair。' }); }
        pair.tries = (pair.tries || 0) + 1;
        const ok = code.length === 6 && safeEqual(crypto.createHash('sha256').update(code).digest('hex'), pair.hash);
        if (!ok) {
          if (pair.tries >= 5) { try { fs.unlinkSync(pf); } catch {} logEvent({ type: 'pair-failed-locked' }); return send(res, 403, { error: 'locked', message: '錯太多次，這組配對碼作廢了。請重新執行 desk pair。' }); }
          writeJson(pf, pair); return send(res, 403, { error: 'wrong', message: `配對碼不對（還可以試 ${5 - pair.tries} 次）。` });
        }
        try { fs.unlinkSync(pf); } catch {}
        logEvent({ type: 'paired', via: String(req.headers.host || '') });
        return send(res, 200, { ok: true }, 'application/json; charset=utf-8', { 'Set-Cookie': `desk_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` });
      }
      if (req.method === 'GET' && url.pathname === '/app.css') return send(res, 200, fs.readFileSync(path.join(APP_DIR, 'app.css')), 'text/css; charset=utf-8');
      if (url.pathname === '/login') {
        const t = url.searchParams.get('t') || '';
        if (!safeEqual(t, TOKEN)) return send(res, 403, '登入連結不對。請在終端機重新執行 desk open。', 'text/plain; charset=utf-8');
        const next = url.searchParams.get('next'); const loc = '/' + (/^(home|talk|org|board|decisions|log)(\/[A-Za-z0-9_-]{1,40})?$/.test(next || '') ? '#' + next : '');
        return send(res, 303, '', 'text/plain', { Location: loc, 'Set-Cookie': `desk_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` });
      }
      const authed = safeEqual(cookieToken(req) || '', TOKEN);
      if (!authed) {
        if (req.method === 'GET' && url.pathname === '/') return send(res, 303, '', 'text/plain', { Location: '/pair' });
        return send(res, 401, '請在電腦的終端機執行 desk open（同一台電腦）或 desk pair（手機）。', 'text/plain; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, fs.readFileSync(path.join(APP_DIR, 'page.html')), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/app.js') return send(res, 200, fs.readFileSync(path.join(APP_DIR, 'app.js')), 'text/javascript; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/app.css') return send(res, 200, fs.readFileSync(path.join(APP_DIR, 'app.css')), 'text/css; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, stateForPage());
      if (req.method === 'GET' && url.pathname.startsWith('/api/decision/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/decision/'.length));
        if (!/^D-\d{2,4}$|^D-early$/.test(id)) return send(res, 400, { error: 'id' });
        const d = readJson(decisionFile(id)); return d ? send(res, 200, d) : send(res, 404, { error: 'not_found' });
      }
      if (req.method === 'GET' && url.pathname === '/api/log') {
        const sp = url.searchParams;
        const lim = Math.max(1, Math.min(200, Number(sp.get('limit') || 50)));
        const day = sp.get('day') || ''; if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return send(res, 400, { error: 'day' });
        return send(res, 200, queryLog({ q: sp.get('q') || '', from: sp.get('from') || '', day, before: sp.get('before') || '', limit: lim }));
      }
      if (req.method === 'GET' && url.pathname === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
        res.write('event: hello\ndata: 1\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/convos') {
        const lis = listeners(); const out = [];
        for (const n of org().nodes) { if (n.line === 'root') continue; const v = convoSummary(n); out.push({ id: n.id, listening: lis.has(n.id), ...(v || { none: true }) }); }
        return send(res, 200, { convos: out });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/convo/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/convo/'.length)); checkId('id', id);
        const n = nodeById(id); if (!n) return send(res, 404, { error: 'not_found', message: '組織圖上沒有這個 session' });
        const got = deliveries(id);
        const msgs = listJson('messages').filter((m) => m.to === id).map((m) => {
          const d = got[`msg:${m.id}`]; const deliveredAt = typeof d === 'string' ? d : (d ? m.at : null);
          const t = deliveredAt ? Date.parse(deliveredAt) : NaN;
          return { ...m, deliveredAt, t: Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER }; // not delivered yet: newest page, after everything
        });
        const beforeRaw = url.searchParams.get('before'); const untilRaw = url.searchParams.get('until'); const sidWanted = url.searchParams.get('sid');
        const until = untilRaw == null || untilRaw === '' ? null : Number(untilRaw);
        const f = transcriptFor(n);
        const r = f ? readConvo(f, { before: beforeRaw == null ? null : Number(beforeRaw) }) : null;
        if (sidWanted && (!r || r.sid !== sidWanted)) return send(res, 409, { error: 'changed', message: '這個 session 換了一份對話紀錄，重新讀取' });
        const inWin = (m, lower) => (lower == null || m.t >= lower) && (until == null || m.t < until);
        if (!r) return send(res, 200, { id, none: true, listening: listeners().has(id), turns: buildTurns([], msgs.filter((m) => inWin(m, null))), cursor: null, lower: null });
        // Pages share one boundary: this page owns messages in [lower, until); the next older page gets until = this lower.
        const firstT = r.entries.length ? Date.parse(r.entries[0].at) : NaN;
        const lower = r.cursor == null ? null : (Number.isFinite(firstT) ? firstT : (until == null ? Number.MAX_SAFE_INTEGER : until));
        return send(res, 200, { id, sid: r.sid, listening: listeners().has(id), turns: buildTurns(r.entries, msgs.filter((m) => inWin(m, lower))), cursor: r.cursor, lower, mtime: r.mtime });
      }
      if (req.method === 'GET' && url.pathname === '/api/file') {
        const r = readReport(url.searchParams.get('path'));
        if (!r) return send(res, 404, { error: 'not_found', message: '這個檔案不能在 desk 上開（只開設定過的資料夾裡的 .md / .txt）' });
        if (r.tooLarge) return send(res, 413, { error: 'too_large', message: '檔案太大（上限 2 MB）' });
        return send(res, 200, { path: r.real, mtime: r.mtime, text: redact(r.text) });
      }
      if (req.method === 'POST' && url.pathname === '/api/message') {
        if (!allowedOrigins.has(String(req.headers.origin || ''))) return send(res, 403, { error: 'origin' });
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'type' });
        const body = JSON.parse(await readBody(req));
        const to = String(body.to || ''); checkId('to', to);
        if (!nodeById(to)) return send(res, 404, { error: 'not_found', message: '組織圖上沒有這個 session' });
        const text = String(body.text || '').trim();
        try { check('訊息', text, LIMIT.messageText); } catch (e) { return send(res, 400, { error: 'too_long', message: e.message }); }
        const images = Array.isArray(body.images) ? Array.from(new Set(body.images.map(String))) : [];
        if (images.length > MAX_IMAGES_PER_ANSWER) return send(res, 400, { error: 'images', message: `一次最多 ${MAX_IMAGES_PER_ANSWER} 張圖` });
        for (const x of images) if (!IMG_ID_RE.test(x) || !fs.existsSync(p('images', x))) return send(res, 400, { error: 'images', message: '有一張圖找不到了，請重新貼上' });
        if (!text && !images.length) return send(res, 400, { error: 'empty', message: '寫幾個字，或貼一張圖' });
        const id = `m-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
        const m = { id, to, text, ...(images.length ? { images } : {}), at: nowIso(), by: OWNER() };
        writeJson(p('messages', `${id}.json`), m);
        logEvent({ type: 'message', id, to });
        writeLog({ from: OWNER(), kind: 'message', text: `對 ${labelOf(to)} 傳了一則話（內容只在對話頁）${images.length ? `，附圖 ${images.length} 張` : ''}` });
        return send(res, 200, { ok: true, id, listening: listeners().has(to) });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/image/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/image/'.length));
        if (!IMG_ID_RE.test(id)) return send(res, 404, { error: 'not_found' });
        const o = openContained(p('images', id), [{ prefix: false, path: canon(p('images')) }], { noFollow: true, maxBytes: IMG_MAX });
        if (!o || o.tooLarge) return send(res, 404, { error: 'not_found' });
        let buf; try { buf = readFd(o.fd, o.st.size); } finally { fs.closeSync(o.fd); }
        const ext = id.split('.').pop();
        if (!imageMagicOk(ext, buf)) return send(res, 404, { error: 'not_found' });
        return send(res, 200, buf, IMG_MIME[ext]);
      }
      if (req.method === 'POST' && url.pathname === '/api/upload') {
        if (!allowedOrigins.has(String(req.headers.origin || ''))) return send(res, 403, { error: 'origin' });
        const ext = IMG_TYPES[String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()];
        if (!ext) return send(res, 415, { error: 'type', message: '只能貼 PNG、JPG、WebP、GIF 圖片。' });
        if (Number(req.headers['content-length'] || 0) > IMG_MAX) return send(res, 413, { error: 'too_large', message: '圖片太大（上限 10 MB）。' }, 'application/json; charset=utf-8', { Connection: 'close' });
        let buf; try { buf = await readRaw(req, IMG_MAX); } catch { return send(res, 413, { error: 'too_large', message: '圖片太大（上限 10 MB）。' }); }
        if (!imageMagicOk(ext, buf)) return send(res, 400, { error: 'not_image', message: '這個檔案不是圖片。' });
        const id = `${nowIso().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
        fs.mkdirSync(p('images'), { recursive: true });
        fs.writeFileSync(p('images', id), buf, { mode: 0o600, flag: 'wx' });
        return send(res, 200, { ok: true, id });
      }
      if (req.method === 'POST' && url.pathname === '/api/answer') {
        if (!allowedOrigins.has(String(req.headers.origin || ''))) return send(res, 403, { error: 'origin' });
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'type' });
        const body = JSON.parse(await readBody(req));
        const askId = String(body.askId || ''); checkId('askId', askId);
        const ask = readJson(p('asks', `${askId}.json`));
        if (!ask) return send(res, 404, { error: 'not_found', message: '找不到這題' });
        if (ask.status !== 'open') return send(res, 409, { error: 'closed', message: ask.status === 'withdrawn' ? '這題已經撤回了，不用回答' : '這題已經處理完了' });
        const choice = body.choice == null || body.choice === '' ? null : String(body.choice);
        if (choice && !ask.options.some((o) => o.key === choice)) return send(res, 400, { error: 'choice', message: '選項不存在' });
        const text = String(body.text || '').trim();
        try { check('回覆', text, LIMIT.answerText); } catch (e) { return send(res, 400, { error: 'too_long', message: e.message }); }
        const images = Array.isArray(body.images) ? Array.from(new Set(body.images.map(String))) : [];
        if (images.length > MAX_IMAGES_PER_ANSWER) return send(res, 400, { error: 'images', message: `一次最多 ${MAX_IMAGES_PER_ANSWER} 張圖` });
        for (const x of images) if (!IMG_ID_RE.test(x) || !fs.existsSync(p('images', x))) return send(res, 400, { error: 'images', message: '有一張圖找不到了，請重新貼上' });
        if (!choice && !text && !images.length) return send(res, 400, { error: 'empty', message: '請選一個選項，或寫幾個字' });
        const old = readJson(p('answers', `${askId}.json`));
        const ans = { askId, choice, choiceLabel: choice ? ask.options.find((o) => o.key === choice).label : null, text, ...(images.length ? { images } : {}), at: nowIso(), by: OWNER(), rev: (old?.rev || 0) + 1 };
        writeJson(p('answers', `${askId}.json`), ans);
        logEvent({ type: 'answered', askId, rev: ans.rev, choice });
        writeLog({ from: OWNER(), kind: 'answer', text: `回覆（${askId}）${ask.title}：${[ans.choiceLabel, ans.text, images.length ? `附圖 ${images.length} 張` : ''].filter(Boolean).join('｜')}${ans.rev > 1 ? `（第 ${ans.rev} 版）` : ''}` });
        return send(res, 200, { ok: true, rev: ans.rev });
      }
      return send(res, 404, { error: 'not_found' });
    } catch (e) {
      if (e instanceof UsageError) return send(res, 400, { error: 'bad_request', message: e.message });
      console.error('[desk] request failed:', e && e.message);
      return send(res, 500, { error: 'internal' });
    }
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[desk] listening on http://127.0.0.1:${PORT}  (data: ${HOME})`);
    console.log('[desk] open it with: desk open');
  });
  if (ts && ts.ip) {
    const tsServer = http.createServer((req, res) => server.emit('request', req, res));
    const tryListen = () => {
      tsServer.once('error', (e) => { console.error(`[desk] Tailscale ${ts.ip}:${PORT} not available (${e.code}); retrying in 30 s`); setTimeout(tryListen, 30000); });
      tsServer.listen(PORT, ts.ip, () => console.log(`[desk] also on Tailscale: http://${ts.ip}:${PORT} and http://${(ts.names || [])[0] || ts.ip}:${PORT}  (phone: desk pair)`));
    };
    tryListen();
  }
}
function localName() { const v = String(config().localName || 'desk.localhost').toLowerCase(); return /^[a-z0-9-]{1,40}\.localhost$/.test(v) ? v : 'desk.localhost'; }
function cmdOpen(args) {
  ensureHome();
  const PORT = Number(args.port || port());
  const url = `http://${localName()}:${PORT}/login?t=${token()}`;
  // Hand the URL straight to the Windows browser; never print the token.
  const child = spawn('cmd.exe', ['/c', 'start', '""', url.replace(/&/g, '^&')], { stdio: 'ignore', detached: true });
  child.on('error', () => console.error('打不開 Windows 瀏覽器。請手動開 http://' + localName() + ':' + PORT + '/ ，登入連結在 desk 資料夾的 token 檔。'));
  child.unref();
  console.log(`已在瀏覽器開啟 http://${localName()}:${PORT}/（登入連結沒有印出來）`);
}

function cmdTailscale(args) {
  ensureHome();
  const sub = args._[1];
  const cfg = config();
  if (sub === 'off') { delete cfg.tailscale; writeJson(p('config.json'), cfg); console.log('Tailscale 關閉了。重新啟動服務後生效。'); return; }
  if (sub === 'on') {
    let self;
    try { self = JSON.parse(execFileSync('tailscale', ['status', '--self', '--json'], { encoding: 'utf8', timeout: 10000 })).Self; }
    catch { throw new UsageError('讀不到 tailscale status。這台 WSL 要先裝好並登入 Tailscale。'); }
    const ip = (self.TailscaleIPs || []).find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x));
    if (!ip) throw new UsageError('找不到 Tailscale 的 IPv4 位址');
    const names = [self.HostName, String(self.DNSName || '').replace(/\.$/, '')].filter(Boolean);
    cfg.tailscale = { ip, names }; writeJson(p('config.json'), cfg);
    console.log(`Tailscale 打開了：http://${ip}:${port()}（也可用 ${names.join('、')}）。重新啟動服務後生效；手機用 desk pair 配對。`);
    return;
  }
  console.log(JSON.stringify(cfg.tailscale || null));
}
function cmdPair() {
  ensureHome();
  const cfg = config();
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  writeJson(p('pair.json'), { hash: crypto.createHash('sha256').update(code).digest('hex'), expires: Date.now() + 5 * 60 * 1000, tries: 0 });
  const where = cfg.tailscale ? `http://${cfg.tailscale.ip}:${port()}/pair` : `http://127.0.0.1:${port()}/pair`;
  console.log(`配對碼：${code.slice(0, 3)} ${code.slice(3)}（5 分鐘內有效，只能用一次）`);
  console.log(`用手機打開 ${where}，輸入這組數字。`);
}

async function cmdWatch(args) {
  ensureHome();
  const as = String(args.as || ''); checkId('--as', as);
  const kinds = new Set(idList('--kinds', args.kinds || 'board,note,ask,answer,decision'));
  const notFrom = new Set(idList('--not-from', args['not-from'] || ''));
  const timeoutMs = args.timeout ? Number(args.timeout) * 1000 : 0;
  touchSeen(as);
  const curFile = p('deliveries', `watch-${as}.json`);
  const cursor = readJson(curFile, null);
  const fresh = () => {
    const all = readAllLog().filter((e) => !e.imported);
    if (!cursor) return { items: [], top: all[0] };
    const out = [];
    for (const e of all) {
      if (String(e.at) < cursor.at || (String(e.at) === cursor.at && String(e.id) <= cursor.id)) break;
      if (kinds.has(e.kind || 'note') && !notFrom.has(e.from)) out.push(e);
    }
    return { items: out.reverse(), top: all[0] };
  };
  const save = (top) => { if (top) writeJson(curFile, { at: top.at, id: top.id }); };
  const first = fresh();
  if (!cursor) { save(first.top); if (!timeoutMs && args.init) { console.log('（已設定起點）'); return 0; } }
  const show = (r) => {
    for (const e of r.items) console.log(`[desk] ${e.at.slice(5, 16).replace('T', ' ')} ${e.from} ${KINDNAME[e.kind || 'note'] || e.kind}${e.topic ? ` ${e.topic}` : ''}：${String(e.text).split('\n').slice(0, 3).join(' / ').slice(0, 300)}`);
    save(r.top);
  };
  if (cursor && first.items.length) { show(first); return 0; }
  const deadline = timeoutMs ? Date.now() + timeoutMs : Infinity;
  return await new Promise((resolve) => {
    let done = false; let watcher = null; let timer = null;
    const finish = (code) => { if (done) return; done = true; try { watcher?.close(); } catch {} clearInterval(timer); resolve(code); };
    const poke = () => {
      if (done) return;
      const c2 = readJson(curFile, null);
      const all = readAllLog().filter((e) => !e.imported);
      const items = [];
      for (const e of all) {
        if (c2 && (String(e.at) < c2.at || (String(e.at) === c2.at && String(e.id) <= c2.id))) break;
        if (kinds.has(e.kind || 'note') && !notFrom.has(e.from)) items.push(e);
      }
      if (items.length) { show({ items: items.reverse(), top: all[0] }); finish(0); }
      else { if (all[0]) save(all[0]); if (Date.now() > deadline) finish(3); }
    };
    try { watcher = fs.watch(p('log'), () => setTimeout(poke, 200)); } catch {}
    timer = setInterval(poke, 3000);
  });
}
const KINDNAME = { note: '日誌', ask: '提問', answer: 'owner 的回覆', board: '看板', decision: '決定' };

function exportMarkdown(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = nowIso();
  const head = (what) => `<!-- 由 desk 自動產生（${stamp}）。只供閱讀；要寫請用 desk ${what}。不要直接改這個檔。 -->\n\n`;
  // board
  const cards = listJson('board').sort((a, b) => String(a.owner).localeCompare(String(b.owner)) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const esc = (x) => String(x || '').replace(/\|/g, '／').replace(/\n/g, ' ');
  let b = head('board set') + '# 看板（desk）\n\n| 卡片 | 負責 | 狀態 | 現在 | 下一步 | 等 | 更新 |\n|---|---|---|---|---|---|---|\n';
  for (const c of cards) b += `| ${esc(c.title)} | ${esc(c.owner)} | ${esc(c.status)} | ${esc(c.now)} | ${esc(c.next)} | ${esc([c.waitingOn, ...(c.waitsOn || [])].filter(Boolean).join('、'))} | ${esc(String(c.updatedAt || '').slice(5, 16).replace('T', ' '))} |\n`;
  fs.writeFileSync(path.join(outDir, 'board.md'), b);
  // decisions
  const decs = listJson('decisions').sort((a, b2) => b2.num - a.num);
  let d = head('decide') + '# 決定紀錄（desk）\n\n';
  for (const x of decs) {
    d += `## ${x.id === 'D-early' ? '更早的決定' : x.id}${x.date ? `　${x.date}` : ''}　${x.fullTitle || x.title}${x.status === 'superseded' ? `（已被 ${x.supersededBy} 取代）` : ''}\n`;
    if (x.full) d += x.full.split('\n').slice(1).join('\n').trim() + '\n\n';
    else d += `- 原話：${x.words}\n${(x.points || []).map((pt) => `- ${pt}`).join('\n')}\n\n`;
  }
  fs.writeFileSync(path.join(outDir, 'decisions.md'), d);
  // log
  const log = readAllLog();
  let l = head('log') + '# 工作日誌（desk，最新在上）\n\n';
  for (const e of log) l += `- **${String(e.at).slice(0, 16).replace('T', ' ')} ${e.from}${e.kind && e.kind !== 'note' ? `（${KINDNAME[e.kind] || e.kind}）` : ''}${e.topic ? ` ${e.topic}` : ''}:** ${e.imported ? String(e.text).replace(/^\*\*[^*]*\*\*\s*/, '') : e.text}\n`;
  fs.writeFileSync(path.join(outDir, 'log.md'), l);
  return { board: cards.length, decisions: decs.length, log: log.length };
}
// SessionStart hook: register the session by project folder; fail-open, quiet outside configured projects.
async function cmdRegister(args) {
  const hook = Boolean(args.hook);
  let input = {};
  if (hook && !process.stdin.isTTY) {
    input = await new Promise((resolve) => {
      let buf = ''; const t = setTimeout(() => resolve({}), 400); t.unref();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { buf += c; if (buf.length > 65536) { clearTimeout(t); resolve({}); } });
      process.stdin.on('end', () => { clearTimeout(t); try { resolve(JSON.parse(buf)); } catch { resolve({}); } });
    });
  }
  const cfg = config();
  const cwd = String(args.cwd || input.cwd || process.cwd());
  const proj = (cfg.projects || []).find((x) => x && x.match && cwd.includes(x.match));
  if (!proj) { if (!hook) console.log('這個資料夾不屬於任何已設定的專案，不登記。'); return; }
  let where = null;
  if (process.env.TMUX_PANE) {
    try { where = execFileSync('tmux', ['display-message', '-p', '-t', process.env.TMUX_PANE, '#S「#W」'], { encoding: 'utf8', timeout: 800 }).trim(); } catch {}
  }
  if (!where && args.where) where = String(args.where);
  const sid = String(input.session_id || process.env.CLAUDE_CODE_SESSION_ID || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
  const norm = (x) => String(x || '').replace(/\s+/g, '');
  // In a split window the label names no single session: match and record by session id only.
  const shared = windowIsShared(); const whereKey = shared ? null : where;
  const result = withOrgLock(() => {
    const o = org();
    let n = (args.id && o.nodes.find((x) => x.id === String(args.id))) || (whereKey && o.nodes.find((x) => norm(x.tmux) === norm(whereKey))) || (sid && o.nodes.find((x) => (x.sessionIds || []).includes(sid)));
    let created = false;
    if (!n) {
      const base = args.id ? String(args.id) : `s-${(sid || crypto.randomBytes(4).toString('hex')).slice(0, 6)}`;
      checkId('id', base);
      n = { id: base, name: '', unregistered: true };
      o.nodes.push(n); created = true;
    }
    n.group = proj.group;
    if (whereKey) n.tmux = whereKey;
    if (sid) n.sessionIds = Array.from(new Set([sid, ...(n.sessionIds || [])])).slice(0, 5);
    o.updatedAt = nowIso(); writeJson(p('org.json'), o);
    return { n, created };
  });
  touchSeen(result.n.id);
  if (result.created) logEvent({ type: 'registered', id: result.n.id, group: proj.group });
  const id = result.n.id;
  if (!result.n.name) console.log(`desk：這個 session 已登記為 ${id}（${proj.label || proj.group}），但還沒寫負責什麼。請跑：desk org node ${id} --name '<你負責什麼>' --now '<一行現況>'。`);
  else console.log(`desk：你在組織圖上是 ${id}（${result.n.name}）。`);
  try { const place = placeText(id); if (place) console.log(place); } catch {}
  console.log(`desk 規則：需要 ${OWNER()} 同意或決定的事，一律用 desk ask --from ${id} 問（附背景、選項和建議），接著在背景跑 desk wait --session ${id}，然後繼續做不受影響的工作。不要在聊天裡寫「你同意我才繼續」然後停下來等。她的回覆一到，wait 會叫醒你。她也可能在 desk 的「對話」頁直接對你說話，同樣經 desk wait 送到：當成她在你視窗裡打的字，直接在對話裡回答，她在頁面上看得到。所以要隨時掛著 desk wait --session <你的id>。說明：~/.claude/skills/multi-session-engineering/reference/desk.md`);
}

function cmdExport(args) {
  ensureHome();
  const out = String(args.out || config().exportDir || p('export'));
  const r = exportMarkdown(out);
  if (args.auto !== undefined) { const cfg = config(); if (args.auto === 'off') delete cfg.exportDir; else cfg.exportDir = out; writeJson(p('config.json'), cfg); }
  console.log(`exported to ${out}: board ${r.board} cards, decisions ${r.decisions}, log ${r.log} entries${config().exportDir ? '（服務會在資料變動後自動更新）' : ''}`);
}
function runBackup({ quiet = false } = {}) {
  const cfg = config();
  const dir = cfg.backup && cfg.backup.dir;
  if (!dir) throw new UsageError('還沒設定備份：desk backup --setup <git repo 資料夾>');
  const dst = path.join(dir, 'data');
  fs.mkdirSync(dst, { recursive: true });
  // Never copy secrets or machine-local settings.
  execFileSync('rsync', ['-a', '--delete', '--exclude', 'token', '--exclude', 'pair.json', '--exclude', 'config.json', '--exclude', '*.tmp', '--exclude', 'export/', `${HOME}/`, `${dst}/`], { stdio: 'ignore' });
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('add', '-A');
  const staged = git('diff', '--cached', '--name-only').trim();
  if (!staged) { if (!quiet) console.log('備份：沒有變動'); return { changed: 0 }; }
  const n = staged.split('\n').length;
  git('-c', 'user.name=desk', '-c', 'user.email=desk@localhost', 'commit', '-q', '-m', `desk backup ${nowIso()} (${n} files)`);
  let pushed = true;
  try { execFileSync('git', ['-C', dir, 'push', '-q', 'origin', 'HEAD'], { stdio: 'ignore', timeout: 120000 }); } catch { pushed = false; }
  logEvent({ type: 'backup', files: n, pushed });
  if (!quiet) console.log(`備份：${n} 個檔案已 commit，${pushed ? '已推上 GitHub' : '推送失敗（下次會再推）'}`);
  return { changed: n, pushed };
}
function cmdBackup(args) {
  ensureHome();
  if (args.setup) {
    const dir = path.resolve(String(args.setup));
    execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
    const cfg = config(); cfg.backup = { dir, everyMinutes: Number(args.every || 60) }; writeJson(p('config.json'), cfg);
    const readme = path.join(dir, 'README.md');
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, '# desk 資料備份（私人）\n\n本機 desk 的資料備份：決定、看板、日誌、提問與回覆。desk 服務每小時自動 commit 並推送。\n\n- 這個 repo 必須保持私人。\n- 不含登入 token、配對碼與本機設定。\n- 還原：把 `data/` 複製回 DESK_HOME，再重新啟動 desk（token 會重新產生，之後用 desk open／desk pair 重新登入）。\n');
    console.log(`備份設定好了：${dir}（每 ${cfg.backup.everyMinutes} 分鐘）`);
  }
  runBackup();
}

function cmdFreeze(args) {
  const note = textArg(args, 'note') || '這份是歷史紀錄，不再更新。';
  for (const f of args._.slice(1)) {
    const s = fs.readFileSync(String(f), 'utf8');
    if (s.startsWith('<!-- desk-frozen')) { console.log(`already frozen: ${f}`); continue; }
    fs.writeFileSync(String(f), `<!-- desk-frozen ${nowIso()} -->\n> ${note}\n\n` + s);
    console.log(`frozen: ${f}`);
  }
}

// ---------- migration from the markdown files ----------
function stripMd(s) { return String(s).replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim(); }
function clip(s, n) { const a = [...s]; return a.length <= n ? s : a.slice(0, n - 1).join('') + '…'; }
function parseDecisions(md) {
  const lines = md.split('\n');
  const blocks = []; let cur = null;
  for (const line of lines) {
    if (/^## /.test(line)) { if (cur) blocks.push(cur); cur = { head: line.slice(3).trim(), body: [] }; }
    else if (cur) cur.body.push(line);
  }
  if (cur) blocks.push(cur);
  const out = [];
  for (const b of blocks) {
    let id, date = '', where = '', title = '';
    let m = /^D-(\d+)\s*\(([^)]*)\)\s*:\s*(.*)$/.exec(b.head);
    if (m) {
      id = `D-${m[1].padStart(2, '0')}`; const meta = m[2]; title = m[3];
      const comma = meta.indexOf(','); date = (comma > 0 ? meta.slice(0, comma) : meta).trim(); where = comma > 0 ? meta.slice(comma + 1).trim() : '';
    } else if ((m = /^D-(\d+)[\s　]+(\S+)[\s　]+(.*)$/.exec(b.head))) {
      id = `D-${m[1].padStart(2, '0')}`; date = m[2]; title = m[3];
    } else if (/^更早的決定/.test(b.head)) {
      id = 'D-early'; title = b.head; date = '2026-10 以前';
    } else continue;
    const body = b.body.join('\n').trim();
    // her words: the "Her words" / 原話 line plus its indented continuation lines
    let words = ''; let noWords = false;
    const bl = b.body;
    for (let i = 0; i < bl.length; i++) {
      const l = bl[i];
      if (/Her (?:words?|answer|choice)|原話/.test(l)) {
        const parts = [l.replace(/^[-*\s]*/, '').replace(/^(?:\*\*)?原話(?:（[^）]*）|\([^)]*\))?\s*[：:]\s*(?:\*\*)?\s*/, '').replace(/^Her (?:words?|answer|choice)[^:：]*[:：]\s*/, '')];
        for (let j = i + 1; j < bl.length; j++) {
          const n = bl[j];
          if (/^\s{2,}(?:[-*]|\d+\.)\s/.test(n) || /^\s{4,}\S/.test(n)) parts.push(n.trim().replace(/^[-*]\s*/, ''));
          else break;
        }
        words = parts.filter(Boolean).join('\n').replace(/\*\*/g, '').trim();
        break;
      }
    }
    if (!words) {
      const relayed = bl.find((l) => /內容[：:]|經.*轉述/.test(l));
      words = relayed ? '轉述，無原話（內容見全文）' : '原話不在這份紀錄裡（見全文）';
      noWords = true;
    }
    // points: top-level bullets that aren't her words / source lines
    const points = [];
    for (const l of bl) {
      if (!/^(?:[-*]|\d+\.)\s/.test(l)) continue;
      if (/Her (?:words?|answer|choice)|原話|出處|Source:|^\s*-\s*\*\*出處/.test(l)) continue;
      const t = stripMd(l.replace(/^(?:[-*]|\d+\.)\s*/, ''));
      if (!t || /^[:：]$/.test(t)) continue;
      points.push(clip(t, LIMIT.decisionPoint));
      if (points.length >= LIMIT.decisionPoints) break;
    }
    out.push({ id, num: id === 'D-early' ? 0 : Number(id.slice(2)), date, where, title: clip(stripMd(title), LIMIT.decisionTitle),
      fullTitle: stripMd(title), words: clip(words, LIMIT.decisionWords), noWords, points, full: `## ${b.head}\n${body}`, status: 'active', migrated: true });
  }
  // supersession hints
  const byId = Object.fromEntries(out.map((d) => [d.id, d]));
  const relations = [];
  for (const d of out) {
    const text = d.full;
    const re = /(?:取代|replaces?|supersedes?)\s*(D-\d+)/gi; let m;
    while ((m = re.exec(text))) {
      const target = `D-${m[1].slice(2).padStart(2, '0')}`;
      if (target === d.id || !byId[target]) continue;
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 6);
      const partial = /^\s*(裡|的|中|'s|\s*§|\s*in part|\s*for\b)/.test(after) || /部分/.test(text.slice(Math.max(0, m.index - 8), m.index));
      relations.push({ by: d.id, target, partial, how: 'by-says-replaces' });
    }
    const re2 = /(?:被|superseded by|Later superseded by|後來被)\s*(D-\d+)\s*(?:取代)?/gi;
    while ((m = re2.exec(text))) {
      const by = `D-${m[1].slice(2).padStart(2, '0')}`;
      if (by === d.id || !byId[by]) continue;
      relations.push({ by, target: d.id, partial: false, how: 'target-says-superseded' });
    }
  }
  // Auto-detection is only a hint: every relation found in the text is recorded as "partly changed".
  // Full supersession comes only from decision-overrides.json (confirmed by the lead).
  for (const r of relations) {
    const t = byId[r.target]; if (!t || byId[r.by].num <= t.num) continue;
    t.partlyBy = Array.from(new Set([...(t.partlyBy || []), r.by]));
  }
  return { decisions: out, relations };
}
function parseBoard(md) {
  const lines = md.split('\n');
  let section = ''; let header = null;
  const live = []; const skipped = { done: 0 };
  const doneRe = /^(已合併|完成|已完成|已關閉|關閉|已打標籤|取消|已取消|撤回|已撤回|上線|已上線|已部署|done|merged)/i;
  const STAMP = /^\s*(?:\d{2}-\d{2}\s+)?\d{1,2}:\d[\dx]\s*[：:]?\s*/;
  const firstSeg = (s) => stripMd(String(s || '').split('‖')[0]).replace(/^(?:\d{2}-\d{2}\s+)?\d{1,2}:\d[\dx]\s*/, '').replace(STAMP, '').trim();
  for (const line of lines) {
    if (/^## /.test(line)) { section = line.slice(3).trim(); header = null; continue; }
    if (!line.startsWith('| ')) continue;
    let cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue;
    if (/^(包|項目)$/.test(cells[0])) { header = cells.map((c) => c.replace(/\s/g, '')); continue; }
    if (!header) continue;
    if (/^已完成/.test(section) || /^機器和時段|安靜機/.test(section)) { skipped.done++; continue; }
    if (cells.length > header.length) cells = [...cells.slice(0, header.length - 1), cells.slice(header.length - 1).join('|')];
    const col = (names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return cells[i] || ''; } return ''; };
    const title = col(['包', '項目']);
    let status = stripMd(col(['狀態']));
    let owner = stripMd(col(['負責']));
    let update = col(['更新', '備註']);
    let next = col(['下一步']);
    let latest;
    if (!owner) {
      // 等產品的事：項目 | 狀態 | 備註（備註開頭寫「負責 X」，接著是最新進度）
      const note = stripMd(update);
      owner = note;
      latest = firstSeg(note.replace(/^負責[^。]*。\s*/, ''));
      next = '';
    } else {
      // 工作線：「下一步」欄其實是最新進度（新的在前，用 ‖ 分隔）；「更新」欄只有時間
      latest = firstSeg(next) || firstSeg(update);
      next = '';
    }
    if (doneRe.test(status)) { skipped.done++; continue; }
    const dm = /(\d{2})-(\d{2})\s+\d{1,2}:\d/.exec(stripMd(col(['更新', '備註', '狀態']))) || /(\d{2})-(\d{2})/.exec(stripMd(col(['更新', '備註', '狀態'])));
    const latestDate = dm ? `${dm[1]}-${dm[2]}` : '';
    live.push({ section, title: stripMd(title), owner, status, next, latest, latestDate });
  }
  return { live, skipped };
}
function guessOwner(s) {
  // Match the owner text from an old board row against the org chart (ids and tmux labels).
  const t = String(s);
  for (const n of org().nodes) {
    if (n.tmux) { const m = /「(.+?)」/.exec(n.tmux); if (m && t.includes(m[1])) return n.id; }
  }
  const ids = org().nodes.map((n) => n.id).filter(Boolean).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (ids.length) {
    const m = new RegExp(`(?:^|[\\s（(：:，、/＋+])(${ids.join('|')})(?=$|[\\s）)：:，、/。（(＋+；;])`).exec(t);
    if (m) return m[1];
  }
  return (org().nodes.find((n) => n.lead) || {}).id || 'lead';
}
function parseCoordination(md) {
  const lines = md.split('\n');
  const out = [];
  const firstHeading = lines.findIndex((l) => /^## \d{4}-\d{2}-\d{2}/.test(l));
  const year = '2026';
  let cur = null;
  const push = () => { if (cur) { cur.text = cur.lines.join('\n').replace(/\s+$/, ''); delete cur.lines; if (cur.text) out.push(cur); } cur = null; };
  const pad = (n) => String(n).padStart(2, '0');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (firstHeading < 0 || i < firstHeading) {
      const m = /^- \*\*(\d{2})-(\d{2}) (\d{1,2}):(\d{2}|\d[x])\s+([^:：*]+?)\s*[:：]/.exec(l) || /^- \*\*(\d{2})-(\d{2}) (\d{1,2}):(\d{2}|\d[x])\s+(\S+)/.exec(l);
      if (m) {
        push();
        const mm = m[4].replace('x', '0');
        cur = { at: `${year}-${m[1]}-${m[2]}T${pad(m[3])}:${mm}:00+08:00`, from: m[5].trim().split(/\s/)[0].slice(0, 20), kind: 'note', imported: true, lines: [l.replace(/^- /, '')] };
        continue;
      }
      if (cur && (l.startsWith(' ') || l.startsWith('\t'))) { cur.lines.push(l); continue; }
      if (cur && l.trim() === '') { cur.lines.push(''); continue; }
      if (cur && l.trim() !== '') { cur.lines.push(l); continue; }
      continue;
    }
    const h = /^## (\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2}))?\s*(.*)$/.exec(l);
    if (h) {
      push();
      const rest = h[6];
      const who = /^—\s*([^—]+?)\s*—/.exec(rest) || /^([A-Za-z0-9]{1,12})\s*[:：]/.exec(rest);
      cur = { at: `${h[1]}-${h[2]}-${h[3]}T${pad(h[4] || 0)}:${h[5] || '00'}:00+08:00`, from: who ? who[1].trim().slice(0, 20) : LEAD(), kind: 'note', imported: true, lines: [l.replace(/^## /, '')] };
      continue;
    }
    if (cur) cur.lines.push(l);
  }
  push();
  out.forEach((e, i) => { e.id = `c-${String(i).padStart(5, '0')}`; });
  return out;
}
function cmdMigrate(args) {
  ensureHome();
  const report = [];
  if (args.decisions) {
    const md = fs.readFileSync(String(args.decisions), 'utf8');
    fs.copyFileSync(String(args.decisions), p('archive', `decisions.${Date.now()}.md`));
    const { decisions, relations } = parseDecisions(md);
    const overrides = readJson(p('decision-overrides.json'), []) || [];
    const byId = Object.fromEntries(decisions.map((d) => [d.id, d]));
    for (const o of overrides) {
      const d = byId[o.id]; if (!d) { report.push(`  override for missing ${o.id}`); continue; }
      if (o.supersededBy) { d.status = 'superseded'; d.supersededBy = o.supersededBy; delete d.partlyBy; }
      if (o.partlyBy) d.partlyBy = o.partlyBy.length ? o.partlyBy : undefined;
    }
    let n = 0;
    for (const d of decisions) { if (!args.force && fs.existsSync(decisionFile(d.id))) continue; writeJson(decisionFile(d.id), d); n++; }
    report.push(`decisions: ${decisions.length} parsed, ${n} written`);
    const headings = (md.match(/^## D-\d+/gm) || []).map((h) => `D-${h.slice(5).padStart(2, '0')}`);
    const cards = fs.readdirSync(p('decisions')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((id) => id !== 'D-early');
    const onlyMd = headings.filter((h) => !cards.includes(h)); const onlyCards = cards.filter((c) => !headings.includes(c));
    const dupes = headings.filter((h, i) => headings.indexOf(h) !== i);
    report.push(`  re-sync: ${headings.length} '## D-xx' headings, ${cards.length} D-xx cards (+ D-early); only in decisions.md: ${onlyMd.join(' ') || '-'}; only as cards: ${onlyCards.join(' ') || '-'}; duplicate headings: ${dupes.join(' ') || '-'}`);
    report.push(`  without verbatim words: ${decisions.filter((d) => d.noWords).map((d) => d.id).join(' ') || '-'}`);
    report.push(`  superseded (auto): ${decisions.filter((d) => d.status === 'superseded').map((d) => `${d.id}→${d.supersededBy}`).join(' ') || '-'}`);
    report.push(`  partly changed (auto): ${decisions.filter((d) => d.partlyBy).map((d) => `${d.id}←${d.partlyBy.join('/')}`).join(' ') || '-'}`);
    report.push(`  relation hints: ${relations.length}`);
  }
  if (args.board) {
    const md = fs.readFileSync(String(args.board), 'utf8');
    fs.copyFileSync(String(args.board), p('archive', `board.${Date.now()}.md`));
    const { live: all, skipped } = parseBoard(md);
    const since = String(args.since || (() => { const d = new Date(Date.now() - 3 * 86400000); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })());
    const live = all.filter((r) => r.latestDate && r.latestDate >= since);
    const stale = all.length - live.length;
    let n = 0;
    for (const row of live) {
      const id = `m-${crypto.createHash('sha1').update(row.section + '\n' + row.title).digest('hex').slice(0, 8)}`;
      if (!args.force && fs.existsSync(p('board', `${id}.json`))) continue;
      const card = { id, owner: guessOwner(row.owner || row.status), ownerRaw: clip(row.owner || row.status, 60), title: clip(row.title, LIMIT.boardTitle),
        status: clip(row.status || '', LIMIT.boardStatus), now: clip(row.latest || '（舊看板沒寫）', LIMIT.boardNow), next: clip(row.next || '', LIMIT.boardNext),
        section: row.section, migrated: true, updatedAt: nowIso() };
      writeJson(p('board', `${id}.json`), card); n++;
    }
    report.push(`board: ${live.length} rows updated since ${since} kept (one card each, marked 待負責人改寫); ${stale} unfinished rows not touched since ${since} and ${skipped.done} finished rows left in the archive; ${n} written`);
  }
  if (args.coordination) {
    const md = fs.readFileSync(String(args.coordination), 'utf8');
    fs.copyFileSync(String(args.coordination), p('archive', `coordination.${Date.now()}.md`));
    const entries = parseCoordination(md);
    const file = p('log', 'imported-coordination.jsonl');
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    const by = {}; for (const e of entries) by[e.from] = (by[e.from] || 0) + 1;
    const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', ');
    report.push(`coordination: ${entries.length} entries imported (re-import replaces them); by author: ${top}; span ${entries.map((e) => e.at).sort()[0]} … ${entries.map((e) => e.at).sort().slice(-1)[0]}`);
  }
  logEvent({ type: 'migrated', report });
  console.log(report.join('\n'));
}

// ---------- main ----------
const HELP = `desk — 決策台（本機）
  desk serve [--port 7801]          啟動頁面（只綁 127.0.0.1）
  desk open                         在瀏覽器開頁面（不印 token）
  desk tailscale on|off             讓 Tailscale 網路裡的裝置也能連（重啟服務後生效）
  desk register [--hook] [--id …]   依專案資料夾登記這個 session（SessionStart hook 用；不屬於任何專案就不做事）
  desk pair                         產生 6 位數配對碼，給手機登入用（5 分鐘、一次）
  desk ask --from <id> --title … [--kind decide|act] [--approval] [--context … | --context-file f]
           --option key=標籤[|說明] … [--recommend key] [--why …] [--notify id,id] [--id …]
  desk notify <askId> [--add id,id] [--remove id]   回覆也要送給誰
  desk wait --session <id> [--timeout 秒] [--peek]   等 owner 回覆你問的事（背景用）
  desk wait --ask <askId> [--session 你的 id]           只等這一題
  desk wait --all --as <主控 id>                       等任何回覆（主控記錄用）
  desk ask --update <askId> [--title …] [--context …] [--option …] [--recommend …] [--why …] [--notify …]   owner 回覆前改內容
  desk withdraw <askId> --reason "…"   撤回（不用問了）
  desk close <askId> --outcome "…"
  desk list [--open] [--from id]
  desk board list | set <id> --owner id --title … --now … [--next …] [--waiting …] [--waits-on askId,…] [--status …] [--by 你的 id] | rm <id>
  desk decide D-12 --title … --words … [--point …]×≤3 [--where …] [--supersedes D-x] [--partly-supersedes D-y]
  desk decision list | supersede D-x --by D-y [--partial] | reactivate D-x
  desk log --from <id> [--topic …] (--text … | --text-file f | --stdin)   寫一筆日誌（≤3000 字）
  desk log list [--from id] [--day 2026-11-17] [--q 字] [--limit 30]
  desk watch --as <id> [--kinds board,note,ask,answer,decision] [--not-from <id>] [--timeout 秒]   等別人更新看板／日誌（背景用）
  desk export [--out 資料夾] [--auto on|off]   產生唯讀的 board.md／decisions.md／log.md
  desk freeze-md <檔案>… [--note …]   在舊檔最上面加「歷史紀錄，不再更新」
  desk backup [--setup <私人 git repo 資料夾>] [--every 分鐘]   備份到私人 GitHub repo（服務每小時自動跑）
  desk org show | node <id> [--now …] [--name …] [--tmux …] [--line engine|quality|product] [--parent id] [--lead] | load f.json
  desk migrate [--decisions decisions.md] [--board board.md] [--coordination coordination.md] [--force]
  資料夾：${HOME}`;
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  try {
    switch (cmd) {
      case 'serve': return serve(args);
      case 'open': return cmdOpen(args);
      case 'ask': return cmdAsk(args);
      case 'wait': process.exitCode = await cmdWait(args); return;
      case 'close': return cmdClose(args);
      case 'withdraw': return cmdWithdraw(args);
      case 'notify': return cmdNotify(args);
      case 'list': return cmdList(args);
      case 'board': return cmdBoard(args);
      case 'decide': return cmdDecide(args);
      case 'decision': return cmdDecision(args);
      case 'org': return cmdOrg(args);
      case 'log': return cmdLog(args);
      case 'watch': process.exitCode = await cmdWatch(args); return;
      case 'export': return cmdExport(args);
      case 'freeze-md': return cmdFreeze(args);
      case 'backup': return cmdBackup(args);
      case 'register':
        try { let timer; await Promise.race([cmdRegister(args), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), 1500); timer.unref(); })]); clearTimeout(timer); }
        catch (e) { if (!args.hook) throw e; }
        if (args.hook) process.exitCode = 0;
        return;
      case 'tailscale': return cmdTailscale(args);
      case 'pair': return cmdPair(args);
      case 'migrate': return cmdMigrate(args);
      default: console.log(HELP); if (cmd && cmd !== 'help') process.exitCode = 2;
    }
  } catch (e) {
    if (e instanceof UsageError) { console.error(`desk: ${e.message}`); process.exitCode = 2; return; }
    throw e;
  }
}
main();
