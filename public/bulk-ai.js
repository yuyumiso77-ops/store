// "AI 요약 전부 만들기" 버튼 (관리자 화면·리포트 공용). 진행 상황을 3초마다 갱신
(function () {
  const mount = document.querySelector('[data-bulk-ai]');
  if (!mount) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn bulk-ai-btn';
  const msg = document.createElement('span');
  msg.className = 'bulk-ai-msg';
  mount.append(btn, msg);
  let timer = null, wasRunning = false;
  const api = async (method) => {
    const r = await fetch('/api/admin/ai-summary-all', { method });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'AI 요약 상태를 불러오지 못했어요.');
    return j;
  };
  function show(s) {
    if (!s.aiEnabled) { btn.textContent = '🤖 AI 요약 (키 없음)'; btn.disabled = true; msg.textContent = ''; return; }
    if (s.running) {
      btn.disabled = true;
      btn.textContent = `🤖 요약 중… ${s.done} / ${s.total}`;
      msg.textContent = (s.current.length ? `지금: ${s.current.join(', ')}` : '') + (s.failed ? ` · 실패 ${s.failed}` : '');
      wasRunning = true;
      if (!timer) timer = setInterval(refresh, 3000);
      return;
    }
    clearInterval(timer); timer = null;
    btn.disabled = s.pending === 0;
    btn.textContent = s.pending ? `🤖 AI 요약 전부 만들기 (${s.pending}건)` : '✅ AI 요약 모두 최신';
    msg.textContent = wasRunning || s.finishedAt
      ? `${s.finishedAt ? new Date(s.finishedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) + ' 완료' : ''}` + (s.failed ? ` · 실패 ${s.failed}건 (${s.errors.slice(0, 2).join(' / ')})` : '')
      : '';
    if (wasRunning) { wasRunning = false; document.dispatchEvent(new CustomEvent('bulk-ai-done')); }
  }
  async function refresh() { try { show(await api('GET')); } catch (ex) { msg.textContent = ex.message; } }
  btn.onclick = async () => {
    const s = await api('GET').catch(() => null);
    if (!s || !s.pending) return refresh();
    if (!confirm(`아직 요약이 없거나 새 평가가 들어온 ${s.pending}건(상품·진열·Z-TEC·사은품)을 AI로 요약해요.\n\n• 한 건에 10~30초, 3건씩 동시에 진행해요 (창을 닫아도 서버에서 계속돼요).\n• AI 사용량(Claude Console 크레딧)이 들어가요.\n\n진행할까요?`)) return;
    try { show(await api('POST')); } catch (ex) { alert(ex.message); }
  };
  refresh();
})();
