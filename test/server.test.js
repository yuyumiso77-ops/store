'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'store-fb-'));
process.env.ADMIN_PASSWORD = 'secret';
const { server } = require('../server');

let base;
const auth = { Authorization: 'Basic ' + Buffer.from('admin:secret').toString('base64') };
const json = { 'Content-Type': 'application/json' };

before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

test('관리자 API는 인증 필요', async () => {
  assert.strictEqual((await fetch(base + '/api/admin/summary')).status, 401);
  assert.strictEqual((await fetch(base + '/admin')).status, 401);
});

test('상품 등록 → 피드백 제출 → 집계 → CSV', async () => {
  const p = await (await fetch(base + '/api/admin/products', { method: 'POST', headers: { ...auth, ...json }, body: JSON.stringify({ name: '딸기잼', category: '식품' }) })).json();
  const list = await (await fetch(base + '/api/products')).json();
  assert.deepStrictEqual(list.map((x) => x.name), ['딸기잼']);

  const bad = await fetch(base + '/api/feedback', { method: 'POST', headers: json, body: JSON.stringify({ productId: p.id, rating: 9 }) });
  assert.strictEqual(bad.status, 400);

  for (const [rating, repurchase] of [[5, 'yes'], [3, 'no']]) {
    const r = await fetch(base + '/api/feedback', { method: 'POST', headers: json, body: JSON.stringify({ productId: p.id, rating, quality: 4, price: 3, repurchase, comment: '=맛있어요' }) });
    assert.strictEqual(r.status, 201);
  }

  const s = await (await fetch(base + '/api/admin/summary', { headers: auth })).json();
  assert.strictEqual(s.totalFeedback, 2);
  assert.strictEqual(s.products[0].avgRating, 4);
  assert.deepStrictEqual(s.products[0].repurchase, { yes: 1, maybe: 0, no: 1 });

  const csv = await (await fetch(base + '/api/admin/feedback.csv', { headers: auth })).text();
  assert.match(csv, /딸기잼/);
  assert.match(csv, /"'=맛있어요"/); // 수식 주입 방지

  await fetch(base + `/api/admin/products/${p.id}`, { method: 'PATCH', headers: { ...auth, ...json }, body: JSON.stringify({ active: false }) });
  assert.deepStrictEqual(await (await fetch(base + '/api/products')).json(), []);
  const closed = await fetch(base + '/api/feedback', { method: 'POST', headers: json, body: JSON.stringify({ productId: p.id, rating: 5, quality: 5, price: 5, repurchase: 'yes' }) });
  assert.strictEqual(closed.status, 400);
});
