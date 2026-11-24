'use strict';
// 매장 상품 피드백 조사 서버 (외부 의존성 없음)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const REPURCHASE = ['yes', 'maybe', 'no'];
const AGE_GROUPS = ['', '10대', '20대', '30대', '40대', '50대', '60대 이상'];

// ---------- 저장소 ----------
function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { products: [], feedback: [] };
  }
}
let db = loadDb();
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

function isAdmin(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const pass = decoded.slice(decoded.indexOf(':') + 1);
  const a = Buffer.from(pass);
  const b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  send(res, 401, '관리자 인증이 필요합니다.', {
    'WWW-Authenticate': 'Basic realm="store-admin", charset="UTF-8"',
  });
  return false;
}

const intIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const cleanText = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function csvCell(v) {
  const s = String(v ?? '');
  // 수식 주입 방지 + 따옴표 이스케이프
  const safe = /^[=+\-@]/.test(s) ? "'" + s : s;
  return '"' + safe.replace(/"/g, '""') + '"';
}

// ---------- 통계 ----------
function summary() {
  const avg = (arr) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null);
  return db.products.map((p) => {
    const fb = db.feedback.filter((f) => f.productId === p.id);
    const dist = [1, 2, 3, 4, 5].map((n) => fb.filter((f) => f.rating === n).length);
    const rep = { yes: 0, maybe: 0, no: 0 };
    fb.forEach((f) => rep[f.repurchase]++);
    return {
      ...p,
      count: fb.length,
      avgRating: avg(fb.map((f) => f.rating)),
      avgQuality: avg(fb.map((f) => f.quality)),
      avgPrice: avg(fb.map((f) => f.price)),
      ratingDist: dist,
      repurchase: rep,
      recentComments: fb
        .filter((f) => f.comment)
        .slice(-10)
        .reverse()
        .map((f) => ({ rating: f.rating, comment: f.comment, createdAt: f.createdAt })),
    };
  });
}

// ---------- 라우팅 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function serveStatic(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found');
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = req.method;

  // 고객용
  if (m === 'GET' && p === '/') return serveStatic(res, 'index.html');
  if (m === 'GET' && p === '/style.css') return serveStatic(res, 'style.css');

  if (m === 'GET' && p === '/api/products') {
    return send(res, 200, db.products.filter((x) => x.active).map(({ id, name, category }) => ({ id, name, category })));
  }

  if (m === 'POST' && p === '/api/feedback') {
    const b = await readBody(req);
    const product = db.products.find((x) => x.id === b.productId && x.active);
    if (!product) return send(res, 400, { error: '상품을 선택해 주세요.' });
    if (!intIn(b.rating, 1, 5)) return send(res, 400, { error: '전체 만족도를 선택해 주세요.' });
    if (!intIn(b.quality, 1, 5)) return send(res, 400, { error: '품질 평가를 선택해 주세요.' });
    if (!intIn(b.price, 1, 5)) return send(res, 400, { error: '가격 만족도를 선택해 주세요.' });
    if (!REPURCHASE.includes(b.repurchase)) return send(res, 400, { error: '재구매 의향을 선택해 주세요.' });
    const ageGroup = AGE_GROUPS.includes(b.ageGroup) ? b.ageGroup : '';
    db.feedback.push({
      id: crypto.randomUUID(),
      productId: product.id,
      rating: b.rating,
      quality: b.quality,
      price: b.price,
      repurchase: b.repurchase,
      ageGroup,
      comment: cleanText(b.comment, 1000),
      createdAt: new Date().toISOString(),
    });
    saveDb();
    return send(res, 201, { ok: true });
  }

  // 관리자용
  if (p === '/admin' || p.startsWith('/api/admin/')) {
    if (!requireAdmin(req, res)) return;

    if (m === 'GET' && p === '/admin') return serveStatic(res, 'admin.html');

    if (m === 'GET' && p === '/api/admin/summary') {
      return send(res, 200, { totalFeedback: db.feedback.length, products: summary() });
    }

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

    if (m === 'GET' && p === '/api/admin/feedback.csv') {
      const names = Object.fromEntries(db.products.map((x) => [x.id, x.name]));
      const rows = [['일시', '상품', '전체만족도', '품질', '가격만족도', '재구매의향', '연령대', '의견']];
      const rep = { yes: '있음', maybe: '고민중', no: '없음' };
      db.feedback.forEach((f) =>
        rows.push([f.createdAt, names[f.productId] || f.productId, f.rating, f.quality, f.price, rep[f.repurchase], f.ageGroup, f.comment])
      );
      const csv = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
      return send(res, 200, csv, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="feedback.csv"',
      });
    }
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
    console.log(`피드백 서버 실행 중: http://localhost:${PORT}`);
    console.log(`관리자 페이지: http://localhost:${PORT}/admin`);
    if (!process.env.ADMIN_PASSWORD) console.warn('⚠️  ADMIN_PASSWORD 환경변수를 설정하세요. (현재 기본값 사용 중)');
  });
}

module.exports = { server };
