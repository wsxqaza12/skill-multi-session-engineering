(function () {
  'use strict';
  const code = document.getElementById('code');
  const msg = document.getElementById('msg');
  const go = document.getElementById('go');
  async function submit() {
    const v = code.value.replace(/\D/g, '');
    if (v.length !== 6) { msg.textContent = '請輸入 6 位數字。'; msg.className = 'note err'; return; }
    go.disabled = true; msg.textContent = '登入中…'; msg.className = 'note';
    try {
      const r = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: v }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { location.href = '/'; return; }
      msg.textContent = j.message || '登入失敗。'; msg.className = 'note err';
    } catch (e) { msg.textContent = '連不到服務。'; msg.className = 'note err'; }
    go.disabled = false;
  }
  go.addEventListener('click', submit);
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  code.focus();
})();
