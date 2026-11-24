'use strict';
// 골프웨어 매장 — 매장별로 상품마다 고객 반응을 종합 평가하는 서버
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
const COMMON_ASPECTS = ['디자인', '색상', '가격(가치 대비)', '품질·마감', '브랜드'];
const CATEGORY_ASPECTS = {
  어패럴: ['핏·사이즈', '소재·촉감', '신축성', '통기성·쿨링', '보온성', '세탁·관리'],
  골프화: ['사이즈·발볼', '착화감·쿠션', '접지력·스파이크', '무게', '방수'],
  장갑: ['사이즈·핏', '그립감', '내구성', '통기성', '가죽·소재'],
  용품: ['기능·성능', '무게·휴대성', '수납·구성', '내구성'],
};
const CATEGORIES = Object.keys(CATEGORY_ASPECTS);
// 복종(상품 종류) 정렬 순서 — 목록에 없는 복종은 뒤쪽에 가나다순
const TYPE_ORDER = {
  어패럴: ['반팔 티셔츠', '긴팔 티셔츠', '맨투맨·후디', '스웨터', '니트 아우터', '베스트', '아우터', '다운', '팬츠', '반바지', '스커트'],
  골프화: ['스파이크', '스파이크리스', '샌들'],
  장갑: ['양피', '합피', '방한 장갑'],
  용품: ['캐디백', '보스턴백', '파우치', '모자', '벨트', '양말', '우산', '기타 용품'],
};
const LINES = ['남성', '여성', '남녀공용'];
const cleanLine = (v) => (LINES.includes(String(v || '').trim()) ? String(v).trim() : '');
const cleanType = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, 30) : '');
const aspectsFor = (category) => [...COMMON_ASPECTS, ...(CATEGORY_ASPECTS[category] || []), '기타'];
const OPTIONS = {
  categories: CATEGORIES,
  typeOrder: TYPE_ORDER,
  lines: LINES,
  aspectsByCategory: Object.fromEntries(CATEGORIES.map((c) => [c, aspectsFor(c)])),
  defaultAspects: aspectsFor(''),
  sales: { good: '잘 팔림', normal: '보통', poor: '잘 안 팔림' },
  // 2-1은 상품 자체가 아닌 '판매 요인'만 묻는다 (상품 장단점은 1-1에서)
  sellReasons: [
    '직원 추천·코디 제안', '할인·프로모션', '시즌·날씨와 잘 맞음', '눈에 잘 띄는 진열', '사이즈·컬러 재고 충분',
    '다른 상품과 함께 구매', '선물 수요', '특별한 요인 없음 (상품 자체가 좋음)', '기타',
  ],
  noBuyReasons: [
    '맞는 사이즈 결품', '원하는 컬러 결품', '정가 부담·할인 없음', '온라인·타매장과 가격 비교', '시즌·날씨와 안 맞음',
    '진열 위치가 눈에 안 띔', '입고 시기가 늦거나 이름', '매장 내 비슷한 상품과 겹침', '특별한 요인 없음 (상품 자체 문제)', '기타',
  ],
  ageGroups: ['20대', '30대', '40대', '50대', '60대 이상'],
  genders: ['남성', '여성'],
  reactions: ['', '매우 나쁨', '나쁨', '보통', '좋음', '매우 좋음'],
  ztecEase: { easy: '쉬웠다', normal: '보통', hard: '어려웠다' },
};

// ---------- 저장소 ----------
function loadDb() {
  try {
    const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return { ...d, products: d.products || [], evaluations: d.evaluations || [], ztec: d.ztec || [], summaries: d.summaries || {} };
  } catch {
    return { products: [], evaluations: [], ztec: [], summaries: {} };
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
// PLC(컬러별 번호): 파일명 속 5~6자리 숫자 (예: FJ_42993_sw.jpg → 42993)
const plcFromName = (n) => (String(n).match(/(?:^|[^0-9])(\d{5,6})(?:[^0-9]|$)/) || [])[1] || '';
// 같은 PLC 사진이 여러 장이면 파일명이 _sw 로 끝나는 사진이 대표
const isSwName = (n) => /(^|[_\-\s])sw$/i.test(String(n).trim());
const byPlc = (plc) => db.products.find((x) => (x.plcs || []).some((q) => q.plc === plc));
function parsePlcs(plcText, colorText) {
  const colors = Object.fromEntries(String(colorText || '').split(/[\s,;]+/).filter(Boolean).map((t) => t.split(':')).filter((a) => a.length === 2));
  return [...new Set(String(plcText || '').split(/[\s,;/]+/).filter((x) => /^\d{4,8}$/.test(x)))].map((plc) => ({ plc, color: (colors[plc] || '').slice(0, 30) }));
}
const byCode = (c) => db.products.find((x) => x.code && x.code.toLowerCase() === c.toLowerCase());
function imageType(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}
// ---------- 상품 사진 (대표 1장 + 상세컷) ----------
// photo = { file, key(원본 파일명), plc, color, rank(엑셀 컬러 순서, 품번 사진은 -1), sw, manual, pinned, at }
function photosOf(p) {
  if (!p.photos) {
    // 예전 데이터(사진 1장) 옮기기
    p.photos = p.image
      ? [{ file: p.image, key: '기존 사진', plc: '', color: '', rank: p.imageRank ?? -1, sw: !!p.imageIsSw, manual: (p.imageRank ?? -1) < 0, pinned: false, at: p.imageAt || 0 }]
      : [];
  }
  return p.photos;
}
// 대표 사진 순서: 직접 지정(★) > 품번 이름 사진 > 엑셀 첫 컬러 > _sw > 파일명
const photoOrder = (a, b) =>
  (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.manual ? 1 : 0) - (a.manual ? 1 : 0) || a.rank - b.rank || (b.sw ? 1 : 0) - (a.sw ? 1 : 0) || a.key.localeCompare(b.key);
function syncMain(p) {
  const ph = photosOf(p).sort(photoOrder);
  if (ph[0]) {
    p.image = ph[0].file;
    p.imageAt = ph[0].at;
  } else {
    delete p.image;
    delete p.imageAt;
  }
  delete p.imageRank;
  delete p.imageIsSw;
}
function removePhotos(p, pred = () => true) {
  const ph = photosOf(p);
  ph.filter(pred).forEach((x) => fs.rmSync(path.join(IMG_DIR, x.file), { force: true }));
  p.photos = ph.filter((x) => !pred(x));
  syncMain(p);
}
const imageUrl = (p) => (p.image ? `/images/${p.image}?v=${p.imageAt}` : null);
const photoList = (p) =>
  photosOf(p).slice().sort(photoOrder).map((x) => ({ id: x.file, url: `/images/${x.file}?v=${x.at}`, label: x.key, color: x.color, pinned: !!x.pinned }));
// 복종이 비어 있으면 상품명 앞부분이 알려진 복종과 정확히 같을 때만 사용 (예: "여성 긴팔 티셔츠 (BLACK)" → 긴팔 티셔츠)
function inferType(name, category) {
  const head = String(name || '').split(' (')[0].trim().replace(/^(남성|여성|남녀공용)\s+/, '');
  return (TYPE_ORDER[category] || []).includes(head) ? head : '';
}
const typeOf = (p) => p.type || inferType(p.name, p.category);
// 구분(남성/여성)이 비어 있으면 상품명 앞의 "남성 "/"여성 "으로 판단
const lineOf = (p) => p.line || (String(p.name || '').match(/^(남성|여성|남녀공용)\s/) || [])[1] || '';
const publicProduct = (p) => ({ id: p.id, code: p.code || '', name: p.name, category: p.category, type: typeOf(p), line: lineOf(p), plcs: p.plcs || [], photos: photoList(p), active: p.active });

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
  send(res, 401, role === 'admin' ? '관리자 인증이 필요합니다.' : '매장 인증이 필요합니다.', {
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
// 고객 반응(상품 자체)과 실제 판매가 엇갈린 상품 찾기
function gapOf(avgReaction, sales, n) {
  if (!n || avgReaction == null) return '';
  const salesScore = (sales.good - sales.poor) / n; // -1 ~ 1
  if (avgReaction >= 3.5 && salesScore <= -0.34) return 'goodReactionPoorSales';
  if (avgReaction <= 2.5 && salesScore >= 0.34) return 'poorReactionGoodSales';
  return '';
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
      sellReasons: countBy(es.map((e) => e.sellReasons || [])),
      gap: gapOf(avg(es.map((e) => e.reaction)), sales, es.length),
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
  return { totalEvaluations: db.evaluations.length, activeProducts: active.length, staff, products, ztec: ztecSummary(), aiEnabled: !!process.env.ANTHROPIC_API_KEY };
}

// ---------- Z-TEC 매장 의견 (매장당 1회) ----------
function ztecSummary() {
  const z = db.ztec;
  const ease = { easy: 0, normal: 0, hard: 0 };
  z.forEach((e) => ease[e.ease]++);
  return {
    count: z.length,
    avgReaction: z.length ? Math.round((z.reduce((a, e) => a + e.reaction, 0) / z.length) * 10) / 10 : null,
    reactionDist: [1, 2, 3, 4, 5].map((n) => z.filter((e) => e.reaction === n).length),
    ease,
    entries: z.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  };
}

// ---------- AI 의견 요약 (Claude API) ----------
// Railway Variables 에 ANTHROPIC_API_KEY 를 넣으면 켜짐
let aiClient = null;
function getAi() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!aiClient) {
    const sdk = require('@anthropic-ai/sdk');
    const Anthropic = sdk.default || sdk.Anthropic;
    aiClient = new Anthropic();
  }
  return aiClient;
}
const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'strengths', 'weaknesses', 'requests', 'actions'],
  properties: {
    headline: { type: 'string', description: '전체 의견을 한두 문장으로 요약' },
    strengths: { type: 'array', items: { type: 'string' }, description: '자주 나온 좋은 점 (많이 나온 순, 최대 5개)' },
    weaknesses: { type: 'array', items: { type: 'string' }, description: '자주 나온 아쉬운 점 (많이 나온 순, 최대 5개)' },
    requests: { type: 'array', items: { type: 'string' }, description: '매장·고객의 개선 요청과 아이디어 (최대 5개)' },
    actions: { type: 'array', items: { type: 'string' }, description: 'MD·영업이 바로 검토할 만한 조치 제안 (최대 3개)' },
  },
};
const SUMMARY_SYSTEM = [
  '당신은 골프웨어 브랜드의 MD를 돕는 분석가입니다.',
  '여러 매장이 남긴 상품 평가와 의견을 읽고, 바쁜 MD가 1분 안에 파악할 수 있게 한국어로 요약합니다.',
  '여러 매장에서 반복해서 나온 내용을 우선하고, 몇 매장에서 나왔는지 대략 함께 적어 주세요 (예: "기장이 짧다 (12개 매장)").',
  '한 매장만 말한 내용은 중요해 보일 때만 넣고, 의견에 없는 내용은 지어내지 마세요.',
  '각 항목은 짧은 한 문장으로 씁니다.',
].join('\n');
const inflight = new Map();
async function runSummary(key, title, body) {
  const ai = getAi();
  if (!ai) {
    const err = new Error('AI 요약을 쓰려면 Railway Variables에 ANTHROPIC_API_KEY를 추가해 주세요.');
    err.status = 503;
    throw err;
  }
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    const response = await ai.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default', // 거절 시 서버가 알맞은 모델로 다시 시도
      system: SUMMARY_SYSTEM,
      output_config: { format: { type: 'json_schema', schema: SUMMARY_SCHEMA } },
      messages: [{ role: 'user', content: `# ${title}\n\n${body}` }],
    });
    if (response.stop_reason === 'refusal') throw Object.assign(new Error('AI가 이 내용을 요약하지 못했어요.'), { status: 502 });
    if (response.stop_reason === 'max_tokens') throw Object.assign(new Error('요약이 너무 길어져 중단됐어요. 다시 시도해 주세요.'), { status: 502 });
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return JSON.parse(text);
  })();
  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}
// 요약할 내용과 '기준'(평가 수·최근 수정 시각)을 만든다. 기준이 바뀌면 다시 요약 필요
function summarySource(key) {
  if (key === 'ztec') {
    const z = db.ztec;
    if (!z.length) return null;
    const zs = ztecSummary();
    const lines = z.map((e) => `- [${e.store}] 반응 ${OPTIONS.reactions[e.reaction]}, 설명 ${OPTIONS.ztecEase[e.ease]}` +
      (e.good ? ` / 좋은 점: ${e.good}` : '') + (e.bad ? ` / 아쉬운 점: ${e.bad}` : '') + (e.suggestion ? ` / 제안: ${e.suggestion}` : ''));
    return {
      basis: `${z.length}:${z.reduce((a, e) => (e.updatedAt > a ? e.updatedAt : a), '')}`,
      title: 'Z-TEC (기능성 라인)에 대한 매장 의견',
      body: `응답 매장 ${zs.count}곳, 평균 고객 반응 ${zs.avgReaction}/5, 설명 쉬움 ${zs.ease.easy}·보통 ${zs.ease.normal}·어려움 ${zs.ease.hard}\n\n매장 의견:\n${lines.join('\n')}`,
      count: z.length,
    };
  }
  const id = key.replace(/^product:/, '');
  const product = db.products.find((x) => x.id === id);
  if (!product) return null;
  const es = db.evaluations.filter((e) => e.productId === id);
  if (!es.length) return null;
  const ps = summary().products.find((x) => x.id === id);
  const top = (list) => list.slice(0, 6).map((x) => `${x.name} ${x.n}`).join(', ') || '없음';
  const lines = es.filter((e) => e.prosNote || e.consNote || e.improvement || e.missing).map((e) =>
    `- [${e.staff}] 반응 ${OPTIONS.reactions[e.reaction]}, 판매 ${OPTIONS.sales[e.sales]}` +
    (e.prosNote ? ` / 좋은 점: ${e.prosNote}` : '') + (e.consNote ? ` / 아쉬운 점: ${e.consNote}` : '') +
    (e.improvement ? ` / 개선: ${e.improvement}` : '') + (e.missing ? ` / 없던 사이즈·색상: ${e.missing}` : ''));
  return {
    basis: `${es.length}:${es.reduce((a, e) => (e.updatedAt > a ? e.updatedAt : a), '')}`,
    title: `${product.code} ${product.name} (${typeOf(product) || product.category})`,
    body: [
      `평가 매장 ${es.length}곳, 평균 고객 반응 ${ps.avgReaction}/5, 판매 반응 잘 팔림 ${ps.sales.good}·보통 ${ps.sales.normal}·잘 안 팔림 ${ps.sales.poor}`,
      `장점으로 꼽힌 항목(횟수): ${top(ps.pros)}`,
      `단점으로 꼽힌 항목(횟수): ${top(ps.cons)}`,
      `판매를 도운 요인: ${top(ps.sellReasons)}`,
      `판매를 막은 요인: ${top(ps.noBuyReasons)}`,
      '',
      lines.length ? `매장 메모:\n${lines.join('\n')}` : '매장 메모: 없음 (위 항목 집계만으로 요약해 주세요)',
    ].join('\n'),
    count: es.length,
  };
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

  if (m === 'GET' && p === '/healthz') return send(res, 200, { ok: true, ai: !!process.env.ANTHROPIC_API_KEY }); // 키 값은 노출하지 않음
  if (m === 'GET' && p === '/style.css') return serveStatic(res, 'style.css');

  // 관리자
  if (p === '/admin' || p.startsWith('/api/admin/')) {
    if (!guard(req, res, 'admin')) return;

    if (m === 'GET' && p === '/admin') return serveStatic(res, 'admin.html');
    if (m === 'GET' && p === '/api/admin/summary') return send(res, 200, summary());

    // ---- 평가 삭제 ----
    // 상품의 매장별 평가 전체 목록
    const pev = p.match(/^\/api\/admin\/products\/([\w-]+)\/evaluations$/);
    if (pev && m === 'GET') {
      const list = db.evaluations.filter((e) => e.productId === pev[1]).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return send(res, 200, list);
    }
    // 평가 한 건 삭제
    const dev = p.match(/^\/api\/admin\/evaluations\/([\w-]+)$/);
    if (dev && m === 'DELETE') {
      const before = db.evaluations.length;
      db.evaluations = db.evaluations.filter((e) => e.id !== dev[1]);
      if (db.evaluations.length === before) return send(res, 404, { error: '평가가 없습니다.' });
      saveDb();
      return send(res, 200, { ok: true });
    }
    // Z-TEC 의견 한 건 삭제
    const dz = p.match(/^\/api\/admin\/ztec\/([\w-]+)$/);
    if (dz && m === 'DELETE') {
      const before = db.ztec.length;
      db.ztec = db.ztec.filter((e) => e.id !== dz[1]);
      if (db.ztec.length === before) return send(res, 404, { error: '의견이 없습니다.' });
      saveDb();
      return send(res, 200, { ok: true });
    }
    // 매장 데이터 전체 삭제 (평가 + Z-TEC). 실수 방지: confirm 에 매장명을 그대로 보내야 함
    const dst = p.match(/^\/api\/admin\/stores\/([^/]+)$/);
    if (dst && m === 'DELETE') {
      const store = decodeURIComponent(dst[1]);
      if (url.searchParams.get('confirm') !== store) return send(res, 400, { error: '확인용 매장명이 일치하지 않아요.' });
      const ev = db.evaluations.length, zt = db.ztec.length;
      db.evaluations = db.evaluations.filter((e) => !sameName(e.staff, store));
      db.ztec = db.ztec.filter((e) => !sameName(e.store, store));
      saveDb();
      return send(res, 200, { ok: true, deletedEvaluations: ev - db.evaluations.length, deletedZtec: zt - db.ztec.length });
    }

    // AI 의견 요약: GET = 저장된 요약, POST = 새로 요약
    const sm = p.match(/^\/api\/admin\/ai-summary\/(ztec|product:[\w-]+)$/);
    if (sm) {
      const key = sm[1];
      const src = summarySource(key);
      const saved = db.summaries[key] || null;
      const view = () => ({ summary: db.summaries[key] || null, stale: !!(db.summaries[key] && src && db.summaries[key].basis !== src.basis), aiEnabled: !!process.env.ANTHROPIC_API_KEY });
      if (m === 'GET') return send(res, 200, view());
      if (m === 'POST') {
        if (!src) return send(res, 400, { error: '요약할 의견이 아직 없어요.' });
        if (saved && saved.basis === src.basis && url.searchParams.get('force') !== '1') return send(res, 200, view());
        try {
          const result = await runSummary(key, src.title, src.body);
          db.summaries[key] = { basis: src.basis, count: src.count, at: new Date().toISOString(), result };
          saveDb();
          return send(res, 200, view());
        } catch (ex) {
          console.error('AI 요약 실패:', ex.status, ex.message);
          if (ex.status === 503 && !getAi()) return send(res, 503, { error: ex.message }); // 키 없음
          if (ex.status === 401) return send(res, 502, { error: 'ANTHROPIC_API_KEY가 올바르지 않아요. Railway Variables의 키를 확인해 주세요.' });
          if (ex.status === 429) return send(res, 502, { error: 'AI 사용량이 많아 잠시 막혔어요. 1~2분 뒤 다시 시도해 주세요.' });
          return send(res, 502, { error: `AI 요약에 실패했어요. 잠시 후 다시 시도해 주세요.` });
        }
      }
    }

    if (m === 'GET' && p === '/api/admin/ztec.csv') {
      const rows = [['수정일시', '매장명', 'Z-TEC 고객 반응(1~5)', '설명 난이도', '좋았던 점', '아쉬웠던 점', '다음 시즌 제안']];
      db.ztec.forEach((e) => rows.push([e.updatedAt, e.store, e.reaction, OPTIONS.ztecEase[e.ease], e.good, e.bad, e.suggestion]));
      const csv = '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
      return send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="ztec.csv"' });
    }

    if (m === 'POST' && p === '/api/admin/products') {
      const b = await readBody(req);
      const name = cleanText(b.name, 100);
      if (!name) return send(res, 400, { error: '상품명을 입력해 주세요.' });
      if (!CATEGORIES.includes(b.category)) return send(res, 400, { error: '품목(어패럴·용품·골프화·장갑)을 선택해 주세요.' });
      const code = cleanCode(b.code);
      if (code && !validCode(code)) return send(res, 400, { error: '품번은 영문·숫자·하이픈(-)·밑줄(_)만 쓸 수 있어요.' });
      if (code && byCode(code)) return send(res, 400, { error: `이미 등록된 품번이에요: ${code}` });
      const product = { id: crypto.randomUUID().slice(0, 8), code, name, category: b.category, type: cleanType(b.type), line: cleanLine(b.line), active: true, createdAt: new Date().toISOString() };
      db.products.push(product);
      saveDb();
      return send(res, 201, product);
    }

    const pm = p.match(/^\/api\/admin\/products\/([\w-]+)$/);
    // 모든 상품의 이미지 일괄 삭제 (상품·평가는 유지). 실수 방지를 위해 confirm=전부삭제 필요
    if (m === 'DELETE' && p === '/api/admin/images') {
      if (url.searchParams.get('confirm') !== '전부삭제') return send(res, 400, { error: '확인 문구가 필요합니다.' });
      let n = 0;
      db.products.forEach((x) => {
        if (!photosOf(x).length) return;
        removePhotos(x);
        n++;
      });
      saveDb();
      return send(res, 200, { ok: true, deleted: n });
    }

    // 이미지만 삭제 (상품·평가는 유지)
    const pim = p.match(/^\/api\/admin\/products\/([\w-]+)\/image$/);
    if (pim && m === 'DELETE') {
      const product = db.products.find((x) => x.id === pim[1]);
      if (!product) return send(res, 404, { error: '상품이 없습니다.' });
      removePhotos(product);
      saveDb();
      return send(res, 200, { ok: true });
    }

    // 사진 한 장 삭제 / 대표로 지정
    const pph = p.match(/^\/api\/admin\/products\/([\w-]+)\/photos\/([\w.-]+)(\/pin)?$/);
    if (pph) {
      const product = db.products.find((x) => x.id === pph[1]);
      const photo = product && photosOf(product).find((x) => x.file === pph[2]);
      if (!photo) return send(res, 404, { error: '사진이 없습니다.' });
      if (m === 'DELETE' && !pph[3]) {
        removePhotos(product, (x) => x === photo);
        saveDb();
        return send(res, 200, { ok: true });
      }
      if (m === 'POST' && pph[3]) {
        photosOf(product).forEach((x) => (x.pinned = x === photo));
        syncMain(product);
        saveDb();
        return send(res, 200, { ok: true });
      }
    }

    // 상품 삭제: 이미지 파일과 그 상품의 평가도 함께 삭제
    if (pm && m === 'DELETE') {
      const product = db.products.find((x) => x.id === pm[1]);
      if (!product) return send(res, 404, { error: '상품이 없습니다.' });
      removePhotos(product);
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
      if (typeof b.type === 'string') product.type = cleanType(b.type);
      if (typeof b.line === 'string') product.line = cleanLine(b.line);
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
        const type = cleanType(r.type);
        const lineVal = cleanLine(r.line);
        const plcs = parsePlcs(r.plc, r.plcColors);
        const line = `${i + 2}행`;
        if (!code || !validCode(code)) return result.errors.push(`${line}: 품번이 올바르지 않아요 (${code || '비어 있음'})`);
        const plcClash = plcs.find((q) => { const o = byPlc(q.plc); return o && (o.code || '').toLowerCase() !== code.toLowerCase(); });
        if (plcClash) return result.errors.push(`${line} ${code}: PLC ${plcClash.plc}는 이미 다른 품번(${byPlc(plcClash.plc).code})에 있어요`);
        if (category && !CATEGORIES.includes(category)) return result.errors.push(`${line} ${code}: 품목은 ${CATEGORIES.join('·')} 중 하나여야 해요`);
        const product = byCode(code);
        if (product) {
          if (name) product.name = name;
          if (type) product.type = type;
          if (lineVal) product.line = lineVal;
          if (plcs.length) product.plcs = plcs;
          if (category) product.category = category;
          result.updated++;
        } else {
          if (!category) return result.errors.push(`${line} ${code}: 새 품번은 품목이 필요해요`);
          db.products.push({ id: crypto.randomUUID().slice(0, 8), code, name: name || code, category, type, line: lineVal, plcs, active: true, createdAt: new Date().toISOString() });
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
      let match = { by: 'code' };
      if (!product) {
        // 파일명이 PLC 번호인 경우: 해당 컬러의 상품을 찾음
        const plc = plcFromName(code);
        if (plc) {
          product = byPlc(plc);
          if (!product) return send(res, 400, { error: `PLC ${plc}에 해당하는 상품이 없어요. PLC 정보 CSV를 먼저 올려 주세요.` });
          const rank = product.plcs.findIndex((q) => q.plc === plc);
          match = { by: 'plc', plc, color: product.plcs[rank].color, rank, sw: isSwName(code) };
        }
      }
      if (!product) {
        const category = url.searchParams.get('category');
        if (!CATEGORIES.includes(category)) return send(res, 400, { error: '새 품번이에요. 품목을 먼저 선택해 주세요.' });
        product = { id: crypto.randomUUID().slice(0, 8), code, name: code, category, active: true, createdAt: new Date().toISOString(), photos: [] };
        db.products.push(product);
        created = true;
      }
      // 같은 파일명(품번 이름 사진은 '품번 사진' 한 칸)은 교체, 새 파일명은 사진 추가
      const ph = photosOf(product);
      const key = match.by === 'code' ? '품번 사진' : code;
      const old = ph.find((x) => x.key.toLowerCase() === key.toLowerCase());
      if (!old && ph.length >= 40) return send(res, 400, { error: '사진은 상품당 40장까지 올릴 수 있어요.' });
      fs.mkdirSync(IMG_DIR, { recursive: true });
      const file = `${product.id}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
      fs.writeFileSync(path.join(IMG_DIR, file), buf);
      const photo = {
        file, key, plc: match.plc || '', color: match.color || '', rank: match.by === 'plc' ? match.rank : -1,
        sw: !!match.sw, manual: match.by === 'code', pinned: old ? !!old.pinned : false, at: Date.now(),
      };
      if (old) {
        fs.rmSync(path.join(IMG_DIR, old.file), { force: true });
        Object.assign(old, photo);
      } else ph.push(photo);
      syncMain(product);
      saveDb();
      const role = product.image === file ? 'main' : 'detail';
      return send(res, created ? 201 : 200, { created, replaced: !!old, role, photoCount: ph.length, match, product: { ...publicProduct(product), imageUrl: imageUrl(product) } });
    }

    if (m === 'GET' && p === '/api/admin/evaluations.csv') {
      const prodOf = Object.fromEntries(db.products.map((x) => [x.id, x]));
      const rows = [['수정일시', '매장명', '품번', '상품', '구분', '품목', '복종', '고객반응(1~5)', '판매반응', '판매를 도운 요인', '판매를 막은 요인', '장점', '장점 메모', '단점', '단점 메모', '찾았지만 없던 사이즈·색상', '개선 아이디어', '주 구매 연령대', '주 구매 성별']];
      db.evaluations.forEach((e) => {
        const pr = prodOf[e.productId] || {};
        rows.push([
          e.updatedAt, e.staff, pr.code || '', pr.name || e.productId, pr.id ? lineOf(pr) : '', pr.category || '', pr.id ? typeOf(pr) : '', e.reaction, OPTIONS.sales[e.sales],
          (e.sellReasons || []).join(', '), e.noBuyReasons.join(', '), e.pros.join(', '), e.prosNote, e.cons.join(', '), e.consNote, e.missing, e.improvement,
          e.ageGroups.join(', '), e.genders.join(', '),
        ]);
      });
      const csv = '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
      return send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="evaluations.csv"' });
    }
    return send(res, 404, 'Not found');
  }

  // 매장 평가 화면
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

  // Z-TEC 매장 의견 (매장당 1회, 다시 저장하면 수정)
  if (m === 'GET' && p === '/api/ztec/mine') {
    const store = cleanText(url.searchParams.get('store'), 30);
    return send(res, 200, (store && db.ztec.find((e) => sameName(e.store, store))) || null);
  }
  if (m === 'POST' && p === '/api/ztec') {
    const b = await readBody(req);
    const store = cleanText(b.store, 30);
    if (!store) return send(res, 400, { error: '매장명을 먼저 입력해 주세요.' });
    if (!intIn(b.reaction, 1, 5)) return send(res, 400, { error: 'Z-TEC 고객 반응을 선택해 주세요.' });
    if (!(b.ease in OPTIONS.ztecEase)) return send(res, 400, { error: '설명 난이도를 선택해 주세요.' });
    const data = { store, reaction: b.reaction, ease: b.ease, good: cleanText(b.good, 500), bad: cleanText(b.bad, 500), suggestion: cleanText(b.suggestion, 500), updatedAt: new Date().toISOString() };
    const existing = db.ztec.find((e) => sameName(e.store, store));
    if (existing) Object.assign(existing, data);
    else db.ztec.push({ id: crypto.randomUUID(), createdAt: data.updatedAt, ...data });
    saveDb();
    return send(res, existing ? 200 : 201, { ok: true, updated: !!existing });
  }

  // 내가 평가한 목록 (이어서 하기·수정용)
  if (m === 'GET' && p === '/api/evaluations/mine') {
    const staff = cleanText(url.searchParams.get('staff'), 30);
    return send(res, 200, staff ? db.evaluations.filter((e) => sameName(e.staff, staff)) : []);
  }

  // 평가 저장: 같은 매장 + 같은 상품이면 덮어씀
  if (m === 'POST' && p === '/api/evaluations') {
    const b = await readBody(req);
    const product = db.products.find((x) => x.id === b.productId && x.active);
    if (!product) return send(res, 400, { error: '상품을 선택해 주세요.' });
    const staff = cleanText(b.staff, 30);
    if (!staff) return send(res, 400, { error: '매장명을 입력해 주세요.' });
    if (!intIn(b.reaction, 1, 5)) return send(res, 400, { error: '고객 반응을 선택해 주세요.' });
    if (!(b.sales in OPTIONS.sales)) return send(res, 400, { error: '판매 반응을 선택해 주세요.' });
    // 판매 반응에 따라 이어지는 질문(2-1) 필수 확인
    if (b.sales === 'good' && !pick(b.sellReasons, OPTIONS.sellReasons).length) return send(res, 400, { error: '판매를 도운 요인을 하나 이상 골라 주세요.' });
    if (b.sales !== 'good' && !pick(b.noBuyReasons, OPTIONS.noBuyReasons).length) return send(res, 400, { error: '판매를 막은 요인을 하나 이상 골라 주세요.' });
    // 고객 반응에 따라 이어지는 질문(1-1) 필수 확인
    const aspects = aspectsFor(product.category);
    const hasPros = pick(b.pros, aspects).length > 0 || cleanText(b.prosNote, 500) !== '';
    const hasCons = pick(b.cons, aspects).length > 0 || cleanText(b.consNote, 500) !== '';
    if (b.reaction >= 4 && !hasPros) return send(res, 400, { error: '고객들이 좋아한 점을 하나 이상 골라 주세요.' });
    if (b.reaction <= 2 && !hasCons) return send(res, 400, { error: '고객들이 아쉬워한 점을 하나 이상 골라 주세요.' });
    if (b.reaction === 3 && !hasPros && !hasCons) return send(res, 400, { error: '좋았던 점이나 아쉬웠던 점을 하나 이상 골라 주세요.' });
    const now = new Date().toISOString();
    const data = {
      productId: product.id,
      staff,
      reaction: b.reaction,
      sales: b.sales,
      noBuyReasons: b.sales === 'good' ? [] : pick(b.noBuyReasons, OPTIONS.noBuyReasons),
      sellReasons: b.sales === 'good' ? pick(b.sellReasons, OPTIONS.sellReasons) : [],
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

// 예전 데이터(사진 1장)를 사진 목록 구조로 옮기기 — 함수 정의 뒤에 실행
db.products.forEach((p) => { photosOf(p); syncMain(p); });

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
    if (!STAFF_PASSWORD) console.warn('ℹ️  STAFF_PASSWORD 가 없어 매장 평가 화면이 비밀번호 없이 열려 있습니다.');
  });
}

module.exports = { server, _setAiClient: (c) => (aiClient = c) }; // _setAiClient: 테스트용
