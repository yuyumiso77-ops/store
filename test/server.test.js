'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'store-fb-'));
process.env.ADMIN_PASSWORD = 'secret';
process.env.STAFF_PASSWORD = 'staffpw';
const { server, _setAiClient } = require('../server');

let base;
const basic = (pw) => ({ Authorization: 'Basic ' + Buffer.from('u:' + pw).toString('base64'), 'Content-Type': 'application/json' });
const admin = basic('secret');
const staff = basic('staffpw');

before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

test('인증: 관리자/직원 분리', async () => {
  assert.strictEqual((await fetch(base + '/api/admin/summary')).status, 401);
  assert.strictEqual((await fetch(base + '/api/admin/summary', { headers: staff })).status, 401);
  assert.strictEqual((await fetch(base + '/')).status, 401);
  assert.strictEqual((await fetch(base + '/', { headers: staff })).status, 200);
  assert.strictEqual((await fetch(base + '/', { headers: admin })).status, 200);
  assert.strictEqual((await fetch(base + '/healthz')).status, 200);
});

test('이미지 업로드: 파일명=품번으로 등록/교체', async () => {
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const put = (code, body, cat = '') => fetch(base + `/api/admin/images/${encodeURIComponent(code)}?category=${encodeURIComponent(cat)}`, { method: 'PUT', headers: { ...admin, 'Content-Type': 'image/jpeg' }, body });
  assert.strictEqual((await put('GM-001', jpg)).status, 400); // 새 품번인데 품목 없음
  assert.strictEqual((await put('GM-001', Buffer.from('not image'), '골프화')).status, 400);
  assert.strictEqual((await put('bad code!', jpg, '골프화')).status, 400);
  const r1 = await put('GM-001', jpg, '골프화');
  assert.strictEqual(r1.status, 201);
  const p1 = (await r1.json()).product;
  assert.deepStrictEqual([p1.code, p1.name, p1.category], ['GM-001', 'GM-001', '골프화']);
  const r2 = await put('gm-001', jpg); // 대소문자 무시, 기존 상품 이미지 교체
  assert.strictEqual(r2.status, 200);
  assert.strictEqual((await r2.json()).product.id, p1.id);
  const opt = await (await fetch(base + '/api/options', { headers: staff })).json();
  const url = opt.products.find((x) => x.id === p1.id).imageUrl;
  assert.ok(url);
  assert.strictEqual((await fetch(base + url)).status, 401); // 인증 필요
  const img = await fetch(base + url, { headers: staff });
  assert.strictEqual(img.headers.get('content-type'), 'image/jpeg');
  assert.deepStrictEqual(Buffer.from(await img.arrayBuffer()), jpg);
  // 품번 중복 방지
  const dup = await fetch(base + '/api/admin/products', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'x', code: 'GM-001', category: '장갑' }) });
  assert.strictEqual(dup.status, 400);
  await fetch(base + `/api/admin/products/${p1.id}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ active: false }) });
});

test('상품 정보 일괄 등록(CSV 행)', async () => {
  const imp = (rows) => fetch(base + '/api/admin/products/import', { method: 'POST', headers: admin, body: JSON.stringify({ rows }) }).then((r) => r.json());
  const r1 = await imp([
    { code: 'FNJMT3101', name: '긴팔 티셔츠 (BLACK)', category: '어패럴', type: ' 긴팔  티셔츠 ', line: '남성' },
    { code: 'FNJMP3601', name: '', category: '어패럴' },
    { code: 'BAD CODE', name: 'x', category: '어패럴' },
    { code: 'NEW-1', name: 'x', category: '' },
    { code: 'NEW-2', name: 'x', category: '식품' },
  ]);
  assert.deepStrictEqual([r1.created, r1.updated, r1.errors.length], [2, 0, 3]);
  const r2 = await imp([{ code: 'fnjmt3101', name: '긴팔 티 수정' }]); // 기존 품번은 이름만 수정
  assert.deepStrictEqual([r2.created, r2.updated], [0, 1]);
  const s = await (await fetch(base + '/api/admin/summary', { headers: admin })).json();
  const t = s.products.find((x) => x.code === 'FNJMT3101');
  assert.deepStrictEqual([t.name, t.category, t.type], ['긴팔 티 수정', '어패럴', '긴팔 티셔츠']);
  assert.strictEqual(t.line, '남성'); // 복종 공백 정리, 빈 값이면 유지
  assert.strictEqual(s.products.find((x) => x.code === 'FNJMP3601').name, 'FNJMP3601'); // 이름 없으면 품번
  // 복종이 비어 있으면 상품명 앞부분으로 추정 (알려진 복종만)
  await imp([{ code: 'INF-1', name: '팬츠 (BLACK)', category: '어패럴' }, { code: 'INF-2', name: '쿨링 폴로 (BLACK)', category: '어패럴' }, { code: 'INF-3', name: '여성 스커트 (WHITE)', category: '어패럴' }]);
  const s2 = await (await fetch(base + '/api/admin/summary', { headers: admin })).json();
  assert.strictEqual(s2.products.find((x) => x.code === 'INF-1').type, '팬츠');
  assert.strictEqual(s2.products.find((x) => x.code === 'INF-2').type, '');
  assert.strictEqual(s2.products.find((x) => x.code === 'INF-3').type, '스커트'); // 성별 접두어 무시
  assert.strictEqual(s2.products.find((x) => x.code === 'INF-3').line, '여성'); // 구분은 상품명 접두어로
  assert.strictEqual(s2.products.find((x) => x.code === 'INF-1').line, '');
  for (const x of s2.products.filter((p) => p.code.startsWith('INF-')))
    await fetch(base + `/api/admin/products/${x.id}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ active: false }) });
  for (const x of s.products.filter((p) => ['FNJMT3101', 'FNJMP3601'].includes(p.code)))
    await fetch(base + `/api/admin/products/${x.id}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ active: false }) });
});

test('상품 삭제: 이미지·평가도 함께 삭제', async () => {
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9]);
  const r = await fetch(base + '/api/admin/images/DEL-1?category=' + encodeURIComponent('장갑'), { method: 'PUT', headers: { ...admin, 'Content-Type': 'image/jpeg' }, body: jpg });
  const p = (await r.json()).product;
  await fetch(base + '/api/evaluations', { method: 'POST', headers: staff, body: JSON.stringify({ productId: p.id, staff: '민지', reaction: 3, display: 'shown', sales: 'normal', prosNote: '그립감', noBuyReasons: ['기타'] }) });
  assert.strictEqual((await fetch(base + `/api/admin/products/${p.id}`, { method: 'DELETE', headers: staff })).status, 401);
  // 이미지만 삭제
  assert.strictEqual((await fetch(base + `/api/admin/products/${p.id}/image`, { method: 'DELETE', headers: admin })).status, 200);
  const opt = await (await fetch(base + '/api/options', { headers: staff })).json();
  assert.strictEqual(opt.products.find((x) => x.id === p.id).imageUrl, null);
  assert.strictEqual((await fetch(base + p.imageUrl, { headers: staff })).status, 404);
  const d = await (await fetch(base + `/api/admin/products/${p.id}`, { method: 'DELETE', headers: admin })).json();
  assert.strictEqual(d.deletedEvaluations, 1);
  const s = await (await fetch(base + '/api/admin/summary', { headers: admin })).json();
  assert.ok(!s.products.some((x) => x.id === p.id));
});

test('반응·판매 엇갈림 표시', async () => {
  const p = await (await fetch(base + '/api/admin/products', { method: 'POST', headers: admin, body: JSON.stringify({ name: '갭 테스트', category: '어패럴' }) })).json();
  for (const staffName of ['가', '나'])
    await fetch(base + '/api/evaluations', { method: 'POST', headers: staff, body: JSON.stringify({ productId: p.id, staff: staffName, reaction: 5, display: 'shown', pros: ['디자인'], sales: 'poor', noBuyReasons: ['맞는 사이즈 결품'] }) });
  const s = await (await fetch(base + '/api/admin/summary', { headers: admin })).json();
  assert.strictEqual(s.products.find((x) => x.id === p.id).gap, 'goodReactionPoorSales');
  await fetch(base + `/api/admin/products/${p.id}`, { method: 'DELETE', headers: admin });
});

test('이미지 전부 삭제', async () => {
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 7]);
  const r = await fetch(base + '/api/admin/images/WIPE-1?category=' + encodeURIComponent('용품'), { method: 'PUT', headers: { ...admin, 'Content-Type': 'image/jpeg' }, body: jpg });
  const p = (await r.json()).product;
  assert.strictEqual((await fetch(base + '/api/admin/images', { method: 'DELETE', headers: admin })).status, 400); // 확인 문구 없음
  assert.strictEqual((await fetch(base + '/api/admin/images?confirm=' + encodeURIComponent('전부삭제'), { method: 'DELETE', headers: staff })).status, 401);
  const d = await (await fetch(base + '/api/admin/images?confirm=' + encodeURIComponent('전부삭제'), { method: 'DELETE', headers: admin })).json();
  assert.ok(d.deleted >= 1);
  const s = await (await fetch(base + '/api/admin/summary', { headers: admin })).json();
  assert.ok(s.products.every((x) => !x.imageUrl));
  assert.ok(s.products.some((x) => x.id === p.id)); // 상품은 남음
  assert.strictEqual((await fetch(base + p.imageUrl, { headers: staff })).status, 404);
  await fetch(base + `/api/admin/products/${p.id}`, { method: 'DELETE', headers: admin });
});

test('PLC 번호 파일명으로 이미지 매칭 (첫 번째 컬러가 대표)', async () => {
  const imp = (rows) => fetch(base + '/api/admin/products/import', { method: 'POST', headers: admin, body: JSON.stringify({ rows }) }).then((r) => r.json());
  const r1 = await imp([{ code: 'PLC-T1', name: '테스트', category: '어패럴', plc: '90001 90002', plcColors: '90001:BLACK 90002:WHITE' }]);
  assert.strictEqual(r1.created, 1);
  const clash = await imp([{ code: 'PLC-T2', category: '어패럴', plc: '90002' }]); // 다른 품번이 이미 쓰는 PLC
  assert.strictEqual(clash.errors.length, 1);
  const put = (name, cat = '어패럴') => fetch(base + `/api/admin/images/${encodeURIComponent(name)}?category=${encodeURIComponent(cat)}`, { method: 'PUT', headers: { ...admin, 'Content-Type': 'image/jpeg' }, body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, name.length]) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const w = await put('FJ_90002_sw'); // 두 번째 컬러 먼저 → 지금은 유일한 사진이라 대표
  assert.deepStrictEqual([w.status, w.match.by, w.match.color, w.product.code, w.role], [200, 'plc', 'WHITE', 'PLC-T1', 'main']);
  const b = await put('90001'); // 첫 번째 컬러 → 대표가 바뀜, WHITE는 상세컷으로
  assert.deepStrictEqual([b.match.color, b.role, b.photoCount], ['BLACK', 'main', 2]);
  const w2 = await put('FJ_90002_sw'); // 같은 파일명 다시 → 교체, 상세컷
  assert.deepStrictEqual([w2.replaced, w2.role, w2.photoCount], [true, 'detail', 2]);
  const sw = await put('FJ_90001_sw'); // 첫 컬러의 _sw → 대표
  assert.deepStrictEqual([sw.role, sw.photoCount], ['main', 3]);
  const f = await put('FJ_90001_f'); // 첫 컬러지만 _sw 아님 → 상세컷
  assert.deepStrictEqual([f.role, f.photoCount], ['detail', 4]);
  const none = await put('FJ_99999_sw'); // 없는 PLC는 품목이 있어도 새 상품을 만들지 않음
  assert.strictEqual(none.status, 400);
  let s = await (await fetch(base + '/api/admin/summary', { headers: admin })).json();
  assert.ok(!s.products.some((x) => x.code === 'FJ_99999_sw'));
  let t = s.products.find((x) => x.code === 'PLC-T1');
  assert.deepStrictEqual(t.plcs, [{ plc: '90001', color: 'BLACK' }, { plc: '90002', color: 'WHITE' }]);
  assert.deepStrictEqual(t.photos.map((x) => x.label), ['FJ_90001_sw', '90001', 'FJ_90001_f', 'FJ_90002_sw']); // 대표가 맨 앞
  assert.strictEqual(t.imageUrl, t.photos[0].url);
  // 품번 이름 사진은 PLC 사진보다 우선
  assert.strictEqual((await put('PLC-T1')).role, 'main');
  // ★ 대표로 지정하면 그 사진이 최우선
  s = await (await fetch(base + '/api/admin/summary', { headers: admin })).json();
  t = s.products.find((x) => x.code === 'PLC-T1');
  const white = t.photos.find((x) => x.label === 'FJ_90002_sw');
  assert.strictEqual((await fetch(base + `/api/admin/products/${t.id}/photos/${white.id}/pin`, { method: 'POST', headers: admin })).status, 200);
  s = await (await fetch(base + '/api/admin/summary', { headers: admin })).json();
  t = s.products.find((x) => x.code === 'PLC-T1');
  assert.strictEqual(t.photos[0].label, 'FJ_90002_sw');
  // 사진 한 장 삭제
  assert.strictEqual((await fetch(base + `/api/admin/products/${t.id}/photos/${white.id}`, { method: 'DELETE', headers: admin })).status, 200);
  s = await (await fetch(base + '/api/admin/summary', { headers: admin })).json();
  t = s.products.find((x) => x.code === 'PLC-T1');
  assert.strictEqual(t.photos.length, 4);
  assert.strictEqual(t.photos[0].label, '품번 사진');
  assert.strictEqual((await fetch(base + white.url, { headers: staff })).status, 404);
  await fetch(base + `/api/admin/products/${t.id}`, { method: 'DELETE', headers: admin });
});

test('예전 데이터(사진 1장)로 서버 시작 가능', () => {
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-legacy-'));
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ products: [{ id: 'old1', code: 'OLD-1', name: 'x', category: '어패럴', active: true, image: 'old1.jpg', imageAt: 1, imageRank: 0, imageIsSw: true }], evaluations: [] }));
  const out = execFileSync(process.execPath, ['-e', "const {server}=require('./server');const s=require('fs');console.log('ok')"], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dir } }).toString();
  assert.match(out, /ok/);
});

test('Z-TEC 매장 의견: 매장당 1회, 다시 저장하면 수정', async () => {
  const post = (b) => fetch(base + '/api/ztec', { method: 'POST', headers: staff, body: JSON.stringify(b) });
  assert.strictEqual((await post({ reaction: 4, ease: 'easy' })).status, 400); // 매장명 없음
  assert.strictEqual((await post({ store: '강남점', ease: 'easy' })).status, 400); // 반응 없음
  assert.strictEqual((await post({ store: '강남점', reaction: 4, ease: 'x' })).status, 400); // 난이도 없음
  assert.strictEqual((await post({ store: '강남점', reaction: 4, ease: 'easy', good: '반응 좋음' })).status, 201);
  assert.strictEqual((await post({ store: '강남 점', reaction: 2, ease: 'hard', bad: '설명 어려움' })).status, 200); // 같은 매장 → 수정
  await post({ store: '부산점', reaction: 5, ease: 'easy', suggestion: '=POP 필요' });
  const mine = await (await fetch(base + '/api/ztec/mine?store=' + encodeURIComponent('강남점'), { headers: staff })).json();
  assert.deepStrictEqual([mine.reaction, mine.ease, mine.bad], [2, 'hard', '설명 어려움']);
  const s = await (await fetch(base + '/api/admin/summary', { headers: admin })).json();
  assert.deepStrictEqual([s.ztec.count, s.ztec.avgReaction, s.ztec.ease], [2, 3.5, { easy: 1, normal: 0, hard: 1 }]);
  const csv = await (await fetch(base + '/api/admin/ztec.csv', { headers: admin })).text();
  assert.match(csv, /부산점/);
  assert.match(csv, /"'=POP 필요"/);
});

test('AI 의견 요약: 키 없으면 안내, 있으면 요약하고 저장(기준 같으면 재사용)', async () => {
  // 키 없음
  delete process.env.ANTHROPIC_API_KEY;
  let r = await fetch(base + '/api/admin/ai-summary/ztec', { method: 'POST', headers: admin });
  assert.strictEqual(r.status, 503);
  assert.match((await r.json()).error, /ANTHROPIC_API_KEY/);
  // 가짜 AI 클라이언트
  process.env.ANTHROPIC_API_KEY = 'test';
  let calls = 0, lastReq = null;
  _setAiClient({ beta: { messages: { create: async (req) => {
    calls++; lastReq = req;
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ headline: '설명이 어렵다는 의견이 많음', strengths: ['반응 좋음'], weaknesses: ['설명 어려움 (1개 매장)'], requests: ['POP 필요'], actions: ['설명 POP 제작'] }) }] };
  } } } });
  r = await fetch(base + '/api/admin/ai-summary/ztec', { method: 'POST', headers: admin });
  assert.strictEqual(r.status, 200);
  let v = await r.json();
  assert.strictEqual(v.summary.result.headline, '설명이 어렵다는 의견이 많음');
  assert.strictEqual(v.stale, false);
  assert.strictEqual(lastReq.model, 'claude-opus-5-5');
  assert.strictEqual(lastReq.output_config.format.type, 'json_schema');
  assert.match(lastReq.messages[0].content, /부산점/);
  // 같은 기준이면 다시 부르지 않음 (force 없을 때)
  await fetch(base + '/api/admin/ai-summary/ztec', { method: 'POST', headers: admin });
  assert.strictEqual(calls, 1);
  // 새 의견이 생기면 stale
  await fetch(base + '/api/ztec', { method: 'POST', headers: staff, body: JSON.stringify({ store: '대구점', reaction: 3, ease: 'normal' }) });
  v = await (await fetch(base + '/api/admin/ai-summary/ztec', { headers: admin })).json();
  assert.strictEqual(v.stale, true);
  // 거절되면 오류
  _setAiClient({ beta: { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } } });
  r = await fetch(base + '/api/admin/ai-summary/ztec?force=1', { method: 'POST', headers: admin });
  assert.strictEqual(r.status, 502);
  // 의견 없는 상품은 400
  const p = await (await fetch(base + '/api/admin/products', { method: 'POST', headers: admin, body: JSON.stringify({ name: '빈 상품', category: '용품' }) })).json();
  assert.strictEqual((await fetch(base + `/api/admin/ai-summary/product:${p.id}`, { method: 'POST', headers: admin })).status, 400);
  await fetch(base + `/api/admin/products/${p.id}`, { method: 'DELETE', headers: admin });
  delete process.env.ANTHROPIC_API_KEY;
  _setAiClient(null);
});

test('평가 삭제: 한 건 / Z-TEC 한 건 / 매장 전체', async () => {
  const pr = await (await fetch(base + '/api/admin/products', { method: 'POST', headers: admin, body: JSON.stringify({ name: '삭제 테스트', category: '장갑' }) })).json();
  const ev = (store) => fetch(base + '/api/evaluations', { method: 'POST', headers: staff, body: JSON.stringify({ productId: pr.id, staff: store, reaction: 4, display: 'shown', pros: ['그립감'], sales: 'good', sellReasons: ['선물 수요'] }) });
  await ev('테스트점'); await ev('진짜점');
  await fetch(base + '/api/ztec', { method: 'POST', headers: staff, body: JSON.stringify({ store: '테스트 점', reaction: 3, ease: 'normal' }) });
  let list = await (await fetch(base + `/api/admin/products/${pr.id}/evaluations`, { headers: admin })).json();
  assert.strictEqual(list.length, 2);
  assert.strictEqual((await fetch(base + `/api/admin/evaluations/${list[0].id}`, { method: 'DELETE', headers: staff })).status, 401);
  // 한 건 삭제
  const real = list.find((x) => x.staff === '진짜점');
  assert.strictEqual((await fetch(base + `/api/admin/evaluations/${real.id}`, { method: 'DELETE', headers: admin })).status, 200);
  assert.strictEqual((await fetch(base + `/api/admin/evaluations/${real.id}`, { method: 'DELETE', headers: admin })).status, 404);
  // 매장 전체 삭제: 확인 문구 틀리면 거부
  const enc = encodeURIComponent('테스트점');
  assert.strictEqual((await fetch(base + `/api/admin/stores/${enc}?confirm=x`, { method: 'DELETE', headers: admin })).status, 400);
  const d = await (await fetch(base + `/api/admin/stores/${enc}?confirm=${enc}`, { method: 'DELETE', headers: admin })).json();
  assert.deepStrictEqual([d.deletedEvaluations, d.deletedZtec], [1, 1]); // '테스트 점'(띄어쓰기)도 같은 매장
  list = await (await fetch(base + `/api/admin/products/${pr.id}/evaluations`, { headers: admin })).json();
  assert.strictEqual(list.length, 0);
  // Z-TEC 한 건 삭제
  await fetch(base + '/api/ztec', { method: 'POST', headers: staff, body: JSON.stringify({ store: '삭제점', reaction: 3, ease: 'normal' }) });
  const s = await (await fetch(base + '/api/admin/summary', { headers: admin })).json();
  const z = s.ztec.entries.find((e) => e.store === '삭제점');
  assert.strictEqual((await fetch(base + `/api/admin/ztec/${z.id}`, { method: 'DELETE', headers: admin })).status, 200);
  const s2 = await (await fetch(base + '/api/admin/summary', { headers: admin })).json();
  assert.ok(!s2.ztec.entries.some((e) => e.store === '삭제점'));
  await fetch(base + `/api/admin/products/${pr.id}`, { method: 'DELETE', headers: admin });
});

test('진열 체크: 매장 × SKU(컬러) 저장·취소·일괄·집계·CSV', async () => {
  const imp = await (await fetch(base + '/api/admin/products/import', { method: 'POST', headers: admin, body: JSON.stringify({ rows: [{ code: 'DSP-1', name: '진열 상품', category: '어패럴', plc: '80001 80002', plcColors: '80001:BLACK 80002:WHITE' }] }) })).json();
  assert.strictEqual(imp.created, 1);
  const put = (b) => fetch(base + '/api/display', { method: 'POST', headers: staff, body: JSON.stringify(b) });
  assert.strictEqual((await put({ sku: '80001', status: 'shown' })).status, 400); // 매장명 없음
  assert.strictEqual((await put({ store: 'A점', sku: '99999', status: 'shown' })).status, 400); // 없는 SKU
  assert.strictEqual((await put({ store: 'A점', sku: '80001', status: 'x' })).status, 400);
  assert.strictEqual((await put({ store: 'A점', sku: '80001', status: 'shown' })).status, 200);
  await put({ store: 'A 점', sku: '80001', status: 'none' }); // 같은 매장 → 덮어씀
  await put({ store: 'B점', items: [{ sku: '80001', status: 'shown' }, { sku: '80002', status: 'stock' }] }); // 일괄
  await put({ store: 'C점', sku: '80002', status: 'shown' });
  await put({ store: 'C점', sku: '80002', status: '' }); // 취소
  const mine = await (await fetch(base + '/api/display/mine?store=' + encodeURIComponent('A점'), { headers: staff })).json();
  assert.deepStrictEqual(mine, { 80001: 'none' });
  const rep = await (await fetch(base + '/api/admin/display', { headers: admin })).json();
  const k1 = rep.skus.find((k) => k.sku === '80001'), k2 = rep.skus.find((k) => k.sku === '80002');
  assert.deepStrictEqual([k1.color, k1.shown, k1.none, k1.checked, k1.rate], ['BLACK', 1, 1, 2, 50]);
  assert.deepStrictEqual(k1.stores.none, ['A점']);
  assert.deepStrictEqual([k2.stock, k2.checked], [1, 1]);
  assert.deepStrictEqual(rep.stores.map((x) => x.name).sort(), ['A점', 'B점']);
  // 상품 표의 진열률도 진열 체크에서 계산
  const s = await (await fetch(base + '/api/admin/summary', { headers: admin })).json();
  const pr = s.products.find((x) => x.code === 'DSP-1');
  assert.deepStrictEqual([pr.display, pr.displayRate], [{ shown: 1, stock: 1, none: 1, notReceived: 0 }, 33]);
  const mx = await (await fetch(base + '/api/admin/display-matrix.csv', { headers: admin })).text();
  assert.match(mx, /DSP-1-BLACK/);
  assert.match(mx, /"B점","\d+\/\d+".*"진열"/);
  const sm = await (await fetch(base + '/api/admin/display-summary.csv', { headers: admin })).text();
  assert.match(sm, /"DSP-1","BLACK","80001"/);
  // 매장 전체 삭제에 진열 체크도 포함
  const d = await (await fetch(base + `/api/admin/stores/${encodeURIComponent('B점')}?confirm=${encodeURIComponent('B점')}`, { method: 'DELETE', headers: admin })).json();
  assert.strictEqual(d.deletedDisplays, 2);
  await fetch(base + `/api/admin/products/${pr.id}`, { method: 'DELETE', headers: admin });
  const rep2 = await (await fetch(base + '/api/admin/display', { headers: admin })).json();
  assert.ok(!rep2.skus.some((k) => k.sku === '80001'));
});

test('진열 분석: 확대 후보 / 효자 / 재검토, 복종·매장별, 창고만 SKU', async () => {
  const rows = [
    { code: 'AN-EXP', name: 'x', category: '어패럴', type: '스웨터', plc: '70001', plcColors: '70001:BLACK' },
    { code: 'AN-STAR', name: 'x', category: '어패럴', type: '스웨터', plc: '70002', plcColors: '70002:WHITE' },
    { code: 'AN-REV', name: 'x', category: '어패럴', type: '팬츠', plc: '70003', plcColors: '70003:GREY' },
  ];
  await fetch(base + '/api/admin/products/import', { method: 'POST', headers: admin, body: JSON.stringify({ rows }) });
  const stores = ['가점', '나점', '다점', '라점'];
  const ev = (code, reaction, sales) => (async () => {
    const opt = await (await fetch(base + '/api/options', { headers: staff })).json();
    const pr = opt.products.find((x) => x.code === code);
    for (const st of stores) {
      const body = { productId: pr.id, staff: st, reaction, sales, ...(reaction >= 3 ? { pros: ['디자인'] } : { cons: ['디자인'] }), ...(sales === 'good' ? { sellReasons: ['선물 수요'] } : { noBuyReasons: ['기타'] }) };
      const r = await fetch(base + '/api/evaluations', { method: 'POST', headers: staff, body: JSON.stringify(body) });
      assert.ok(r.ok, await r.text());
    }
  })();
  await ev('AN-EXP', 5, 'good');
  await ev('AN-STAR', 4, 'good');
  await ev('AN-REV', 2, 'poor');
  const disp = (store, items) => fetch(base + '/api/display', { method: 'POST', headers: staff, body: JSON.stringify({ store, items }) });
  for (const [i, st] of stores.entries()) {
    await disp(st, [
      { sku: '70001', status: i === 0 ? 'shown' : 'stock' }, // 25% 진열, 창고만 3
      { sku: '70002', status: 'shown' },
      { sku: '70003', status: i === 3 ? 'none' : 'shown' }, // 75%
    ]);
  }
  const a = await (await fetch(base + '/api/admin/display-analysis', { headers: admin })).json();
  const grp = (c) => a.products.find((x) => x.code === c).group;
  assert.deepStrictEqual([grp('AN-EXP'), grp('AN-STAR'), grp('AN-REV')], ['expand', 'star', 'review']);
  const sw = a.byType.find((t) => t.type === '스웨터');
  assert.deepStrictEqual([sw.shown, sw.stock, sw.checks], [5, 3, 8]);
  assert.strictEqual(a.stockOnly[0].code, 'AN-EXP');
  assert.strictEqual(a.stockOnly[0].stock, 3);
  const ra = a.byStore.find((x) => x.name === '라점');
  assert.deepStrictEqual(ra.noneSkus, [{ code: 'AN-REV', color: 'GREY' }]);
  // AI 요약 소스
  delete process.env.ANTHROPIC_API_KEY;
  assert.strictEqual((await fetch(base + '/api/admin/ai-summary/display', { method: 'POST', headers: admin })).status, 503);
  for (const st of stores) await fetch(base + `/api/admin/stores/${encodeURIComponent(st)}?confirm=${encodeURIComponent(st)}`, { method: 'DELETE', headers: admin });
  const s = await (await fetch(base + '/api/admin/summary', { headers: admin })).json();
  for (const x of s.products.filter((p) => p.code.startsWith('AN-'))) await fetch(base + `/api/admin/products/${x.id}`, { method: 'DELETE', headers: admin });
});

test('검색엔진 차단: robots.txt, X-Robots-Tag, meta', async () => {
  const r = await fetch(base + '/robots.txt');
  assert.strictEqual(r.status, 200);
  assert.match(await r.text(), /Disallow: \//);
  assert.match(r.headers.get('x-robots-tag'), /noindex/);
  const page = await fetch(base + '/', { headers: staff });
  assert.match(page.headers.get('x-robots-tag'), /noindex/);
  assert.match(await page.text(), /<meta name="robots" content="noindex/);
  assert.match((await fetch(base + '/logo.png')).headers.get('x-robots-tag'), /noimageindex/);
});

test('평가 제외(판매 경험 없음·미입고)와 진열 미입고', async () => {
  const imp = await (await fetch(base + '/api/admin/products/import', { method: 'POST', headers: admin, body: JSON.stringify({ rows: [{ code: 'SKIP-1', name: 'x', category: '어패럴', plc: '60001 60002', plcColors: '60001:BLACK 60002:WHITE' }] }) })).json();
  assert.strictEqual(imp.created, 1);
  const opt = await (await fetch(base + '/api/options', { headers: staff })).json();
  const pr = opt.products.find((x) => x.code === 'SKIP-1');
  const post = (b) => fetch(base + '/api/evaluations', { method: 'POST', headers: staff, body: JSON.stringify({ productId: pr.id, ...b }) });
  // 정상 평가 1건 + 판매 경험 없음 1건 + 미입고 1건
  assert.strictEqual((await post({ staff: '가점', reaction: 4, pros: ['디자인'], sales: 'good', sellReasons: ['선물 수요'] })).status, 201);
  assert.strictEqual((await post({ staff: '나점', status: 'nosale' })).status, 201); // 질문 없이 저장
  assert.strictEqual((await post({ staff: '다점', status: 'notreceived' })).status, 201);
  assert.strictEqual((await post({ staff: '라점', status: 'x' })).status, 400);
  // 평가했던 매장이 '판매 경험 없음'으로 바꾸면 기존 답은 지워짐
  assert.strictEqual((await post({ staff: '가점', status: 'nosale' })).status, 200);
  const mine = await (await fetch(base + '/api/evaluations/mine?staff=' + encodeURIComponent('가점'), { headers: staff })).json();
  assert.deepStrictEqual([mine[0].status, mine[0].reaction, mine[0].pros], ['nosale', 0, []]);
  await post({ staff: '가점', reaction: 4, pros: ['디자인'], sales: 'good', sellReasons: ['선물 수요'] }); // 다시 평가
  let s = await (await fetch(base + '/api/admin/summary', { headers: admin })).json();
  let x = s.products.find((p) => p.id === pr.id);
  assert.deepStrictEqual([x.count, x.avgReaction, x.skipped], [1, 4, { nosale: 1, notreceived: 1 }]); // 평균엔 1건만
  const csv = await (await fetch(base + '/api/admin/evaluations.csv', { headers: admin })).text();
  assert.match(csv, /판매 경험 없음/);
  assert.match(csv, /미입고/);
  // 진열 미입고: 진열률에서 제외
  const disp = (store, items) => fetch(base + '/api/display', { method: 'POST', headers: staff, body: JSON.stringify({ store, items }) });
  await disp('가점', [{ sku: '60001', status: 'shown' }, { sku: '60002', status: 'none' }]);
  await disp('다점', [{ sku: '60001', status: 'notReceived' }, { sku: '60002', status: 'notReceived' }]);
  const rep = await (await fetch(base + '/api/admin/display', { headers: admin })).json();
  const k1 = rep.skus.find((k) => k.sku === '60001');
  assert.deepStrictEqual([k1.shown, k1.notReceived, k1.checked, k1.rate], [1, 1, 2, 100]); // 미입고 제외 → 1/1
  assert.deepStrictEqual(k1.stores.notReceived, ['다점']);
  const a = await (await fetch(base + '/api/admin/display-analysis', { headers: admin })).json();
  assert.ok(a.notReceived.some((k) => k.sku === '60001' && k.notReceived === 1));
  assert.strictEqual(a.byStore.find((st) => st.name === '다점').notReceivedSkus.length, 2);
  s = await (await fetch(base + '/api/admin/summary', { headers: admin })).json();
  x = s.products.find((p) => p.id === pr.id);
  assert.deepStrictEqual([x.display, x.displayRate], [{ shown: 1, stock: 0, none: 1, notReceived: 2 }, 50]);
  for (const st of ['가점', '나점', '다점']) await fetch(base + `/api/admin/stores/${encodeURIComponent(st)}?confirm=${encodeURIComponent(st)}`, { method: 'DELETE', headers: admin });
  await fetch(base + `/api/admin/products/${pr.id}`, { method: 'DELETE', headers: admin });
});

test('미입고 자동 연동: 평가 ↔ 진열 체크', async () => {
  await fetch(base + '/api/admin/products/import', { method: 'POST', headers: admin, body: JSON.stringify({ rows: [{ code: 'SYNC-1', name: 'x', category: '어패럴', plc: '50001 50002', plcColors: '50001:BLACK 50002:WHITE' }] }) });
  const opt = await (await fetch(base + '/api/options', { headers: staff })).json();
  const pr = opt.products.find((x) => x.code === 'SYNC-1');
  const ev = (b) => fetch(base + '/api/evaluations', { method: 'POST', headers: staff, body: JSON.stringify({ productId: pr.id, ...b }) }).then((r) => r.json());
  const disp = (store, items) => fetch(base + '/api/display', { method: 'POST', headers: staff, body: JSON.stringify({ store, items }) }).then((r) => r.json());
  const myDisp = async (st) => (await fetch(base + '/api/display/mine?store=' + encodeURIComponent(st), { headers: staff })).json();
  const myEval = async (st) => (await (await fetch(base + '/api/evaluations/mine?staff=' + encodeURIComponent(st), { headers: staff })).json()).find((e) => e.productId === pr.id);
  // 1) 평가 '미입고' → 진열 체크 모든 컬러 미입고
  let r = await ev({ staff: '연동점', status: 'notreceived' });
  assert.deepStrictEqual(r.synced, { display: 'notReceived', count: 2 });
  assert.deepStrictEqual(await myDisp('연동점'), { 50001: 'notReceived', 50002: 'notReceived' });
  // 2) 평가를 '판매 경험 없음'으로 바꾸면 미입고 진열 체크 지움
  r = await ev({ staff: '연동점', status: 'nosale' });
  assert.deepStrictEqual(r.synced, { display: 'cleared', count: 2 });
  assert.deepStrictEqual(await myDisp('연동점'), {});
  // 3) 진열 체크: 한 컬러만 미입고 → 평가 변화 없음, 두 컬러 다 미입고 → 평가 '미입고' (기존 nosale을 바꿈)
  r = await disp('연동2점', [{ sku: '50001', status: 'notReceived' }]);
  assert.deepStrictEqual(r.synced, []);
  assert.strictEqual(await myEval('연동2점'), undefined);
  r = await disp('연동2점', [{ sku: '50002', status: 'notReceived' }]);
  assert.strictEqual(r.synced[0].evaluation, 'notreceived');
  assert.strictEqual((await myEval('연동2점')).status, 'notreceived');
  // 4) 한 컬러를 진열로 바꾸면 '미입고' 평가 삭제
  r = await disp('연동2점', [{ sku: '50001', status: 'shown' }]);
  assert.strictEqual(r.synced[0].evaluation, 'cleared');
  assert.strictEqual(await myEval('연동2점'), undefined);
  // 5) 정식 평가가 있으면 진열 체크가 모두 미입고여도 덮어쓰지 않음
  await ev({ staff: '연동3점', reaction: 4, pros: ['디자인'], sales: 'good', sellReasons: ['선물 수요'] });
  r = await disp('연동3점', [{ sku: '50001', status: 'notReceived' }, { sku: '50002', status: 'notReceived' }]);
  assert.deepStrictEqual(r.synced, []);
  assert.strictEqual((await myEval('연동3점')).status, 'done');
  // 6) '미입고' 평가 → 정식 평가로 바꾸면 미입고 진열 체크도 지움
  await ev({ staff: '연동4점', status: 'notreceived' });
  r = await ev({ staff: '연동4점', reaction: 3, pros: ['디자인'], sales: 'normal', noBuyReasons: ['기타'] });
  assert.deepStrictEqual(r.synced, { display: 'cleared', count: 2 });
  for (const st of ['연동점', '연동2점', '연동3점', '연동4점']) await fetch(base + `/api/admin/stores/${encodeURIComponent(st)}?confirm=${encodeURIComponent(st)}`, { method: 'DELETE', headers: admin });
  await fetch(base + `/api/admin/products/${pr.id}`, { method: 'DELETE', headers: admin });
});

test('판매 경험 없음 + 응대 반응 피드백(선택)', async () => {
  await fetch(base + '/api/admin/products/import', { method: 'POST', headers: admin, body: JSON.stringify({ rows: [{ code: 'NOSALE-1', name: 'x', category: '어패럴', plc: '40001', plcColors: '40001:BLACK' }] }) });
  const opt = await (await fetch(base + '/api/options', { headers: staff })).json();
  const pr = opt.products.find((x) => x.code === 'NOSALE-1');
  const ev = (b) => fetch(base + '/api/evaluations', { method: 'POST', headers: staff, body: JSON.stringify({ productId: pr.id, ...b }) });
  assert.strictEqual((await ev({ staff: '응대점', status: 'nosale' })).status, 201); // 피드백 없이도 저장
  assert.strictEqual((await ev({ staff: '응대점', status: 'nosale', reaction: 4, pros: ['디자인', '그립감'], prosNote: '색이 예쁘다는 말', improvement: '네이비 요청', sales: 'good' })).status, 200);
  assert.strictEqual((await ev({ staff: '판매점', reaction: 2, cons: ['가격(가치 대비)'], sales: 'poor', noBuyReasons: ['기타'] })).status, 201);
  const mine = (await (await fetch(base + '/api/evaluations/mine?staff=' + encodeURIComponent('응대점'), { headers: staff })).json()).find((e) => e.productId === pr.id);
  assert.deepStrictEqual([mine.status, mine.reaction, mine.pros, mine.sales], ['nosale', 4, ['디자인'], '']); // 다른 품목 항목·판매 반응은 무시
  const s = await (await fetch(base + '/api/admin/summary', { headers: admin })).json();
  const x = s.products.find((p) => p.id === pr.id);
  assert.deepStrictEqual([x.count, x.avgReaction, x.nosaleFeedback], [1, 2, 1]); // 평균은 판매한 매장만
  assert.ok(x.pros.some((p) => p.name === '디자인')); // 장점 순위엔 응대 의견 포함
  const n = x.notes.find((n) => n.staff === '응대점');
  assert.deepStrictEqual([n.status, n.prosNote, n.improvement], ['nosale', '색이 예쁘다는 말', '네이비 요청']);
  // AI 요약 소스에 응대 의견 포함
  process.env.ANTHROPIC_API_KEY = 'test';
  let req = null;
  _setAiClient({ beta: { messages: { create: async (r) => { req = r; return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ headline: 'h', strengths: [], weaknesses: [], requests: [], actions: [] }) }] }; } } } });
  await fetch(base + `/api/admin/ai-summary/product:${pr.id}?force=1`, { method: 'POST', headers: admin });
  assert.match(req.messages[0].content, /판매 경험 없음, 응대 중 느낌/);
  _setAiClient(null); delete process.env.ANTHROPIC_API_KEY;
  for (const st of ['응대점', '판매점']) await fetch(base + `/api/admin/stores/${encodeURIComponent(st)}?confirm=${encodeURIComponent(st)}`, { method: 'DELETE', headers: admin });
  await fetch(base + `/api/admin/products/${pr.id}`, { method: 'DELETE', headers: admin });
});

test('조사 대상 매장 명단·참여 현황', async () => {
  const imp = (rows) => fetch(base + '/api/admin/stores/import', { method: 'POST', headers: admin, body: JSON.stringify({ rows }) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  assert.strictEqual((await imp([])).status, 400);
  const r = await imp([{ code: 'C1', name: '롯데잠실', channel: '백화점', manager: '가' }, { code: 'C2', name: '신세계강남', channel: '백화점', manager: '나' }, { name: '롯데 잠실점' }, { name: '' }]);
  assert.deepStrictEqual([r.count, r.errors.length], [2, 2]); // 중복(롯데 잠실점)·빈 이름 제외
  assert.deepStrictEqual(await (await fetch(base + '/api/stores', { headers: staff })).json(), ['롯데잠실', '신세계강남']);
  const prod = await (await fetch(base + '/api/admin/products', { method: 'POST', headers: admin, body: JSON.stringify({ name: '진행률 상품', category: '용품' }) })).json();
  // '신세계강남점' 이름으로 입력해도 같은 매장으로 집계, 명단에 없는 이름은 따로
  await fetch(base + '/api/ztec', { method: 'POST', headers: staff, body: JSON.stringify({ store: '신세계강남점', reaction: 4, ease: 'easy' }) });
  await fetch(base + '/api/ztec', { method: 'POST', headers: staff, body: JSON.stringify({ store: '강남신세계', reaction: 3, ease: 'easy' }) });
  const pr = await (await fetch(base + '/api/admin/store-progress', { headers: admin })).json();
  const g = pr.stores.find((x) => x.name === '신세계강남');
  assert.deepStrictEqual([g.ztec, g.status, g.manager, g.names], [true, 'progress', '나', ['신세계강남점']]);
  assert.strictEqual(pr.stores.find((x) => x.name === '롯데잠실').status, 'none');
  assert.ok(pr.unknown.some((u) => u.name === '강남신세계' && u.ztec));
  for (const st of ['신세계강남점', '강남신세계']) await fetch(base + `/api/admin/stores/${encodeURIComponent(st)}?confirm=${encodeURIComponent(st)}`, { method: 'DELETE', headers: admin });
  await fetch(base + `/api/admin/products/${prod.id}`, { method: 'DELETE', headers: admin });
});

test('응답 품질 점검: 같은 답 반복·의견 없음·너무 빠름', async () => {
  await fetch(base + '/api/admin/stores/import', { method: 'POST', headers: admin, body: JSON.stringify({ rows: [{ name: '현대판교' }, { name: '롯데본점' }] }) });
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push((await (await fetch(base + '/api/admin/products', { method: 'POST', headers: admin, body: JSON.stringify({ name: '점검 상품' + i, category: '용품' }) })).json()).id);
  const ev = (store, productId, b) => fetch(base + '/api/evaluations', { method: 'POST', headers: staff, body: JSON.stringify({ productId, staff: store, display: 'shown', ...b }) });
  for (const id of ids) await ev('현대판교점', id, { reaction: 3, sales: 'normal', pros: ['디자인'], cons: ['가격(가치 대비)'], noBuyReasons: ['기타'], sellReasons: ['기타'] });
  for (const [i, id] of ids.entries()) await ev('롯데본점', id, i % 2 ? { reaction: 5, sales: 'good', pros: ['디자인'], sellReasons: ['기타'], prosNote: '색감이 좋다는 반응이 많았어요' } : { status: 'nosale' });
  const pr = await (await fetch(base + '/api/admin/store-progress', { headers: admin })).json();
  const codes = (n) => pr.stores.find((x) => x.name === n).flags.map((f) => f.code).sort();
  assert.deepStrictEqual(codes('현대판교'), ['fast', 'notext', 'same']);
  assert.deepStrictEqual(codes('롯데본점'), ['skip']);
  const ans = await (await fetch(base + '/api/admin/store-answers?name=' + encodeURIComponent('롯데본점'), { headers: admin })).json();
  assert.strictEqual(ans.evals.length, 6);
  assert.ok(ans.evals.some((e) => e.text.includes('색감')));
  for (const st of ['현대판교점', '롯데본점']) await fetch(base + `/api/admin/stores/${encodeURIComponent(st)}?confirm=${encodeURIComponent(st)}`, { method: 'DELETE', headers: admin });
  for (const id of ids) await fetch(base + `/api/admin/products/${id}`, { method: 'DELETE', headers: admin });
});

test('사은품 니즈: 매장당 1회 저장·수정·집계·CSV·참여 현황', async () => {
  const post = (b) => fetch(base + '/api/gifts', { method: 'POST', headers: staff, body: JSON.stringify(b) });
  const opts = await (await fetch(base + '/api/options', { headers: staff })).json();
  assert.strictEqual(opts.giftCatalog.length, 11); // 2026 사은품 기본 목록
  assert.ok(opts.giftCatalog[0].photos[0].startsWith('/images/gift-'));
  assert.strictEqual((await fetch(base + opts.giftCatalog[0].photos[0], { headers: staff })).status, 200);
  const reviews = Object.fromEntries(opts.giftCatalog.map((g, i) => [g.id, i === 0 ? { r: 5, note: '가방 인기' } : i === 1 ? { r: 'na' } : { r: 3 }]));
  const ok = { store: '갤광교점', freq: 'often', delay: 'sometimes', impact: 'some', reviews, items: ['골프공', '골프 양말'], threshold: 30, currentNote: '양말 반응 좋음', idea: '금액대별 선택' };
  assert.strictEqual((await post({ ...ok, items: [] })).status, 400);
  const { [opts.giftCatalog[2].id]: _, ...partial } = reviews;
  assert.strictEqual((await post({ ...ok, reviews: partial })).status, 400); // 사은품 하나 반응 누락
  assert.strictEqual((await post({ ...ok, threshold: 7 })).status, 400);
  assert.strictEqual((await post(ok)).status, 201);
  // 행사 없었음이면 반응 없어도 OK, 같은 매장(이름 차이)은 수정. 품목은 최대 3개·목록에 있는 것만
  const r2 = await post({ ...ok, store: '갤광교', impact: 'noGift', reaction: 5, items: ['골프공', '우산', '모자·캡', '헤드커버', '없는품목'] });
  assert.strictEqual(r2.status, 200);
  const mine = await (await fetch(base + '/api/gifts/mine?store=' + encodeURIComponent('갤광교 점'), { headers: staff })).json();
  assert.deepStrictEqual([mine.impact, mine.reaction, mine.items], ['noGift', 0, ['골프공', '우산', '모자·캡']]);
  await post({ ...ok, store: '갤타임월드', items: ['골프공'], threshold: 20 });
  const g = await (await fetch(base + '/api/admin/gifts', { headers: admin })).json();
  assert.strictEqual(g.count, 2);
  assert.deepStrictEqual(g.items[0], { name: '골프공', count: 2 });
  assert.deepStrictEqual([g.threshold['20'], g.threshold['30'], g.freq.often, g.impact.noGift, g.avgReaction], [1, 1, 2, 1, 3]);
  const gi0 = g.giftItems.find((x) => x.id === opts.giftCatalog[0].id), gi1 = g.giftItems.find((x) => x.id === opts.giftCatalog[1].id);
  assert.deepStrictEqual([gi0.avg, gi0.count, gi0.notes[0].note, gi1.na, gi1.avg], [5, 1, '가방 인기', 1, null]);
  // 사은품 목록 관리: 숨기면 매장 평가 대상에서 빠짐, 이름 변경, 새 사은품 추가
  const g0 = opts.giftCatalog[0].id;
  await fetch(base + '/api/admin/gift-items/' + g0, { method: 'PATCH', headers: admin, body: JSON.stringify({ name: '미니 보스턴백', active: false }) });
  const added = await (await fetch(base + '/api/admin/gift-items', { method: 'POST', headers: admin, body: JSON.stringify({ name: '골프 양말 세트' }) })).json();
  const cat2 = (await (await fetch(base + '/api/options', { headers: staff })).json()).giftCatalog;
  assert.ok(!cat2.some((x) => x.id === g0) && cat2.some((x) => x.id === added.id));
  await fetch(base + '/api/admin/gift-items/' + g0, { method: 'PATCH', headers: admin, body: JSON.stringify({ name: '메쉬 미니 보스턴백', active: true }) });
  await fetch(base + '/api/admin/gift-items/' + added.id, { method: 'PATCH', headers: admin, body: JSON.stringify({ active: false }) });
  const csv = await (await fetch(base + '/api/admin/gifts.csv', { headers: admin })).text();
  assert.ok(csv.includes('갤타임월드') && csv.includes('20만원 이상'));
  await fetch(base + '/api/admin/stores/import', { method: 'POST', headers: admin, body: JSON.stringify({ rows: [{ name: '갤광교' }] }) });
  const pr = await (await fetch(base + '/api/admin/store-progress', { headers: admin })).json();
  assert.deepStrictEqual([pr.stores[0].gift, pr.stores[0].status], [true, 'progress']);
  assert.ok(pr.unknown.some((u) => u.name === '갤타임월드' && u.gift));
  // 매장 전체 삭제에 사은품도 포함, 한 건 삭제
  const del = await (await fetch(base + `/api/admin/stores/${encodeURIComponent('갤광교')}?confirm=${encodeURIComponent('갤광교')}`, { method: 'DELETE', headers: admin })).json();
  assert.strictEqual(del.deletedGifts, 1);
  const left = (await (await fetch(base + '/api/admin/gifts', { headers: admin })).json()).entries;
  assert.strictEqual((await fetch(base + '/api/admin/gifts/' + left[0].id, { method: 'DELETE', headers: admin })).status, 200);
  assert.strictEqual((await (await fetch(base + '/api/admin/gifts', { headers: admin })).json()).count, 0);
});

test('품목 필수', async () => {
  const r = await fetch(base + '/api/admin/products', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'x', category: '식품' }) });
  assert.strictEqual(r.status, 400);
});

test('상품 등록 → 직원 평가(수정 포함) → 집계 → CSV', async () => {
  const p = await (await fetch(base + '/api/admin/products', { method: 'POST', headers: admin, body: JSON.stringify({ name: '쿨링 폴로', category: '어패럴' }) })).json();
  const opts = await (await fetch(base + '/api/options', { headers: staff })).json();
  assert.deepStrictEqual(opts.products.map((x) => x.name), ['쿨링 폴로']);

  const post = (b) => fetch(base + '/api/evaluations', { method: 'POST', headers: staff, body: JSON.stringify({ productId: p.id, staff: '민지', ...b }) });
  assert.strictEqual((await post({ reaction: 4, display: 'shown' })).status, 400); // 판매 반응 누락
  assert.strictEqual((await post({ reaction: 4, display: 'shown', sales: 'good', staff: ' ' })).status, 400); // 이름 누락

  // 민지: 처음 저장 → 같은 이름(공백 차이)으로 다시 저장하면 수정
  assert.strictEqual((await post({ reaction: 2, display: 'shown', sales: 'poor', noBuyReasons: ['정가 부담·할인 없음'] })).status, 400); // 나쁨인데 아쉬운 점 없음
  assert.strictEqual((await post({ reaction: 5, display: 'shown', sales: 'good', cons: ['가격(가치 대비)'], sellReasons: ['선물 수요'] })).status, 400); // 좋음인데 좋은 점 없음
  assert.strictEqual((await post({ reaction: 5, display: 'shown', sales: 'good', pros: ['디자인'] })).status, 400); // 잘 팔린 이유 없음
  assert.strictEqual((await post({ reaction: 2, display: 'shown', sales: 'poor', cons: ['가격(가치 대비)'] })).status, 400); // 안 팔린 이유 없음
  assert.strictEqual((await post({ reaction: 3, display: 'shown', sales: 'normal', noBuyReasons: ['기타'] })).status, 400); // 보통인데 둘 다 없음
  assert.strictEqual((await post({ reaction: 2, display: 'shown', sales: 'poor', consNote: '기장이 짧음', noBuyReasons: ['정가 부담·할인 없음'] })).status, 201);
  const upd = await post({ staff: '민 지', reaction: 5, display: 'shown', sales: 'good', sellReasons: ['직원 추천·코디 제안', '없는이유'], pros: ['신축성', '신축성', '그립감'], prosNote: '=스윙이 편해요', noBuyReasons: ['정가 부담·할인 없음'], missing: '105 네이비', ageGroups: ['40대', '50대', '90대'], genders: ['남성'] });
  assert.strictEqual(upd.status, 200);
  assert.strictEqual((await upd.json()).updated, true);
  // 준호
  assert.strictEqual((await post({ staff: '준호', reaction: 2, display: 'shown', sales: 'poor', pros: ['신축성'], cons: ['가격(가치 대비)'], noBuyReasons: ['맞는 사이즈 결품'], improvement: '반팔 출시', ageGroups: ['40대'] })).status, 201);

  const mine = await (await fetch(base + '/api/evaluations/mine?staff=' + encodeURIComponent('민지'), { headers: staff })).json();
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].reaction, 5);

  const s = await (await fetch(base + '/api/admin/summary', { headers: admin })).json();
  const ps = s.products.find((x) => x.id === p.id);
  assert.strictEqual(ps.count, 2);
  assert.strictEqual(ps.avgReaction, 3.5);
  assert.deepStrictEqual(ps.sales, { good: 1, normal: 0, poor: 1 });
  assert.deepStrictEqual(ps.pros, [{ name: '신축성', n: 2 }]); // 중복·다른 품목 항목 제거
  assert.deepStrictEqual(ps.noBuyReasons, [{ name: '맞는 사이즈 결품', n: 1 }]); // 잘 팔림이면 이유 무시
  assert.deepStrictEqual(ps.sellReasons, [{ name: '직원 추천·코디 제안', n: 1 }]); // 잘 팔림일 때만, 목록 밖 값 제거
  assert.strictEqual(ps.gap, ''); // 평균 반응 3.5, 판매 반반 → 엇갈림 아님
  assert.deepStrictEqual(ps.ageGroups, [{ name: '40대', n: 2 }, { name: '50대', n: 1 }]);
  assert.deepStrictEqual(ps.missing.map((x) => x.missing), ['105 네이비']);
  assert.ok(s.staff.some((x) => x.name === '민 지' && x.done === 1));

  const csv = await (await fetch(base + '/api/admin/evaluations.csv', { headers: admin })).text();
  assert.match(csv, /쿨링 폴로/);
  assert.match(csv, /"'=스윙이 편해요"/);
  assert.match(csv, /반팔 출시/);
  assert.match(csv, /잘 팔림/);
  assert.match(csv, /직원 추천·코디 제안/);

  await fetch(base + `/api/admin/products/${p.id}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ active: false }) });
  assert.deepStrictEqual((await (await fetch(base + '/api/options', { headers: staff })).json()).products, []);
  assert.strictEqual((await post({ reaction: 5, display: 'shown', sales: 'good', pros: ['디자인'], sellReasons: ['선물 수요'] })).status, 400); // 조사 중지된 상품
});
