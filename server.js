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
  display: { shown: '진열', stock: '창고만', none: '없음', notReceived: '미입고' }, // 진열 체크 (매장 × SKU). 미입고는 진열률 계산에서 제외
  evalStatus: { done: '평가', nosale: '판매 경험 없음', notreceived: '미입고' }, // 평가 상태. done 외에는 평균·비율에서 제외
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
  // 사은품 니즈 (매장당 1회, 26년 전체 기준)
  giftFreq: { often: '자주 (거의 매일)', sometimes: '가끔 (주 1~2번)', rarely: '거의 없음' },
  giftDelay: { often: '자주 있음', sometimes: '가끔 있음', never: '없음' },
  giftImpact: { big: '구매 결정에 큰 도움', some: '약간 도움', none: '영향 거의 없음', noGift: '사은품 행사가 없었음·모름' },
  giftItems: ['골프공', '골프장갑', '골프 양말', '볼마커·티', '파우치·클러치', '모자·캡', '헤드커버', '골프 타월', '우산', '텀블러·보틀', '슈백(신발 가방)', '보스턴백·가방', '기타'],
  giftThreshold: { 10: '10만원 이상', 20: '20만원 이상', 30: '30만원 이상', 50: '50만원 이상', 100: '100만원 이상' },
};

// ---------- 저장소 ----------
function loadDb() {
  try {
    const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return { ...d, products: d.products || [], evaluations: d.evaluations || [], ztec: d.ztec || [], gifts: d.gifts || [], giftItems: d.giftItems, summaries: d.summaries || {}, displays: d.displays || [], stores: d.stores || [], stock: d.stock || null, sales: d.sales || null, storeSizes: d.storeSizes || null, production: d.production || null };
  } catch {
    return { products: [], evaluations: [], ztec: [], gifts: [], summaries: {}, displays: [], stores: [] };
  }
}
const db = loadDb();
let DB_VER = 0; // 저장할 때마다 올라감 → 무거운 집계(summary) 재사용 판단
function saveDb() {
  DB_VER++;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db)); // 들여쓰기 없이 (재고·진열 데이터가 커서)
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
  lists.flat().filter((x) => x != null && x !== '').forEach((x) => (c[x] = (c[x] || 0) + 1));
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
const isDone = (e) => (e.status || 'done') === 'done';
let SUMMARY_CACHE = { ver: -1, val: null };
function summary() {
  if (SUMMARY_CACHE.ver === DB_VER && SUMMARY_CACHE.val) return SUMMARY_CACHE.val;
  const val = computeSummary();
  SUMMARY_CACHE = { ver: DB_VER, val };
  return val;
}
function computeSummary() {
  // 생산·판매·판매율: 생산수량 = 올린 생산 자료, 판매수량 = 생산 자료의 판매수량(있으면) 없으면 판매 자료(매장 판매 합계)
  const psales = typeof productSales === 'function' ? productSales() : null;
  const prodOf = (id) => (db.production && db.production.products[id]) || null;
  const avg = (arr) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null);
  const products = db.products.map((p) => {
    const all = db.evaluations.filter((e) => e.productId === p.id);
    const es = all.filter(isDone);
    const fb = all.filter((e) => isDone(e) || e.status === 'nosale'); // 장단점·의견에는 '판매 경험 없음' 응대 의견도 포함
    const skipped = { nosale: all.filter((e) => e.status === 'nosale').length, notreceived: all.filter((e) => e.status === 'notreceived').length };
    const sales = { good: 0, normal: 0, poor: 0 };
    const display = { shown: 0, stock: 0, none: 0, notReceived: 0 };
    db.displays.forEach((d) => { if (d.productId === p.id) display[d.status]++; });
    const answered = display.shown + display.stock + display.none;
    es.forEach((e) => sales[e.sales]++);
    return {
      ...publicProduct(p),
      imageUrl: imageUrl(p),
      createdAt: p.createdAt,
      count: es.length,
      skipped,
      avgReaction: avg(es.map((e) => e.reaction)),
      sales,
      display,
      displayRate: answered ? Math.round((display.shown / answered) * 100) : null,
      pros: countBy(fb.map((e) => e.pros)),
      cons: countBy(fb.map((e) => e.cons)),
      noBuyReasons: countBy(es.map((e) => e.noBuyReasons)),
      sellReasons: countBy(es.map((e) => e.sellReasons || [])),
      gap: gapOf(avg(es.map((e) => e.reaction)), sales, es.length),
      ...(() => {
        const pr = prodOf(p.id);
        const salesQty = pr && pr.sales != null ? pr.sales : psales ? (psales.get(p.id) || { qty: 0 }).qty : null;
        const prodQty = pr ? pr.prod : null;
        return { prodQty, salesQty, sellThrough: prodQty && salesQty != null ? Math.round((salesQty / prodQty) * 1000) / 10 : null };
      })(),
      ageGroups: countBy(es.map((e) => e.ageGroups)),
      genders: countBy(es.map((e) => e.genders)),
      missing: es.filter((e) => e.missing).map(({ missing, staff, updatedAt }) => ({ missing, staff, updatedAt })),
      notes: fb
        .filter((e) => e.prosNote || e.consNote || e.improvement)
        .map(({ staff, status, reaction, sales, prosNote, consNote, improvement, updatedAt }) => ({ staff, status: status || 'done', reaction, sales, prosNote, consNote, improvement, updatedAt })),
      nosaleFeedback: all.filter((e) => e.status === 'nosale' && (e.reaction || e.pros.length || e.cons.length || e.prosNote || e.consNote || e.improvement)).length,
    };
  });
  const active = db.products.filter((p) => p.active).map((p) => p.id);
  const staff = countBy(db.evaluations.map((e) => [e.staff])).map((x) => ({
    ...x,
    done: db.evaluations.filter((e) => e.staff === x.name && active.includes(e.productId)).length,
  }));
  const productionInfo = db.production ? { fileName: db.production.fileName, uploadedAt: db.production.uploadedAt, products: Object.keys(db.production.products).length, hasSales: db.production.hasSales, basis: db.production.basis || '생산수량' } : null;
  const salesInfo = db.sales ? { from: db.sales.from, to: db.sales.to } : null;
  return { productionInfo, salesInfo, totalEvaluations: db.evaluations.filter(isDone).length, skippedEvaluations: db.evaluations.filter((e) => !isDone(e)).length, activeProducts: active.length, staff, products, ztec: ztecSummary(), aiEnabled: !!process.env.ANTHROPIC_API_KEY };
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

// ---------- 사은품 니즈 (매장당 1회) ----------
// 2026년 진행 사은품 목록 (처음 실행 시 repo의 gifts/ 사진으로 채움, 이후 관리자 화면에서 이름·사진·노출 관리)
const DEFAULT_GIFTS = [
  ['g01', '메쉬 미니 보스턴백', ['g01a']], ['g02', '패딩 미니 백팩', ['g02a']], ['g03', '마그네틱 골프 타월', ['g03a']],
  ['g04', '플라워 볼파우치', ['g04a']], ['g05', '사피르 슈케어 키트', ['g05a']], ['g06', '토트백', ['g06a']],
  ['g07', '거리측정기 파우치', ['g07a', 'g07b']], ['g08', 'Z-TEC 백팩', ['g08a']], ['g09', 'Z-TEC 메쉬 백팩', ['g09a', 'g09b']],
  ['g10', '폴로 셔츠', ['g10a']], ['g11', '재킷 볼파우치', ['g11a']],
];
function seedGiftItems() {
  if (Array.isArray(db.giftItems)) return;
  fs.mkdirSync(IMG_DIR, { recursive: true });
  db.giftItems = DEFAULT_GIFTS.map(([id, name, files]) => ({
    id, name, active: true,
    photos: files.map((f) => {
      const file = `gift-${f}.jpg`;
      try { fs.copyFileSync(path.join(__dirname, 'gifts', file), path.join(IMG_DIR, file)); } catch (ex) { console.error('사은품 사진 복사 실패:', file, ex.message); }
      return file;
    }),
  }));
  saveDb();
}
const giftItemView = (g) => ({ id: g.id, name: g.name, active: g.active, photos: g.photos.map((f) => `/images/${f}`) });
const GIFT_NA = 'na'; // 우리 매장은 증정 안 함
const GIFT_NR = 'nr'; // 사은품이 매장에 들어오지 않음 (미입고)
const GIFT_SKIP = { [GIFT_NA]: '증정 안 함', [GIFT_NR]: '미입고' };
const giftLabel = (r) => GIFT_SKIP[r] || OPTIONS.reactions[r] || '';

function giftSummary() {
  const g = db.gifts;
  const dist = (key) => Object.fromEntries(Object.keys(OPTIONS[key]).map((k) => [k, g.filter((e) => String(e[key.replace('gift', '').toLowerCase()]) === k).length]));
  const items = OPTIONS.giftItems.map((name) => ({ name, count: g.filter((e) => e.items.includes(name)).length })).filter((x) => x.count).sort((a, b) => b.count - a.count);
  const rated = g.filter((e) => e.reaction);
  // 사은품별 평가가 있으면 그 평균을 매장의 '올해 사은품 반응'으로 사용
  return {
    count: g.length,
    freq: dist('giftFreq'), delay: dist('giftDelay'), impact: dist('giftImpact'), threshold: dist('giftThreshold'),
    items,
    avgReaction: rated.length ? Math.round((rated.reduce((a, e) => a + e.reaction, 0) / rated.length) * 10) / 10 : null,
    reactionDist: [1, 2, 3, 4, 5].map((n) => rated.filter((e) => e.reaction === n).length),
    giftItems: db.giftItems.map((it) => {
      const rv = g.map((e) => ({ store: e.store, ...((e.reviews || {})[it.id] || {}) })).filter((x) => x.r);
      const sc = rv.filter((x) => !GIFT_SKIP[x.r]);
      return {
        ...giftItemView(it), answered: rv.length, na: rv.filter((x) => x.r === GIFT_NA).length, nr: rv.filter((x) => x.r === GIFT_NR).length,
        nrStores: rv.filter((x) => x.r === GIFT_NR).map((x) => x.store), count: sc.length,
        avg: sc.length ? Math.round((sc.reduce((a, x) => a + x.r, 0) / sc.length) * 10) / 10 : null,
        dist: [1, 2, 3, 4, 5].map((n) => sc.filter((x) => x.r === n).length),
        notes: rv.filter((x) => x.note).map((x) => ({ store: x.store, r: x.r, note: x.note })),
      };
    }),
    entries: g.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  };
}

// ---------- 진열 현황 (매장 × SKU) ----------
// SKU = 품번 × 컬러(PLC). PLC가 없는 상품은 상품 자체를 SKU 하나로 본다
const skusOf = (p) => ((p.plcs && p.plcs.length) ? p.plcs.map((q) => ({ sku: q.plc, color: q.color })) : [{ sku: 'P-' + p.id, color: '' }]);
const skuIndex = () => {
  const map = new Map();
  db.products.filter((p) => p.active).forEach((p) => skusOf(p).forEach((k) => map.set(k.sku, { ...k, product: p })));
  return map;
};
function displayReport() {
  const idx = skuIndex();
  const skus = [...idx.values()].map(({ sku, color, product: p }) => {
    const ds = db.displays.filter((d) => d.sku === sku);
    const by = { shown: [], stock: [], none: [], notReceived: [] };
    ds.forEach((d) => by[d.status].push(d.store));
    const n = ds.length;
    const base = n - by.notReceived.length; // 미입고는 진열률에서 제외
    return {
      sku, color, productId: p.id, code: p.code || '', name: p.name, line: lineOf(p), type: typeOf(p), category: p.category, imageUrl: imageUrl(p),
      shown: by.shown.length, stock: by.stock.length, none: by.none.length, notReceived: by.notReceived.length, checked: n,
      rate: base ? Math.round((by.shown.length / base) * 100) : null, stores: by,
    };
  });
  const storeNames = [...new Set(db.displays.map((d) => d.store))];
  const stores = storeNames.map((name) => {
    const mine = db.displays.filter((d) => d.store === name && idx.has(d.sku));
    return { name, checked: mine.length, shown: mine.filter((d) => d.status === 'shown').length, none: mine.filter((d) => d.status === 'none').length, notReceived: mine.filter((d) => d.status === 'notReceived').length };
  }).sort((a, b) => a.checked - b.checked || a.name.localeCompare(b.name));
  const all = db.displays.filter((d) => idx.has(d.sku));
  return {
    totalSkus: idx.size,
    stores,
    totals: { checks: all.length, shown: all.filter((d) => d.status === 'shown').length, stock: all.filter((d) => d.status === 'stock').length, none: all.filter((d) => d.status === 'none').length, notReceived: all.filter((d) => d.status === 'notReceived').length },
    skus,
  };
}

// ---------- 미입고 자동 연동 (상품 평가 ↔ 진열 체크) ----------
// 평가를 '미입고'로 저장 → 그 상품의 모든 컬러를 진열 체크 '미입고'로.
// 평가를 미입고에서 다른 상태로 바꾸면 → 그 상품의 '미입고' 진열 체크를 지움.
function syncDisplayFromEval(store, product, status, prevStatus) {
  const now = new Date().toISOString();
  if (status === 'notreceived') {
    let n = 0;
    skusOf(product).forEach(({ sku }) => {
      const i = db.displays.findIndex((d) => d.sku === sku && sameName(d.store, store));
      const rec = { store: i >= 0 ? db.displays[i].store : store, sku, productId: product.id, status: 'notReceived', updatedAt: now, auto: true };
      if (i >= 0) { if (db.displays[i].status !== 'notReceived') n++; db.displays[i] = rec; } else { db.displays.push(rec); n++; }
    });
    return n ? { display: 'notReceived', count: n } : null;
  }
  if (prevStatus === 'notreceived') {
    const before = db.displays.length;
    db.displays = db.displays.filter((d) => !(d.productId === product.id && sameName(d.store, store) && d.status === 'notReceived'));
    const n = before - db.displays.length;
    return n ? { display: 'cleared', count: n } : null;
  }
  return null;
}
// 진열 체크에서 한 상품의 모든 컬러가 '미입고' → 평가를 '미입고'로 (이미 정식 평가한 건 그대로).
// 미입고가 아닌 컬러가 생기면 → '미입고' 평가를 지움.
function syncEvalFromDisplay(store, productIds) {
  const out = [];
  const now = new Date().toISOString();
  productIds.forEach((pid) => {
    const product = db.products.find((x) => x.id === pid);
    if (!product) return;
    const skus = skusOf(product).map((k) => k.sku);
    const st = skus.map((sku) => (db.displays.find((d) => d.sku === sku && sameName(d.store, store)) || {}).status);
    const allNR = st.every((x) => x === 'notReceived');
    const i = db.evaluations.findIndex((e) => e.productId === pid && sameName(e.staff, store));
    const ev = i >= 0 ? db.evaluations[i] : null;
    if (allNR) {
      if (ev && (ev.status || 'done') === 'done') return; // 정식 평가는 덮어쓰지 않음
      if (ev && ev.status === 'notreceived') return;
      const blank = { productId: pid, staff: ev ? ev.staff : store, status: 'notreceived', reaction: 0, sales: '', noBuyReasons: [], sellReasons: [], pros: [], prosNote: '', cons: [], consNote: '', missing: '', improvement: '', ageGroups: [], genders: [], updatedAt: now, auto: true };
      if (ev) Object.assign(ev, blank); else db.evaluations.push({ id: crypto.randomUUID(), createdAt: now, ...blank });
      out.push({ productId: pid, code: product.code, evaluation: 'notreceived' });
    } else if (ev && ev.status === 'notreceived' && st.some((x) => x && x !== 'notReceived')) {
      db.evaluations.splice(i, 1);
      out.push({ productId: pid, code: product.code, evaluation: 'cleared' });
    }
  });
  return out;
}

// ---------- 조사 대상 매장 명단 ----------
// 매장명 비교: 공백·대소문자 무시, 끝의 '백화점'·'점' 무시 (롯데잠실점 = 롯데잠실)
const storeKey = (n) => String(n || '').toLowerCase().replace(/\s+/g, '').replace(/백화점$/, '').replace(/점$/, '');
const matchStore = (name) => { const k = storeKey(name); return k ? db.stores.find((s) => storeKey(s.name) === k) : null; };
// 응답 품질 점검 기준 (성의 없는 응답 의심 신호)
const QA = { minEvals: 5, sameRatio: 0.8, fastSec: 15, skipRatio: 0.5, minDisplay: 20, dispSameRatio: 0.95, minText: 5 };
function qualityFlags(ev, ds) {
  const flags = [];
  const done = ev.filter(isDone);
  if (done.length >= QA.minEvals) {
    const cnt = {};
    done.forEach((e) => { const k = `${e.reaction}|${e.sales}`; cnt[k] = (cnt[k] || 0) + 1; });
    const top = Math.max(...Object.values(cnt));
    if (top / done.length >= QA.sameRatio) flags.push({ code: 'same', label: '같은 답 반복', detail: `평가한 ${done.length}개 중 ${top}개가 고객 반응·판매 반응이 똑같아요` });
    const texts = done.filter((e) => [e.prosNote, e.consNote, e.improvement, e.missing].some((t) => String(t || '').trim().length >= QA.minText)).length;
    if (!texts) flags.push({ code: 'notext', label: '서술 의견 없음', detail: `평가한 ${done.length}개 모두 좋은 점·아쉬운 점·개선 의견을 쓰지 않았어요` });
    const ts = done.map((e) => Date.parse(e.createdAt || e.updatedAt)).filter(Number.isFinite).sort((a, b) => a - b);
    const gaps = ts.slice(1).map((t, i) => (t - ts[i]) / 1000).filter((g) => g < 30 * 60); // 30분 넘게 쉰 건 제외
    if (gaps.length >= QA.minEvals - 1) {
      const med = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
      if (med < QA.fastSec) flags.push({ code: 'fast', label: '너무 빠른 평가', detail: `상품 하나 평가에 보통 ${Math.round(med)}초밖에 안 걸렸어요` });
    }
  }
  const skipped = ev.length - done.length;
  if (ev.length >= QA.minEvals && skipped / ev.length >= QA.skipRatio) {
    const nr = ev.filter((e) => e.status === 'notreceived').length;
    flags.push({ code: 'skip', label: '평가 제외 많음', detail: `${ev.length}개 중 ${skipped}개를 '판매 안 함'(${skipped - nr})·'미입고'(${nr})로 넘겼어요` });
  }
  if (ds.length >= QA.minDisplay) {
    const cnt = {};
    ds.forEach((d) => (cnt[d.status] = (cnt[d.status] || 0) + 1));
    const [st, n] = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
    const L = { shown: '진열', stock: '재고만', none: '미진열', notReceived: '미입고' };
    if (n / ds.length >= QA.dispSameRatio) flags.push({ code: 'dispSame', label: '진열 체크 일괄 입력', detail: `진열 체크 ${ds.length}개 중 ${n}개가 전부 '${L[st] || st}'예요 (실제로 그런지 확인 필요)` });
  }
  return flags;
}
// 다른 이름으로 입력된 매장 데이터를 공식 매장명으로 합치기 (같은 상품·SKU가 겹치면 최근 입력을 남김)
function mergeStore(from, to) {
  const fk = storeKey(from);
  const newer = (a, b) => (String(a.updatedAt) >= String(b.updatedAt) ? a : b);
  const moved = { evaluations: 0, displays: 0, ztec: 0, gifts: 0 };
  const merge = (list, field, keyOf, kind) => {
    const keep = new Map();
    const out = [];
    list.forEach((x) => {
      const isFrom = storeKey(x[field]) === fk;
      const isTo = sameName(x[field], to);
      if (!isFrom && !isTo) return out.push(x);
      if (isFrom) { x[field] = to; moved[kind]++; }
      const k = keyOf(x);
      const prev = keep.get(k);
      keep.set(k, prev ? newer(prev, x) : x);
    });
    return [...out, ...keep.values()];
  };
  db.evaluations = merge(db.evaluations, 'staff', (e) => e.productId, 'evaluations');
  db.displays = merge(db.displays, 'store', (d) => d.sku, 'displays');
  db.ztec = merge(db.ztec, 'store', () => 'one', 'ztec');
  db.gifts = merge(db.gifts, 'store', () => 'one', 'gifts');
  return moved;
}
function deleteStoreData(store) {
  const before = [db.evaluations.length, db.ztec.length, db.displays.length, db.gifts.length];
  db.evaluations = db.evaluations.filter((e) => !sameName(e.staff, store));
  db.ztec = db.ztec.filter((e) => !sameName(e.store, store));
  db.displays = db.displays.filter((d) => !sameName(d.store, store));
  db.gifts = db.gifts.filter((e) => !sameName(e.store, store));
  return { deletedEvaluations: before[0] - db.evaluations.length, deletedZtec: before[1] - db.ztec.length, deletedDisplays: before[2] - db.displays.length, deletedGifts: before[3] - db.gifts.length };
}
// 1회성 정리 (2026-11-26 요청): 명단에 없는 이름 → 공식 매장명, 순천점 삭제
function fixStoreNames20261126() {
  db.migrations = db.migrations || [];
  if (db.migrations.includes('stores-20261126')) return;
  try { fs.writeFileSync(path.join(DATA_DIR, 'db-backup-before-stores-20261126.json'), JSON.stringify(db)); } catch (ex) { console.error('백업 실패:', ex.message); }
  const MAP = [['롯데부산본점', '롯데부산'], ['신촌현대', '현대신촌'], ['롯데백화점 창원점', '롯데창원'], ['롯데백화점 건대스타시티점', '롯데건대'],
    ['롯데백화점본점', '롯데본점'], ['신세계김해ㅡ', '신세계김해'], ['갤러리아센터시티', '갤센터시티']];
  const log = [];
  MAP.forEach(([from, to]) => { if (db.stores.some((x) => x.name === to)) log.push(`${from} → ${to} ${JSON.stringify(mergeStore(from, to))}`); });
  log.push('순천점 삭제 ' + JSON.stringify(deleteStoreData('순천점')));
  db.migrations.push('stores-20261126');
  saveDb();
  console.log('매장명 정리:\n  ' + log.join('\n  '));
}
function storeProgress() {
  const active = db.products.filter((p) => p.active);
  const activeIds = new Set(active.map((p) => p.id));
  const totalSkus = active.reduce((a, p) => a + skusOf(p).length, 0);
  const skuSet = new Set(active.flatMap((p) => skusOf(p).map((k) => k.sku)));
  const rows = db.stores.map((st) => {
    const k = storeKey(st.name);
    const ev = db.evaluations.filter((e) => storeKey(e.staff) === k && activeIds.has(e.productId));
    const ds = db.displays.filter((d) => storeKey(d.store) === k && skuSet.has(d.sku));
    const zt = db.ztec.find((z) => storeKey(z.store) === k);
    const gf = db.gifts.find((z) => storeKey(z.store) === k);
    const evals = ev.length, display = ds.length;
    const last = [...ev, ...ds, ...(zt ? [zt] : []), ...(gf ? [gf] : [])].reduce((m, x) => (x.updatedAt > m ? x.updatedAt : m), '');
    const names = [...new Set([...ev.map((e) => e.staff), ...ds.map((d) => d.store), ...(zt ? [zt.store] : []), ...(gf ? [gf.store] : [])])];
    const status = !evals && !display && !zt && !gf ? 'none' : evals >= active.length && display >= totalSkus && zt && gf ? 'done' : 'progress';
    return { ...st, evals, evalsDone: ev.filter(isDone).length, skipped: evals - ev.filter(isDone).length, display, ztec: !!zt, gift: !!gf, last, status, names, flags: qualityFlags(ev, ds) };
  });
  // 명단에 없는 이름으로 입력된 데이터
  const seen = new Map();
  const add = (name, field) => { if (matchStore(name)) return; const k = storeKey(name); if (!seen.has(k)) seen.set(k, { name, evals: 0, display: 0, ztec: false, gift: false }); const r = seen.get(k); if (field === 'ztec' || field === 'gift') r[field] = true; else r[field]++; };
  db.evaluations.forEach((e) => add(e.staff, 'evals'));
  db.displays.forEach((d) => add(d.store, 'display'));
  db.ztec.forEach((z) => add(z.store, 'ztec'));
  db.gifts.forEach((z) => add(z.store, 'gift'));
  return { totalProducts: active.length, totalSkus, stores: rows, unknown: [...seen.values()] };
}

// ---------- 진열 분석 (진열 체크 × 상품 평가) ----------
const DA = { highDisplay: 70, lowDisplay: 60, goodReaction: 3.5, badReaction: 2.8, ratio: 0.4, minChecks: 3, minEvals: 3 };
function displayAnalysis() {
  const rep = displayReport();
  const rate = (a, b) => (b ? Math.round((a / b) * 100) : null);
  // 복종별
  const gmap = new Map();
  rep.skus.forEach((k) => {
    const key = `${k.line}|${k.type || k.category}`;
    if (!gmap.has(key)) gmap.set(key, { line: k.line, type: k.type || k.category, skus: 0, shown: 0, stock: 0, none: 0, notReceived: 0, checks: 0 });
    const g = gmap.get(key);
    g.skus++; g.shown += k.shown; g.stock += k.stock; g.none += k.none; g.notReceived += k.notReceived; g.checks += k.checked;
  });
  const byType = [...gmap.values()].map((g) => ({ ...g, rate: rate(g.shown, g.checks - g.notReceived) }))
    .sort((a, b) => (a.line + a.type).localeCompare(b.line + b.type));
  // 매장별 (진열률, 없음·창고만 SKU 목록)
  const idx = skuIndex();
  const byStore = rep.stores.map((st) => {
    const mine = db.displays.filter((d) => d.store === st.name && idx.has(d.sku));
    const list = (status) => mine.filter((d) => d.status === status).map((d) => { const k = idx.get(d.sku); return { code: k.product.code || k.product.name, color: k.color }; });
    const shown = mine.filter((d) => d.status === 'shown').length;
    const nr = list('notReceived');
    return { name: st.name, checked: mine.length, coverage: rate(mine.length, rep.totalSkus), rate: rate(shown, mine.length - nr.length), shown, noneSkus: list('none'), stockSkus: list('stock'), notReceivedSkus: nr };
  }).sort((a, b) => (a.rate ?? 999) - (b.rate ?? 999) || a.name.localeCompare(b.name));
  // 상품별: 진열률 × 고객 반응 × 판매 반응
  const products = summary().products.filter((p) => p.active).map((p) => {
    const checks = p.display.shown + p.display.stock + p.display.none; // 미입고 제외
    const good = p.count ? p.sales.good / p.count : null;
    const poor = p.count ? p.sales.poor / p.count : null;
    const enough = checks >= DA.minChecks && p.count >= DA.minEvals;
    let group = '';
    if (enough) {
      if (p.displayRate < DA.lowDisplay && (p.avgReaction >= DA.goodReaction || good >= DA.ratio)) group = 'expand';
      else if (p.displayRate >= DA.highDisplay && p.avgReaction >= DA.goodReaction && good >= DA.ratio) group = 'star';
      else if (p.displayRate >= DA.highDisplay && (poor >= DA.ratio || p.avgReaction < DA.badReaction)) group = 'review';
    }
    return {
      id: p.id, code: p.code, name: p.name, line: p.line, type: p.type, imageUrl: p.imageUrl,
      displayRate: p.displayRate, checks, display: p.display, avgReaction: p.avgReaction, evals: p.count,
      goodPct: good == null ? null : Math.round(good * 100), poorPct: poor == null ? null : Math.round(poor * 100), group,
    };
  });
  // 창고에만 있는 SKU (진열하면 바로 팔 수 있는 재고), 매장에 없는 SKU
  const topBy = (field) => rep.skus.filter((k) => k[field] > 0).sort((a, b) => b[field] - a[field] || (a.code + a.color).localeCompare(b.code + b.color)).slice(0, 15)
    .map(({ sku, code, color, name, line, type, imageUrl, shown, stock, none, notReceived, checked, stores }) => ({ sku, code, color, name, line, type, imageUrl, shown, stock, none, notReceived, checked, stores: stores[field] }));
  return { thresholds: DA, totals: rep.totals, storeCount: rep.stores.length, totalSkus: rep.totalSkus, byType, byStore, products, stockOnly: topBy('stock'), missing: topBy('none'), notReceived: topBy('notReceived') };
}

// ---------- 🧩 공간 효율 (좁은 매장 공간에 잘 팔리는 상품이 걸려 있는가) ----------
// 진열 자리 = 진열(shown) 중인 SKU 하나. 그 자리의 판매 점수 = 그 매장의 상품 평가(잘 팔림 100·보통 50·안 팔림 0),
// 그 매장 평가가 없으면 전체 매장 평균으로 대신함
const SELL = { good: 100, normal: 50, poor: 0 };
const sellClass = (s) => (s == null ? 'unknown' : s >= 67 ? 'good' : s <= 33 ? 'poor' : 'normal');
function spaceEfficiency() {
  const idx = skuIndex();
  const own = new Map(); // storeKey|productId -> 점수
  const all = new Map(); // productId -> {sum, n}
  db.evaluations.filter((e) => isDone(e) && e.sales in SELL).forEach((e) => {
    own.set(storeKey(e.staff) + '|' + e.productId, SELL[e.sales]);
    const a = all.get(e.productId) || { sum: 0, n: 0 };
    a.sum += SELL[e.sales]; a.n++; all.set(e.productId, a);
  });
  const scoreOf = (store, pid) => {
    const s = own.get(storeKey(store) + '|' + pid);
    if (s != null) return { score: s, src: 'store' };
    const a = all.get(pid);
    return a ? { score: Math.round(a.sum / a.n), src: 'all' } : { score: null, src: '' };
  };
  const item = (k, sc) => ({ sku: k.sku, code: k.product.code || k.product.name, name: k.product.name, color: k.color, line: lineOf(k.product), type: typeOf(k.product), imageUrl: imageUrl(k.product), score: sc.score, src: sc.src });
  const byStoreMap = new Map();
  db.displays.forEach((d) => {
    const k = idx.get(d.sku);
    if (!k || d.status === 'notReceived') return;
    if (!byStoreMap.has(d.store)) byStoreMap.set(d.store, []);
    byStoreMap.get(d.store).push({ d, k, sc: scoreOf(d.store, k.product.id) });
  });
  const typeKey = (x) => `${x.line}|${x.type}`;
  const types = new Map();
  const skuAgg = new Map(); // 여러 매장 공통 패턴
  const stores = [...byStoreMap.entries()].map(([name, rows]) => {
    const shown = rows.filter((r) => r.d.status === 'shown');
    const known = shown.filter((r) => r.sc.score != null);
    const cnt = { good: 0, normal: 0, poor: 0, unknown: 0 };
    shown.forEach((r) => cnt[sellClass(r.sc.score)]++);
    shown.forEach((r) => {
      const it = item(r.k, r.sc);
      const t = types.get(typeKey(it)) || { line: it.line, type: it.type, slots: 0, known: 0, scoreSum: 0, good: 0, poor: 0 };
      t.slots++; if (r.sc.score != null) { t.known++; t.scoreSum += r.sc.score; } if (sellClass(r.sc.score) === 'good') t.good++; if (sellClass(r.sc.score) === 'poor') t.poor++;
      types.set(typeKey(it), t);
    });
    const poorShown = shown.filter((r) => sellClass(r.sc.score) === 'poor').map((r) => item(r.k, r.sc)).sort((a, b) => a.score - b.score);
    const goodStock = rows.filter((r) => r.d.status === 'stock' && sellClass(r.sc.score) === 'good').map((r) => item(r.k, r.sc)).sort((a, b) => b.score - a.score);
    const goodNone = rows.filter((r) => r.d.status === 'none' && sellClass(r.sc.score) === 'good').map((r) => item(r.k, r.sc)).sort((a, b) => b.score - a.score);
    poorShown.forEach((x) => { const a = skuAgg.get(x.sku) || { ...x, poorShown: [], goodStock: [] }; a.poorShown.push(name); skuAgg.set(x.sku, a); });
    goodStock.forEach((x) => { const a = skuAgg.get(x.sku) || { ...x, poorShown: [], goodStock: [] }; a.goodStock.push(name); skuAgg.set(x.sku, a); });
    // 교체 추천: 안 팔리는 진열 → 창고의 잘 팔리는 상품 (같은 복종 우선)
    const pool = goodStock.slice();
    const swaps = poorShown.map((out) => {
      let i = pool.findIndex((x) => typeKey(x) === typeKey(out));
      if (i < 0) i = pool.findIndex((x) => x.line === out.line);
      if (i < 0) i = 0;
      return pool.length ? { out, in: pool.splice(i, 1)[0] } : null;
    }).filter(Boolean);
    const score = known.length ? Math.round(known.reduce((a, r) => a + r.sc.score, 0) / known.length) : null;
    return {
      name, slots: shown.length, score, ...cnt, ownPct: shown.length ? Math.round((shown.filter((r) => r.sc.src === 'store').length / shown.length) * 100) : 0,
      poorShown, goodStock, goodNone, swaps,
    };
  }).sort((a, b) => (a.score ?? 999) - (b.score ?? 999) || b.poorShown.length - a.poorShown.length);
  const totSlots = stores.reduce((a, s) => a + s.slots, 0);
  const tot = { good: 0, normal: 0, poor: 0, unknown: 0 };
  stores.forEach((s) => Object.keys(tot).forEach((k) => (tot[k] += s[k])));
  const knownSlots = [...types.values()].reduce((a, t) => a + t.known, 0);
  const scoreTotal = [...types.values()].reduce((a, t) => a + t.scoreSum, 0);
  const byType = [...types.values()].map((t) => {
    const space = knownSlots ? t.known / knownSlots : 0;
    const contrib = scoreTotal ? t.scoreSum / scoreTotal : 0;
    return { ...t, spacePct: Math.round(space * 1000) / 10, contribPct: Math.round(contrib * 1000) / 10, score: t.known ? Math.round(t.scoreSum / t.known) : null, efficiency: space ? Math.round((contrib / space) * 100) / 100 : null };
  }).sort((a, b) => (a.line + a.type).localeCompare(b.line + b.type));
  const top = (field) => [...skuAgg.values()].filter((x) => x[field].length).sort((a, b) => b[field].length - a[field].length || a.code.localeCompare(b.code)).slice(0, 15)
    .map((x) => ({ sku: x.sku, code: x.code, name: x.name, color: x.color, type: x.type, line: x.line, imageUrl: x.imageUrl, score: x.score, stores: x[field] }));
  return {
    totals: { slots: totSlots, ...tot, goodStock: stores.reduce((a, s) => a + s.goodStock.length, 0), goodNone: stores.reduce((a, s) => a + s.goodNone.length, 0), swaps: stores.reduce((a, s) => a + s.swaps.length, 0),
      score: knownSlots ? Math.round(scoreTotal / knownSlots) : null, evalCount: db.evaluations.filter(isDone).length },
    byType, stores, wasted: top('poorShown'), idle: top('goodStock'),
  };
}

// ---------- 📄 조사 리포트 (인쇄·PDF용, 지금 데이터로 한 번에) ----------
function buildReport() {
  const sm = summary();
  const prods = sm.products.filter((p) => p.active && p.count);
  const psales = productSales();
  const pick = (p) => ({ id: p.id, salesQty: psales ? (psales.get(p.id) || { qty: 0 }).qty : null, salesAmount: psales ? (psales.get(p.id) || { amount: 0 }).amount : null, code: p.code, name: p.name, line: lineOf(p), type: typeOf(p), imageUrl: p.imageUrl, count: p.count, avgReaction: p.avgReaction,
    goodPct: p.count ? Math.round((p.sales.good / p.count) * 100) : null, poorPct: p.count ? Math.round((p.sales.poor / p.count) * 100) : null, displayRate: p.displayRate,
    pros: p.pros.slice(0, 3).map((x) => x.name), cons: p.cons.slice(0, 3).map((x) => x.name) });
  const enough = prods.filter((p) => p.count >= 3);
  const rank = (dir) => enough.slice().sort((a, b) => dir * (a.avgReaction - b.avgReaction) || b.count - a.count).slice(0, 10).map(pick);
  const typeMap = new Map();
  prods.forEach((p) => {
    const k = `${lineOf(p)}|${typeOf(p)}`;
    const t = typeMap.get(k) || { line: lineOf(p), type: typeOf(p), n: 0, rsum: 0, good: 0, poor: 0, products: 0 };
    t.n += p.count; t.rsum += p.avgReaction * p.count; t.good += p.sales.good; t.poor += p.sales.poor; t.products++;
    typeMap.set(k, t);
  });
  const byType = [...typeMap.values()].map((t) => ({ line: t.line, type: t.type, products: t.products, evals: t.n, avgReaction: Math.round((t.rsum / t.n) * 10) / 10, goodPct: Math.round((t.good / t.n) * 100), poorPct: Math.round((t.poor / t.n) * 100) }))
    .sort((a, b) => (a.line + a.type).localeCompare(b.line + b.type));
  const reasons = (field) => countBy(db.evaluations.filter(isDone).map((e) => e[field] || [])).slice(0, 8);
  const da = displayAnalysis();
  const sp = spaceEfficiency();
  const pr = storeProgress();
  const z = ztecSummary();
  const g = giftSummary();
  const ai = (k) => { const x = db.summaries[k]; if (!x) return null; const src = summarySource(k); return { ...x.result, at: x.at, stale: !!(src && src.basis !== x.basis) }; };
  const allDone = db.evaluations.filter(isDone);
  return {
    at: new Date().toISOString(),
    overview: {
      targetStores: pr.stores.length, participated: pr.stores.filter((x) => x.status !== 'none').length, doneStores: pr.stores.filter((x) => x.status === 'done').length,
      evaluations: allDone.length, skipped: sm.skippedEvaluations, products: sm.activeProducts, evaluatedProducts: prods.length,
      avgReaction: allDone.length ? Math.round((allDone.reduce((a, e) => a + e.reaction, 0) / allDone.length) * 10) / 10 : null,
      sales: { good: allDone.filter((e) => e.sales === 'good').length, normal: allDone.filter((e) => e.sales === 'normal').length, poor: allDone.filter((e) => e.sales === 'poor').length },
      displayChecks: da.totals.checks, displayRate: da.totals.checks - da.totals.notReceived ? Math.round((da.totals.shown / (da.totals.checks - da.totals.notReceived)) * 100) : null,
      spaceScore: sp.totals.score, ztec: z.count, gifts: g.count,
    },
    progress: {
      totalProducts: pr.totalProducts, totalSkus: pr.totalSkus,
      byManager: [...new Set(pr.stores.map((x) => x.manager || '담당자 없음'))].map((m) => {
        const l = pr.stores.filter((x) => (x.manager || '담당자 없음') === m);
        return { manager: m, total: l.length, done: l.filter((x) => x.status === 'done').length, progress: l.filter((x) => x.status === 'progress').length, none: l.filter((x) => x.status === 'none').map((x) => x.name) };
      }),
      flagged: pr.stores.filter((x) => x.flags.length).map((x) => ({ name: x.name, flags: x.flags.map((f) => f.label) })),
    },
    salesInfo: db.sales ? { from: db.sales.from, to: db.sales.to } : null,
    reaction: { top: rank(-1), bottom: rank(1), products: sm.products.filter((p) => p.active && (p.count || (psales && psales.has(p.id)))).map(pick), byType, sellReasons: reasons('sellReasons'), noBuyReasons: reasons('noBuyReasons'), pros: countBy(allDone.map((e) => e.pros || [])).slice(0, 8), cons: countBy(allDone.map((e) => e.cons || [])).slice(0, 8) },
    display: {
      totals: da.totals, byType: da.byType.map((t) => ({ line: t.line, type: t.type, rate: t.rate, shown: t.shown, stock: t.stock, none: t.none, notReceived: t.notReceived })),
      groups: ['expand', 'star', 'review'].map((k) => ({ key: k, items: da.products.filter((p) => p.group === k).map((p) => ({ code: p.code, name: p.name, type: p.type, displayRate: p.displayRate, avgReaction: p.avgReaction, goodPct: p.goodPct })) })),
      notReceived: da.notReceived.slice(0, 10).map((k) => ({ code: k.code, color: k.color, n: k.notReceived })),
    },
    space: { totals: sp.totals, byType: sp.byType.filter((t) => t.known), lowStores: sp.stores.filter((x) => x.score != null).slice(0, 10).map((x) => ({ name: x.name, score: x.score, slots: x.slots, poor: x.poor, goodStock: x.goodStock.length, swaps: x.swaps.length })),
      wasted: sp.wasted.slice(0, 10).map((k) => ({ code: k.code, color: k.color, n: k.stores.length })), idle: sp.idle.slice(0, 10).map((k) => ({ code: k.code, color: k.color, n: k.stores.length })) },
    ztec: { count: z.count, avgReaction: z.avgReaction, ease: z.ease, reactionDist: z.reactionDist },
    gift: { count: g.count, freq: g.freq, delay: g.delay, impact: g.impact, threshold: g.threshold, items: g.items, avgReaction: g.avgReaction,
      giftItems: g.giftItems.filter((x) => x.answered).map((x) => ({ name: x.name, photo: x.photos[0], avg: x.avg, count: x.count, na: x.na, nr: x.nr })).sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1)) },
    ai: { display: ai('display'), ztec: ai('ztec'), gift: ai('gift') },
    labels: { giftFreq: OPTIONS.giftFreq, giftDelay: OPTIONS.giftDelay, giftImpact: OPTIONS.giftImpact, giftThreshold: OPTIONS.giftThreshold, reactions: OPTIONS.reactions },
  };
}

// ---------- 📦 매장 재고 (ERP 매장시점재고현황) × 진열 체크 ----------
// 재고 파일: 매장코드 × 품번 × 색상별 재고수량·판매수량 합계. SKU는 품번 + 색상명으로 맞춤
const normColor = (c) => String(c || '').toUpperCase().replace(/\s+/g, '');
function erpMapper(names) {
  const idx = skuIndex();
  const byCodeColor = new Map();
  idx.forEach((k) => byCodeColor.set(`${k.product.code}|${normColor(k.color)}`, k.sku));
  const storeByCode = new Map(db.stores.filter((s) => s.code).map((s) => [String(s.code).trim(), s.name]));
  const cleanName = (n) => String(n || '').replace(/^FJ\s*/, '').replace(/백화점\s*/, '').replace(/\s+/g, '');
  return {
    sku: (prod, color) => byCodeColor.get(`${String(prod).trim()}|${normColor(color)}`),
    store: (code) => storeByCode.get(String(code).trim()) || (matchStore(cleanName(names[code])) || {}).name || null,
  };
}
// 판매 자료 (ERP 판매 내역): 매장코드 × 품번 × 색상별 판매수량·판매금액 합계 (반품 차감)
function importSales(b) {
  const names = b.stores && typeof b.stores === 'object' ? b.stores : {};
  const mp = erpMapper(names);
  const items = new Map();
  const unmatchedStores = new Set();
  let skipped = 0;
  for (const r of Array.isArray(b.rows) ? b.rows : []) {
    if (!Array.isArray(r) || r.length < 5) { skipped++; continue; }
    const [code, prod, color, qty, amount, weeks] = r;
    const sku = mp.sku(prod, color);
    if (!sku) { skipped++; continue; }
    const store = mp.store(code);
    if (!store) { unmatchedStores.add(names[code] || String(code)); continue; }
    const k = store + '|' + sku;
    const it = items.get(k) || { store, sku, qty: 0, amount: 0 };
    it.qty += Number(qty) || 0; it.amount += Number(amount) || 0;
    if (Array.isArray(weeks)) { it.w = it.w || []; weeks.slice(0, 60).forEach((v, i) => (it.w[i] = (it.w[i] || 0) + (Number(v) || 0))); } // 주별 판매수량
    items.set(k, it);
  }
  if (!items.size) return { error: '조사 대상 상품(품번·색상)이나 매장(매장코드)과 맞는 판매 자료가 없어요. 파일을 확인해 주세요.' };
  db.sales = { from: cleanText(b.from, 20), to: cleanText(b.to, 20), fileName: cleanText(b.fileName, 120), uploadedAt: new Date().toISOString(), items: [...items.values()], unmatchedStores: [...unmatchedStores].slice(0, 50) };
  saveDb();
  const qty = db.sales.items.reduce((a, x) => a + x.qty, 0), amount = db.sales.items.reduce((a, x) => a + x.amount, 0);
  return { ok: true, items: items.size, stores: new Set(db.sales.items.map((x) => x.store)).size, skus: new Set(db.sales.items.map((x) => x.sku)).size, qty, amount, unmatchedStores: db.sales.unmatchedStores, skipped };
}
// 생산수량 자료: 품번(+색상)별 생산수량, 판매수량(선택). 상품 단위로 합침
function importProduction(b) {
  const byCode = new Map(db.products.filter((p) => p.code).map((p) => [String(p.code).toUpperCase().trim(), p]));
  const products = {};
  let matched = 0, skipped = 0, hasSales = false;
  const mp = erpMapper({});
  const skus = {};
  const weekLabels = Array.isArray(b.weekLabels) ? b.weekLabels.slice(0, 60).map((x) => cleanText(x, 40)) : null;
  for (const r of Array.isArray(b.rows) ? b.rows : []) {
    if (!Array.isArray(r)) { skipped++; continue; }
    const [code, color, prod, sales, recv, weeks] = r;
    const p = byCode.get(String(code || '').toUpperCase().trim());
    const q = Number(prod);
    if (!p || !(q >= 0)) { skipped++; continue; }
    // SKU(품번×컬러) 단위: 기획·입고·판매·주별 판매 (판매율 진단용)
    const sku = mp.sku(code, color);
    if (sku) {
      const k = skus[sku] || { plan: 0, recv: 0, sold: 0, w: [] };
      k.plan += q;
      if (recv != null && recv !== '' && !Number.isNaN(Number(recv))) k.recv += Number(recv); else k.recv = null;
      k.sold += Number(sales) || 0;
      if (Array.isArray(weeks) && weekLabels) weeks.slice(0, weekLabels.length).forEach((v, i) => (k.w[i] = (k.w[i] || 0) + (Number(v) || 0)));
      skus[sku] = k;
    }
    const a = products[p.id] || { prod: 0, sales: null };
    a.prod += q;
    if (sales != null && sales !== '' && !Number.isNaN(Number(sales))) { a.sales = (a.sales || 0) + Number(sales); hasSales = true; }
    products[p.id] = a;
    matched++;
  }
  if (!matched) return { error: '조사 상품의 품번과 맞는 생산수량이 없어요. 첫 줄에 품번(상품코드)·생산수량 열이 있는지 확인해 주세요.' };
  db.production = { fileName: cleanText(b.fileName, 120), basis: cleanText(b.basis, 20) || '생산수량', uploadedAt: new Date().toISOString(), products, hasSales, skus, weekLabels: weekLabels && Object.values(skus).some((k) => k.w.length) ? weekLabels : null };
  saveDb();
  return { ok: true, products: Object.keys(products).length, rows: matched, skipped, hasSales };
}
// 🎯 판매율 진단: 기획 대비 판매율 + 남은 재고를 시즌 끝까지 팔 수 있는지 + 매장 진열률 → SKU별 진열 액션
function sellReview() {
  const pr = db.production;
  if (!pr || !pr.skus || !pr.weekLabels) return { ready: false };
  const labels = pr.weekLabels;
  const up = new Date(pr.uploadedAt);
  // 주 라벨 'Nov 3rd11/16~11/22' → 그 주의 마지막 날
  const y0 = up.getUTCMonth() >= 5 ? up.getUTCFullYear() : up.getUTCFullYear() - 1; // 시즌 시작 연도 (6월~)
  const endOf = (l) => { const m = String(l).match(/(\d{1,2})\/(\d{1,2})\s*~\s*(\d{1,2})\/(\d{1,2})/); if (!m) return null; const mo = +m[3]; return Date.UTC(mo >= 6 ? y0 : y0 + 1, mo - 1, +m[4]); };
  const ends = labels.map(endOf);
  const short = (l) => { const m = String(l || '').match(/\d{1,2}\/\d{1,2}\s*~\s*\d{1,2}\/\d{1,2}/); return m ? m[0].replace(/\s+/g, '') : l || null; };
  const all = Object.values(pr.skus);
  let L = -1; // 판매가 있는 마지막 주
  labels.forEach((_, i) => { if (all.some((k) => k.w[i])) L = i; });
  if (L < 0) return { ready: false };
  const today = Date.parse(new Date().toISOString().slice(0, 10));
  const lastFull = ends[L] != null && ends[L] >= Math.min(today, Date.parse(pr.uploadedAt.slice(0, 10))) ? L - 1 : L; // 덜 끝난 주는 빼고
  const recentIdx = [lastFull, lastFull - 1, lastFull - 2].filter((i) => i >= 0);
  const seasonEnd = ends[labels.length - 1];
  const baseDay = ends[L] || today;
  const weeksLeft = seasonEnd ? Math.max(1, Math.round((seasonEnd - baseDay) / (7 * 864e5))) : Math.max(1, labels.length - 1 - L);
  const disp = new Map(displayReport().skus.map((x) => [x.sku, x]));
  const idx = skuIndex();
  const r1 = (v) => Math.round(v * 10) / 10;
  const skus = [];
  Object.entries(pr.skus).forEach(([sku, k]) => {
    const ix = idx.get(sku);
    if (!ix) return;
    const p = ix.product, d = disp.get(sku) || {};
    const recv = k.recv == null ? k.plan : k.recv;
    const rem = Math.max(0, recv - k.sold);
    const rec = Math.max(0, r1(recentIdx.reduce((a, i) => a + (k.w[i] || 0), 0) / (recentIdx.length || 1))); // 반품이 많아 음수면 0
    const cover = rec > 0 ? r1(rem / rec) : null;
    const leftover = Math.max(0, Math.round(rem - Math.max(0, rec) * weeksLeft));
    const rate = d.rate == null ? null : d.rate;
    let status, action;
    if (rem <= 0) { status = 'sold'; action = '완판 — 진열에서 빼고 다른 SKU로 채우기'; }
    else if (rec <= 0.3) { status = 'stall'; action = '최근 판매 거의 없음 — 진열 빼고 잘 팔리는 SKU로 교체, 시즌 아웃 검토'; }
    else if (cover < 4) { status = 'hot'; action = '품절 임박 — 진열 유지, 잘 팔리는 매장 위주로 재고 몰아주기'; }
    else if (cover > weeksLeft) { status = 'slow'; action = rate != null && rate < 70 ? `진열 부족(진열률 ${rate}%) — 걸어서 노출부터 늘리기` : rate == null ? '시즌 내 소진 어려움 — 진열 체크 결과 확인 필요' : '진열은 충분 — 코디 제안·행사로 판매 촉진'; }
    else { status = 'ok'; action = rate != null && rate < 70 ? `시즌 내 소진 가능, 진열률 ${rate}% — 더 걸면 추가 판매 여지` : '적정 — 지금 진열 유지'; }
    skus.push({ sku, productId: p.id, code: p.code || '', name: p.name, color: ix.color, gender: lineOf(p), type: typeOf(p), imageUrl: imageUrl(p),
      plan: k.plan, recv, sold: k.sold, st: k.plan ? r1((k.sold / k.plan) * 100) : null, rem, rec, cover, leftover,
      w: k.w.slice(0, L + 1), displayRate: rate, checked: d.checked || 0, status, action });
  });
  const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);
  const groupBy = (f) => {
    const m = new Map();
    skus.forEach((x) => { const g = f(x); m.has(g) || m.set(g, []); m.get(g).push(x); });
    return [...m].map(([g, xs]) => {
      const plan = sum(xs, (x) => x.plan), sold = sum(xs, (x) => x.sold), rem = sum(xs, (x) => x.rem), rec = r1(sum(xs, (x) => x.rec));
      const dr = xs.filter((x) => x.displayRate != null);
      return { group: g, skus: xs.length, plan, sold, st: plan ? r1((sold / plan) * 100) : null, rem, rec, cover: rec > 0 ? r1(rem / rec) : null, leftover: sum(xs, (x) => x.leftover),
        displayRate: dr.length ? Math.round(sum(dr, (x) => x.displayRate) / dr.length) : null, hot: xs.filter((x) => x.status === 'hot').length, slow: xs.filter((x) => x.status === 'slow' || x.status === 'stall').length };
    }).sort((a, b) => (b.st || 0) - (a.st || 0));
  };
  const plan = sum(skus, (x) => x.plan), sold = sum(skus, (x) => x.sold);
  return {
    ready: true, fileName: pr.fileName, basis: (pr.basis || '기획수량').replace(/수량$/, ''),
    lastWeek: short(labels[L]), lastFullWeek: short(labels[lastFull]), recentWeeks: recentIdx.length, weeksLeft, seasonEndLabel: short(labels[labels.length - 1]),
    weekLabels: labels.slice(0, L + 1).map(short),
    totals: { plan, sold, st: plan ? r1((sold / plan) * 100) : null, rem: sum(skus, (x) => x.rem), rec: r1(sum(skus, (x) => x.rec)), leftover: sum(skus, (x) => x.leftover) },
    counts: ['hot', 'ok', 'slow', 'stall', 'sold'].reduce((o, s) => ((o[s] = skus.filter((x) => x.status === s).length), o), {}),
    groups: groupBy((x) => `${x.gender} ${x.type}`.trim()),
    skus: skus.sort((a, b) => b.leftover - a.leftover),
  };
}
// 상품별 실판매 합계 (판매 자료가 있을 때)
function productSales() {
  if (!db.sales) return null;
  const idx = skuIndex();
  const m = new Map();
  db.sales.items.forEach((x) => { const k = idx.get(x.sku); if (!k) return; const a = m.get(k.product.id) || { qty: 0, amount: 0 }; a.qty += x.qty; a.amount += x.amount; m.set(k.product.id, a); });
  return m;
}
function importStock(b) {
  const idx = skuIndex();
  const byCodeColor = new Map();
  idx.forEach((k) => byCodeColor.set(`${k.product.code}|${normColor(k.color)}`, k.sku));
  const storeByCode = new Map(db.stores.filter((s) => s.code).map((s) => [String(s.code).trim(), s.name]));
  const cleanName = (n) => String(n || '').replace(/^FJ\s*/, '').replace(/백화점\s*/, '').replace(/\s+/g, '');
  const storeOf = (code, name) => storeByCode.get(String(code).trim()) || (matchStore(cleanName(name)) || {}).name || null;
  const names = b.stores && typeof b.stores === 'object' ? b.stores : {};
  const items = new Map();
  const unmatchedStores = new Set();
  let skipped = 0;
  for (const r of Array.isArray(b.rows) ? b.rows : []) {
    if (!Array.isArray(r) || r.length < 5) { skipped++; continue; }
    const [code, prod, color, stock, sales] = r;
    const sku = byCodeColor.get(`${String(prod).trim()}|${normColor(color)}`);
    if (!sku) { skipped++; continue; } // 조사 대상(26FW) 상품이 아님
    const store = storeOf(code, names[code]);
    if (!store) { unmatchedStores.add(names[code] || String(code)); continue; }
    const k = store + '|' + sku;
    const it = items.get(k) || { store, sku, stock: 0, sales: 0 };
    it.stock += Number(stock) || 0; it.sales += Number(sales) || 0;
    items.set(k, it);
  }
  if (!items.size) return { error: '조사 대상 상품(품번·색상)이나 매장(매장코드)과 맞는 재고가 없어요. 파일을 확인해 주세요.' };
  db.stock = {
    asOf: cleanText(b.asOf, 20), fileName: cleanText(b.fileName, 120), uploadedAt: new Date().toISOString(),
    items: [...items.values()], unmatchedStores: [...unmatchedStores].slice(0, 50),
  };
  saveDb();
  return { ok: true, items: db.stock.items.length, stores: new Set(db.stock.items.map((x) => x.store)).size, skus: new Set(db.stock.items.map((x) => x.sku)).size, unmatchedStores: db.stock.unmatchedStores, skipped };
}
function stockAnalysis() {
  const st = db.stock || { items: [] };
  const sl = db.sales;
  if (!db.stock && !sl) return { loaded: false };
  const idx = skuIndex();
  const disp = new Map(db.displays.map((d) => [d.store + '|' + d.sku, d.status]));
  const checkedStores = new Set(db.displays.map((d) => d.store));
  const sku = (s) => { const k = idx.get(s); return k ? { sku: s, code: k.product.code || k.product.name, name: k.product.name, color: k.color, line: lineOf(k.product), type: typeOf(k.product), imageUrl: imageUrl(k.product) } : null; };
  // 판매 자료(시즌 판매)가 있으면 그 판매수량·금액을 쓰고, 없으면 재고 파일의 판매수량
  const salesMap = new Map((sl ? sl.items : []).map((x) => [x.store + '|' + x.sku, x]));
  const stockMap = new Map(st.items.map((x) => [x.store + '|' + x.sku, x]));
  const keys = new Set([...stockMap.keys(), ...salesMap.keys()]);
  const pairs = [...keys].map((k) => {
    const s = stockMap.get(k), v = salesMap.get(k);
    const [store, skuId] = [k.slice(0, k.lastIndexOf('|')), k.slice(k.lastIndexOf('|') + 1)];
    return { store, sku: skuId, stock: Math.max(0, s ? s.stock : 0), sales: sl ? (v ? v.qty : 0) : (s ? s.sales : 0), amount: v ? v.amount : 0, status: disp.get(k) || '' };
  }).filter((x) => idx.has(x.sku));
  // 상태별 실제 판매 (진열 효과)
  const G = {};
  ['shown', 'stock', 'none', 'notReceived', ''].forEach((s) => (G[s] = { pairs: 0, sales: 0, stock: 0, zeroSales: 0, amount: 0 }));
  pairs.forEach((p) => { const g = G[p.status]; g.pairs++; g.sales += p.sales; g.stock += p.stock; g.amount += p.amount; if (p.sales <= 0) g.zeroSales++; });
  const grp = (s) => ({ ...G[s], avgSales: G[s].pairs ? Math.round((G[s].sales / G[s].pairs) * 10) / 10 : null, avgAmount: G[s].pairs ? Math.round(G[s].amount / G[s].pairs) : null, sellThrough: G[s].sales + G[s].stock ? Math.round((G[s].sales / (G[s].sales + G[s].stock)) * 100) : null });
  const byStatus = { shown: grp('shown'), stock: grp('stock'), none: grp('none'), notReceived: grp('notReceived'), unchecked: grp('') };
  const lift = byStatus.shown.avgSales && byStatus.stock.avgSales ? Math.round((byStatus.shown.avgSales / byStatus.stock.avgSales) * 10) / 10 : null;
  // 복종별: 진열 자리 비율 vs 실제 판매 비율 (진열된 자리 기준)
  const shown = pairs.filter((p) => p.status === 'shown');
  const useAmt = !!sl; // 판매 자료가 있으면 매출액 기준으로 기여도 계산
  const val = (p) => Math.max(0, useAmt ? p.amount : p.sales);
  const totSlots = shown.length, totSales = shown.reduce((a, p) => a + val(p), 0);
  const tmap = new Map();
  shown.forEach((p) => { const s = sku(p.sku); const k = `${s.line}|${s.type}`; const t = tmap.get(k) || { line: s.line, type: s.type, slots: 0, sales: 0, amount: 0, val: 0, stock: 0 }; t.slots++; t.sales += Math.max(0, p.sales); t.amount += Math.max(0, p.amount); t.val += val(p); t.stock += p.stock; tmap.set(k, t); });
  const byType = [...tmap.values()].map((t) => {
    const space = totSlots ? t.slots / totSlots : 0, contrib = totSales ? t.val / totSales : 0;
    return { ...t, spacePct: Math.round(space * 1000) / 10, salesPct: Math.round(contrib * 1000) / 10, perSlot: Math.round((t.sales / t.slots) * 10) / 10, perSlotAmount: Math.round(t.amount / t.slots), efficiency: space ? Math.round((contrib / space) * 100) / 100 : null };
  }).sort((a, b) => b.efficiency - a.efficiency);
  // 매장별
  const smap = new Map();
  pairs.forEach((p) => {
    const s = smap.get(p.store) || { name: p.store, checked: checkedStores.has(p.store), slots: 0, shownSales: 0, shownAmount: 0, idleQty: 0, idleSkus: 0, stockQty: 0, sales: 0, amount: 0, mismatch: 0 };
    s.stockQty += p.stock; s.sales += Math.max(0, p.sales); s.amount += Math.max(0, p.amount);
    if (p.status === 'shown') { s.slots++; s.shownSales += Math.max(0, p.sales); s.shownAmount += Math.max(0, p.amount); }
    if (p.status === 'stock' && p.stock > 0) { s.idleQty += p.stock; s.idleSkus++; }
    if (db.stock && (((p.status === 'none' || p.status === 'notReceived') && p.stock > 0) || (p.status === 'shown' && p.stock <= 0))) s.mismatch++;
    smap.set(p.store, s);
  });
  const byStore = [...smap.values()].map((s) => ({ ...s, perSlot: s.slots ? Math.round((s.shownSales / s.slots) * 10) / 10 : null, perSlotAmount: s.slots ? Math.round(s.shownAmount / s.slots) : null }))
    .sort((a, b) => (a.perSlot ?? 999) - (b.perSlot ?? 999));
  // 불일치 (체크 정확도)
  const mm = (pred, label) => pairs.filter(pred).map((p) => ({ store: p.store, ...sku(p.sku), stock: p.stock, sales: p.sales, status: p.status, label }));
  const hasStockButNone = mm((p) => (p.status === 'none' || p.status === 'notReceived') && p.stock > 0, '재고 있는데 없음·미입고로 체크');
  const shownNoStock = db.stock ? mm((p) => p.status === 'shown' && p.stock <= 0, '재고 0인데 진열로 체크') : [];
  // SKU 단위 집계
  const agg = (list, valueOf) => {
    const m = new Map();
    list.forEach((p) => { const a = m.get(p.sku) || { ...sku(p.sku), stores: [], qty: 0 }; a.stores.push(p.store); a.qty += valueOf(p); m.set(p.sku, a); });
    return [...m.values()].sort((a, b) => b.qty - a.qty || b.stores.length - a.stores.length).slice(0, 20);
  };
  const idleTop = agg(pairs.filter((p) => p.status === 'stock' && p.stock > 0), (p) => p.stock);
  const deadShown = agg(pairs.filter((p) => p.status === 'shown' && p.sales <= 0 && p.stock > 0), (p) => p.stock);
  return {
    loaded: true, hasStock: !!db.stock, asOf: st.asOf, fileName: st.fileName, uploadedAt: st.uploadedAt, unmatchedStores: st.unmatchedStores,
    salesInfo: sl ? { from: sl.from, to: sl.to, fileName: sl.fileName, uploadedAt: sl.uploadedAt } : null, useAmount: useAmt,
    totals: { stores: smap.size, checkedStores: [...smap.values()].filter((s) => s.checked).length, pairs: pairs.length, stockQty: pairs.reduce((a, p) => a + p.stock, 0), sales: pairs.reduce((a, p) => a + Math.max(0, p.sales), 0), amount: pairs.reduce((a, p) => a + Math.max(0, p.amount), 0),
      idleQty: byStatus.stock.stock, mismatches: hasStockButNone.length + shownNoStock.length },
    byStatus, lift, byType, byStore, idleTop, deadShown,
    mismatches: { hasStockButNone: hasStockButNone.slice(0, 3000), shownNoStock: shownNoStock.slice(0, 3000), counts: { hasStockButNone: hasStockButNone.length, shownNoStock: shownNoStock.length } },
  };
}

// ---------- 🧮 적정 진열·재고 (판매 · 재고 · 평수 기준) + 매장 조사 비교 ----------
// 기준값: 여기만 바꾸면 계산이 바뀜
const OPT = { newSkuFactor: 0.7, tiered: true, safetyDays: 14, density: null, skuBuffer: 1.1, coreMultiplier: 1.5, coverDays: 56, minStockPerSku: 4, lowActive: 60, highActive: 80 }; // 재고: 8주치·SKU당 최소 4개(사이즈) — 화면에서 바꿔 볼 수 있음
function importSizes(b) {
  const mp = erpMapper(b.names && typeof b.names === 'object' ? b.names : {});
  const sizes = {};
  const unmatched = [];
  for (const r of Array.isArray(b.rows) ? b.rows : []) {
    const [code, py] = r;
    const store = mp.store(code);
    const v = parseFloat(String(py).replace(/[^\d.]/g, ''));
    if (!store) { if (code) unmatched.push(String(code)); continue; }
    if (v > 0) sizes[store] = v;
  }
  if (!Object.keys(sizes).length) return { error: '명단의 매장코드와 맞는 평수가 없어요. 첫 줄에 코드·평수 열이 있는지 확인해 주세요.' };
  db.storeSizes = { sizes, fileName: cleanText(b.fileName, 120), uploadedAt: new Date().toISOString() };
  saveDb();
  return { ok: true, stores: Object.keys(sizes).length, unmatched: unmatched.length };
}
function optimalDisplay(over = {}) {
  const OPT_ = { ...OPT, ...over };
  const sl = db.sales;
  const stockInfo = db.stock ? { asOf: db.stock.asOf, fileName: db.stock.fileName } : null;
  const sizesInfo0 = db.storeSizes ? { fileName: db.storeSizes.fileName, uploadedAt: db.storeSizes.uploadedAt, stores: Object.keys(db.storeSizes.sizes).length } : null;
  if (!sl) return { ready: false, need: ['판매 자료'], hasStock: !!db.stock, stockInfo, sizesInfo: sizesInfo0 };
  const idx = skuIndex();
  const days = Math.max(1, Math.round((Date.parse(sl.to) - Date.parse(sl.from)) / 864e5) + 1) || 1;
  // ── 기온·계절 반영: 최근 4주 판매 흐름 (주별 판매가 있을 때) ──
  const hasWeeks = sl.items.some((x) => Array.isArray(x.w));
  const nW = Math.ceil(days / 7), recentFrom = Math.max(0, nW - 4);
  const recentDays = Math.max(1, days - recentFrom * 7);
  const recentQty = (x) => (Array.isArray(x.w) ? x.w.slice(recentFrom).reduce((a, v) => a + Math.max(0, v || 0), 0) : 0);
  // 복종별 계절 지수 = 최근 4주 하루 판매 ÷ 시즌 평균 하루 판매 (판매 적은 복종은 1 쪽으로 당김)
  const typeAgg = new Map();
  sl.items.forEach((x) => { const k = idx.get(x.sku); if (!k) return; const t = `${lineOf(k.product)}|${typeOf(k.product)}`; const a = typeAgg.get(t) || { line: lineOf(k.product), type: typeOf(k.product), qty: 0, recent: 0, weeks: [] }; a.qty += Math.max(0, x.qty); a.recent += recentQty(x); (x.w || []).forEach((v, i) => (a.weeks[i] = (a.weeks[i] || 0) + Math.max(0, v || 0))); typeAgg.set(t, a); });
  const season = new Map([...typeAgg.entries()].map(([t, a]) => {
    const base = a.qty / days, rec = a.recent / recentDays;
    const raw = base > 0 ? rec / base : 1;
    const w = Math.min(1, a.qty / 60); // 판매 60개 미만이면 덜 믿음
    return [t, { ...a, factor: hasWeeks ? Math.round((1 + (raw - 1) * w) * 100) / 100 : 1, weeks: Array.from(a.weeks, (v) => v || 0) }];
  }));
  const typeKeyOf = (s) => { const k = idx.get(s); return `${lineOf(k.product)}|${typeOf(k.product)}`; };
  // 예상 하루 판매 = 최근 4주 60% + 시즌 평균 × 계절 지수 40%
  const forecast = (x, s) => (hasWeeks ? 0.6 * (recentQty(x) / recentDays) + 0.4 * (Math.max(0, x.qty) / days) * season.get(typeKeyOf(s)).factor : Math.max(0, x.qty) / days);
  const sizes = (db.storeSizes && db.storeSizes.sizes) || {};
  const stockMap = new Map((db.stock ? db.stock.items : []).map((x) => [x.store + '|' + x.sku, Math.max(0, x.stock)]));
  const disp = new Map(db.displays.map((d) => [d.store + '|' + d.sku, d.status]));
  const sku = (s) => { const k = idx.get(s); return k ? { sku: s, productId: k.product.id, code: k.product.code || k.product.name, name: k.product.name, color: k.color, line: lineOf(k.product), type: typeOf(k.product), imageUrl: imageUrl(k.product) } : null; };
  // 전체 매장 판매 순위 (권장 목록을 채울 때 사용)
  // 전체 매장 '지금 시점' 예상 매출 순위 (모자라는 자리를 채울 때 사용: 다른 매장에서 지금 잘 팔리는 시즌 상품)
  const net = new Map();
  sl.items.forEach((x) => { if (!idx.has(x.sku) || x.qty <= 0) return; net.set(x.sku, (net.get(x.sku) || 0) + forecast(x, x.sku) * (x.amount / x.qty)); });
  const netRank = [...net.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  // 공간 기준 밀도(평당 진열 SKU): 평당 매출 상위 1/3 매장이 실제로 진열한 SKU ÷ 평수의 중간값 (진열 체크 없으면 재고 SKU 기준)
  const sizesAll = (db.storeSizes && db.storeSizes.sizes) || {};
  const bench = (() => {
    const rows = [];
    const amtBy = new Map();
    sl.items.forEach((x) => amtBy.set(x.store, (amtBy.get(x.store) || 0) + Math.max(0, x.amount)));
    const shownBy = new Map(), heldBy = new Map();
    db.displays.forEach((d) => { if (d.status === 'shown' && idx.has(d.sku)) shownBy.set(d.store, (shownBy.get(d.store) || 0) + 1); });
    stockMap.forEach((q, k) => { if (q > 0) { const st = k.slice(0, k.lastIndexOf('|')); heldBy.set(st, (heldBy.get(st) || 0) + 1); } });
    Object.entries(sizesAll).forEach(([st, py]) => { if (py > 0 && amtBy.get(st)) rows.push({ st, perPy: amtBy.get(st) / py, shown: shownBy.get(st) || 0, held: heldBy.get(st) || 0, py }); });
    const top = rows.sort((a, b) => b.perPy - a.perPy).slice(0, Math.max(3, Math.ceil(rows.length / 3)));
    const med = (a) => { const v = a.filter((x) => x > 0).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
    const byShown = med(top.filter((r) => r.shown > 0).map((r) => r.shown / r.py));
    const byHeld = med(top.map((r) => r.held / r.py));
    if (top.filter((r) => r.shown > 0).length >= 3 && byShown) return { value: Math.round(byShown * 10) / 10, source: '평당 매출 상위 매장의 진열 체크' };
    if (byHeld) return { value: Math.round(byHeld * 10) / 10, source: '평당 매출 상위 매장의 보유 재고 SKU' };
    return { value: 10, source: '기본값' };
  })();
  const density = OPT_.density || bench.value;
  const byStore = new Map();
  sl.items.forEach((x) => { if (!idx.has(x.sku)) return; if (!byStore.has(x.store)) byStore.set(x.store, []); byStore.get(x.store).push(x); });
  const storeNames = db.stores.length ? db.stores.map((s) => s.name) : [...byStore.keys()];
  const evalByStore = new Map();
  db.evaluations.filter((e) => isDone(e) && e.sales).forEach((e) => { const k = (matchStore(e.staff) || { name: e.staff }).name; if (!evalByStore.has(k)) evalByStore.set(k, []); evalByStore.get(k).push(e); });
  // ── 매장 등급 (평당 매출 상·중·하 1/3, 평수 없으면 매출 기준) ── 등급별 재고 깊이
  const amtOf = new Map();
  sl.items.forEach((x) => amtOf.set(x.store, (amtOf.get(x.store) || 0) + Math.max(0, x.amount)));
  // ── 매장별 '지금 예상 매출' 순위용: SKU별 취급 매장 1곳당 예상 판매·가격, 매장 판매 규모 ──
  const netSku = new Map();
  const storeFcTotal = new Map();
  sl.items.forEach((x) => {
    if (!idx.has(x.sku)) return;
    const f = x.qty > 0 ? forecast(x, x.sku) : 0;
    const a = netSku.get(x.sku) || { fc: 0, stores: new Set(), qty: 0, amount: 0 };
    a.fc += f; a.qty += Math.max(0, x.qty); a.amount += Math.max(0, x.amount); a.stores.add(x.store);
    netSku.set(x.sku, a);
    storeFcTotal.set(x.store, (storeFcTotal.get(x.store) || 0) + f);
  });
  stockMap.forEach((q, k) => { if (q > 0) { const i = k.lastIndexOf('|'); const a = netSku.get(k.slice(i + 1)); if (a) a.stores.add(k.slice(0, i)); } });
  const fcVals = [...storeFcTotal.values()].filter((v) => v > 0);
  const avgStoreFc = fcVals.length ? fcVals.reduce((a, b) => a + b, 0) / fcVals.length : 1;
  const tierOf = new Map();
  const rankTier = (list) => list.forEach((n, i) => tierOf.set(n, i < list.length / 3 ? 'A' : i < (list.length * 2) / 3 ? 'B' : 'C'));
  rankTier(storeNames.filter((n) => sizes[n] && amtOf.get(n)).sort((a, b) => amtOf.get(b) / sizes[b] - amtOf.get(a) / sizes[a]));
  rankTier(storeNames.filter((n) => !sizes[n] && amtOf.get(n)).sort((a, b) => amtOf.get(b) - amtOf.get(a)));
  const TIER = {
    A: { label: '상위', min: OPT_.minStockPerSku + 2, cover: OPT_.coverDays, safety: OPT_.safetyDays },
    B: { label: '중위', min: OPT_.minStockPerSku, cover: OPT_.coverDays, safety: 0 },
    C: { label: '하위', min: Math.max(2, OPT_.minStockPerSku - 1), cover: Math.round(OPT_.coverDays * 0.75), safety: 0 },
  };
  const ruleOf = (n) => (OPT_.tiered ? TIER[tierOf.get(n) || 'B'] : { label: '공통', min: OPT_.minStockPerSku, cover: OPT_.coverDays, safety: 0 });
  const stores = storeNames.map((name) => {
    const rule = ruleOf(name);
    const items = (byStore.get(name) || []).map((x) => ({ ...x, qty: Math.max(0, x.qty), amount: Math.max(0, x.amount) }));
    const amount = items.reduce((a, x) => a + x.amount, 0), qty = items.reduce((a, x) => a + x.qty, 0);
    const price = (x) => (x.qty > 0 ? x.amount / x.qty : 0);
    items.forEach((x) => { x.fc = forecast(x, x.sku); x.fcAmount = x.fc * price(x); });
    const sold = items.filter((x) => x.qty > 0).sort((a, b) => b.fcAmount - a.fcAmount || b.amount - a.amount); // 지금 시점 예상 매출 순
    let acc = 0, core = 0;
    const fcTotal = sold.reduce((a, x) => a + x.fcAmount, 0) || 1;
    for (const x of sold) { acc += hasWeeks ? x.fcAmount : x.amount; core++; if (acc >= (hasWeeks ? fcTotal : amount) * 0.8) break; }
    const held = [...idx.keys()].filter((s) => (stockMap.get(name + '|' + s) || 0) > 0);
    const heldSet = new Set(held);
    // 지금 시점에 팔리는 SKU: 비시즌 복종(계절 지수 0.6 이하)이면서 최근에 안 팔린 SKU만 뺌
    const activeNow = hasWeeks ? sold.filter((x) => recentQty(x) > 0 || season.get(typeKeyOf(x.sku)).factor > 0.6) : sold;
    const salesBased = Math.max(Math.round(activeNow.length * OPT_.skuBuffer), Math.round(core * OPT_.coreMultiplier));
    const pySize = sizes[name] || 0;
    const spaceMin = pySize ? Math.round(pySize * density) : 0; // 공간 기준 최소 진열 SKU (매장이 비어 보이지 않게)
    const recCount = Math.min(idx.size, Math.max(salesBased, spaceMin));
    // 모든 SKU를 '이 매장에서 지금 예상 매출' 하나로 줄 세움 (팔아 본 상품 = 이 매장 예상, 안 팔아 본 상품 = 다른 매장 평균 × 이 매장 규모 × 0.7)
    const scale = (storeFcTotal.get(name) || 0) / avgStoreFc;
    const itemOf = new Map(items.map((x) => [x.sku, x]));
    const expOf = (sk) => {
      const it = itemOf.get(sk);
      if (it && it.qty > 0) return { week: (it.fc || 0) * 7, price: it.amount / it.qty, basis: 'store' };
      const n = netSku.get(sk);
      if (!n || !n.qty || !n.stores.size) return { week: 0, price: 0, basis: 'none' };
      return { week: (n.fc / n.stores.size) * 7 * scale * OPT_.newSkuFactor, price: n.amount / n.qty, basis: 'network' };
    };
    const isOffSeason = (sk) => hasWeeks && (season.get(typeKeyOf(sk)) || { factor: 1 }).factor <= 0.6 && !(itemOf.get(sk) && recentQty(itemOf.get(sk)) > 0);
    const exp = new Map([...idx.keys()].map((sk) => { const e = expOf(sk); return [sk, { ...e, amt: e.week * e.price, off: isOffSeason(sk) }]; }));
    const expRanked = [...idx.keys()].filter((sk) => exp.get(sk).amt > 0 && !exp.get(sk).off).sort((a, b) => exp.get(b).amt - exp.get(a).amt);
    const rec = expRanked.slice(0, recCount);
    for (const s2 of netRank) { if (rec.length >= recCount) break; if (!rec.includes(s2) && !exp.get(s2).off) rec.push(s2); }
    const recSet = new Set(rec);
    const coreSet = new Set(sold.slice(0, core).map((x) => x.sku)); // 매출 80%를 만드는 핵심 SKU → 상위 매장은 안전재고 추가
    const qtyOf = new Map(items.map((x) => [x.sku, x]));
    // SKU별 권장 재고 = 하루 판매 × 기간(최소 n개), 권장 목록 밖이면 0
    const skuRows = [...new Set([...rec, ...held, ...[...idx.keys()].filter((s) => disp.has(name + '|' + s))])].map((s) => {
      const it = qtyOf.get(s) || { qty: 0, amount: 0, fc: 0 };
      const stock = stockMap.get(name + '|' + s) || 0;
      const offSeason = hasWeeks && (season.get(typeKeyOf(s)) || { factor: 1 }).factor <= 0.6 && (it.fc || 0) * 7 < 0.5; // 비시즌·지금 안 팔림 → 최소 수량 적용 안 함
      const dayRate = ((exp.get(s) || { week: 0 }).week) / 7; // 이 매장 예상 (안 팔아 본 상품은 다른 매장 기준 추정)
      const recStock = recSet.has(s) ? Math.max(offSeason ? 0 : rule.min, Math.ceil(dayRate * (rule.cover + (coreSet.has(s) ? rule.safety : 0)))) : 0;
      const sf = season.get(typeKeyOf(s));
      const e = exp.get(s) || { week: 0, amt: 0, basis: 'none', off: false };
      return { ...sku(s), qty: it.qty, amount: it.amount, recent: recentQty(it), forecastPerWeek: Math.round((it.fc || 0) * 7 * 10) / 10, expWeek: Math.round(e.week * 10) / 10, expAmt: Math.round(e.amt), basis: e.basis, off: e.off, season: sf ? sf.factor : 1, stock, recStock, gap: stock - recStock, rec: recSet.has(s), status: disp.get(name + '|' + s) || '' };
    });
    const stockQty = skuRows.reduce((a, x) => a + x.stock, 0), recStockQty = skuRows.reduce((a, x) => a + x.recStock, 0);
    const offSeasonStock = hasWeeks ? skuRows.filter((x) => x.season <= 0.6).reduce((a, x) => a + x.stock, 0) : 0;
    // 매장 조사 비교: 진열 체크
    const checked = [...idx.keys()].some((s) => disp.has(name + '|' + s));
    const shown = skuRows.filter((x) => x.status === 'shown');
    const toHang = skuRows.filter((x) => x.rec && x.status && x.status !== 'shown' && x.stock > 0).sort((a, b) => b.expAmt - a.expAmt); // 권장인데 진열 안 됨 (재고 있음) · 지금 예상 매출 큰 순
    const toAllocate = skuRows.filter((x) => x.rec && x.stock <= 0 && x.status !== 'shown' && !x.off && (db.stock ? true : false)).sort((a, b) => b.expAmt - a.expAmt); // 권장인데 재고 없음
    const toRemove = shown.filter((x) => !x.rec).sort((a, b) => a.expAmt - b.expAmt); // 진열 중인데 권장 밖 · 지금 예상 매출 작은 순
    // 매장 조사 비교: 상품 평가(판매 반응) vs 실제 판매 (상품 단위, 매장 안 판매 순위 3등분)
    const prodQty = new Map();
    items.forEach((x) => { const k = idx.get(x.sku); prodQty.set(k.product.id, (prodQty.get(k.product.id) || 0) + x.qty); });
    const evs = evalByStore.get(name) || [];
    const ranked = [...new Set(db.products.filter((p) => p.active).map((p) => p.id))].map((id) => [id, prodQty.get(id) || 0]).sort((a, b) => b[1] - a[1]);
    const tier = new Map(ranked.map(([id, q], i) => [id, q <= 0 ? 'poor' : i < ranked.length / 3 ? 'good' : i < (ranked.length * 2) / 3 ? 'normal' : 'poor']));
    const evalRows = evs.filter((e) => tier.has(e.productId)).map((e) => {
      const p = db.products.find((x) => x.id === e.productId);
      return { code: p.code || p.name, said: e.sales, actual: tier.get(e.productId), qty: prodQty.get(e.productId) || 0 };
    });
    const agree = evalRows.filter((x) => x.said === x.actual).length;
    const evalMiss = evalRows.filter((x) => (x.said === 'good' && x.actual === 'poor') || (x.said === 'poor' && x.actual === 'good'));
    const active = held.length ? Math.round((held.filter((s) => (qtyOf.get(s) || {}).qty > 0).length / held.length) * 100) : null;
    const py = sizes[name] || null;
    return {
      name, tier: tierOf.get(name) || '', rule: { min: rule.min, coverWeeks: Math.round(rule.cover / 7), safetyWeeks: Math.round(rule.safety / 7) }, manager: (db.stores.find((s) => s.name === name) || {}).manager || '', py, amount, qty, perPy: py ? Math.round(amount / py) : null,
      held: held.length, sold: sold.length, activeNow: activeNow.length, core, active, recSku: recCount, salesBased, spaceMin, filled: Math.max(0, recCount - Math.min(recCount, sold.length)), recPerPy: py ? Math.round((recCount / py) * 10) / 10 : null,
      cutSku: Math.max(0, held.length - recCount),
      judge: active == null ? '' : active < OPT_.lowActive ? 'over' : active >= OPT_.highActive ? 'room' : 'ok',
      stockQty, recStockQty, offSeasonStock, overStock: skuRows.reduce((a, x) => a + Math.max(0, x.gap), 0), shortStock: skuRows.reduce((a, x) => a + Math.max(0, -x.gap), 0),
      survey: {
        checked, shown: shown.length, shownPerPy: py && checked ? Math.round((shown.length / py) * 10) / 10 : null,
        recShown: shown.filter((x) => x.rec).length, toHang: toHang.length, toAllocate: toAllocate.length, toRemove: toRemove.length,
        evals: evalRows.length, agreePct: evalRows.length ? Math.round((agree / evalRows.length) * 100) : null, evalMiss: evalMiss.length,
      },
      detail: { toHang: toHang.slice(0, 40), toAllocate: toAllocate.slice(0, 40), toRemove: toRemove.slice(0, 40), evalMiss: evalMiss.slice(0, 30),
        stockGap: skuRows.filter((x) => x.gap !== 0).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 40) },
    };
  }).filter((s) => s.amount > 0 || s.held > 0);
  const sum = (f) => stores.reduce((a, s) => a + (f(s) || 0), 0);
  return {
    ready: true, opt: OPT_, density: { value: density, bench: bench.value, source: OPT_.density ? '직접 선택' : bench.source }, days, salesInfo: { from: sl.from, to: sl.to, fileName: sl.fileName }, stockInfo,
    seasonal: hasWeeks ? { fullWeeks: Math.floor(days / 7), recentDays, recentFrom: new Date(Date.parse(sl.from) + recentFrom * 7 * 864e5).toISOString().slice(0, 10), weekStarts: Array.from({ length: nW }, (_, i) => new Date(Date.parse(sl.from) + i * 7 * 864e5).toISOString().slice(5, 10)),
      types: [...season.values()].filter((t) => t.qty > 0).sort((a, b) => b.factor - a.factor).map((t) => ({ line: t.line, type: t.type, factor: t.factor, qty: t.qty, recent: t.recent, weeks: t.weeks })) } : null, hasStock: !!db.stock, hasSizes: !!db.storeSizes,
    sizesInfo: db.storeSizes ? { fileName: db.storeSizes.fileName, uploadedAt: db.storeSizes.uploadedAt, stores: Object.keys(db.storeSizes.sizes).length } : null,
    totals: { stores: stores.length, over: stores.filter((s) => s.judge === 'over').length, ok: stores.filter((s) => s.judge === 'ok').length, room: stores.filter((s) => s.judge === 'room').length,
      cutSku: sum((s) => s.cutSku), offSeasonStock: sum((s) => s.offSeasonStock), overStock: sum((s) => s.overStock), shortStock: sum((s) => s.shortStock), stockQty: sum((s) => s.stockQty), recStockQty: sum((s) => s.recStockQty),
      toHang: sum((s) => s.survey.toHang), toRemove: sum((s) => s.survey.toRemove), checkedStores: stores.filter((s) => s.survey.checked).length,
      agreePct: (() => { const n = sum((s) => s.survey.evals); return n ? Math.round((stores.reduce((a, s) => a + (s.survey.agreePct || 0) * s.survey.evals, 0) / n)) : null; })() },
    tiers: OPT_.tiered ? Object.fromEntries(Object.entries(TIER).map(([k, v]) => [k, { label: v.label, min: v.min, coverWeeks: Math.round(v.cover / 7), safetyWeeks: Math.round(v.safety / 7), stores: [...tierOf.values()].filter((t) => t === k).length }])) : null,
    stores: stores.sort((a, b) => (b.perPy ?? -1) - (a.perPy ?? -1) || b.amount - a.amount),
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
// ---- AI 요약 한 번에 전부: 없거나 오래된(새 평가가 들어온) 요약만 골라 순서대로 만든다 ----
const BULK = { running: false, total: 0, done: 0, failed: 0, skipped: 0, current: [], errors: [], startedAt: null, finishedAt: null };
function bulkTargets() {
  const keys = ['display', 'ztec', 'gift', ...db.products.filter((p) => p.active).map((p) => 'product:' + p.id)];
  return keys.map((key) => ({ key, src: summarySource(key) })).filter(({ key, src }) => src && (!db.summaries[key] || db.summaries[key].basis !== src.basis));
}
const bulkName = (key) => { if (!key.startsWith('product:')) return { display: '진열 분석', ztec: 'Z-TEC', gift: '사은품' }[key] || key; const p = db.products.find((x) => 'product:' + x.id === key); return p ? p.code || p.name : key; };
async function runBulkSummaries() {
  const targets = bulkTargets();
  Object.assign(BULK, { running: true, total: targets.length, done: 0, failed: 0, current: [], errors: [], startedAt: new Date().toISOString(), finishedAt: null });
  const queue = targets.slice();
  const worker = async () => {
    while (queue.length) {
      const { key } = queue.shift();
      const src = summarySource(key); // 그사이 바뀌었을 수 있어 다시 계산
      if (!src) { BULK.done++; continue; }
      BULK.current.push(bulkName(key));
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await runSummary(key, src.title, src.body);
          db.summaries[key] = { basis: src.basis, count: src.count, at: new Date().toISOString(), result };
          saveDb();
          BULK.done++;
          break;
        } catch (ex) {
          if ((ex.status === 429 || ex.status >= 500) && ex.status !== 503 && attempt < 2) { await new Promise((r) => setTimeout(r, 15000 * (attempt + 1))); continue; }
          BULK.failed++; BULK.done++;
          BULK.errors.push(`${bulkName(key)}: ${ex.status === 401 ? 'API 키 오류' : ex.status === 429 ? '사용량 제한' : ex.message}`.slice(0, 120));
          console.error('AI 일괄 요약 실패:', key, ex.status, ex.message);
          if (ex.status === 401 || ex.status === 503) queue.length = 0; // 키 문제면 더 진행해도 소용없음
          break;
        }
      }
      BULK.current = BULK.current.filter((n) => n !== bulkName(key));
    }
  };
  try { await Promise.all([worker(), worker(), worker()]); } finally { BULK.running = false; BULK.finishedAt = new Date().toISOString(); BULK.current = []; }
}
// 요약할 내용과 '기준'(평가 수·최근 수정 시각)을 만든다. 기준이 바뀌면 다시 요약 필요
function summarySource(key) {
  if (key === 'display') {
    if (!db.displays.length) return null;
    const a = displayAnalysis();
    const pct = (v) => (v == null ? '-' : v + '%');
    const g = (k) => a.products.filter((p) => p.group === k).map((p) => `${p.code}(${p.type}, 진열 ${pct(p.displayRate)}, 반응 ${p.avgReaction}, 잘 팔림 ${pct(p.goodPct)})`).join('; ') || '없음';
    return {
      basis: `d${db.displays.length}:${db.displays.reduce((m, d) => (d.updatedAt > m ? d.updatedAt : m), '')}:e${db.evaluations.length}`,
      title: '매장 진열 현황 분석 (SKU = 품번 × 컬러)',
      body: [
        `체크한 매장 ${a.storeCount}매장, SKU ${a.totalSkus}개, 체크 ${a.totals.checks}건 (진열 ${a.totals.shown}·창고만 ${a.totals.stock}·없음 ${a.totals.none}·미입고 ${a.totals.notReceived}). 진열률은 미입고를 뺀 기준`,
        '',
        '복종별 진열률:',
        ...a.byType.map((t) => `- ${t.line} ${t.type}: 진열률 ${pct(t.rate)} (진열 ${t.shown}·창고만 ${t.stock}·없음 ${t.none}·미입고 ${t.notReceived}, SKU ${t.skus}개)`),
        '',
        '진열률 낮은 매장 (하위 10):',
        ...a.byStore.slice(0, 10).map((s) => `- ${s.name}: 진열률 ${pct(s.rate)}, 체크 ${s.checked}/${a.totalSkus}, 없음 ${s.noneSkus.length}·창고만 ${s.stockSkus.length}·미입고 ${s.notReceivedSkus.length}`),
        '',
        `진열 확대 후보(반응·판매 좋은데 진열 ${DA.lowDisplay}% 미만): ${g('expand')}`,
        `진열 재검토(진열 ${DA.highDisplay}% 이상인데 반응·판매 부진): ${g('review')}`,
        `효자 상품(진열 많고 반응·판매 좋음): ${g('star')}`,
        '',
        '창고에만 있는 매장이 많은 SKU: ' + (a.stockOnly.map((k) => `${k.code}-${k.color} ${k.stock}매장`).join(', ') || '없음'),
        '미입고 매장이 많은 SKU(배분 검토): ' + (a.notReceived.map((k) => `${k.code}-${k.color} ${k.notReceived}매장`).join(', ') || '없음'),
        '진열·재고 모두 없는 매장이 많은 SKU: ' + (a.missing.map((k) => `${k.code}-${k.color} ${k.none}매장`).join(', ') || '없음'),
        '',
        '요약 지침: 이것은 매장 의견이 아니라 진열 데이터 분석입니다. strengths=잘 되고 있는 점, weaknesses=문제점, requests=추가로 확인할 점, actions=영업·VMD가 바로 할 조치로 써 주세요.',
      ].join('\n'),
      count: db.displays.length,
    };
  }
  if (key === 'gift') {
    const g = db.gifts;
    if (!g.length) return null;
    const gs = giftSummary();
    const L = (key, v) => OPTIONS[key][v] || v;
    const lines = g.map((e) => `- [${e.store}] 문의 ${L('giftFreq', e.freq)}, 사은품 때문에 구매 미룸 ${L('giftDelay', e.delay)}, 현재 사은품 ${e.reaction ? '반응 ' + OPTIONS.reactions[e.reaction] + ', ' : ''}${L('giftImpact', e.impact)}` +
      `, 원하는 품목 ${e.items.join('·')}, 적정 기준 ${L('giftThreshold', e.threshold)}` +
      (Object.keys(e.reviews || {}).length ? ' / 사은품별: ' + db.giftItems.filter((it) => (e.reviews || {})[it.id]).map((it) => { const v = e.reviews[it.id]; return `${it.name} ${giftLabel(v.r)}${v.note ? '(' + v.note + ')' : ''}`; }).join(', ') : '') +
      (e.currentNote ? ` / 현재 사은품 반응: ${e.currentNote}` : '') + (e.itemNote ? ` / 품목 의견: ${e.itemNote}` : '') + (e.idea ? ` / 아이디어: ${e.idea}` : ''));
    const d = (key, obj) => Object.entries(obj).map(([k, n]) => `${L(key, k)} ${n}`).join('·');
    return {
      basis: `${g.length}:${g.reduce((a, e) => (e.updatedAt > a ? e.updatedAt : a), '')}`,
      title: '2026년 사은품(구매 사은품) 니즈에 대한 매장 의견',
      body: [`응답 매장 ${gs.count}매장`, `고객 사은품 문의: ${d('giftFreq', gs.freq)}`, `사은품 때문에 구매를 미루거나 안 한 경우: ${d('giftDelay', gs.delay)}`,
        `현재 사은품 평균 고객 반응 ${gs.avgReaction ?? '-'}/5, 구매 영향: ${d('giftImpact', gs.impact)}`,
        `2026 사은품별 평균 반응(5점): ${gs.giftItems.filter((x) => x.count).map((x) => `${x.name} ${x.avg}(${x.count}매장)`).join(', ') || '없음'}`,
        `사은품 미입고 매장(배분 검토): ${gs.giftItems.filter((x) => x.nr).map((x) => `${x.name} ${x.nr}매장`).join(', ') || '없음'}`, `원하는 사은품 순위: ${gs.items.map((x) => `${x.name} ${x.count}`).join(', ')}`,
        `적정 사은품 기준 금액: ${d('giftThreshold', gs.threshold)}`, '', `매장 의견:\n${lines.join('\n')}`,
        '', '요약 지침: strengths=현재 사은품에서 잘 먹히는 점, weaknesses=아쉬운 점, requests=매장·고객이 원하는 사은품과 조건, actions=본사가 다음 사은품 기획에 바로 반영할 일로 써 주세요. 사은품별로 반응이 좋았던 것·나빴던 것을 구체적인 이름으로 짚어 주세요.'].join('\n'),
      count: g.length,
    };
  }
  if (key === 'ztec') {
    const z = db.ztec;
    if (!z.length) return null;
    const zs = ztecSummary();
    const lines = z.map((e) => `- [${e.store}] 반응 ${OPTIONS.reactions[e.reaction]}, 설명 ${OPTIONS.ztecEase[e.ease]}` +
      (e.good ? ` / 좋은 점: ${e.good}` : '') + (e.bad ? ` / 아쉬운 점: ${e.bad}` : '') + (e.suggestion ? ` / 제안: ${e.suggestion}` : ''));
    return {
      basis: `${z.length}:${z.reduce((a, e) => (e.updatedAt > a ? e.updatedAt : a), '')}`,
      title: 'Z-TEC (기능성 라인)에 대한 매장 의견',
      body: `응답 매장 ${zs.count}매장, 평균 고객 반응 ${zs.avgReaction}/5, 설명 쉬움 ${zs.ease.easy}·보통 ${zs.ease.normal}·어려움 ${zs.ease.hard}\n\n매장 의견:\n${lines.join('\n')}`,
      count: z.length,
    };
  }
  const id = key.replace(/^product:/, '');
  const product = db.products.find((x) => x.id === id);
  if (!product) return null;
  const es = db.evaluations.filter((e) => e.productId === id && isDone(e));
  const ns = db.evaluations.filter((e) => e.productId === id && e.status === 'nosale' && (e.reaction || e.pros.length || e.cons.length || e.prosNote || e.consNote || e.improvement));
  if (!es.length && !ns.length) return null;
  const ps = summary().products.find((x) => x.id === id);
  const top = (list) => list.slice(0, 6).map((x) => `${x.name} ${x.n}`).join(', ') || '없음';
  const lines = es.filter((e) => e.prosNote || e.consNote || e.improvement || e.missing).map((e) =>
    `- [${e.staff}] 반응 ${OPTIONS.reactions[e.reaction]}, 판매 ${OPTIONS.sales[e.sales]}` +
    (e.prosNote ? ` / 좋은 점: ${e.prosNote}` : '') + (e.consNote ? ` / 아쉬운 점: ${e.consNote}` : '') +
    (e.improvement ? ` / 개선: ${e.improvement}` : '') + (e.missing ? ` / 없던 사이즈·색상: ${e.missing}` : ''));
  const nsLines = ns.map((e) => `- [${e.staff}] (판매 경험 없음, 응대 중 느낌) ` + (e.reaction ? `반응 ${OPTIONS.reactions[e.reaction]}` : '반응 미선택') +
    (e.pros.length ? ` / 좋은 점: ${e.pros.join(', ')}` : '') + (e.prosNote ? ` (${e.prosNote})` : '') +
    (e.cons.length ? ` / 아쉬운 점: ${e.cons.join(', ')}` : '') + (e.consNote ? ` (${e.consNote})` : '') + (e.improvement ? ` / 개선: ${e.improvement}` : ''));
  const both = [...es, ...ns];
  return {
    basis: `${both.length}:${both.reduce((a, e) => (e.updatedAt > a ? e.updatedAt : a), '')}`,
    title: `${product.code} ${product.name} (${typeOf(product) || product.category})`,
    body: [
      `평가 매장 ${es.length}매장, 평균 고객 반응 ${ps.avgReaction}/5, 판매 반응 잘 팔림 ${ps.sales.good}·보통 ${ps.sales.normal}·잘 안 팔림 ${ps.sales.poor}`,
      `매장 진열 체크(컬러별 합계): 진열 ${ps.display.shown}·창고만 ${ps.display.stock}·없음 ${ps.display.none}`,
      `장점으로 꼽힌 항목(횟수): ${top(ps.pros)}`,
      `단점으로 꼽힌 항목(횟수): ${top(ps.cons)}`,
      `판매를 도운 요인: ${top(ps.sellReasons)}`,
      `판매를 막은 요인: ${top(ps.noBuyReasons)}`,
      '',
      lines.length ? `매장 메모:\n${lines.join('\n')}` : '매장 메모: 없음 (위 항목 집계만으로 요약해 주세요)',
      nsLines.length ? `\n판매 경험은 없지만 고객 응대 중 느낀 반응 (${nsLines.length}매장, 판매 데이터와 구분해서 참고):\n${nsLines.join('\n')}` : '',
    ].join('\n'),
    count: both.length,
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

  if (m === 'GET' && p === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n');
  if (m === 'GET' && p === '/healthz') return send(res, 200, { ok: true, ai: !!process.env.ANTHROPIC_API_KEY }); // 키 값은 노출하지 않음
  if (m === 'GET' && p === '/style.css') return serveStatic(res, 'style.css');
  if (m === 'GET' && p === '/admin-theme.css') return serveStatic(res, 'admin-theme.css');
  if (m === 'GET' && p === '/bulk-ai.js') return serveStatic(res, 'bulk-ai.js');
  if (m === 'GET' && p === '/xlsx-lite.js') return serveStatic(res, 'xlsx-lite.js');
  if (m === 'GET' && (p === '/logo.png' || p === '/favicon.png')) return serveStatic(res, p.slice(1));

  // 관리자
  if (p === '/admin' || p === '/admin/report' || p.startsWith('/api/admin/')) {
    if (!guard(req, res, 'admin')) return;

    if (m === 'GET' && p === '/admin') return serveStatic(res, 'admin.html');
    if (m === 'GET' && p === '/admin/report') return serveStatic(res, 'report.html');
    if (m === 'GET' && p === '/api/admin/report') return send(res, 200, buildReport());
    const prp = p.match(/^\/api\/admin\/product-report\/([\w-]+)$/);
    if (m === 'GET' && prp) {
      const pr = summary().products.find((x) => x.id === prp[1]);
      if (!pr) return send(res, 404, { error: '상품이 없어요.' });
      const key = 'product:' + pr.id;
      const saved = db.summaries[key];
      const src = summarySource(key);
      const ai = saved ? { ...saved.result, at: saved.at, count: saved.count, stale: !!(src && src.basis !== saved.basis) } : null;
      return send(res, 200, { product: { ...pr, line: lineOf(pr), type: typeOf(pr), photos: photoList(db.products.find((x) => x.id === pr.id)) }, ai, aiEnabled: !!process.env.ANTHROPIC_API_KEY });
    }
    if (m === 'GET' && p === '/api/admin/summary') return send(res, 200, summary());

    // ---- 조사 대상 매장 ----
    if (m === 'GET' && p === '/api/admin/store-progress') return send(res, 200, storeProgress());
    if (m === 'GET' && p === '/api/admin/store-answers') {
      const k = storeKey(url.searchParams.get('name'));
      const byId = new Map(db.products.map((x) => [x.id, x]));
      const evals = db.evaluations.filter((e) => storeKey(e.staff) === k).map((e) => {
        const pr = byId.get(e.productId) || {};
        return { product: pr.name || e.productId, code: pr.code || '', status: e.status || 'done', reaction: e.reaction || 0, sales: OPTIONS.sales[e.sales] || '',
          text: [e.prosNote, e.consNote, e.improvement, e.missing].map((t) => String(t || '').trim()).filter(Boolean).join(' / '), at: e.createdAt || e.updatedAt };
      }).sort((a, b) => String(a.at).localeCompare(String(b.at)));
      const zt = db.ztec.find((z) => storeKey(z.store) === k) || null;
      const gf = db.gifts.find((z) => storeKey(z.store) === k) || null;
      return send(res, 200, { evals, ztec: zt && { reaction: zt.reaction, good: zt.good, bad: zt.bad, suggestion: zt.suggestion }, gift: gf });
    }
    if (m === 'POST' && p === '/api/admin/stores/import') {
      const b = await readBody(req, 256 * 1024);
      const rows = Array.isArray(b.rows) ? b.rows : [];
      const list = [];
      const errors = [];
      rows.slice(0, 1000).forEach((r, i) => {
        const name = cleanText(r.name, 30);
        if (!name) return errors.push(`${i + 2}행: 매장명이 비어 있어요`);
        if (list.some((x) => storeKey(x.name) === storeKey(name))) return errors.push(`${i + 2}행: 매장명이 중복돼요 (${name})`);
        list.push({ code: cleanText(r.code, 20), name, channel: cleanText(r.channel, 20), manager: cleanText(r.manager, 20) });
      });
      if (!list.length) return send(res, 400, { error: '등록할 매장이 없어요. 첫 줄에 "매장명" 열이 있는지 확인해 주세요.', errors });
      db.stores = list; // 명단은 통째로 교체
      saveDb();
      return send(res, 200, { ok: true, count: list.length, errors });
    }

    // ---- 진열 현황 ----
    if (m === 'GET' && p === '/api/admin/display') return send(res, 200, displayReport());
    if (m === 'GET' && p === '/api/admin/display-analysis') return send(res, 200, displayAnalysis());
    if (m === 'GET' && p === '/api/admin/space-efficiency') return send(res, 200, spaceEfficiency());
    if (m === 'GET' && p === '/api/admin/stock-analysis') return send(res, 200, stockAnalysis());
    if (m === 'GET' && p === '/api/admin/sell-review') return send(res, 200, sellReview());
    if (m === 'POST' && p === '/api/admin/stock/import') {
      let b;
      try { b = JSON.parse((await readRaw(req, 8 * 1024 * 1024)).toString('utf8')); } catch { return send(res, 400, { error: '재고 데이터를 읽지 못했어요 (너무 크거나 형식 오류).' }); }
      const r = importStock(b);
      return send(res, r.error ? 400 : 200, r);
    }
    if (m === 'DELETE' && p === '/api/admin/stock') { db.stock = null; saveDb(); return send(res, 200, { ok: true }); }
    if (m === 'POST' && p === '/api/admin/sales/import') {
      let b;
      try { b = JSON.parse((await readRaw(req, 8 * 1024 * 1024)).toString('utf8')); } catch { return send(res, 400, { error: '판매 데이터를 읽지 못했어요 (너무 크거나 형식 오류).' }); }
      const r = importSales(b);
      return send(res, r.error ? 400 : 200, r);
    }
    if (m === 'DELETE' && p === '/api/admin/sales') { db.sales = null; saveDb(); return send(res, 200, { ok: true }); }
    if (m === 'POST' && p === '/api/admin/production/import') {
      let b;
      try { b = JSON.parse((await readRaw(req, 4 * 1024 * 1024)).toString('utf8')); } catch { return send(res, 400, { error: '생산 자료를 읽지 못했어요.' }); }
      const r = importProduction(b);
      return send(res, r.error ? 400 : 200, r);
    }
    if (m === 'POST' && p === '/api/admin/sizes/import') {
      const r = importSizes(await readBody(req, 256 * 1024));
      return send(res, r.error ? 400 : 200, r);
    }
    const optQ = () => { const q = (k) => (url.searchParams.has(k) && url.searchParams.get(k) !== '' ? Number(url.searchParams.get(k)) : NaN); const c = q('cover'), mn = q('min'); const o = {}; if (c >= 7 && c <= 180) o.coverDays = Math.round(c); if (mn >= 0 && mn <= 20) o.minStockPerSku = Math.round(mn); const dn = q('density'); if (dn > 0 && dn <= 40) o.density = dn; if (url.searchParams.get('tiered') === '0') o.tiered = false; return o; };
    if (m === 'GET' && p === '/api/admin/optimal-display') return send(res, 200, optimalDisplay(optQ()));
    if (m === 'GET' && p === '/api/admin/optimal-display.csv') {
      const o = optimalDisplay(optQ());
      if (!o.ready) return send(res, 400, { error: '판매 자료를 먼저 올려 주세요.' });
      const J = { over: '구색 과다 (축소 검토)', ok: '적정', room: '구색 효율 높음 (확대 여지)' };
      const rows = [['매장', '등급', '담당자', '평수', `26FW 매출(${o.salesInfo.from}~${o.salesInfo.to})`, '평당 매출', '보유 SKU', '판매된 SKU', 'SKU 활성률(%)', '매출 80% SKU', '권장 진열 SKU', '줄일 SKU', '진열 SKU(조사)', '권장 중 진열됨', '걸기 후보(권장·재고 있음·미진열)', '빼기 후보(진열·권장 밖)', '배분 필요(권장·재고 없음)', '현재 재고', '권장 재고', '과잉 재고', '부족 재고', '평가 일치율(%)', '판정']];
      o.stores.forEach((s) => rows.push([s.name, { A: '상위', B: '중위', C: '하위' }[s.tier] || '', s.manager, s.py ?? '', s.amount, s.perPy ?? '', s.held, s.sold, s.active ?? '', s.core, s.recSku, s.cutSku, s.survey.checked ? s.survey.shown : '', s.survey.checked ? s.survey.recShown : '', s.survey.toHang, s.survey.toRemove, s.survey.toAllocate, s.stockQty, s.recStockQty, s.overStock, s.shortStock, s.survey.agreePct ?? '', J[s.judge] || '']));
      const csv = '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
      return send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="optimal-display.csv"' });
    }
    if (m === 'GET' && p === '/api/admin/space-swaps.csv') {
      const sp = spaceEfficiency();
      const cell = (x) => (x ? `${x.code} ${x.color}`.trim() : '');
      const rows = [['매장명', '공간 효율 점수', '빼기 (안 팔리는 진열)', '빼기 판매 점수', '걸기 (창고의 잘 팔리는 상품)', '걸기 판매 점수', '복종']];
      sp.stores.forEach((st) => st.swaps.forEach((w) => rows.push([st.name, st.score ?? '', cell(w.out), w.out.score, cell(w.in), w.in.score, `${w.out.line} ${w.out.type}`])));
      const csv = '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
      return send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="space-swaps.csv"' });
    }
    if (m === 'GET' && (p === '/api/admin/display-matrix.csv' || p === '/api/admin/display-summary.csv')) {
      const rep = displayReport();
      const skus = rep.skus.slice().sort((a, b) => (a.code + a.sku).localeCompare(b.code + b.sku));
      let rows;
      if (p.endsWith('matrix.csv')) {
        // 행 = 매장, 열 = SKU (품번-컬러)
        const st = Object.fromEntries(db.displays.map((d) => [`${d.store}\u0000${d.sku}`, OPTIONS.display[d.status]]));
        rows = [['매장명', '체크한 SKU', ...skus.map((k) => `${k.code}${k.color ? '-' + k.color : ''}`)]];
        rep.stores.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((s) =>
          rows.push([s.name, `${s.checked}/${rep.totalSkus}`, ...skus.map((k) => st[`${s.name}\u0000${k.sku}`] || '')]));
      } else {
        rows = [['품번', '컬러', 'PLC', '상품', '구분', '복종', '진열 매장', '창고만', '없음', '미입고', '체크한 매장', '진열률(%, 미입고 제외)', '없음 매장 목록', '미입고 매장 목록']];
        skus.forEach((k) => rows.push([k.code, k.color, k.sku.startsWith('P-') ? '' : k.sku, k.name, k.line, k.type, k.shown, k.stock, k.none, k.notReceived, k.checked, k.rate ?? '', k.stores.none.join(', '), k.stores.notReceived.join(', ')]));
      }
      const csv = '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
      return send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${p.split('/').pop()}"` });
    }

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
    if (m === 'GET' && p === '/api/admin/gifts') return send(res, 200, giftSummary());
    // 2026 사은품 목록 관리
    if (m === 'POST' && p === '/api/admin/gift-items') {
      const b = await readBody(req);
      const name = cleanText(b.name, 60);
      if (!name) return send(res, 400, { error: '사은품 이름을 입력해 주세요.' });
      const it = { id: 'g' + crypto.randomUUID().slice(0, 6), name, active: true, photos: [] };
      db.giftItems.push(it);
      saveDb();
      return send(res, 201, giftItemView(it));
    }
    const gi = p.match(/^\/api\/admin\/gift-items\/([\w-]+)(\/photo)?$/);
    if (gi) {
      const it = db.giftItems.find((x) => x.id === gi[1]);
      if (!it) return send(res, 404, { error: '사은품이 없어요.' });
      if (!gi[2] && m === 'PATCH') {
        const b = await readBody(req);
        if (b.name !== undefined) { const n = cleanText(b.name, 60); if (!n) return send(res, 400, { error: '이름을 입력해 주세요.' }); it.name = n; }
        if (b.active !== undefined) it.active = !!b.active;
        saveDb();
        return send(res, 200, giftItemView(it));
      }
      if (gi[2] && m === 'POST') {
        const buf = await readRaw(req, 5 * 1024 * 1024);
        const ext = imageType(buf);
        if (!ext) return send(res, 400, { error: 'JPG·PNG·WEBP 이미지만 올릴 수 있어요.' });
        if (it.photos.length >= 10) return send(res, 400, { error: '사진은 10장까지 올릴 수 있어요.' });
        fs.mkdirSync(IMG_DIR, { recursive: true });
        const file = `gift-${it.id}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
        fs.writeFileSync(path.join(IMG_DIR, file), buf);
        it.photos.push(file);
        saveDb();
        return send(res, 201, giftItemView(it));
      }
      if (gi[2] && m === 'DELETE') {
        const file = String(url.searchParams.get('file') || '').replace(/^\/images\//, '');
        if (!it.photos.includes(file)) return send(res, 404, { error: '사진이 없어요.' });
        it.photos = it.photos.filter((f) => f !== file);
        if (!db.giftItems.some((x) => x.photos.includes(file))) fs.rmSync(path.join(IMG_DIR, file), { force: true });
        saveDb();
        return send(res, 200, giftItemView(it));
      }
    }
    const dg = p.match(/^\/api\/admin\/gifts\/([\w-]+)$/);
    if (dg && m === 'DELETE') {
      const before = db.gifts.length;
      db.gifts = db.gifts.filter((e) => e.id !== dg[1]);
      if (db.gifts.length === before) return send(res, 404, { error: '의견이 없습니다.' });
      saveDb();
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/admin/gifts.csv') {
      const L = (key, v) => OPTIONS[key][v] || v || '';
      const its = db.giftItems;
      const rows = [['수정일시', '매장명', '사은품 문의 빈도', '사은품 때문에 구매 미룸', '올해 사은품 평균 반응(1~5)', '올해 사은품 구매 영향', '올해 사은품 전체 메모', '원하는 사은품', '품목 의견', '적정 기준 금액', '매장 아이디어',
        ...its.flatMap((it) => [`[${it.name}] 반응`, `[${it.name}] 메모`])]];
      db.gifts.forEach((e) => rows.push([e.updatedAt, e.store, L('giftFreq', e.freq), L('giftDelay', e.delay), e.reaction || '', L('giftImpact', e.impact), e.currentNote, e.items.join(' / '), e.itemNote, L('giftThreshold', e.threshold), e.idea,
        ...its.flatMap((it) => { const v = (e.reviews || {})[it.id]; return v ? [GIFT_SKIP[v.r] || v.r, v.note] : ['', '']; })]));
      const csv = '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
      return send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="gifts.csv"' });
    }
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
      const r = deleteStoreData(store);
      saveDb();
      return send(res, 200, { ok: true, ...r });
    }
    if (m === 'POST' && p === '/api/admin/stores/merge') {
      const b = await readBody(req);
      const from = cleanText(b.from, 60);
      const to = db.stores.find((x) => x.name === b.to);
      if (!from || !to) return send(res, 400, { error: '합칠 이름과 명단의 매장을 골라 주세요.' });
      if (storeKey(from) === storeKey(to.name)) return send(res, 400, { error: '이미 같은 매장이에요.' });
      const moved = mergeStore(from, to.name);
      saveDb();
      return send(res, 200, { ok: true, moved });
    }

    if (p === '/api/admin/ai-summary-all') {
      if (m === 'POST' && !BULK.running) {
        if (!getAi()) return send(res, 503, { error: 'AI 요약을 쓰려면 Railway Variables에 ANTHROPIC_API_KEY를 추가해 주세요.' });
        runBulkSummaries().catch((ex) => console.error('AI 일괄 요약 중단:', ex.message));
      }
      if (m === 'GET' || m === 'POST') {
        const all = ['display', 'ztec', 'gift', ...db.products.filter((x) => x.active).map((x) => 'product:' + x.id)];
        const withData = all.filter((k) => summarySource(k));
        const pending = BULK.running ? null : bulkTargets().length;
        return send(res, 200, { ...BULK, pending, ready: withData.length - (pending ?? 0), withData: withData.length, aiEnabled: !!process.env.ANTHROPIC_API_KEY });
      }
    }
    // AI 의견 요약: GET = 저장된 요약, POST = 새로 요약
    const sm = p.match(/^\/api\/admin\/ai-summary\/(ztec|gift|display|product:[\w-]+)$/);
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
      db.displays = db.displays.filter((d) => d.productId !== product.id);
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
      const rows = [['수정일시', '매장명', '품번', '상품', '구분', '품목', '복종', '평가 상태', '고객반응(1~5)', '판매반응', '판매를 도운 요인', '판매를 막은 요인', '장점', '장점 메모', '단점', '단점 메모', '찾았지만 없던 사이즈·색상', '개선 아이디어', '주 구매 연령대', '주 구매 성별']];
      db.evaluations.forEach((e) => {
        const pr = prodOf[e.productId] || {};
        rows.push([
          e.updatedAt, e.staff, pr.code || '', pr.name || e.productId, pr.id ? lineOf(pr) : '', pr.category || '', pr.id ? typeOf(pr) : '', OPTIONS.evalStatus[e.status || 'done'], e.reaction || '', OPTIONS.sales[e.sales] || '',
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
    return send(res, 200, { ...OPTIONS, giftCatalog: db.giftItems.filter((g) => g.active).map(giftItemView), products: db.products.filter((x) => x.active).map((x) => ({ ...publicProduct(x), imageUrl: imageUrl(x) })) });
  }

  // 매장 이름 자동완성용 (매장명만)
  if (m === 'GET' && p === '/api/stores') return send(res, 200, db.stores.map((s) => s.name));

  // 진열 체크: 내 매장 상태 / 저장 (한 번에 여러 SKU도 가능, status '' 는 체크 취소)
  if (m === 'GET' && p === '/api/display/mine') {
    const store = cleanText(url.searchParams.get('store'), 30);
    const mine = {};
    if (store) db.displays.forEach((d) => { if (sameName(d.store, store)) mine[d.sku] = d.status; });
    return send(res, 200, mine);
  }
  if (m === 'POST' && p === '/api/display') {
    const b = await readBody(req, 256 * 1024);
    const store = cleanText(b.store, 30);
    if (!store) return send(res, 400, { error: '매장을 먼저 선택해 주세요.' });
    const items = Array.isArray(b.items) ? b.items.slice(0, 1000) : [{ sku: b.sku, status: b.status }];
    const idx = skuIndex();
    for (const it of items) {
      if (!idx.has(String(it.sku))) return send(res, 400, { error: `없는 SKU예요: ${it.sku}` });
      if (it.status !== '' && !(it.status in OPTIONS.display)) return send(res, 400, { error: '진열 상태가 올바르지 않아요.' });
    }
    const now = new Date().toISOString();
    for (const it of items) {
      const sku = String(it.sku);
      const i = db.displays.findIndex((d) => d.sku === sku && sameName(d.store, store));
      if (it.status === '') { if (i >= 0) db.displays.splice(i, 1); continue; }
      const rec = { store: i >= 0 ? db.displays[i].store : store, sku, productId: idx.get(sku).product.id, status: it.status, updatedAt: now };
      if (i >= 0) db.displays[i] = rec; else db.displays.push(rec);
    }
    const synced = syncEvalFromDisplay(store, [...new Set(items.map((it) => idx.get(String(it.sku)).product.id))]);
    saveDb();
    return send(res, 200, { ok: true, count: items.length, synced });
  }

  // Z-TEC 매장 의견 (매장당 1회, 다시 저장하면 수정)
  if (m === 'GET' && p === '/api/ztec/mine') {
    const store = cleanText(url.searchParams.get('store'), 30);
    return send(res, 200, (store && db.ztec.find((e) => sameName(e.store, store))) || null);
  }
  if (m === 'POST' && p === '/api/ztec') {
    const b = await readBody(req);
    const store = cleanText(b.store, 30);
    if (!store) return send(res, 400, { error: '매장을 먼저 선택해 주세요.' });
    if (!intIn(b.reaction, 1, 5)) return send(res, 400, { error: 'Z-TEC 고객 반응을 선택해 주세요.' });
    if (!(b.ease in OPTIONS.ztecEase)) return send(res, 400, { error: '설명 난이도를 선택해 주세요.' });
    const data = { store, reaction: b.reaction, ease: b.ease, good: cleanText(b.good, 500), bad: cleanText(b.bad, 500), suggestion: cleanText(b.suggestion, 500), updatedAt: new Date().toISOString() };
    const existing = db.ztec.find((e) => sameName(e.store, store));
    if (existing) Object.assign(existing, data);
    else db.ztec.push({ id: crypto.randomUUID(), createdAt: data.updatedAt, ...data });
    saveDb();
    return send(res, existing ? 200 : 201, { ok: true, updated: !!existing });
  }

  // 사은품 니즈 (매장당 1회, 다시 저장하면 수정)
  if (m === 'GET' && p === '/api/gifts/mine') {
    const k = storeKey(cleanText(url.searchParams.get('store'), 30));
    return send(res, 200, (k && db.gifts.find((e) => storeKey(e.store) === k)) || null);
  }
  if (m === 'POST' && p === '/api/gifts') {
    const b = await readBody(req);
    const store = cleanText(b.store, 30);
    if (!store) return send(res, 400, { error: '매장을 먼저 선택해 주세요.' });
    if (!(b.freq in OPTIONS.giftFreq)) return send(res, 400, { error: '1. 사은품 문의 빈도를 골라 주세요.' });
    if (!(b.delay in OPTIONS.giftDelay)) return send(res, 400, { error: '2. 사은품 때문에 구매를 미룬 경우를 골라 주세요.' });
    if (!(b.impact in OPTIONS.giftImpact)) return send(res, 400, { error: '3. 현재 사은품이 구매에 준 영향을 골라 주세요.' });
    const reviews = {};
    if (b.impact !== 'noGift') {
      const src = b.reviews && typeof b.reviews === 'object' ? b.reviews : {};
      for (const it of db.giftItems.filter((g) => g.active)) {
        const v = src[it.id] || {};
        if (!(GIFT_SKIP[v.r] || intIn(v.r, 1, 5))) return send(res, 400, { error: `3-1. '${it.name}' 사은품의 고객 반응을 골라 주세요. (안 들어왔으면 '미입고', 증정 안 했으면 '증정 안 함')` });
        reviews[it.id] = { r: v.r, note: cleanText(v.note, 300) };
      }
    }
    const scored = Object.values(reviews).filter((v) => !GIFT_SKIP[v.r]);
    b.reaction = scored.length ? Math.round(scored.reduce((a, v) => a + v.r, 0) / scored.length) : 0;
    const items = [...new Set(Array.isArray(b.items) ? b.items.filter((x) => OPTIONS.giftItems.includes(x)) : [])].slice(0, 3);
    if (!items.length) return send(res, 400, { error: '4. 고객이 원하는 사은품을 1~3개 골라 주세요.' });
    if (!(String(b.threshold) in OPTIONS.giftThreshold)) return send(res, 400, { error: '5. 적정 사은품 기준 금액을 골라 주세요.' });
    const data = {
      store, freq: b.freq, delay: b.delay, impact: b.impact, reaction: b.impact === 'noGift' ? 0 : b.reaction, reviews,
      currentNote: cleanText(b.currentNote, 500), items, itemNote: cleanText(b.itemNote, 500), threshold: String(b.threshold), idea: cleanText(b.idea, 500),
      updatedAt: new Date().toISOString(),
    };
    const existing = db.gifts.find((e) => storeKey(e.store) === storeKey(store));
    if (existing) Object.assign(existing, data);
    else db.gifts.push({ id: crypto.randomUUID(), createdAt: data.updatedAt, ...data });
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
    const status = b.status || 'done';
    if (!(status in OPTIONS.evalStatus)) return send(res, 400, { error: '평가 상태가 올바르지 않아요.' });
    const now0 = new Date().toISOString();
    // 판매 경험 없음 / 미입고: 질문 없이 '평가 제외'로 저장 (평균·비율에서 빠짐)
    if (status !== 'done') {
      const blank = { productId: product.id, staff, status, reaction: 0, sales: '', noBuyReasons: [], sellReasons: [], pros: [], prosNote: '', cons: [], consNote: '', missing: '', improvement: '', ageGroups: [], genders: [], updatedAt: now0 };
      if (status === 'nosale') {
        // 판매 경험은 없지만 고객 응대하면서 느낀 반응 (모두 선택)
        const aspects = aspectsFor(product.category);
        Object.assign(blank, {
          reaction: intIn(b.reaction, 1, 5) ? b.reaction : 0,
          pros: pick(b.pros, aspects), prosNote: cleanText(b.prosNote, 500),
          cons: pick(b.cons, aspects), consNote: cleanText(b.consNote, 500),
          improvement: cleanText(b.improvement, 500),
        });
      }
      const ex = db.evaluations.find((e) => e.productId === product.id && sameName(e.staff, staff));
      const prev = ex ? ex.status || 'done' : null;
      if (ex) { Object.assign(ex, blank); delete ex.auto; }
      else db.evaluations.push({ id: crypto.randomUUID(), createdAt: now0, ...blank });
      const synced = syncDisplayFromEval(ex ? ex.staff : staff, product, status, prev);
      saveDb();
      return send(res, ex ? 200 : 201, { ok: true, updated: !!ex, synced });
    }
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
      status: 'done',
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
    const prev = existing ? existing.status || 'done' : null;
    if (existing) { Object.assign(existing, data); delete existing.auto; }
    else db.evaluations.push({ id: crypto.randomUUID(), createdAt: now, ...data });
    const synced = syncDisplayFromEval(existing ? existing.staff : staff, product, 'done', prev);
    saveDb();
    return send(res, existing ? 200 : 201, { ok: true, updated: !!existing, synced });
  }

  send(res, 404, 'Not found');
}

// 예전 데이터(사진 1장)를 사진 목록 구조로 옮기기 — 함수 정의 뒤에 실행
db.products.forEach((p) => { photosOf(p); syncMain(p); });
seedGiftItems();
fixStoreNames20261126();

const server = http.createServer((req, res) => {
  // 검색엔진에 노출되지 않게 (페이지·이미지·CSV 모두)
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, noimageindex');
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
