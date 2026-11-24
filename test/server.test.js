'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'store-fb-'));
process.env.ADMIN_PASSWORD = 'secret';
process.env.STAFF_PASSWORD = 'staffpw';
const { server } = require('../server');

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
  await fetch(base + '/api/evaluations', { method: 'POST', headers: staff, body: JSON.stringify({ productId: p.id, staff: '민지', reaction: 3, sales: 'normal', prosNote: '그립감', noBuyReasons: ['기타'] }) });
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
    await fetch(base + '/api/evaluations', { method: 'POST', headers: staff, body: JSON.stringify({ productId: p.id, staff: staffName, reaction: 5, pros: ['디자인'], sales: 'poor', noBuyReasons: ['맞는 사이즈 결품'] }) });
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

test('품목 필수', async () => {
  const r = await fetch(base + '/api/admin/products', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'x', category: '식품' }) });
  assert.strictEqual(r.status, 400);
});

test('상품 등록 → 직원 평가(수정 포함) → 집계 → CSV', async () => {
  const p = await (await fetch(base + '/api/admin/products', { method: 'POST', headers: admin, body: JSON.stringify({ name: '쿨링 폴로', category: '어패럴' }) })).json();
  const opts = await (await fetch(base + '/api/options', { headers: staff })).json();
  assert.deepStrictEqual(opts.products.map((x) => x.name), ['쿨링 폴로']);

  const post = (b) => fetch(base + '/api/evaluations', { method: 'POST', headers: staff, body: JSON.stringify({ productId: p.id, staff: '민지', ...b }) });
  assert.strictEqual((await post({ reaction: 4 })).status, 400); // 판매 반응 누락
  assert.strictEqual((await post({ reaction: 4, sales: 'good', staff: ' ' })).status, 400); // 이름 누락

  // 민지: 처음 저장 → 같은 이름(공백 차이)으로 다시 저장하면 수정
  assert.strictEqual((await post({ reaction: 2, sales: 'poor', noBuyReasons: ['정가 부담·할인 없음'] })).status, 400); // 나쁨인데 아쉬운 점 없음
  assert.strictEqual((await post({ reaction: 5, sales: 'good', cons: ['가격(가치 대비)'], sellReasons: ['선물 수요'] })).status, 400); // 좋음인데 좋은 점 없음
  assert.strictEqual((await post({ reaction: 5, sales: 'good', pros: ['디자인'] })).status, 400); // 잘 팔린 이유 없음
  assert.strictEqual((await post({ reaction: 2, sales: 'poor', cons: ['가격(가치 대비)'] })).status, 400); // 안 팔린 이유 없음
  assert.strictEqual((await post({ reaction: 3, sales: 'normal', noBuyReasons: ['기타'] })).status, 400); // 보통인데 둘 다 없음
  assert.strictEqual((await post({ reaction: 2, sales: 'poor', consNote: '기장이 짧음', noBuyReasons: ['정가 부담·할인 없음'] })).status, 201);
  const upd = await post({ staff: '민 지', reaction: 5, sales: 'good', sellReasons: ['직원 추천·코디 제안', '없는이유'], pros: ['신축성', '신축성', '그립감'], prosNote: '=스윙이 편해요', noBuyReasons: ['정가 부담·할인 없음'], missing: '105 네이비', ageGroups: ['40대', '50대', '90대'], genders: ['남성'] });
  assert.strictEqual(upd.status, 200);
  assert.strictEqual((await upd.json()).updated, true);
  // 준호
  assert.strictEqual((await post({ staff: '준호', reaction: 2, sales: 'poor', pros: ['신축성'], cons: ['가격(가치 대비)'], noBuyReasons: ['맞는 사이즈 결품'], improvement: '반팔 출시', ageGroups: ['40대'] })).status, 201);

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
  assert.strictEqual((await post({ reaction: 5, sales: 'good', pros: ['디자인'], sellReasons: ['선물 수요'] })).status, 400); // 조사 중지된 상품
});
