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
    { code: 'FNJMT3101', name: '긴팔 티셔츠 (BLACK)', category: '어패럴' },
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
  assert.deepStrictEqual([t.name, t.category], ['긴팔 티 수정', '어패럴']);
  assert.strictEqual(s.products.find((x) => x.code === 'FNJMP3601').name, 'FNJMP3601'); // 이름 없으면 품번
  for (const x of s.products.filter((p) => ['FNJMT3101', 'FNJMP3601'].includes(p.code)))
    await fetch(base + `/api/admin/products/${x.id}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ active: false }) });
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
  assert.strictEqual((await post({ reaction: 2, sales: 'poor', noBuyReasons: ['가격이 비쌈'] })).status, 201);
  const upd = await post({ staff: '민 지', reaction: 5, sales: 'good', pros: ['신축성', '신축성', '그립감'], prosNote: '=스윙이 편해요', noBuyReasons: ['가격이 비쌈'], missing: '105 네이비', ageGroups: ['40대', '50대', '90대'], genders: ['남성'] });
  assert.strictEqual(upd.status, 200);
  assert.strictEqual((await upd.json()).updated, true);
  // 준호
  assert.strictEqual((await post({ staff: '준호', reaction: 2, sales: 'poor', pros: ['신축성'], cons: ['가격'], noBuyReasons: ['맞는 사이즈 없음'], improvement: '반팔 출시', ageGroups: ['40대'] })).status, 201);

  const mine = await (await fetch(base + '/api/evaluations/mine?staff=' + encodeURIComponent('민지'), { headers: staff })).json();
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].reaction, 5);

  const s = await (await fetch(base + '/api/admin/summary', { headers: admin })).json();
  const ps = s.products.find((x) => x.id === p.id);
  assert.strictEqual(ps.count, 2);
  assert.strictEqual(ps.avgReaction, 3.5);
  assert.deepStrictEqual(ps.sales, { good: 1, normal: 0, poor: 1 });
  assert.deepStrictEqual(ps.pros, [{ name: '신축성', n: 2 }]); // 중복·다른 품목 항목 제거
  assert.deepStrictEqual(ps.noBuyReasons, [{ name: '맞는 사이즈 없음', n: 1 }]); // 잘 팔림이면 이유 무시
  assert.deepStrictEqual(ps.ageGroups, [{ name: '40대', n: 2 }, { name: '50대', n: 1 }]);
  assert.deepStrictEqual(ps.missing.map((x) => x.missing), ['105 네이비']);
  assert.ok(s.staff.some((x) => x.name === '민 지' && x.done === 1));

  const csv = await (await fetch(base + '/api/admin/evaluations.csv', { headers: admin })).text();
  assert.match(csv, /쿨링 폴로/);
  assert.match(csv, /"'=스윙이 편해요"/);
  assert.match(csv, /반팔 출시/);
  assert.match(csv, /잘 팔림/);

  await fetch(base + `/api/admin/products/${p.id}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ active: false }) });
  assert.deepStrictEqual((await (await fetch(base + '/api/options', { headers: staff })).json()).products, []);
  assert.strictEqual((await post({ reaction: 5, sales: 'good' })).status, 400);
});
