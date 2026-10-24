'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const isTouch = () => matchMedia('(pointer: coarse)').matches;

const DEFAULT_TITLE = '나의 비전보드';
const MAX_SIDE = 2000;      // 저장할 때 사진 긴 변 최대 픽셀 (용량 절약)
const SLIDE_MS = 6000;      // 슬라이드 한 장당 시간

function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key, val) { try { localStorage.setItem(key, val); } catch { /* 사생활 모드 등 */ } }

/* =========================================================
 * 저장소 (IndexedDB) — 사진 원본은 이 기기 브라우저 안에만 저장
 * ======================================================= */
let dbPromise;
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open('visionboard', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('boards', { keyPath: 'id' });
        d.createObjectStore('photos', { keyPath: 'id' }).createIndex('boardId', 'boardId');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = t => new Promise((res, rej) => {
  t.oncomplete = () => res();
  t.onerror = t.onabort = () => rej(t.error || new Error('저장 실패'));
});

const DB = {
  async boards() {
    const d = await openDB();
    return reqP(d.transaction('boards').objectStore('boards').getAll());
  },
  async photosOf(boardId) {
    const d = await openDB();
    return reqP(d.transaction('photos').objectStore('photos').index('boardId').getAll(boardId));
  },
  async put(storeName, ...values) {
    const d = await openDB();
    const t = d.transaction(storeName, 'readwrite');
    values.forEach(v => t.objectStore(storeName).put(v));
    return txDone(t);
  },
  async putPhotoAndBoard(photo, board) {
    const d = await openDB();
    const t = d.transaction(['photos', 'boards'], 'readwrite');
    t.objectStore('photos').put(photo);
    t.objectStore('boards').put(board);
    return txDone(t);
  },
  async deletePhoto(photoId, board) {
    const d = await openDB();
    const t = d.transaction(['photos', 'boards'], 'readwrite');
    t.objectStore('photos').delete(photoId);
    t.objectStore('boards').put(board);
    return txDone(t);
  },
  async deleteBoard(boardId) {
    const d = await openDB();
    const ids = await reqP(d.transaction('photos').objectStore('photos').index('boardId').getAllKeys(boardId));
    const t = d.transaction(['photos', 'boards'], 'readwrite');
    ids.forEach(id => t.objectStore('photos').delete(id));
    t.objectStore('boards').delete(boardId);
    return txDone(t);
  },
};

function newBoard(title) {
  return { id: uid(), title, motto: '', order: [], createdAt: Date.now() };
}

/* =========================================================
 * 상태
 * ======================================================= */
const state = {
  boards: [],
  board: null,
  photos: new Map(),   // 현재 보드의 사진: id -> photo
  urls: new Map(),     // id -> 화면 표시용 objectURL
};

function sortBoards() { state.boards.sort((a, b) => a.createdAt - b.createdAt); }

function orderedPhotos() {
  const seen = new Set();
  const list = [];
  for (const id of state.board.order) {
    const p = state.photos.get(id);
    if (p && !seen.has(id)) { list.push(p); seen.add(id); }
  }
  for (const p of state.photos.values()) if (!seen.has(p.id)) list.push(p);
  return list;
}

function urlFor(p) {
  let u = state.urls.get(p.id);
  if (!u) { u = URL.createObjectURL(p.blob); state.urls.set(p.id, u); }
  return u;
}
function dropUrl(id) {
  const u = state.urls.get(id);
  if (u) { URL.revokeObjectURL(u); state.urls.delete(id); }
}

async function openBoard(id) {
  const b = state.boards.find(x => x.id === id) || state.boards[0];
  for (const id of [...state.urls.keys()]) dropUrl(id);
  state.board = b;
  state.photos = new Map((await DB.photosOf(b.id)).map(p => [p.id, p]));
  lsSet('vb.currentBoard', b.id);
  render();
  window.scrollTo(0, 0);
}

/* =========================================================
 * 화면 그리기
 * ======================================================= */
const ROW_PX = 4;

function render() {
  const b = state.board;
  $('#boardName').textContent = b.title;
  document.title = `${b.title} · 비전보드`;

  const motto = $('#motto');
  motto.textContent = b.motto || '탭해서 이 보드의 다짐을 적어보세요';
  motto.classList.toggle('placeholder', !b.motto);

  const list = orderedPhotos();
  $('#grid').replaceChildren(...list.map(tileFor));
  $('#empty').hidden = list.length > 0;
  $('#playBtn').disabled = list.length === 0;
  layout();
}

// 너무 길쭉한 사진은 칸 비율을 제한하고 잘라서 보여줌
const tileRatio = p => clamp(p.h / p.w, 0.56, 1.8);

function tileFor(p) {
  const fig = document.createElement('figure');
  fig.className = 'tile';
  fig.dataset.id = p.id;
  fig.style.aspectRatio = `1 / ${tileRatio(p)}`;
  const img = new Image();
  img.src = urlFor(p);
  img.alt = p.caption || '';
  img.draggable = false;
  img.decoding = 'async';
  fig.append(img);
  if (p.caption) {
    const cap = document.createElement('figcaption');
    cap.textContent = p.caption;
    fig.append(cap);
  }
  return fig;
}

// 핀터레스트식 배치: 칸 너비에 맞춰 각 사진이 차지할 세로 줄 수 계산
function layout() {
  const grid = $('#grid');
  const W = grid.clientWidth;
  if (!W) return;
  const cols = W < 560 ? 2 : W < 900 ? 3 : W < 1300 ? 4 : 5;
  const gap = parseFloat(getComputedStyle(grid).columnGap) || 12;
  grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  const colW = (W - gap * (cols - 1)) / cols;
  // 순서대로 하나씩, 지금 가장 짧은 열에 넣어서 빈 구멍이 안 생기게 함
  const heights = new Array(cols).fill(0);
  for (const el of grid.children) {
    const p = state.photos.get(el.dataset.id);
    if (!p) continue;
    const span = Math.ceil((colW * tileRatio(p) + gap) / ROW_PX);
    const c = heights.indexOf(Math.min(...heights));
    el.style.gridColumn = String(c + 1);
    el.style.gridRow = `${heights[c] + 1} / span ${span}`;
    heights[c] += span;
  }
}

/* =========================================================
 * 알림 / 레이어(팝업) — 안드로이드 뒤로가기로 닫히도록 history 사용
 * ======================================================= */
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

const layers = [];
const backWaiters = [];

function openLayer(el, onClose) {
  el.hidden = false;
  el.style.zIndex = String(100 + layers.length);   // 나중에 연 창이 항상 위로
  layers.push({ el, onClose });
  document.body.classList.add('no-scroll');
  history.pushState({ vbLayer: layers.length }, '');
}
function hideLayer(l) {
  l.el.hidden = true;
  if (!layers.length) document.body.classList.remove('no-scroll');
}
function closeLayer() {
  return new Promise(resolve => {
    const l = layers.pop();
    if (!l) return resolve();
    hideLayer(l);
    backWaiters.push(() => { l.onClose?.(); resolve(); });
    history.back();
  });
}
window.addEventListener('popstate', () => {
  if (backWaiters.length) { backWaiters.shift()(); return; }
  const l = layers.pop();   // 기기의 뒤로가기 버튼으로 닫힘
  if (l) { hideLayer(l); l.onClose?.(); }
});
const topLayer = () => layers[layers.length - 1]?.el;

function actionSheet(title, items) {
  $('#sheetTitle').textContent = title;
  const list = $('#sheetList');
  list.replaceChildren();
  for (const it of items) {
    if (it === '-') {
      const sep = document.createElement('div');
      sep.className = 'sheet-sep';
      list.append(sep);
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sheet-item' + (it.danger ? ' danger' : '') + (it.active ? ' active' : '');
    const label = document.createElement('span');
    label.textContent = it.label;
    if (it.sub) {
      const sub = document.createElement('small');
      sub.textContent = ' ' + it.sub;
      label.append(sub);
    }
    b.append(label);
    b.addEventListener('click', async () => {
      // 파일 선택창처럼 "터치 직후"에만 허용되는 동작은 닫기 전에 바로 실행
      if (it.immediate) { it.onClick(); closeLayer(); return; }
      await closeLayer();
      it.onClick?.();
    });
    list.append(b);
  }
  openLayer($('#sheet'));
}

function dialog({ title, message = '', input = null, value = '', placeholder = '', okLabel = '확인', danger = false, cancel = true }) {
  return new Promise(resolve => {
    const el = $('#ask');
    let result = input ? null : false;
    $('#askTitle').textContent = title;
    $('#askMessage').textContent = message;
    $('#askMessage').hidden = !message;
    const field = input === 'area' ? $('#askArea') : $('#askInput');
    $('#askInput').hidden = input !== 'line';
    $('#askArea').hidden = input !== 'area';
    if (input) { field.value = value; field.placeholder = placeholder; }
    const ok = $('#askOk');
    ok.textContent = okLabel;
    ok.className = 'btn ' + (danger ? 'danger' : 'primary');
    $('#askCancel').hidden = !cancel;

    const form = $('#askForm');
    form.onsubmit = e => {
      e.preventDefault();
      result = input ? field.value.trim() : true;
      closeLayer();
    };
    $('#askCancel').onclick = () => closeLayer();
    openLayer(el, () => resolve(result));
    if (input) setTimeout(() => field.focus(), 50);
  });
}
const askText = opts => dialog({ okLabel: '저장', input: 'line', ...opts });
const confirmAsk = opts => dialog(opts);

/* =========================================================
 * 사진 넣기
 * ======================================================= */
function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 열 수 없음')); };
    img.src = url;
  });
}
async function decode(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch { return loadImage(blob); }
}

async function processImage(file) {
  const src = await decode(file);
  const w0 = src.width, h0 = src.height;
  if (!w0 || !h0) throw new Error('빈 이미지');
  const s = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const w = Math.round(w0 * s), h = Math.round(h0 * s);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#111';   // 투명 PNG 배경
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0, w, h);
  src.close?.();
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.86));
  if (!blob) throw new Error('변환 실패');
  return { blob, w, h };
}

async function addFiles(fileList) {
  const files = [...fileList].filter(f => f.type.startsWith('image/') || /\.(hei[cf]|jpe?g|png|webp|gif|avif)$/i.test(f.name));
  if (!files.length) return;
  const board = state.board;
  let ok = 0, fail = 0;
  for (const [i, f] of files.entries()) {
    toast(`사진 넣는 중… ${i + 1}/${files.length}`, 0);
    try {
      const { blob, w, h } = await processImage(f);
      const p = { id: uid(), boardId: board.id, blob, w, h, caption: '', createdAt: Date.now() };
      const order = [...board.order, p.id];
      await DB.putPhotoAndBoard(p, { ...board, order });
      board.order = order;
      if (state.board === board) state.photos.set(p.id, p);
      ok++;
    } catch (e) {
      console.error(e);
      fail++;
    }
  }
  if (state.board === board) render();
  if (fail) toast(`${ok}장 추가, ${fail}장은 열 수 없는 형식이에요 (JPG/PNG로 바꿔서 넣어주세요)`, 5000);
  else toast(`${ok}장 추가했어요`);
  // 브라우저가 저장공간이 부족할 때 임의로 지우지 않도록 요청
  navigator.storage?.persist?.().catch(() => {});
}

/* =========================================================
 * 사진 크게 보기 + 문구 편집
 * ======================================================= */
let viewerId = null;

function openViewer(id) {
  viewerId = id;
  fillViewer();
  openLayer($('#viewer'), () => { saveCaption(); viewerId = null; });
}
function fillViewer() {
  const p = state.photos.get(viewerId);
  if (!p) return;
  $('#viewerImg').src = urlFor(p);
  $('#captionInput').value = p.caption || '';
  const many = state.photos.size > 1;
  $('#viewerPrev').hidden = !many;
  $('#viewerNext').hidden = !many;
}
async function saveCaption() {
  const p = state.photos.get(viewerId);
  if (!p) return;
  const v = $('#captionInput').value.trim();
  if (v === (p.caption || '')) return;
  p.caption = v;
  await DB.put('photos', p);
  render();
}
async function viewerStep(d) {
  await saveCaption();
  const list = orderedPhotos();
  const i = list.findIndex(p => p.id === viewerId);
  viewerId = list[(i + d + list.length) % list.length].id;
  fillViewer();
}
async function deleteCurrentPhoto() {
  const id = viewerId;
  const ok = await confirmAsk({ title: '사진 삭제', message: '이 사진을 보드에서 지울까요?\n되돌릴 수 없어요.', okLabel: '삭제', danger: true });
  if (!ok) return;
  const board = state.board;
  const order = board.order.filter(x => x !== id);
  await DB.deletePhoto(id, { ...board, order });
  board.order = order;
  state.photos.delete(id);
  viewerId = null;
  if (topLayer() === $('#viewer')) await closeLayer();
  dropUrl(id);
  render();
  toast('삭제했어요');
}

/* =========================================================
 * 보드 관리
 * ======================================================= */
function openBoardSwitcher() {
  actionSheet('보드', [
    ...state.boards.map(b => ({ label: b.title, active: b.id === state.board.id, onClick: () => openBoard(b.id) })),
    '-',
    { label: '+ 새 보드 만들기', onClick: createBoard },
  ]);
}

async function createBoard() {
  const title = await askText({ title: '새 보드', placeholder: '예: 건강, 돈, 여행, 커리어', okLabel: '만들기' });
  if (!title) return;
  const b = newBoard(title);
  await DB.put('boards', b);
  state.boards.push(b);
  await openBoard(b.id);
}

async function renameBoard() {
  const title = await askText({ title: '보드 이름', value: state.board.title });
  if (!title) return;
  state.board.title = title;
  await DB.put('boards', state.board);
  render();
}

async function editMotto() {
  const motto = await askText({
    title: '보드 다짐',
    input: 'area',
    value: state.board.motto,
    placeholder: '예: 2027년, 나는 매일 성장하고 자유롭게 산다',
  });
  if (motto === null) return;
  state.board.motto = motto;
  await DB.put('boards', state.board);
  render();
}

async function deleteBoard() {
  const b = state.board;
  const ok = await confirmAsk({
    title: '보드 삭제',
    message: `"${b.title}" 보드와 사진 ${state.photos.size}장을 모두 지울까요?\n되돌릴 수 없어요. 걱정되면 먼저 백업하세요.`,
    okLabel: '삭제',
    danger: true,
  });
  if (!ok) return;
  await DB.deleteBoard(b.id);
  state.boards = state.boards.filter(x => x.id !== b.id);
  if (!state.boards.length) {
    const nb = newBoard(DEFAULT_TITLE);
    await DB.put('boards', nb);
    state.boards.push(nb);
  }
  await openBoard(state.boards[0].id);
  toast('보드를 삭제했어요');
}

function openMenu() {
  actionSheet(state.board.title, [
    { label: '다짐 문구 수정', onClick: editMotto },
    { label: '보드 이름 바꾸기', onClick: renameBoard },
    '-',
    { label: '배경화면 이미지 만들기', sub: '폰 잠금화면용', onClick: () => makeWallpaper('phone') },
    { label: '배경화면 이미지 만들기', sub: 'PC 가로형', onClick: () => makeWallpaper('desktop') },
    '-',
    { label: '백업 파일로 내보내기', onClick: exportBackup },
    { label: '백업 파일 불러오기', immediate: true, onClick: () => $('#importInput').click() },
    { label: '사용 팁', onClick: showHelp },
    '-',
    { label: '이 보드 삭제', danger: true, onClick: deleteBoard },
  ]);
}

function showHelp() {
  confirmAsk({
    title: '사용 팁',
    message: [
      '• 사진은 이 기기 브라우저 안에만 저장돼요. 다른 사람은 볼 수 없어요.',
      '• 폰과 PC는 서로 따로예요. 옮기려면 "백업 파일로 내보내기" → 다른 기기에서 "불러오기".',
      '• 아이폰: Safari 공유 버튼 → "홈 화면에 추가"로 설치한 뒤 그 아이콘에서 사진을 넣으세요. Safari 탭과 홈 화면 앱은 저장소가 따로라서 서로 안 보여요.',
      '• 브라우저 "방문 기록/데이터 삭제"를 하면 사진도 지워져요. 가끔 백업하세요.',
      '• 사진을 꾹 누른 채 끌면 순서가 바뀌어요.',
    ].join('\n'),
    okLabel: '알겠어요',
    cancel: false,
  });
}

/* =========================================================
 * 슬라이드쇼
 * ======================================================= */
const show = { list: [], i: 0, timer: 0, paused: false, wake: null, idleTimer: 0 };

async function startShow(from = 0) {
  show.list = orderedPhotos();
  if (!show.list.length) return;
  show.i = from;
  show.paused = false;
  $('#showPaused').hidden = true;
  $('#showMotto').textContent = state.board.motto;
  const el = $('#show');
  openLayer(el, stopShow);
  const fs = document.documentElement;
  (fs.requestFullscreen || fs.webkitRequestFullscreen)?.call(fs)?.catch?.(() => {});
  try { show.wake = await navigator.wakeLock?.request('screen'); } catch { /* 지원 안 하면 무시 */ }
  renderSlide();
  schedule();
  poke();
}

function renderSlide() {
  const p = show.list[show.i];
  const stage = $('#showStage');
  const slide = document.createElement('div');
  slide.className = 'slide';
  const bg = document.createElement('div');
  bg.className = 'bg';
  bg.style.backgroundImage = `url("${urlFor(p)}")`;
  const img = new Image();
  img.className = 'main';
  img.src = urlFor(p);
  img.alt = p.caption || '';
  img.style.transformOrigin = ['50% 50%', '30% 40%', '70% 40%', '40% 70%', '60% 60%'][show.i % 5];
  slide.append(bg, img);
  stage.append(slide);
  requestAnimationFrame(() => requestAnimationFrame(() => slide.classList.add('on')));
  const old = [...stage.children].slice(0, -1);
  setTimeout(() => old.forEach(o => o.remove()), 1200);

  const cap = $('#showCaption');
  cap.style.opacity = 0;
  setTimeout(() => { cap.textContent = p.caption || ''; cap.style.opacity = 1; }, 350);
  restartBar();
}

function restartBar() {
  const bar = $('#showBar');
  bar.style.animation = 'none';
  void bar.offsetWidth;
  bar.style.animation = show.paused ? 'none' : `progress ${SLIDE_MS}ms linear forwards`;
}
function schedule() {
  clearTimeout(show.timer);
  if (!show.paused && show.list.length > 1) show.timer = setTimeout(() => showStep(1), SLIDE_MS);
}
function showStep(d) {
  if ($('#show').hidden) return;
  show.i = (show.i + d + show.list.length) % show.list.length;
  renderSlide();
  schedule();
}
function togglePause() {
  show.paused = !show.paused;
  $('#showPaused').hidden = !show.paused;
  restartBar();
  schedule();
}
function stopShow() {
  clearTimeout(show.timer);
  clearTimeout(show.idleTimer);
  $('#showStage').replaceChildren();
  $('#showCaption').textContent = '';
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsEl) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document)?.catch?.(() => {});
  show.wake?.release?.().catch?.(() => {});
  show.wake = null;
}
// 마우스를 잠시 안 움직이면 닫기 버튼/커서 숨김
function poke() {
  const el = $('#show');
  el.classList.remove('idle');
  clearTimeout(show.idleTimer);
  show.idleTimer = setTimeout(() => el.classList.add('idle'), 2500);
}

function bindShowInput() {
  const el = $('#show');
  let sx = null, sy = 0;
  el.addEventListener('pointerdown', e => { sx = e.clientX; sy = e.clientY; poke(); });
  el.addEventListener('pointermove', poke);
  el.addEventListener('pointerup', e => {
    if (sx === null || e.target.closest('.show-close')) { sx = null; return; }
    const dx = e.clientX - sx, dy = e.clientY - sy;
    sx = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) return showStep(dx < 0 ? 1 : -1);
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) return;
    const x = e.clientX / window.innerWidth;
    if (x < 0.3) showStep(-1);
    else if (x > 0.7) showStep(1);
    else togglePause();
  });
  $('#showClose').addEventListener('click', () => closeLayer());
  // 다른 앱 갔다 오면 화면 꺼짐 방지 다시 요청
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && !el.hidden && !show.wake) {
      try { show.wake = await navigator.wakeLock?.request('screen'); } catch { /* 무시 */ }
    }
  });
}

/* =========================================================
 * 배경화면 이미지 만들기
 * ======================================================= */
function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCover(ctx, img, x, y, w, h) {
  const s = Math.max(w / img.width, h / img.height);
  const sw = w / s, sh = h / s;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

// 작게 줄였다가 크게 늘리면 흐린 배경이 됨 (Safari는 canvas blur 필터 지원이 불안정)
function drawBlurred(ctx, img, W, H) {
  let cur = img;
  for (const side of [24, 96]) {
    const c = document.createElement('canvas');
    c.width = side;
    c.height = Math.max(1, Math.round(side * H / W));
    const cx = c.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    if (cur === img) drawCover(cx, img, 0, 0, c.width, c.height);
    else cx.drawImage(cur, 0, 0, c.width, c.height);
    cur = c;
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, W, H);
}

function wrapText(ctx, text, maxW) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const tryLine = line ? line + ' ' + word : word;
      if (ctx.measureText(tryLine).width <= maxW) { line = tryLine; continue; }
      if (line) lines.push(line);
      line = '';
      // 한 단어가 너무 길면 글자 단위로 자름
      for (const ch of word) {
        if (ctx.measureText(line + ch).width > maxW && line) { lines.push(line); line = ''; }
        line += ch;
      }
    }
    lines.push(line);
  }
  return lines;
}

function ellipsize(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

function wallpaperSize(kind) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const short = Math.round(Math.min(screen.width, screen.height) * dpr);
  const long = Math.round(Math.max(screen.width, screen.height) * dpr);
  if (kind === 'phone') return isTouch() && short >= 640 ? [short, long] : [1179, 2556];
  return !isTouch() && long >= 1920 ? [long, short] : [2560, 1440];
}

let previewBlob = null;

async function makeWallpaper(kind) {
  const list = orderedPhotos();
  if (!list.length) return toast('먼저 사진을 넣어주세요');
  toast('이미지 만드는 중…', 0);
  try {
    const [W, H] = wallpaperSize(kind);
    const portrait = H > W;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    const imgs = await Promise.all(list.map(p => decode(p.blob)));
    await Promise.race([document.fonts?.load('600 40px "Noto Serif KR"'), new Promise(r => setTimeout(r, 2500))]).catch(() => {});

    // 배경: 첫 사진을 흐리게 + 어둡게
    ctx.fillStyle = '#0b0b0d';
    ctx.fillRect(0, 0, W, H);
    drawBlurred(ctx, imgs[0], W, H);
    ctx.fillStyle = 'rgba(8, 8, 10, 0.74)';
    ctx.fillRect(0, 0, W, H);

    const u = Math.min(W, H) / 100;
    const pad = u * 5;
    const gap = u * 1.4;
    // 폰 잠금화면은 위쪽에 시계, 아래쪽에 손전등/카메라 버튼이 있어서 비워둠
    let y = portrait ? H * 0.27 : H * 0.08;
    const bottom = portrait ? H * 0.11 : H * 0.07;

    const motto = (state.board.motto || '').trim();
    if (motto) {
      const fs = portrait ? u * 6.2 : u * 4.4;
      ctx.font = `600 ${fs}px "Noto Serif KR", serif`;
      ctx.fillStyle = '#f3efe7';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.shadowColor = 'rgba(0,0,0,.6)';
      ctx.shadowBlur = u;
      const lines = wrapText(ctx, motto, W - pad * 2).slice(0, 3);
      lines.forEach((ln, i) => ctx.fillText(ln, W / 2, y + i * fs * 1.38));
      ctx.shadowBlur = 0;
      y += lines.length * fs * 1.38 + u * 1.6;
      ctx.fillStyle = '#c9a96e';
      ctx.fillRect(W / 2 - u * 3, y, u * 6, Math.max(2, u * 0.25));
      y += u * 4;
    }

    // 사진 칸 배치: 사진 비율에 가장 잘 맞는 열 수를 고름
    const area = { x: pad, y, w: W - pad * 2, h: H - bottom - y };
    const n = list.length;
    const ratios = list.map(p => p.w / p.h).sort((a, b) => a - b);
    const target = clamp(ratios[Math.floor(n / 2)], 0.65, 1.5);
    let best = null;
    for (let cols = 1; cols <= Math.min(n, 8); cols++) {
      const rows = Math.ceil(n / cols);
      let cw = (area.w - gap * (cols - 1)) / cols;
      let ch = (area.h - gap * (rows - 1)) / rows;
      if (cw <= 0 || ch <= 0) continue;
      // 칸이 너무 길쭉/납작해지지 않게 줄임
      if (cw / ch < target * 0.75) ch = cw / (target * 0.75);
      if (cw / ch > target * 1.33) cw = ch * target * 1.33;
      const score = -(cw * ch * n) / (area.w * area.h) + Math.abs(Math.log(cw / ch / target)) * 0.3;
      if (!best || score < best.score) best = { cols, rows, cw, ch, score };
    }
    const { cols, rows, cw, ch } = best;
    const blockH = rows * ch + (rows - 1) * gap;
    const oy = area.y + Math.max(0, (area.h - blockH) / 2);
    const radius = u * 1.6;
    const showCaps = cw > u * 20;

    imgs.forEach((img, idx) => {
      const r = Math.floor(idx / cols);
      const k = idx % cols;
      const inRow = r === rows - 1 ? n - cols * (rows - 1) : cols;
      const rowW = inRow * cw + (inRow - 1) * gap;
      const x = area.x + (area.w - rowW) / 2 + k * (cw + gap);
      const yy = oy + r * (ch + gap);
      ctx.save();
      roundRectPath(ctx, x, yy, cw, ch, radius);
      ctx.clip();
      drawCover(ctx, img, x, yy, cw, ch);
      const cap = list[idx].caption;
      if (showCaps && cap) {
        const fs = clamp(cw * 0.075, u * 2.2, u * 3.4);
        const g = ctx.createLinearGradient(0, yy + ch - fs * 3.2, 0, yy + ch);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, 'rgba(0,0,0,.78)');
        ctx.fillStyle = g;
        ctx.fillRect(x, yy + ch - fs * 3.2, cw, fs * 3.2);
        ctx.font = `600 ${fs}px -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif`;
        ctx.fillStyle = '#f3efe7';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(ellipsize(ctx, cap, cw - fs * 1.4), x + fs * 0.7, yy + ch - fs * 0.8);
      }
      ctx.restore();
      img.close?.();
    });

    previewBlob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
    if (!previewBlob) throw new Error('이미지 생성 실패');
    const img = $('#previewImg');
    if (img.src) URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(previewBlob);
    $('#toast').classList.remove('show');
    openLayer($('#preview'));
  } catch (e) {
    console.error(e);
    toast('이미지를 만들지 못했어요. 사진 수를 줄여서 다시 해보세요.', 4000);
  }
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 20000);
}

function safeName(s) { return s.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || 'board'; }

async function savePreview() {
  if (!previewBlob) return;
  const name = `visionboard-${safeName(state.board.title)}.jpg`;
  const file = new File([previewBlob], name, { type: 'image/jpeg' });
  // 폰에서는 공유 시트 → "이미지 저장"으로 사진 앱에 바로 저장 가능
  if (isTouch() && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  downloadBlob(previewBlob, name);
}

/* =========================================================
 * 백업 내보내기 / 불러오기
 * ======================================================= */
const blobToDataURL = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

async function exportBackup() {
  toast('백업 파일 만드는 중…', 0);
  try {
    const boards = await DB.boards();
    const out = { app: 'visionboard', version: 1, exportedAt: new Date().toISOString(), boards, photos: [] };
    for (const b of boards) {
      for (const p of await DB.photosOf(b.id)) {
        const { blob, ...rest } = p;
        out.photos.push({ ...rest, data: await blobToDataURL(blob) });
      }
    }
    const date = new Date().toISOString().slice(0, 10);
    downloadBlob(new Blob([JSON.stringify(out)], { type: 'application/json' }), `visionboard-backup-${date}.json`);
    toast(`백업 완료: 보드 ${boards.length}개, 사진 ${out.photos.length}장`);
  } catch (e) {
    console.error(e);
    toast('백업에 실패했어요', 4000);
  }
}

async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { return toast('백업 파일을 읽을 수 없어요', 4000); }
  if (data?.app !== 'visionboard' || !Array.isArray(data.boards) || !Array.isArray(data.photos)) {
    return toast('비전보드 백업 파일이 아니에요', 4000);
  }
  const ok = await confirmAsk({
    title: '백업 불러오기',
    message: `보드 ${data.boards.length}개, 사진 ${data.photos.length}장을 불러올게요.\n같은 보드가 이미 있으면 백업 내용으로 바뀌어요.`,
    okLabel: '불러오기',
  });
  if (!ok) return;
  toast('불러오는 중…', 0);
  try {
    const before = state.boards.slice();
    for (const raw of data.boards) {
      if (!raw?.id) continue;
      const board = {
        id: String(raw.id),
        title: String(raw.title || DEFAULT_TITLE),
        motto: String(raw.motto || ''),
        order: Array.isArray(raw.order) ? raw.order.map(String) : [],
        createdAt: Number(raw.createdAt) || Date.now(),
      };
      // 변환을 먼저 끝내고 나서 기존 것을 지움 (중간에 실패해도 원래 데이터 유지)
      const photos = await Promise.all(data.photos.filter(p => p.boardId === raw.id && p.data).map(async p => {
        const blob = await (await fetch(p.data)).blob();
        return { id: String(p.id), boardId: board.id, blob, w: Number(p.w) || 1, h: Number(p.h) || 1, caption: String(p.caption || ''), createdAt: Number(p.createdAt) || Date.now() };
      }));
      if (before.some(b => b.id === board.id)) await DB.deleteBoard(board.id);
      if (photos.length) await DB.put('photos', ...photos);
      await DB.put('boards', board);
    }
    // 새 기기에서 자동으로 생긴 빈 기본 보드는 정리
    const importedIds = new Set(data.boards.map(b => String(b.id)));
    for (const b of before) {
      if (!importedIds.has(b.id) && b.title === DEFAULT_TITLE && !b.motto && !(await DB.photosOf(b.id)).length) {
        await DB.deleteBoard(b.id);
      }
    }
    state.boards = await DB.boards();
    sortBoards();
    const firstId = data.boards[0]?.id ? String(data.boards[0].id) : state.boards[0].id;
    await openBoard(firstId);
    toast('불러오기 완료');
  } catch (e) {
    console.error(e);
    toast('불러오는 중 문제가 생겼어요. 파일이 손상됐을 수 있어요.', 5000);
  }
}

/* =========================================================
 * 시작
 * ======================================================= */
function bindEvents() {
  $('#boardSwitch').addEventListener('click', openBoardSwitcher);
  $('#menuBtn').addEventListener('click', openMenu);
  $('#motto').addEventListener('click', editMotto);
  $('#motto').addEventListener('keydown', e => { if (e.key === 'Enter') editMotto(); });
  $('#playBtn').addEventListener('click', () => startShow(0));

  $('#fileInput').addEventListener('change', async e => {
    const files = [...e.target.files];
    e.target.value = '';
    await addFiles(files);
  });
  $('#importInput').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) await importBackup(f);
  });

  const grid = $('#grid');
  grid.addEventListener('click', e => {
    const t = e.target.closest('.tile');
    if (t) openViewer(t.dataset.id);
  });
  grid.addEventListener('contextmenu', e => e.preventDefault());
  if (window.Sortable) {
    Sortable.create(grid, {
      animation: 200,
      delay: 220,
      delayOnTouchOnly: true,
      touchStartThreshold: 6,
      forceFallback: true,
      fallbackTolerance: 4,
      ghostClass: 'ghost',
      dragClass: 'dragging',
      onChange: () => layout(),
      onEnd: async e => {
        layout();
        if (e.oldIndex === e.newIndex) return;
        state.board.order = [...grid.children].map(el => el.dataset.id);
        await DB.put('boards', state.board);
      },
    });
  }
  new ResizeObserver(() => layout()).observe(grid);

  $('#viewerClose').addEventListener('click', () => closeLayer());
  $('#viewerDelete').addEventListener('click', deleteCurrentPhoto);
  $('#viewerPrev').addEventListener('click', () => viewerStep(-1));
  $('#viewerNext').addEventListener('click', () => viewerStep(1));
  $('#captionInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); saveCaption(); } });
  $('#captionInput').addEventListener('change', saveCaption);

  $('#previewClose').addEventListener('click', () => closeLayer());
  $('#previewSave').addEventListener('click', savePreview);

  // 바깥(어두운 부분) 누르면 닫기
  for (const id of ['#sheet', '#ask', '#preview']) {
    $(id).addEventListener('click', e => { if (e.target === e.currentTarget) closeLayer(); });
  }

  bindShowInput();

  document.addEventListener('keydown', e => {
    const top = topLayer();
    if (e.key === 'Escape' && top) { e.preventDefault(); closeLayer(); return; }
    if (top === $('#show')) {
      if (e.key === 'ArrowRight') showStep(1);
      else if (e.key === 'ArrowLeft') showStep(-1);
      else if (e.key === ' ') { e.preventDefault(); togglePause(); }
      poke();
    } else if (top === $('#viewer') && document.activeElement !== $('#captionInput')) {
      if (e.key === 'ArrowRight') viewerStep(1);
      else if (e.key === 'ArrowLeft') viewerStep(-1);
    }
  });

  // PC: 파일을 끌어다 놓기 / 붙여넣기(Ctrl+V)로 사진 추가
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (!layers.length) addFiles(e.dataTransfer.files);
  });
  document.addEventListener('paste', e => {
    if (layers.length) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) addFiles(files);
  });
}

async function init() {
  try {
    state.boards = await DB.boards();
  } catch (e) {
    console.error(e);
    $('#motto').textContent = '이 브라우저에서는 저장소를 쓸 수 없어요. (사생활 보호 모드라면 일반 모드로 열어주세요)';
    return;
  }
  if (!state.boards.length) {
    const b = newBoard(DEFAULT_TITLE);
    await DB.put('boards', b);
    state.boards = [b];
  }
  sortBoards();
  bindEvents();
  await openBoard(lsGet('vb.currentBoard'));

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
