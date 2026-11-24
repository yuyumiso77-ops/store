'use strict';
// 골프웨어 매장 — 직원이 상품별로 고객 반응을 종합 평가하는 서버
// (예전 고객별 기록 db.records 는 파일에 그대로 두고 사용하지 않음) (외부 의존성 없음)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || ''; // 비워두면 기록 화면은 비밀번호 없이 열림
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const IMG_DIR = path.join(DATA_DIR, 'images');
const PUBLIC_DIR = path.join(__dirname, 'public');

// 선택지 (화면과 공유) — 골프웨어 매장용
const COMMON_ASPECTS = ['디자인', '색상', '가격', '품질·마감', '브랜드'];
const CATEGORY_ASPECTS = {
  어패럴: ['핏·사이즈', '소재·촉감', '신축성', '통기성·쿨링', '보온성', '세탁·관리'],
  골프화: ['사이즈·발볼', '착화감·쿠션', '접지력·스파이크', '무게', '방수'],
  장갑: ['사이즈·핏', '그립감', '내구성', '통기성', '가죽·소재'],
  용품: ['기능·성능', '무게·휴대성', '수납·구성', '내구성'],
};
const CATEGORIES = Object.keys(CATEGORY_ASPECTS);
const aspectsFor = (category) => [...COMMON_ASPECTS, ...(CATEGORY_ASPECTS[category] || []), '기타'];
const OPTIONS = {
  categories: CATEGORIES,
  aspectsByCategory: Object.fromEntries(CATEGORIES.map((c) => [c, aspectsFor(c)])),
  defaultAspects: aspectsFor(''),
  sales: { good: '잘 팔림', normal: '보통', poor: '잘 안 팔림' },
  noBuyReasons: [
    '가격이 비쌈', '맞는 사이즈 없음', '원하는 색상 없음', '디자인 취향 아님', '핏이 안 맞음', '착용감 불편',
    '이미 비슷한 제품 있음', '온라인·타매장과 비교', '시즌이 안 맞음', '기타',
  ],
  ageGroups: ['20대', '30대', '40대', '50대', '60대 이상'],
  genders: ['남성', '여성'],
  reactions: ['', '매우 나쁨', '나쁨', '보통', '좋음', '매우 좋음'],
};

// ---------- 저장소 ----------
function loadDb() {
  try {
    const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return { ...d, products: d.products || [], evaluations: d.evaluations || [] };
  } catch {
    return { products: [], evaluations: [] };
  }
}
const db = loadDb();
function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ---------- 유틸 ----------
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req, max = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 품번: 영문·숫자·하이픈·밑줄·점 (파일명에서 확장자를 뺀 값)
const cleanCode = (v) => (typeof v === 'string' ? v.trim().slice(0, 60) : '');
const validCode = (c) => /^[\w.-]+$/.test(c);
const byCode = (c) => db.products.find((x) => x.code && x.code.toLowerCase() === c.toLowerCase());
function imageType(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}
const imageUrl = (p) => (p.image ? `/images/${p.image}?v=${p.imageAt}` : null);
const publicProduct = ({ id, code, name, category, active }) => ({ id, code: code || '', name, category, active });

function passwordOf(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return null;
  const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  return decoded.slice(decoded.indexOf(':') + 1);
}
function same(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function guard(req, res, role) {
  const pw = passwordOf(req);
  const isAdmin = pw !== null && same(pw, ADMIN_PASSWORD);
  const ok = role === 'admin' ? isAdmin : !STAFF_PASSWORD || isAdmin || (pw !== null && same(pw, STAFF_PASSWORD));
  if (ok) return true;
  send(res, 401, role === 'admin' ? '관리자 인증이 필요합니다.' : '직원 인증이 필요합니다.', {
    'WWW-Authenticate': `Basic realm="store-${role}", charset="UTF-8"`,
  });
  return false;
}

const intIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const cleanText = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const sameName = (a, b) => a.replace(/\s+/g, '').toLowerCase() === b.replace(/\s+/g, '').toLowerCase();
const pick = (v, allowed) => (Array.isArray(v) ? [...new Set(v.filter((x) => allowed.includes(x)))] : []);

function csvCell(v) {
  const s = String(v ?? '');
  const safe = /^[=+\-@]/.test(s) ? "'" + s : s; // 엑셀 수식 주입 방지
  return '"' + safe.replace(/"/g, '""') + '"';
}

// ---------- 통계 ----------
function countBy(lists) {
  const c = {};
  lists.flat().forEach((x) => (c[x] = (c[x] || 0) + 1));
  return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
}
function summary() {
  const avg = (arr) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null);
  const products = db.products.map((p) => {
    const es = db.evaluations.filter((e) => e.productId === p.id);
    const sales = { good: 0, normal: 0, poor: 0 };
    es.forEach((e) => sales[e.sales]++);
    return {
      ...publicProduct(p),
      imageUrl: imageUrl(p),
      createdAt: p.createdAt,
      count: es.length,
      avgReaction: avg(es.map((e) => e.reaction)),
      sales,
      pros: countBy(es.map((e) => e.pros)),
      cons: countBy(es.map((e) => e.cons)),
      noBuyReasons: countBy(es.map((e) => e.noBuyReasons)),
      ageGroups: countBy(es.map((e) => e.ageGroups)),
      genders: countBy(es.map((e) => e.genders)),
      missing: es.filter((e) => e.missing).map(({ missing, staff, updatedAt }) => ({ missing, staff, updatedAt })),
      notes: es
        .filter((e) => e.prosNote || e.consNote || e.improvement)
        .map(({ staff, reaction, sales, prosNote, consNote, improvement, updatedAt }) => ({ staff, reaction, sales, prosNote, consNote, improvement, updatedAt })),
    };
  });
  const active = db.products.filter((p) => p.active).map((p) => p.id);
  const staff = countBy(db.evaluations.map((e) => [e.staff])).map((x) => ({
    ...x,
    done: db.evaluations.filter((e) => e.staff === x.name && active.includes(e.productId)).length,
  }));
  return { totalEvaluations: db.evaluations.length, activeProducts: active.length, staff, products };
}

// ---------- 라우팅 ----------
const MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
function serveStatic(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found');
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = req.method;

  if (m === 'GET' && p === '/healthz') return send(res, 200, { ok: true });
  if (m === 'GET' && p === '/style.css') return serveStatic(res, 'style.css');

  // 관리자
  if (p === '/admin' || p.startsWith('/api/admin/')) {
    if (!guard(req, res, 'admin')) return;

    if (m === 'GET' && p === '/admin') return serveStatic(res, 'admin.html');
    if (m === 'GET' && p === '/api/admin/summary') return send(res, 200, summary());

    if (m === 'POST' && p === '/api/admin/products') {
      const b = await readBody(req);
      const name = cleanText(b.name, 100);
      if (!name) return send(res, 400, { error: '상품명을 입력해 주세요.' });
      if (!CATEGORIES.includes(b.category)) return send(res, 400, { error: '품목(어패럴·용품·골프화·장갑)을 선택해 주세요.' });
      const code = cleanCode(b.code);
      if (code && !validCode(code)) return send(res, 400, { error: '품번은 영문·숫자·하이픈(-)·밑줄(_)만 쓸 수 있어요.' });
      if (code && byCode(code)) return send(res, 400, { error: `이미 등록된 품번이에요: ${code}` });
      const product = { id: crypto.randomUUID().slice(0, 8), code, name, category: b.category, active: true, createdAt: new Date().toISOString() };
      db.products.push(product);
      saveDb();
      return send(res, 201, product);
    }

    const pm = p.match(/^\/api\/admin\/products\/([\w-]+)$/);
    // 이미지만 삭제 (상품·평가는 유지)
    const pim = p.match(/^\/api\/admin\/products\/([\w-]+)\/image$/);
    if (pim && m === 'DELETE') {
      const product = db.products.find((x) => x.id === pim[1]);
      if (!product) return send(res, 404, { error: '상품이 없습니다.' });
      if (product.image) fs.rmSync(path.join(IMG_DIR, product.image), { force: true });
      delete product.image;
      delete product.imageAt;
      saveDb();
      return send(res, 200, { ok: true });
    }

    // 상품 삭제: 이미지 파일과 그 상품의 평가도 함께 삭제
    if (pm && m === 'DELETE') {
      const product = db.products.find((x) => x.id === pm[1]);
      if (!product) return send(res, 404, { error: '상품이 없습니다.' });
      if (product.image) fs.rmSync(path.join(IMG_DIR, product.image), { force: true });
      const before = db.evaluations.length;
      db.evaluations = db.evaluations.filter((e) => e.productId !== product.id);
      db.products = db.products.filter((x) => x.id !== product.id);
      saveDb();
      return send(res, 200, { ok: true, deletedEvaluations: before - db.evaluations.length });
    }

    if (pm && m === 'PATCH') {
      const product = db.products.find((x) => x.id === pm[1]);
      if (!product) return send(res, 404, { error: '상품이 없습니다.' });
      const b = await readBody(req);
      if (typeof b.active === 'boolean') product.active = b.active;
      if (typeof b.name === 'string' && b.name.trim()) product.name = cleanText(b.name, 100);
      if (CATEGORIES.includes(b.category)) product.category = b.category;
      if (typeof b.code === 'string') {
        const code = cleanCode(b.code);
        if (code && !validCode(code)) return send(res, 400, { error: '품번은 영문·숫자·하이픈(-)·밑줄(_)만 쓸 수 있어요.' });
        const dup = code && byCode(code);
        if (dup && dup.id !== product.id) return send(res, 400, { error: `이미 등록된 품번이에요: ${code}` });
        product.code = code;
      }
      saveDb();
      return send(res, 200, product);
    }

    // 상품 정보 일괄 등록/수정 (CSV: 품번, 상품명, 품목)
    if (m === 'POST' && p === '/api/admin/products/import') {
      const b = await readBody(req, 512 * 1024);
      const rows = Array.isArray(b.rows) ? b.rows.slice(0, 2000) : [];
      const result = { created: 0, updated: 0, errors: [] };
      rows.forEach((r, i) => {
        const code = cleanCode(r.code);
        const name = cleanText(r.name, 100);
        const category = typeof r.category === 'string' ? r.category.trim() : '';
        const line = `${i + 2}행`;
        if (!code || !validCode(code)) return result.errors.push(`${line}: 품번이 올바르지 않아요 (${code || '비어 있음'})`);
        if (category && !CATEGORIES.includes(category)) return result.errors.push(`${line} ${code}: 품목은 ${CATEGORIES.join('·')} 중 하나여야 해요`);
        const product = byCode(code);
        if (product) {
          if (name) product.name = name;
          if (category) product.category = category;
          result.updated++;
        } else {
          if (!category) return result.errors.push(`${line} ${code}: 새 품번은 품목이 필요해요`);
          db.products.push({ id: crypto.randomUUID().slice(0, 8), code, name: name || code, category, active: true, createdAt: new Date().toISOString() });
          result.created++;
        }
      });
      saveDb();
      return send(res, 200, result);
    }

    // 이미지 업로드: 파일명(품번)으로 상품을 찾고, 없으면 새로 등록
    const im = p.match(/^\/api\/admin\/images\/([^/]+)$/);
    if (im && m === 'PUT') {
      const code = cleanCode(decodeURIComponent(im[1]));
      if (!code || !validCode(code)) return send(res, 400, { error: `품번 형식이 올바르지 않아요: ${code}` });
      const buf = await readRaw(req, 5 * 1024 * 1024);
      const ext = imageType(buf);
      if (!ext) return send(res, 400, { error: 'JPG·PNG·WEBP 이미지만 올릴 수 있어요.' });
      let product = byCode(code);
      let created = false;
      if (!product) {
        const category = url.searchParams.get('category');
        if (!CATEGORIES.includes(category)) return send(res, 400, { error: '새 품번이에요. 품목을 먼저 선택해 주세요.' });
        product = { id: crypto.randomUUID().slice(0, 8), code, name: code, category, active: true, createdAt: new Date().toISOString() };
        db.products.push(product);
        created = true;
      }
      const hadImage = !!product.image;
      fs.mkdirSync(IMG_DIR, { recursive: true });
      if (product.image && product.image !== `${product.id}.${ext}`) fs.rmSync(path.join(IMG_DIR, product.image), { force: true });
      fs.writeFileSync(path.join(IMG_DIR, `${product.id}.${ext}`), buf);
      product.image = `${product.id}.${ext}`;
      product.imageAt = Date.now();
      saveDb();
      return send(res, created ? 201 : 200, { created, hadImage, product: { ...publicProduct(product), imageUrl: imageUrl(product) } });
    }

    if (m === 'GET' && p === '/api/admin/evaluations.csv') {
      const prodOf = Object.fromEntries(db.products.map((x) => [x.id, x]));
      const rows = [['수정일시', '직원', '품번', '상품', '품목', '고객반응(1~5)', '판매반응', '안 팔린 이유', '장점', '장점 메모', '단점', '단점 메모', '찾았지만 없던 사이즈·색상', '개선 아이디어', '주 구매 연령대', '주 구매 성별']];
      db.evaluations.forEach((e) => {
        const pr = prodOf[e.productId] || {};
        rows.push([
          e.updatedAt, e.staff, pr.code || '', pr.name || e.productId, pr.category || '', e.reaction, OPTIONS.sales[e.sales],
          e.noBuyReasons.join(', '), e.pros.join(', '), e.prosNote, e.cons.join(', '), e.consNote, e.missing, e.improvement,
          e.ageGroups.join(', '), e.genders.join(', '),
        ]);
      });
      const csv = '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
      return send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="evaluations.csv"' });
    }
    return send(res, 404, 'Not found');
  }

  // 직원 기록 화면
  if (!guard(req, res, 'staff')) return;

  if (m === 'GET' && p === '/') return serveStatic(res, 'index.html');

  const img = p.match(/^\/images\/([\w-]+\.(jpg|png|webp))$/);
  if (m === 'GET' && img) {
    return fs.readFile(path.join(IMG_DIR, img[1]), (err, data) => {
      if (err) return send(res, 404, 'Not found');
      res.writeHead(200, { 'Content-Type': MIME['.' + img[2]], 'Cache-Control': 'private, max-age=604800' });
      res.end(data);
    });
  }

  if (m === 'GET' && p === '/api/options') {
    return send(res, 200, { ...OPTIONS, products: db.products.filter((x) => x.active).map((x) => ({ ...publicProduct(x), imageUrl: imageUrl(x) })) });
  }

  // 내가 평가한 목록 (이어서 하기·수정용)
  if (m === 'GET' && p === '/api/evaluations/mine') {
    const staff = cleanText(url.searchParams.get('staff'), 30);
    return send(res, 200, staff ? db.evaluations.filter((e) => sameName(e.staff, staff)) : []);
  }

  // 평가 저장: 같은 직원 + 같은 상품이면 덮어씀
  if (m === 'POST' && p === '/api/evaluations') {
    const b = await readBody(req);
    const product = db.products.find((x) => x.id === b.productId && x.active);
    if (!product) return send(res, 400, { error: '상품을 선택해 주세요.' });
    const staff = cleanText(b.staff, 30);
    if (!staff) return send(res, 400, { error: '직원 이름을 입력해 주세요.' });
    if (!intIn(b.reaction, 1, 5)) return send(res, 400, { error: '고객 반응을 선택해 주세요.' });
    if (!(b.sales in OPTIONS.sales)) return send(res, 400, { error: '판매 반응을 선택해 주세요.' });
    const now = new Date().toISOString();
    const data = {
      productId: product.id,
      staff,
      reaction: b.reaction,
      sales: b.sales,
      noBuyReasons: b.sales === 'good' ? [] : pick(b.noBuyReasons, OPTIONS.noBuyReasons),
      pros: pick(b.pros, aspectsFor(product.category)),
      prosNote: cleanText(b.prosNote, 500),
      cons: pick(b.cons, aspectsFor(product.category)),
      consNote: cleanText(b.consNote, 500),
      missing: cleanText(b.missing, 200),
      improvement: cleanText(b.improvement, 500),
      ageGroups: pick(b.ageGroups, OPTIONS.ageGroups),
      genders: pick(b.genders, OPTIONS.genders),
      updatedAt: now,
    };
    const existing = db.evaluations.find((e) => e.productId === product.id && sameName(e.staff, staff));
    if (existing) Object.assign(existing, data);
    else db.evaluations.push({ id: crypto.randomUUID(), createdAt: now, ...data });
    saveDb();
    return send(res, existing ? 200 : 201, { ok: true, updated: !!existing });
  }

  send(res, 404, 'Not found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) send(res, 400, { error: '잘못된 요청입니다.' });
    console.error(err.message);
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`서버 실행 중: http://localhost:${PORT}  (관리자: /admin)`);
    if (!process.env.ADMIN_PASSWORD) console.warn('⚠️  ADMIN_PASSWORD 환경변수를 설정하세요. (현재 기본값 사용 중)');
    if (!STAFF_PASSWORD) console.warn('ℹ️  STAFF_PASSWORD 가 없어 직원 기록 화면이 비밀번호 없이 열려 있습니다.');
  });
}

module.exports = { server };
