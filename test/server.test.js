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

test('상품 등록 → 직원 기록 → 집계 → CSV', async () => {
  const p = await (await fetch(base + '/api/admin/products', { method: 'POST', headers: admin, body: JSON.stringify({ name: '딸기잼', category: '식품' }) })).json();
  const opts = await (await fetch(base + '/api/options', { headers: staff })).json();
  assert.deepStrictEqual(opts.products.map((x) => x.name), ['딸기잼']);

  const post = (b) => fetch(base + '/api/records', { method: 'POST', headers: staff, body: JSON.stringify({ productId: p.id, staff: '민지', ...b }) });
  assert.strictEqual((await post({ reaction: 4 })).status, 400); // 구매 결과 누락
  assert.strictEqual((await post({ reaction: 4, outcome: 'bought', staff: ' ' })).status, 400); // 이름 누락

  assert.strictEqual((await post({ reaction: 5, outcome: 'bought', pros: ['맛', '맛', '없는항목'], prosNote: '=덜 달아요', noBuyReasons: ['가격이 비쌈'] })).status, 201);
  assert.strictEqual((await post({ reaction: 2, outcome: 'no', pros: ['맛'], cons: ['가격'], noBuyReasons: ['가격이 비쌈'], improvement: '소용량 출시' })).status, 201);

  const s = await (await fetch(base + '/api/admin/summary', { headers: admin })).json();
  const ps = s.products[0];
  assert.strictEqual(s.totalRecords, 2);
  assert.strictEqual(ps.avgReaction, 3.5);
  assert.strictEqual(ps.buyRate, 50);
  assert.deepStrictEqual(ps.pros, [{ name: '맛', n: 2 }]); // 중복·잘못된 항목 제거
  assert.deepStrictEqual(ps.cons, [{ name: '가격', n: 1 }]);
  assert.deepStrictEqual(ps.noBuyReasons, [{ name: '가격이 비쌈', n: 1 }]); // 구매한 건은 미구매 이유 무시
  assert.deepStrictEqual(s.staff, [{ name: '민지', n: 2 }]);

  const csv = await (await fetch(base + '/api/admin/records.csv', { headers: admin })).text();
  assert.match(csv, /딸기잼/);
  assert.match(csv, /"'=덜 달아요"/);
  assert.match(csv, /소용량 출시/);

  await fetch(base + `/api/admin/products/${p.id}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ active: false }) });
  assert.deepStrictEqual((await (await fetch(base + '/api/options', { headers: staff })).json()).products, []);
  assert.strictEqual((await post({ reaction: 5, outcome: 'bought' })).status, 400);
});
