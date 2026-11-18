// Desk. Everything from the server is rendered as plain text.
(function () {
  'use strict';
  const VIEWS = ['home', 'org', 'board', 'decisions', 'log'];
  const S = { data: null, view: 'home', filter: null, picks: {}, sending: {}, notes: {}, ctxOpen: {}, compose: {}, editing: {}, full: {}, images: {}, uploading: {}, q: '', showSuperseded: false };
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  const draftKey = (id) => 'desk-draft:' + id;
  const loadDraft = (id) => { try { return localStorage.getItem(draftKey(id)) || ''; } catch (e) { return ''; } };
  const saveDraft = (id, v) => { try { if (v) localStorage.setItem(draftKey(id), v); else localStorage.removeItem(draftKey(id)); } catch (e) {} };

  // ---------- helpers ----------
  const pad = (n) => String(n).padStart(2, '0');
  function fmt(iso) {
    if (!iso) return '';
    const d = new Date(iso); if (isNaN(d)) return String(iso);
    const same = d.toDateString() === new Date().toDateString();
    return (same ? '' : (d.getMonth() + 1) + '/' + d.getDate() + ' ') + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function ago(iso) {
    const ms = Date.now() - new Date(iso).getTime(); if (!(ms >= 0)) return '';
    const m = Math.round(ms / 60000); if (m < 1) return ''; if (m < 60) return m + ' 分鐘';
    const h = Math.round(m / 60); if (h < 48) return h + ' 小時';
    return Math.round(h / 24) + ' 天';
  }
  const nodes = () => (S.data && S.data.org && S.data.org.nodes) || [];
  const node = (id) => nodes().find((n) => n.id === id);
  const label = (id) => { if (S.data && id === S.data.owner) return '你'; const n = node(id); return n ? (n.tmux || n.name || id) : (id || ''); };
  const short = (id) => { const t = label(id); const m = /「(.+?)」/.exec(t); return m ? m[1] : t; };
  // ---------- grouping by the owner's tmux sessions ----------
  const sessOf = (tmux) => { const m = /^([^「]+)「/.exec(String(tmux || '')); return m ? m[1].trim() : ''; };
  const winOf = (tmux) => { const m = /「(.+?)」/.exec(String(tmux || '')); return m ? m[1] : String(tmux || ''); };
  const gFromTmux = (tmux) => { const m = S.data.groupFromTmux || {}; return m[sessOf(tmux)] || sessOf(tmux); };
  const groupOfNode = (n) => n.group || gFromTmux(n.tmux) || n.line || '';
  const seenRecently = (id) => { const at = (S.data.seen || {})[id]; return at && (Date.now() - new Date(at).getTime()) < 6 * 3600 * 1000; };
  function groups() {
    if (S.data.groups && S.data.groups.length) return S.data.groups.map((g) => ({ key: g.key, label: g.label, note: g.note, bySession: true }));
    return ((S.data.org || {}).lines || []).map((l) => ({ key: l.key, label: l.label, note: l.note, bySession: false }));
  }
  function membersOf(g) {
    const running = S.data.running || [];
    const idx = (tmux) => { const r = running.find((x) => x.tmux.replace(/\s+/g, '') === String(tmux || '').replace(/\s+/g, '')); return r ? r.index : 999; };
    let list;
    if (g.bySession) {
      list = nodes().filter((n) => n.line !== 'root' && groupOfNode(n) === g.key).map((n) => ({ node: n, tmux: n.tmux || n.where || '', index: idx(n.tmux), running: idx(n.tmux) !== 999 || seenRecently(n.id) }));
      for (const r of running.filter((x) => gFromTmux(x.tmux) === g.key)) {
        if (!list.some((m) => String(m.tmux || '').replace(/\s+/g, '') === r.tmux.replace(/\s+/g, ''))) list.push({ node: null, tmux: r.tmux, index: r.index, running: true, agent: r.agent });
      }
    } else list = nodes().filter((n) => n.line === g.key).map((n) => ({ node: n, tmux: n.tmux, index: 0, running: true }));
    return list.sort((a, b) => a.index - b.index);
  }
  function groupOfFrom(from) { const n = node(from); if (!n) return ''; const gs = groups(); return gs.length && gs[0].bySession ? groupOfNode(n) : n.line; }
  function askState(a) { if (a.status === 'closed' || a.status === 'withdrawn') return 'closed'; return S.data.answers[a.id] ? 'answered' : 'open'; }
  const openAsks = () => S.data.asks.filter((a) => askState(a) === 'open');
  const match = (from) => !S.filter || from === S.filter;
  function waitsOwner(t) { return Boolean(t) && (t.includes('你') || (S.data.owner && t.includes(S.data.owner))); }
  function hotWaits(c) { return (c.waitsOn || []).some((id) => { const x = S.data.asks.find((y) => y.id === id); return x && askState(x) === 'open'; }); }
  // Only open asks count as "waiting on you"; board cards light up on the board itself.
  function waitingFor(id) { return openAsks().filter((a) => a.from === id).length; }

  // ---------- navigation ----------
  function setView(v) {
    let [base, arg] = String(v || '').split('/'); if (base === 'talk') base = 'org'; // the old 對話 page now lives in 組織
    S.view = VIEWS.includes(base) ? base : 'home';
    if (S.view === 'org' && arg) { try { selectTalk(decodeURIComponent(arg), true); } catch (e) {} }
    if (S.view === 'org') loadConvos();
    for (const name of VIEWS) $('view-' + name).hidden = name !== S.view;
    for (const a of document.querySelectorAll('.nav')) { if (a.dataset.view === S.view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
    if (S.view === 'log' && !L.loaded) loadLog(false);
  }
  window.addEventListener('hashchange', () => { setView(location.hash.slice(1)); window.scrollTo(0, 0); });

  // ---------- home ----------
  function renderHero() {
    const open = openAsks().filter((a) => match(a.from));
    const d = new Date(S.data.now || Date.now());
    const wk = '日一二三四五六'[d.getDay()];
    $('hero-date').textContent = (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 · 週' + wk + (S.filter ? ' · 只看 ' + label(S.filter) : '');
    const num = $('hero-num'); num.textContent = String(open.length); num.classList.toggle('zero', open.length === 0);
    $('hero-label').textContent = open.length ? '件事等你' : '件事等你，可以休息一下';
    let sub;
    if (open.length) {
      const oldest = open.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
      const whos = Array.from(new Set(open.map((a) => short(a.from))));
      const w = ago(oldest.createdAt);
      sub = '來自 ' + whos.join('、') + '。' + (w ? '最久的一件已經等了 ' + w + '。' : '剛剛才送來。');
    } else sub = '新的問題會出現在這裡；你回覆後，提問的 session 幾秒內就收到。';
    $('hero-sub').textContent = sub;
    const n = openAsks().length; $('nav-count').hidden = !n; $('nav-count').textContent = String(n);
  }
  function renderTrail() {
    const host = $('trail'); host.textContent = '';
    for (const g of groups()) {
      const members = membersOf(g);
      if (!members.length) continue;
      const lane = el('div', 'lane'); lane.append(el('div', 'lane-name', g.label));
      const row = el('div', 'stones');
      for (const m of members) {
        const n = m.node;
        const w = n ? waitingFor(n.id) : 0;
        const unreg = !n || (n.unregistered && !n.name);
        const b = el('button', 'stone' + (n && n.lead ? ' lead' : '') + (w ? ' waiting' : '') + (n && S.filter === n.id ? ' selected' : '') + (unreg ? ' unreg' : '') + (!m.running ? ' idle' : ''));
        b.type = 'button';
        const primary = winOf(m.tmux) || (n && n.id) || '';
        const secondary = n?.name || (m.agent === 'codex' ? 'Codex · 未登記' : '未登記');
        b.title = [m.tmux || primary, secondary, n?.now, !n && '還沒登記：請它用 desk org node 登記', !m.running && '現在沒在跑'].filter(Boolean).join('\n');
        b.setAttribute('aria-label', (m.tmux || primary) + '，' + secondary + (w ? '，' + w + ' 件等你' : ''));
        b.append(el('span', 's1', primary), el('span', 's2', secondary));
        if (w) b.append(el('span', 'blaze-count', String(w)));
        if (n) { b.setAttribute('aria-pressed', String(S.filter === n.id)); b.addEventListener('click', () => { S.filter = S.filter === n.id ? null : n.id; render(); }); }
        else b.disabled = true;
        row.append(b);
      }
      lane.append(row); host.append(lane);
    }
    $('trail-note').hidden = true;
    $('filter-note').hidden = !S.filter;
    $('filter-label').textContent = S.filter ? '只看 ' + label(S.filter) + ' 的事' : '';
    $('filter-talk').href = '#org/' + encodeURIComponent(S.filter || '');
  }

  const IMG_OK = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  const imgUrl = (id) => '/api/image/' + encodeURIComponent(id);
  async function attachImages(askId, files) {
    const list = S.images[askId] || (S.images[askId] = []);
    for (const f of files) {
      if (!IMG_OK.includes(f.type)) { S.notes[askId] = { err: true, text: '只能貼 PNG、JPG、WebP、GIF 圖片。' }; continue; }
      if (f.size > 10 * 1024 * 1024) { S.notes[askId] = { err: true, text: '圖片太大（上限 10 MB）。' }; continue; }
      if (list.length >= 6) { S.notes[askId] = { err: true, text: '一次最多 6 張圖。' }; break; }
      S.notes[askId] = { text: '上傳圖片中…' }; if (String(askId).startsWith('talk:')) C.dirty = true; render();
      S.uploading[askId] = (S.uploading[askId] || 0) + 1;
      try {
        const r = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': f.type }, body: f });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.id) S.notes[askId] = { err: true, text: j.message || ('圖片沒傳上去（' + r.status + '）。') };
        else { list.push(j.id); S.notes[askId] = null; S.compose[askId] = true; }
      } catch (e) { S.notes[askId] = { err: true, text: '圖片沒傳上去：服務沒有回應。' }; }
      S.uploading[askId] = Math.max(0, (S.uploading[askId] || 1) - 1);
    }
    if (String(askId).startsWith('talk:')) C.dirty = true;
    render();
  }
  const imageFiles = (dt) => Array.from((dt && dt.files) || []).filter((f) => f.type.startsWith('image/'));
  function thumbs(ids, removable, askId) {
    const row = el('div', 'thumbs');
    for (const id of ids) {
      const t = el('a', 'thumb'); t.href = imgUrl(id); t.target = '_blank'; t.rel = 'noopener'; t.title = '開新分頁看原圖';
      const img = el('img'); img.src = imgUrl(id); img.alt = '附圖'; img.loading = 'lazy'; t.append(img);
      if (removable) {
        const x = el('button', 'thumb-x', '×'); x.type = 'button'; x.setAttribute('aria-label', '拿掉這張圖');
        x.addEventListener('click', (e) => { e.preventDefault(); S.images[askId] = (S.images[askId] || []).filter((y) => y !== id); if (String(askId).startsWith('talk:')) C.dirty = true; render(); });
        t.append(x);
      }
      row.append(t);
    }
    return row;
  }
  document.addEventListener('paste', (e) => {
    const files = imageFiles(e.clipboardData); if (!files.length) return;
    if (e.target && e.target.tagName === 'TEXTAREA' && e.clipboardData.getData('text/plain')) return; // e.g. cells copied from a spreadsheet: keep the text
    const tc = e.target && e.target.closest ? e.target.closest('.talk-compose') : null;
    if (tc) { e.preventDefault(); attachImages(talkKey(tc.dataset.talk), files); return; }
    const card = e.target && e.target.closest ? e.target.closest('article.ask') : null;
    let a = card ? S.data.asks.find((x) => 'ask-' + x.id === card.id) : null;
    if (!a) { const vis = openAsks(); if (vis.length === 1) a = vis[0]; }
    if (!a || askState(a) === 'closed' || (askState(a) === 'answered' && !S.editing[a.id])) return;
    e.preventDefault(); attachImages(a.id, files);
  });
  async function sendAnswer(a) {
    if (S.sending[a.id]) return;
    if (S.uploading[a.id]) { S.notes[a.id] = { err: true, text: '圖片還在上傳，等它傳完再送。' }; render(); return; }
    const choice = S.picks[a.id] || null;
    const text = loadDraft(a.id).trim();
    const images = S.images[a.id] || [];
    if (!choice && !text && !images.length) { S.notes[a.id] = { err: true, text: '先選一個選項，或寫一句話。' }; render(); return; }
    S.sending[a.id] = true; S.notes[a.id] = { text: '送出中…' }; render();
    try {
      const r = await fetch('/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ askId: a.id, choice, text, images }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) S.notes[a.id] = { err: true, text: j.message || ('沒送出去（' + r.status + '）。') };
      else { saveDraft(a.id, ''); S.images[a.id] = []; S.notes[a.id] = null; S.editing[a.id] = false; S.compose[a.id] = false; }
    } catch (e) { S.notes[a.id] = { err: true, text: '沒送出去：服務沒有回應。' }; }
    S.sending[a.id] = false; await refresh();
  }
  function controls(a) {
    const box = el('div', 'compose'); box.tabIndex = -1;
    box.addEventListener('dragover', (e) => { if (Array.from(e.dataTransfer.items || []).some((i) => i.kind === 'file')) { e.preventDefault(); box.classList.add('dragover'); } });
    box.addEventListener('dragleave', () => box.classList.remove('dragover'));
    box.addEventListener('drop', (e) => { box.classList.remove('dragover'); const f = imageFiles(e.dataTransfer); if (f.length) { e.preventDefault(); attachImages(a.id, f); } });
    const ans = S.data.answers[a.id];
    if (S.picks[a.id] === undefined && ans && ans.choice) S.picks[a.id] = ans.choice;
    if ((a.options || []).length) {
      const opts = el('div', 'opts');
      for (const o of a.options) {
        const b = el('button', 'opt' + (o.key === a.recommend ? ' recommended' : '') + (S.picks[a.id] === o.key ? ' chosen' : ''));
        b.type = 'button'; b.setAttribute('aria-pressed', String(S.picks[a.id] === o.key));
        if (o.key === a.recommend) b.append(el('span', 'rtag', '建議'));
        b.append(el('span', null, o.label)); if (o.note) b.append(el('small', null, o.note));
        b.addEventListener('click', () => { S.picks[a.id] = S.picks[a.id] === o.key ? null : o.key; render(); });
        opts.append(b);
      }
      box.append(opts);
    }
    const draft = loadDraft(a.id);
    const showText = S.compose[a.id] || Boolean(draft) || !(a.options || []).length;
    if (showText) {
      const ta = el('textarea'); ta.id = 'reply-' + a.id; ta.placeholder = '想補充的話（可留空）'; ta.value = draft;
      ta.placeholder = '想補充的話（可留空）；也可以直接貼上圖片'; ta.setAttribute('aria-label', '回覆：' + a.title);
      ta.addEventListener('input', () => saveDraft(a.id, ta.value));
      box.append(ta);
    }
    if ((S.images[a.id] || []).length) box.append(thumbs(S.images[a.id], true, a.id));
    const row = el('div', 'send-row');
    const btn = el('button', 'send', ans ? '送出新的回覆' : '送出'); btn.type = 'button'; btn.disabled = Boolean(S.sending[a.id]);
    btn.addEventListener('click', () => sendAnswer(a)); row.append(btn);
    const pick = el('input'); pick.type = 'file'; pick.accept = IMG_OK.join(','); pick.multiple = true; pick.hidden = true;
    pick.addEventListener('change', () => { const f = Array.from(pick.files || []); if (f.length) attachImages(a.id, f); });
    const pb = el('button', 'text-btn', '＋ 附圖'); pb.type = 'button'; pb.title = '也可以直接 Ctrl+V 貼上，或把圖片拖進來'; pb.addEventListener('click', () => pick.click());
    if (!showText) { const t = el('button', 'text-btn', '＋ 補充一句'); t.type = 'button'; t.addEventListener('click', () => { S.compose[a.id] = true; render(); const x = $('reply-' + a.id); if (x) x.focus(); }); row.append(t); }
    row.append(pb, pick);
    if (ans) { const c = el('button', 'text-btn', '取消'); c.type = 'button'; c.addEventListener('click', () => { S.editing[a.id] = false; render(); }); row.append(c); }
    const n = S.notes[a.id]; if (n) row.append(el('span', 'note' + (n.err ? ' err' : ''), n.text));
    box.append(row);
    return box;
  }
  function askCard(a, compact) {
    const st = askState(a); const ans = S.data.answers[a.id];
    const card = el('article', 'ask ' + st); card.id = 'ask-' + a.id;
    const meta = el('div', 'ask-meta');
    meta.append(el('span', 'who', label(a.from)));
    if (!compact) meta.append(el('span', 'tag' + (a.kind === 'act' ? ' act' : ''), a.kind === 'act' ? '要你動手' : '要你決定'));
    if (a.approval && !compact) meta.append(el('span', 'tag approval', '正式核准'));
    meta.append(el('span', 'time', st === 'open' ? (ago(a.createdAt) ? '等了 ' + ago(a.createdAt) : '剛剛') : fmt(a.closedAt || a.createdAt)));
    card.append(meta);
    card.append(el('h3', null, a.title));
    if (st === 'closed') { if (a.status === 'withdrawn') meta.append(el('span', 'tag', '撤回')); if (a.outcome) card.append(el('div', 'outcome', a.outcome)); return card; }
    if (st === 'answered' && !S.editing[a.id]) {
      const mine = el('div', 'my-answer'); mine.append(el('b', null, '你回覆了'), [ans.choiceLabel, ans.text].filter(Boolean).join('：') || '（只附圖）');
      if ((ans.images || []).length) mine.append(thumbs(ans.images, false));
      card.append(mine);
      const recips = [a.from].concat(a.notify || []); const got = (S.data.deliveredTo && S.data.deliveredTo[a.id]) || [];
      const tags = el('div', 'ask-meta');
      for (const r of recips) tags.append(el('span', 'tag ' + (got.includes(r) ? 'ok' : 'pending'), got.includes(r) ? '已送達 ' + short(r) : '等 ' + short(r) + ' 讀取'));
      const edit = el('button', 'text-btn', '改回覆'); edit.type = 'button'; edit.addEventListener('click', () => { S.editing[a.id] = true; render(); });
      tags.append(edit); card.append(tags);
      return card;
    }
    if (a.context) {
      const long = a.context.length > 110 || a.context.split('\n').length > 3;
      card.append(el('div', 'ctx' + (S.ctxOpen[a.id] || !long ? ' open' : ''), a.context));
      if (long) { const t = el('button', 'text-btn', S.ctxOpen[a.id] ? '收起背景' : '看完整背景'); t.type = 'button'; t.addEventListener('click', () => { S.ctxOpen[a.id] = !S.ctxOpen[a.id]; render(); }); card.append(t); }
    }
    if (a.recommendText || a.recommend) {
      const rec = el('div', 'rec');
      const opt = (a.options || []).find((o) => o.key === a.recommend);
      rec.append(el('b', null, '建議' + (opt ? '：' + opt.label : '')), el('span', null, a.recommendText || ''));
      card.append(rec);
    }
    card.append(controls(a));
    return card;
  }
  function renderHome() {
    renderHero(); renderTrail();
    const open = openAsks().filter((a) => match(a.from)).sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)));
    const host = $('asks'); host.textContent = '';
    const gs = groups();
    if (open.length && gs.length > 1 && !S.filter) {
      const used = new Set();
      for (const g of gs.concat([{ key: '', label: '其他' }])) {
        const items = open.filter((a) => (groupOfFrom(a.from) || '') === g.key && !used.has(a.id));
        if (!items.length) continue;
        items.forEach((a) => used.add(a.id));
        const head = el('h2', 'group-h'); head.append(el('span', null, g.label), el('em', null, String(items.length))); host.append(head);
        items.forEach((a) => host.append(askCard(a)));
      }
    } else if (!open.length) {
      const e = el('div', 'empty-state');
      e.append(el('strong', null, S.filter ? short(S.filter) + ' 沒有等你的事' : '都處理完了'), el('span', null, S.filter ? '點上面的石頭換一個人，或看全部。' : '有新的問題時，這裡會出現一張卡。'));
      host.append(e);
    } else if (!(open.length && gs.length > 1 && !S.filter)) open.forEach((a) => host.append(askCard(a)));
    const answered = S.data.asks.filter((a) => askState(a) === 'answered' && match(a.from)).sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
    $('answered-block').hidden = !answered.length;
    const ah = $('answered'); ah.textContent = ''; answered.forEach((a) => ah.append(askCard(a)));
    const done = S.data.asks.filter((a) => askState(a) === 'closed' && match(a.from)).sort((x, y) => String(y.closedAt || y.createdAt).localeCompare(String(x.closedAt || x.createdAt)));
    $('count-done').textContent = String(done.length);
    const dh = $('done'); dh.textContent = ''; done.slice(0, 40).forEach((a) => dh.append(askCard(a, true)));
  }

  // ---------- org ----------
  function renderOrg() { /* the org chart is drawn by renderTalkList (tree + conversation) */ }
  function renderUnplaced() {
    const box = $('unplaced'); box.textContent = '';
    const list = (groups()[0] || {}).bySession ? [] : (S.data.unplaced || []);
    box.hidden = !list.length; if (!list.length) return;
    box.append(el('h3', null, '還沒放進組織圖的 session（' + list.length + '）'));
    box.append(el('p', null, '這些視窗正在跑 Claude Code 或 Codex，但組織圖上沒有它們。請負責那條線的主控用 desk org node 補上（名字、負責什麼、屬於哪條線）。'));
    const ul = el('ul'); list.forEach((d) => ul.append(el('li', null, d.tmux + (d.agent === 'codex' ? '（Codex）' : '')))); box.append(ul);
  }
  // ---------- feed (recent activity) ----------
  const F = { busy: false };
  const wide = window.matchMedia('(min-width: 1400px)');
  wide.addEventListener('change', loadFeed);
  async function loadFeed() {
    if (F.busy || !wide.matches || !S.data) return; F.busy = true;
    try { const r = await fetch('/api/log?limit=14', { cache: 'no-store' }); const j = await r.json(); renderFeed(j.entries || []); } catch (e) {}
    F.busy = false;
  }
  function renderFeed(entries) {
    const host = $('feed'); host.textContent = '';
    if (!entries.length) { host.append(el('li', 'note', '還沒有動態。')); return; }
    for (const e of entries) {
      const li = el('li', 'f-' + (e.kind || 'note'));
      const m = el('div', 'f-meta'); m.append(el('span', 'time', fmt(e.at)), el('span', null, e.from === S.data.owner ? '你' : short(e.from)), el('span', null, KIND[e.kind] || '日誌'));
      li.append(m, el('div', 'f-text', String(e.text).replace(/\*\*/g, '').split('\n').slice(0, 2).join(' ')));
      host.append(li);
    }
  }

  // ---------- board ----------
  function renderBoard() {
    const host = $('board-cols'); host.textContent = '';
    const cards = S.data.board;
    const lineOf = (c) => (node(c.owner) || {}).line || 'other';
    const lines = ((S.data.org || {}).lines || []).map((l) => [l.key, l.label]).concat([['other', '其他']]);
    for (const [key, name] of lines) {
      const items = cards.filter((c) => lineOf(c) === key).sort((a, b) => (hotWaits(b) ? 1 : 0) - (hotWaits(a) ? 1 : 0) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
      if (!items.length) continue;
      const col = el('section', 'col'); const h = el('h3', null, name); h.append(el('span', null, String(items.length))); col.append(h);
      for (const c of items) {
        const hot = waitsOwner(c.waitingOn) || hotWaits(c);
        const b = el('article', 'bcard' + (hot ? ' hot' : ''));
        const top = el('div', 'b-top'); top.append(el('span', 'who', short(c.owner)), el('span', 'time', (c.status ? c.status + ' · ' : '') + fmt(c.updatedAt)));
        b.append(top, el('div', 'b-title', c.title), el('div', 'b-now', c.now || ''));
        const more = el('div', 'b-more');
        if (c.next) { const r = el('div'); r.append(el('span', 'k', '下一步'), c.next); more.append(r); }
        if (c.waitingOn) { const r = el('div'); r.append(el('span', 'k', '等'), c.waitingOn); more.append(r); }
        if (more.childNodes.length) b.append(more);
        for (const askId of (c.waitsOn || [])) {
          const ask = S.data.asks.find((x) => x.id === askId);
          const link = el('button', 'b-waits', (ask && askState(ask) === 'open' ? '等你回覆：' : '已回覆：') + (ask ? ask.title : askId)); link.type = 'button';
          link.addEventListener('click', () => { location.hash = '#home'; setTimeout(() => { const t = $('ask-' + askId); if (t) { t.scrollIntoView({ block: 'center' }); t.classList.add('flash'); setTimeout(() => t.classList.remove('flash'), 1400); } }, 60); });
          b.append(link);
        }
        if (c.migrated) b.append(el('div', 'b-stale', '舊看板搬來，等負責人改寫'));
        col.append(b);
      }
      host.append(col);
    }
  }

  // ---------- decisions ----------
  async function loadFull(id, box) {
    if (S.full[id]) { box.textContent = S.full[id]; return; }
    box.textContent = '載入中…';
    try { const r = await fetch('/api/decision/' + encodeURIComponent(id)); const j = await r.json(); S.full[id] = j.full || '（沒有額外的全文）'; box.textContent = S.full[id]; }
    catch (e) { box.textContent = '讀不到全文。'; }
  }
  function renderDecisions() {
    const host = $('decision-list'); host.textContent = '';
    const q = S.q.trim().toLowerCase();
    const list = S.data.decisions
      .filter((d) => S.showSuperseded || d.status !== 'superseded')
      .filter((d) => !q || [d.id, d.title, d.fullTitle, d.words, (d.points || []).join(' ')].join(' ').toLowerCase().includes(q))
      .sort((a, b) => (a.status === 'superseded') - (b.status === 'superseded') || b.num - a.num);
    if (!list.length) { const e = el('li', 'empty-state'); e.append(el('strong', null, '找不到'), el('span', null, '換個字搜尋看看。')); host.append(e); return; }
    for (const d of list) {
      const li = el('li', 'dec' + (d.status === 'superseded' ? ' superseded' : ''));
      const num = el('div', 'dec-num', d.id === 'D-early' ? '早' : String(d.num)); num.append(el('small', null, d.date || ''));
      const body = el('div', 'dec-body');
      body.append(el('h3', 'dec-title', d.title), el('p', 'dec-words' + (d.noWords ? ' nowords' : ''), d.words));
      const flags = el('div', 'dec-flags');
      if (d.status === 'superseded') flags.append(el('span', 'tag', '已被 ' + d.supersededBy + ' 取代'));
      if (d.partlyBy && d.partlyBy.length) flags.append(el('span', 'tag', '部分被 ' + d.partlyBy.join('、') + ' 修改'));
      if (d.where) flags.append(el('span', 'tag', d.where));
      if (flags.childNodes.length) body.append(flags);
      if ((d.points && d.points.length) || d.hasFull) {
        const det = el('details'); det.append(el('summary', null, '重點與全文'));
        if (d.points && d.points.length) { const ul = el('ul'); d.points.forEach((x) => ul.append(el('li', null, x))); det.append(ul); }
        if (d.hasFull) { const box = el('div', 'fulltext'); det.append(box); det.addEventListener('toggle', () => { if (det.open) loadFull(d.id, box); }); }
        body.append(det);
      }
      li.append(num, body); host.append(li);
    }
  }

  // ---------- log ----------
  const L = { entries: [], more: false, loaded: false, busy: false, q: '', from: '', day: '', open: {} };
  const KIND = { note: '日誌', ask: '提問', answer: '你的回覆', board: '看板', decision: '決定', message: '你傳話' };
  async function loadLog(append) {
    if (L.busy) return; L.busy = true;
    const params = new URLSearchParams({ limit: '50' });
    if (L.q) params.set('q', L.q); if (L.from) params.set('from', L.from); if (L.day) params.set('day', L.day);
    if (append && L.entries.length) { const last = L.entries[L.entries.length - 1]; params.set('before', last.at + '|' + last.id); }
    try { const r = await fetch('/api/log?' + params.toString(), { cache: 'no-store' }); const j = await r.json(); L.entries = append ? L.entries.concat(j.entries) : j.entries; L.more = j.more; L.loaded = true; }
    catch (e) {}
    L.busy = false; renderLog();
  }
  function renderLog() {
    const sel = $('log-from');
    if (sel.options.length <= 1 && S.data) {
      for (const n of nodes()) { if (n.line === 'root') continue; const o = el('option', null, label(n.id)); o.value = n.id; sel.append(o); }
      const o = el('option', null, '你'); o.value = S.data.owner || 'owner'; sel.append(o);
    }
    const host = $('log-list'); host.textContent = '';
    if (!L.loaded) { host.append(el('li', 'note', '載入中…')); return; }
    if (!L.entries.length) { const e = el('li', 'empty-state'); e.append(el('strong', null, '沒有符合的日誌')); host.append(e); }
    for (const e of L.entries) {
      const li = el('li', 'lentry k-' + (e.kind || 'note'));
      const m = el('div', 'l-meta'); m.append(el('span', 'time', fmt(e.at)), el('span', 'who', e.from === S.data.owner ? '你' : short(e.from)), el('span', null, KIND[e.kind] || '日誌'));
      if (e.topic) m.append(el('span', 'mono', e.topic));
      if (e.imported) m.append(el('span', null, '舊日誌'));
      const t = el('div', 'l-text' + (L.open[e.id] ? ' open' : ''), String(e.text).replace(/\*\*/g, ''));
      t.addEventListener('click', () => { L.open[e.id] = !L.open[e.id]; t.classList.toggle('open'); });
      li.append(m, t); host.append(li);
    }
    $('log-more').hidden = !L.more;
  }
  let logTimer = null;
  const relog = () => { clearTimeout(logTimer); logTimer = setTimeout(() => loadLog(false), 250); };
  $('log-q').addEventListener('input', (e) => { L.q = e.target.value.trim(); relog(); });
  $('log-from').addEventListener('change', (e) => { L.from = e.target.value; relog(); });
  $('log-day').addEventListener('change', (e) => { L.day = e.target.value; relog(); });
  $('log-more').addEventListener('click', () => loadLog(true));


  // ---------- talk: conversations with each session ----------
  const C = { list: null, sel: null, pages: [], cursor: null, lower: null, sid: '', listening: false, none: false, loading: false, err: '', open: {}, busyList: false, dirty: true, sig: '' };
  const talkKey = (id) => 'talk:' + id;
  async function loadConvos() {
    if (C.busyList || !S.data) return; C.busyList = true;
    try { const r = await fetch('/api/convos', { cache: 'no-store' }); if (r.ok) C.list = (await r.json()).convos || []; } catch (e) {}
    C.busyList = false; renderTalkList();
  }
  async function loadConvo(more) {
    if (!C.sel || C.loading) return;
    const id = C.sel; C.loading = true; if (more) { C.dirty = true; renderTalkPanel(); }
    try {
      // Older pages are tied to the same transcript (sid) and share one time boundary (until = the newer page's lower).
      const q = more && C.cursor != null ? '?before=' + encodeURIComponent(C.cursor) + (C.lower != null ? '&until=' + encodeURIComponent(C.lower) : '') + (C.sid ? '&sid=' + encodeURIComponent(C.sid) : '') : '';
      const r = await fetch('/api/convo/' + encodeURIComponent(id) + q, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (id !== C.sel) { C.loading = false; return; }
      if (r.status === 409 && more) { Object.assign(C, { pages: [], cursor: null, lower: null, sid: '', sig: '', loading: false }); return loadConvo(false); }
      if (!r.ok) { C.err = j.message || ('讀不到（' + r.status + '）'); C.dirty = true; }
      else if (more) { C.pages.push(j.turns || []); C.cursor = j.cursor; C.lower = j.lower; C.dirty = true; }
      else {
        const sig = JSON.stringify([j.turns, j.listening, j.cursor, j.none, j.sid]);
        if (sig !== C.sig) { C.sig = sig; C.pages = [j.turns || []]; C.cursor = j.cursor; C.lower = j.lower; C.sid = j.sid || ''; C.listening = Boolean(j.listening); C.none = Boolean(j.none); C.err = ''; C.dirty = true; }
      }
    } catch (e) { C.err = '服務沒有回應'; C.dirty = true; }
    C.loading = false; renderTalkPanel();
  }
  function selectTalk(id, fromHash) {
    if (C.sel === id) return;
    Object.assign(C, { sel: id, pages: [], cursor: null, lower: null, sid: '', err: '', none: false, sig: '', open: {}, dirty: true });
    if (!fromHash) history.replaceState(null, '', '#org/' + encodeURIComponent(id));
    renderTalkList(); renderTalkPanel(); loadConvo(false);
    const p = $('talk-panel'); if (p && window.matchMedia('(max-width: 1100px)').matches) window.scrollTo(0, 0);
  }
  // The org chart: a tree from the owner down (parent links), each card showing what that session is doing now.
  function renderTalkList() {
    const host = $('talk-list'); if (!host || !S.data) return; host.textContent = '';
    const by = Object.fromEntries((C.list || []).map((x) => [x.id, x]));
    const norm = (x) => String(x || '').replace(/\s+/g, '');
    const all = nodes(); const root = all.find((n) => n.line === 'root'); const kids = {};
    for (const n of all) { if (n === root) continue; const k = n.parent && all.some((m) => m.id === n.parent) ? n.parent : ''; (kids[k] = kids[k] || []).push(n); }
    const running = new Set((S.data.running || []).map((r) => norm(r.tmux)));
    const card = (n) => {
      const c = by[n.id] || {}; const w = waitingFor(n.id);
      const live = c.listening || (S.data.listening || []).includes(n.id);
      const up = running.has(norm(n.tmux)) || seenRecently(n.id);
      const b = el('button', 'oc' + (C.sel === n.id ? ' selected' : '') + (w ? ' waiting' : '') + (!up ? ' idle' : '')); b.type = 'button';
      const top = el('span', 'oc-top'); top.append(el('span', 'oc-name', winOf(n.tmux) || n.id));
      if (live) top.append(el('span', 'ti-live', '在聽'));
      if (w) top.append(el('span', 'oc-count', String(w)));
      top.append(el('span', 'ti-time', fmt(c.replyAt || c.at)));
      b.append(top, el('span', 'oc-role', n.name || ''));
      if (n.now) b.append(el('span', 'oc-now', n.now));
      b.title = [n.tmux || n.id, n.name, n.note, !up && '現在沒在跑'].filter(Boolean).join('\n');
      b.setAttribute('aria-current', String(C.sel === n.id));
      b.addEventListener('click', () => selectTalk(n.id));
      return b;
    };
    const branch = (pid) => { const list = kids[pid] || []; if (!list.length) return null; const ul = el('ul'); for (const n of list) { const li = el('li'); li.append(card(n)); const sub = branch(n.id); if (sub) li.append(sub); ul.append(li); } return ul; };
    const tree = el('div', 'tree');
    const top = el('div', 'tree-root'); top.append(el('span', 'oc-name', '你'), el('span', 'oc-role', 'owner · ' + (S.data.owner || '')));
    tree.append(top);
    const sub = root ? branch(root.id) : null; if (sub) tree.append(sub);
    host.append(tree);
    const loose = root ? (kids[''] || []) : [];
    const unreg = (S.data.running || []).filter((r) => !all.some((n) => norm(n.tmux) === norm(r.tmux)));
    if (loose.length || unreg.length) {
      host.append(el('div', 'talk-group', '還沒放進組織圖的'));
      loose.forEach((n) => host.append(card(n)));
      unreg.forEach((r) => host.append(el('div', 'oc unreg-row', r.tmux + (r.agent === 'codex' ? '（Codex）' : '') + ' · 未登記')));
    }
    if (!C.list) host.append(el('p', 'note', '讀取對話中…'));
  }
  function placeBox(n) {
    const box = el('div', 'place');
    const row = (k, v) => { if (!v) return; const d = el('div', 'place-row'); d.append(el('span', 'place-k', k), el('span', 'place-v', v)); box.append(d); };
    const par = n.parent ? node(n.parent) : null;
    row('向誰報告', !par || par.line === 'root' ? '你' : (par.tmux || par.id) + (par.name ? '（' + par.name + '）' : ''));
    row('帶', nodes().filter((x) => x.parent === n.id).map((x) => winOf(x.tmux) || x.id).join('、'));
    row('備註', n.note || '');
    row('現在', n.now || '');
    return box;
  }
  function renderRules() {
    const rules = (S.data && S.data.rules) || []; const box = $('org-rules'); if (!box) return;
    box.hidden = !rules.length; const ol = $('org-rules-list'); ol.textContent = '';
    rules.forEach((r) => ol.append(el('li', null, r)));
    box.querySelector('summary').textContent = '聯絡規則（' + rules.length + ' 條，每個 session 開工時都會收到）';
  }
  function renderTalkPanel() {
    const host = $('talk-panel'); if (!host || !S.data) return;
    $('talk-wrap').classList.toggle('has-sel', Boolean(C.sel));
    if (!C.dirty) return; C.dirty = false;
    const active = document.activeElement && document.activeElement.id; const sel = active && document.activeElement.selectionStart;
    host.textContent = '';
    if (!C.sel) { host.append(el('div', 'talk-empty', '從左邊選一個 session。')); return; }
    const n = node(C.sel);
    const head = el('div', 'talk-head');
    const back = el('button', 'text-btn talk-back', '← 組織圖'); back.type = 'button';
    back.addEventListener('click', () => { C.sel = null; C.dirty = true; history.replaceState(null, '', '#org'); renderTalkList(); renderTalkPanel(); });
    const sub = el('div', 'talk-sub');
    sub.append(el('span', null, (n && n.name) || ''), el('span', 'talk-state ' + (C.listening ? 'on' : 'off'), C.listening ? '在聽：你說的話幾秒內會送到' : '現在沒在聽：要等它下次掛上 desk wait 才收得到'));
    head.append(back, el('h3', null, n ? (n.tmux || n.id) : C.sel), sub);
    host.append(head);
    if (n) host.append(placeBox(n));
    host.append(talkCompose(C.sel));
    if (C.err) host.append(el('p', 'note err', C.err));
    if (!C.pages.length && C.loading) host.append(el('p', 'note', '讀取中…'));
    if (C.none) host.append(el('p', 'note', '還接不到這個 session 的對話紀錄。它下次用 desk（例如掛上 desk wait）時就會接上。'));
    const turns = [].concat(...C.pages.map((pg) => pg.slice().reverse()));
    turns.forEach((t, i) => host.append(turnView(t, i === 0)));
    if (C.cursor != null) {
      const more = el('button', 'more-btn', C.loading ? '讀取中…' : '看更早的對話'); more.type = 'button'; more.disabled = C.loading;
      more.addEventListener('click', () => loadConvo(true)); host.append(more);
    }
    if (active) { const b = document.getElementById(active); if (b && b.tagName === 'TEXTAREA') { b.focus(); try { if (sel != null) b.setSelectionRange(sel, sel); } catch (e) {} } }
  }
  function turnView(t, latest) {
    const key = t.at + '|' + (t.msgId || '');
    const box = el('article', 'turn' + (latest ? ' latest' : ''));
    const meta = el('div', 'turn-meta'); meta.append(el('span', 'time', fmt(t.at)));
    if (t.you != null) meta.append(el('span', 'who', t.source === 'desk' ? '你從 desk 說' : '你說'));
    else meta.append(el('span', 'who trig', t.trigger || ''));
    if (t.source === 'desk') meta.append(el('span', 'tag ' + (t.delivered ? 'ok' : 'pending'), t.delivered ? '已送達' : '還沒送到'));
    box.append(meta);
    if (t.you != null) {
      const y = el('div', 'turn-you', t.you || ''); if (t.images) y.append(el('span', 'img-note', '（附圖 ' + t.images + ' 張）'));
      box.append(y); if ((t.deskImages || []).length) box.append(thumbs(t.deskImages, false));
    }
    const replies = t.replies || [];
    if (!replies.length) { box.append(el('div', 'turn-wait', t.source === 'desk' ? '還沒有回覆' : '（沒有文字回覆）')); return box; }
    const open = latest || C.open[key];
    const rep = el('div', 'turn-reply');
    rep.append(el('div', 'reply-label', replies.length > 1 ? '它的回覆（最後一段）' : '它的回覆'));
    const md = renderMd(replies[replies.length - 1].text);
    if (!open) { md.classList.add('clamped'); md.title = '點一下展開'; md.addEventListener('click', (e) => { if (e.target.closest('a, button')) return; C.open[key] = true; C.dirty = true; renderTalkPanel(); }); }
    rep.append(md); box.append(rep);
    if (replies.length > 1) {
      const k2 = key + '|steps'; const show = C.open[k2];
      const tg = el('button', 'text-btn steps-btn', show ? '收起過程' : '看過程中的 ' + (replies.length - 1) + ' 段說明'); tg.type = 'button';
      tg.addEventListener('click', () => { C.open[k2] = !show; C.dirty = true; renderTalkPanel(); });
      box.append(tg);
      if (show) { const st = el('div', 'steps'); for (const r of replies.slice(0, -1)) { const s1 = el('div', 'step'); s1.append(el('span', 'time', fmt(r.at)), renderMd(r.text)); st.append(s1); } box.append(st); }
    }
    return box;
  }
  function talkCompose(id) {
    const key = talkKey(id);
    const box = el('div', 'talk-compose'); box.tabIndex = -1; box.dataset.talk = id;
    const ta = el('textarea'); ta.id = 'talk-input-' + id; ta.placeholder = '跟它說…（可以直接貼上圖片）'; ta.value = loadDraft(key);
    ta.setAttribute('aria-label', '跟 ' + label(id) + ' 說');
    ta.addEventListener('input', () => saveDraft(key, ta.value));
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendTalk(id); } });
    box.append(ta);
    if ((S.images[key] || []).length) box.append(thumbs(S.images[key], true, key));
    const row = el('div', 'send-row');
    const btn = el('button', 'send', '送出'); btn.type = 'button'; btn.disabled = Boolean(S.sending[key]); btn.addEventListener('click', () => sendTalk(id));
    const pick = el('input'); pick.type = 'file'; pick.accept = IMG_OK.join(','); pick.multiple = true; pick.hidden = true;
    pick.addEventListener('change', () => { const f = Array.from(pick.files || []); if (f.length) attachImages(key, f); });
    const pb = el('button', 'text-btn', '＋ 附圖'); pb.type = 'button'; pb.addEventListener('click', () => pick.click());
    row.append(btn, pb, pick, el('span', 'hint', 'Ctrl+Enter 送出'));
    const nt = S.notes[key]; if (nt) row.append(el('span', 'note' + (nt.err ? ' err' : ''), nt.text));
    box.append(row);
    box.addEventListener('dragover', (e) => { if (Array.from(e.dataTransfer.items || []).some((i) => i.kind === 'file')) { e.preventDefault(); box.classList.add('dragover'); } });
    box.addEventListener('dragleave', () => box.classList.remove('dragover'));
    box.addEventListener('drop', (e) => { box.classList.remove('dragover'); const f = imageFiles(e.dataTransfer); if (f.length) { e.preventDefault(); attachImages(key, f); } });
    return box;
  }
  async function sendTalk(id) {
    const key = talkKey(id); if (S.sending[key]) return;
    if (S.uploading[key]) { S.notes[key] = { err: true, text: '圖片還在上傳，等它傳完再送。' }; C.dirty = true; renderTalkPanel(); return; }
    const text = loadDraft(key).trim(); const images = S.images[key] || [];
    if (!text && !images.length) { S.notes[key] = { err: true, text: '寫幾個字，或貼一張圖。' }; C.dirty = true; renderTalkPanel(); return; }
    S.sending[key] = true; S.notes[key] = { text: '送出中…' }; C.dirty = true; renderTalkPanel();
    try {
      const r = await fetch('/api/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: id, text, images }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) S.notes[key] = { err: true, text: j.message || ('沒送出去（' + r.status + '）。') };
      else { saveDraft(key, ''); S.images[key] = []; S.notes[key] = { text: j.listening ? '送出了，它幾秒內會收到。' : '送出了。它現在沒在聽，下次掛上 desk wait 時會收到。' }; }
    } catch (e) { S.notes[key] = { err: true, text: '沒送出去：服務沒有回應。' }; }
    S.sending[key] = false; C.sig = ''; C.dirty = true; await loadConvo(false);
  }
  // Markdown → DOM (no innerHTML). Paths to .md/.txt files open in the file viewer.
  const INLINE_SRC = '(`[^`\\n]{1,500}`)|(\\*\\*[^*\\n]{1,500}?\\*\\*)|\\[([^\\]\\n]{1,300})\\]\\((https?:\\/\\/[^)\\s]{1,500})\\)|(https?:\\/\\/[^\\s<>)）」』，。]{1,500})(?![^\\s<>)）」』，。])|(?<![\\w.~\\-\\/])((?:\\/[\\w.@+\\-\\u3400-\\u9fff]{1,120}){1,24}\\.(?:md|markdown|txt))(?![\\w])';
  function extLink(text, href) { const a = el('a', null, text); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; }
  function fileLink(fp) {
    const b = el('button', 'file-link', fp); b.type = 'button'; b.title = '在 desk 上打開這個檔案';
    b.addEventListener('click', (e) => { e.stopPropagation(); openFile(fp); }); return b;
  }
  function inline(parent, text) {
    if (text.length > 4000) { parent.append(document.createTextNode(text)); return; } // bounded work per line
    const re = new RegExp(INLINE_SRC, 'g'); let last = 0; let m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
      if (m[1]) { const code = m[1].slice(1, -1); parent.append(/^\/\S+\.(md|markdown|txt)$/.test(code) ? fileLink(code) : el('code', null, code)); }
      else if (m[2]) { const b = el('strong'); inline(b, m[2].slice(2, -2)); parent.append(b); }
      else if (m[3]) parent.append(extLink(m[3], m[4]));
      else if (m[5]) parent.append(extLink(m[5], m[5]));
      else if (m[6]) parent.append(fileLink(m[6]));
      last = re.lastIndex;
    }
    if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
  }
  function renderMd(src, depth = 0) {
    const root = el('div', 'md');
    if (depth > 5 || String(src || '').length > 400000) { const pre = el('pre'); pre.textContent = String(src || ''); root.append(pre); return root; }
    const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
    let i = 0; let para = [];
    const flush = () => { if (para.length) { const p = el('p'); para.forEach((l, k) => { if (k) p.append(el('br')); inline(p, l); }); root.append(p); para = []; } };
    const cells = (s) => s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    while (i < lines.length) {
      const L = lines[i]; let m;
      if ((m = /^\s*(```|~~~)/.exec(L))) { flush(); const buf = []; i++; while (i < lines.length && !lines[i].trim().startsWith(m[1])) { buf.push(lines[i]); i++; } i++; const pre = el('pre'); pre.append(el('code', null, buf.join('\n'))); root.append(pre); continue; }
      if ((m = /^(#{1,6})\s+(.*)$/.exec(L))) { flush(); const h = el('h' + Math.min(6, m[1].length + 3)); inline(h, m[2]); root.append(h); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(L)) { flush(); root.append(el('hr')); i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(L) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flush(); const tb = el('table'); const thead = el('thead'); const tr = el('tr');
        cells(L).forEach((c) => { const th = el('th'); inline(th, c); tr.append(th); }); thead.append(tr); tb.append(thead);
        const tbody = el('tbody'); i += 2;
        while (i < lines.length && /^\s*\|/.test(lines[i])) { const r = el('tr'); cells(lines[i]).forEach((c) => { const td = el('td'); inline(td, c); r.append(td); }); tbody.append(r); i++; }
        tb.append(tbody); const wrap = el('div', 'table-wrap'); wrap.append(tb); root.append(wrap); continue;
      }
      if (/^\s*>/.test(L)) { flush(); const buf = []; while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; } const bq = el('blockquote'); bq.append(renderMd(buf.join('\n'), depth + 1)); root.append(bq); continue; }
      if ((m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(L))) {
        flush(); const ordered = /\d/.test(m[2]); const list = el(ordered ? 'ol' : 'ul'); if (ordered) list.start = parseInt(m[2], 10) || 1;
        while (i < lines.length) {
          const mm = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (mm) { const li = el('li'); const lvl = Math.min(3, Math.floor(mm[1].replace(/\t/g, '  ').length / 2)); if (lvl) li.className = 'lvl-' + lvl; inline(li, mm[3]); list.append(li); i++; continue; }
          if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && list.lastChild) { list.lastChild.append(el('br')); inline(list.lastChild, lines[i].trim()); i++; continue; }
          break;
        }
        root.append(list); continue;
      }
      if (!L.trim()) { flush(); i++; continue; }
      para.push(L); i++;
    }
    flush(); return root;
  }
  async function openFile(fp) {
    const box = $('file-view'); box.hidden = false; box.textContent = '';
    const inner = el('div', 'file-inner'); inner.setAttribute('role', 'dialog'); inner.setAttribute('aria-label', fp);
    const head = el('div', 'file-head'); const close = el('button', 'text-btn', '關閉 ✕'); close.type = 'button';
    const shut = () => { box.hidden = true; box.textContent = ''; };
    close.addEventListener('click', shut); box.onclick = (e) => { if (e.target === box) shut(); };
    head.append(el('code', null, fp), close); const wait = el('p', 'note', '讀取中…'); inner.append(head, wait); box.append(inner); close.focus();
    try {
      const r = await fetch('/api/file?path=' + encodeURIComponent(fp), { cache: 'no-store' }); const j = await r.json().catch(() => ({})); wait.remove();
      if (!r.ok) inner.append(el('p', 'note err', j.message || ('開不了（' + r.status + '）')));
      else { inner.append(el('div', 'file-meta', '更新於 ' + fmt(j.mtime))); if (/\.txt$/i.test(fp)) { const pre = el('pre', 'file-pre'); pre.textContent = j.text; inner.append(pre); } else inner.append(renderMd(j.text)); }
    } catch (e) { wait.textContent = '開不了：服務沒有回應。'; }
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('file-view').hidden) { $('file-view').hidden = true; $('file-view').textContent = ''; } });

  // ---------- frame ----------
  function render() {
    if (!S.data) return;
    const active = document.activeElement && document.activeElement.id;
    const sel = active && document.activeElement.selectionStart;
    renderHome(); renderOrg(); renderUnplaced(); renderBoard(); renderDecisions(); loadFeed(); renderTalkList(); renderTalkPanel(); renderRules(); if (S.view === 'org' && !C.list) loadConvos();
    $('rail-foot').textContent = '更新 ' + fmt(S.data.now) + ' · ' + S.data.decisions.filter((d) => d.status !== 'superseded').length + ' 條有效決定';
    if (active) { const back = document.getElementById(active); if (back && (back.tagName === 'TEXTAREA' || back.tagName === 'INPUT')) { back.focus(); try { if (sel != null) back.setSelectionRange(sel, sel); } catch (e) {} } }
  }
  async function refresh() {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      if (r.status === 401) { $('status').hidden = false; $('status').textContent = '登入過期了：電腦上用 desk open，手機用 desk pair。'; return; }
      S.data = await r.json();
      if (S.data.ui) {
        document.title = S.data.ui.title;
        $('brand-name').textContent = S.data.ui.brand;
        $('brand-title').textContent = S.data.ui.title;
      }
      $('status').hidden = true; render();
    } catch (e) { $('status').hidden = false; $('status').textContent = '連不到 desk 服務，請確認它還在跑。'; }
  }
  $('clear-filter').addEventListener('click', () => { S.filter = null; render(); });
  $('decision-q').addEventListener('input', (e) => { S.q = e.target.value; renderDecisions(); });
  $('show-superseded').addEventListener('change', (e) => { S.showSuperseded = e.target.checked; renderDecisions(); });

  setView(location.hash.slice(1) || 'home');
  refresh();
  function connect() {
    try {
      const es = new EventSource('/api/stream');
      es.addEventListener('changed', () => { refresh(); if (S.view === 'log' && L.loaded && !L.q && !L.day) loadLog(false); if (S.view === 'org') { loadConvos(); if (C.sel && C.pages.length <= 1) loadConvo(false); } });
      es.onerror = () => { try { es.close(); } catch (e) {} setTimeout(connect, 5000); };
    } catch (e) {}
  }
  if (!/HeadlessChrome/.test(navigator.userAgent)) {
    connect(); setInterval(refresh, 30000);
    setInterval(() => { if (document.hidden || S.view !== 'org') return; loadConvos(); if (C.sel && C.pages.length <= 1) loadConvo(false); }, 15000);
  }
})();
