'use strict';
// 매장 직원용 상품 고객반응 조사 서버 (외부 의존성 없음)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || ''; // 비워두면 기록 화면은 비밀번호 없이 열림
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// 선택지 (화면과 공유)
const OPTIONS = {
  aspects: ['가격', '품질', '맛', '향', '디자인·포장', '용량·크기', '사용 편의', '기능·효과', '브랜드', '기타'],
  outcomes: { bought: '구매함', hold: '고민 후 보류', no: '구매 안 함' },
  noBuyReasons: ['가격이 비쌈', '품질이 기대 이하', '취향에 안 맞음', '이미 비슷한 상품 있음', '용량·크기가 안 맞음', '다른 매장/온라인과 비교', '필요 없음', '기타'],
  ageGroups: ['10대', '20대', '30대', '40대', '50대', '60대 이상'],
  genders: ['남성', '여성'],
  reactions: ['', '매우 부정적', '부정적', '보통', '긍정적', '매우 긍정적'],
};

// ---------- 저장소 ----------
function loadDb() {
  try {
    const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return { products: d.products || [], records: d.records || [] };
  } catch {
    return { products: [], records: [] };
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 32 * 1024) {
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
    const rs = db.records.filter((r) => r.productId === p.id);
    const outcomes = { bought: 0, hold: 0, no: 0 };
    rs.forEach((r) => outcomes[r.outcome]++);
    return {
      ...p,
      count: rs.length,
      avgReaction: avg(rs.map((r) => r.reaction)),
      outcomes,
      buyRate: rs.length ? Math.round((outcomes.bought / rs.length) * 100) : null,
      pros: countBy(rs.map((r) => r.pros)),
      cons: countBy(rs.map((r) => r.cons)),
      noBuyReasons: countBy(rs.map((r) => r.noBuyReasons)),
      notes: rs
        .filter((r) => r.prosNote || r.consNote || r.improvement)
        .slice(-15)
        .reverse()
        .map(({ staff, reaction, outcome, prosNote, consNote, improvement, createdAt }) => ({ staff, reaction, outcome, prosNote, consNote, improvement, createdAt })),
    };
  });
  return {
    totalRecords: db.records.length,
    staff: countBy(db.records.map((r) => [r.staff])),
    products,
  };
}

// ---------- 라우팅 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
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
      const product = { id: crypto.randomUUID().slice(0, 8), name, category: cleanText(b.category, 50), active: true, createdAt: new Date().toISOString() };
      db.products.push(product);
      saveDb();
      return send(res, 201, product);
    }

    const pm = p.match(/^\/api\/admin\/products\/([\w-]+)$/);
    if (pm && m === 'PATCH') {
      const product = db.products.find((x) => x.id === pm[1]);
      if (!product) return send(res, 404, { error: '상품이 없습니다.' });
      const b = await readBody(req);
      if (typeof b.active === 'boolean') product.active = b.active;
      if (typeof b.name === 'string' && b.name.trim()) product.name = cleanText(b.name, 100);
      if (typeof b.category === 'string') product.category = cleanText(b.category, 50);
      saveDb();
      return send(res, 200, product);
    }

    if (m === 'GET' && p === '/api/admin/records.csv') {
      const names = Object.fromEntries(db.products.map((x) => [x.id, x.name]));
      const rows = [['일시', '직원', '상품', '고객반응(1~5)', '구매결과', '미구매이유', '장점', '장점 메모', '단점', '단점 메모', '개선 아이디어', '연령대', '성별']];
      db.records.forEach((r) =>
        rows.push([
          r.createdAt, r.staff, names[r.productId] || r.productId, r.reaction, OPTIONS.outcomes[r.outcome],
          r.noBuyReasons.join(', '), r.pros.join(', '), r.prosNote, r.cons.join(', '), r.consNote, r.improvement, r.ageGroup, r.gender,
        ])
      );
      const csv = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
      return send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="records.csv"' });
    }
    return send(res, 404, 'Not found');
  }

  // 직원 기록 화면
  if (!guard(req, res, 'staff')) return;

  if (m === 'GET' && p === '/') return serveStatic(res, 'index.html');

  if (m === 'GET' && p === '/api/options') {
    return send(res, 200, { ...OPTIONS, products: db.products.filter((x) => x.active).map(({ id, name, category }) => ({ id, name, category })) });
  }

  if (m === 'POST' && p === '/api/records') {
    const b = await readBody(req);
    const product = db.products.find((x) => x.id === b.productId && x.active);
    if (!product) return send(res, 400, { error: '상품을 선택해 주세요.' });
    const staff = cleanText(b.staff, 30);
    if (!staff) return send(res, 400, { error: '직원 이름을 입력해 주세요.' });
    if (!intIn(b.reaction, 1, 5)) return send(res, 400, { error: '고객 반응을 선택해 주세요.' });
    if (!(b.outcome in OPTIONS.outcomes)) return send(res, 400, { error: '구매 결과를 선택해 주세요.' });
    db.records.push({
      id: crypto.randomUUID(),
      productId: product.id,
      staff,
      reaction: b.reaction,
      outcome: b.outcome,
      noBuyReasons: b.outcome === 'bought' ? [] : pick(b.noBuyReasons, OPTIONS.noBuyReasons),
      pros: pick(b.pros, OPTIONS.aspects),
      prosNote: cleanText(b.prosNote, 500),
      cons: pick(b.cons, OPTIONS.aspects),
      consNote: cleanText(b.consNote, 500),
      improvement: cleanText(b.improvement, 500),
      ageGroup: OPTIONS.ageGroups.includes(b.ageGroup) ? b.ageGroup : '',
      gender: OPTIONS.genders.includes(b.gender) ? b.gender : '',
      createdAt: new Date().toISOString(),
    });
    saveDb();
    return send(res, 201, { ok: true });
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
