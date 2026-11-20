/* 旅の記録 — 行った旅行先を地図のピンで記録するPWA
 * データ：非公開リポジトリのJSON（GitHub Contents APIで読み書き）
 * 認証：GitHubのアクセストークン（端末のブラウザ内だけに保存。コードには書かない）
 */
(() => {
  'use strict';

  // ---------- 定数 ----------
  const KINDS = {
    sightseeing: { label: '観光', color: '#8cc7dd' },
    stay:        { label: '宿泊', color: '#b8a06a' },
    food:        { label: '食事', color: '#f26b2a' },
    drink:       { label: 'お酒', color: '#a5c43c' },
  };
  const MODES = {
    plane:      { label: '飛行機', dash: '0.5 7', weight: 1.8, curve: true },
    shinkansen: { label: '新幹線', dash: null,    weight: 2.2 },
    train:      { label: '電車',   dash: null,    weight: 1.4 },
    bus:        { label: 'バス',   dash: '6 6',   weight: 1.6 },
    car:        { label: '車',     dash: '6 6',   weight: 1.6 },
    ship:       { label: '船',     dash: '2 8',   weight: 1.8 },
    other:      { label: 'その他', dash: '4 5',   weight: 1.4 },
  };
  const LINE_COLOR = '#00cf8f'; // 経路・移動の線（青みのある鮮やかな緑。お酒のピンの黄緑と区別できる色）
  const LS_SETTINGS = 'travel.settings';
  const LS_CACHE = 'travel.cache';
  const DEFAULT_PATH = 'private/travel/trips.json';
  const EMPTY = () => ({ version: 1, trips: [] });

  // ---------- 状態 ----------
  let settings = readLS(LS_SETTINGS) || { repo: '', path: DEFAULT_PATH, token: '' };
  const cache = readLS(LS_CACHE);
  let data = normalize(cache && cache.data) || EMPTY();
  let sha = (cache && cache.sha) || null;
  let selectedId = null;   // 選択中の旅行
  let activeItemId = null; // 選択中の場所・移動
  let saveChain = Promise.resolve();

  const $ = (s, el = document) => el.querySelector(s);
  const sheet = $('#sheet');
  const sheetBody = $('#sheet-body');

  // ---------- 小物 ----------
  function readLS(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
  function writeLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できない環境では無視 */ } }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function uid() {
    return (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(16).slice(2) + Date.now().toString(16)).replace(/-/g, '').slice(0, 10);
  }
  function yen(n) { return '¥' + Math.round(n).toLocaleString('ja-JP'); }
  function num(v) { const n = Number(String(v ?? '').replace(/[,，¥円\s]/g, '')); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null; }
  function hasLoc(p) { return p && Number.isFinite(p.lat) && Number.isFinite(p.lng); }
  function fmtDate(d) { return d ? d.slice(0, 10).replace(/-/g, '.') : ''; }
  function fmtRange(a, b) {
    if (!a) return '';
    if (!b || a === b) return fmtDate(a);
    return a.slice(0, 4) === b.slice(0, 4) ? `${fmtDate(a)} – ${b.slice(5, 10).replace('-', '.')}` : `${fmtDate(a)} – ${fmtDate(b)}`;
  }
  function nights(t) {
    if (!t.start || !t.end) return null;
    const n = Math.round((Date.parse(t.end) - Date.parse(t.start)) / 864e5);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  function nightsLabel(t) { const n = nights(t); return n == null ? '' : n === 0 ? '日帰り' : `${n}泊`; }
  function tripCost(t) {
    let sum = 0, any = false;
    for (const x of [...t.places, ...t.moves]) if (Number.isFinite(x.cost)) { sum += x.cost; any = true; }
    return any ? sum : null;
  }
  function timeOf(dt) { return dt && dt.length > 10 ? dt.slice(11, 16) : ''; }

  function normalize(d) {
    if (!d || !Array.isArray(d.trips)) return null;
    d.trips.forEach(t => { t.places = t.places || []; t.moves = t.moves || []; });
    return d;
  }

  // 場所と移動を、日時順（日時がないものは登録順で後ろ）に並べる
  function timeline(t) {
    const items = [
      ...t.places.map((p, i) => ({ type: 'place', item: p, i })),
      ...t.moves.map((m, i) => ({ type: 'move', item: m, i: i + 0.5 })),
    ];
    return items.sort((a, b) => {
      const da = a.item.datetime || '', db = b.item.datetime || '';
      if (da && db && da !== db) return da < db ? -1 : 1;
      if (da && !db) return -1;
      if (!da && db) return 1;
      return a.i - b.i;
    });
  }
  function orderedPlaces(t) { return timeline(t).filter(x => x.type === 'place').map(x => x.item); }

  function toast(msg, ms = 1800) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), ms);
  }

  // ---------- GitHub ----------
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64decode(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  function connected() { return !!(settings.repo && settings.path && settings.token); }
  function apiUrl() {
    return `https://api.github.com/repos/${settings.repo.trim()}/contents/${settings.path.trim().split('/').map(encodeURIComponent).join('/')}`;
  }
  async function gh(method, body) {
    const res = await fetch(method === 'GET' ? `${apiUrl()}?_=${Date.now()}` : apiUrl(), {
      method,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${settings.token.trim()}`,
        Accept: 'application/vnd.github+json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  }
  async function loadRemote() {
    const res = await gh('GET');
    if (res.status === 404) {
      // GitHubは「権限がない」ときも404を返すので、リポジトリ自体が見えるかで原因を分ける
      const repoRes = await fetch(`https://api.github.com/repos/${settings.repo.trim()}`, {
        cache: 'no-store', headers: { Authorization: `Bearer ${settings.token.trim()}`, Accept: 'application/vnd.github+json' },
      });
      if (!repoRes.ok) throw new Error(`リポジトリ「${settings.repo.trim()}」が見つからないか、トークンにこのリポジトリの権限がありません`);
      data = EMPTY(); sha = null; return 'missing';
    }
    if (res.status === 401 || res.status === 403) throw new Error('トークンが無効か、権限が足りません');
    if (!res.ok) throw new Error(`読み込みに失敗しました（${res.status}）`);
    const j = await res.json();
    const parsed = normalize(JSON.parse(b64decode(j.content)));
    if (!parsed) throw new Error('記録データの形式が正しくありません');
    data = parsed; sha = j.sha;
    writeLS(LS_CACHE, { data, sha });
    return 'ok';
  }
  async function putRemote(d, message) {
    const res = await gh('PUT', {
      message,
      content: b64encode(JSON.stringify(d, null, 2) + '\n'),
      ...(sha ? { sha } : {}),
    });
    if (res.status === 409 || res.status === 422) throw Object.assign(new Error('conflict'), { conflict: true });
    if (!res.ok) throw new Error(`保存に失敗しました（${res.status}）`);
    const j = await res.json();
    sha = j.content.sha;
  }

  // 変更をその場で反映し、裏でGitHubに保存する。失敗したら元に戻す
  function commit(message, mutate) {
    if (!connected()) { toast('先に設定でGitHubとつないでください', 2600); openSettings(); return Promise.resolve(false); }
    const before = JSON.stringify(data);
    mutate(data);
    writeLS(LS_CACHE, { data, sha });
    render();
    const snapshot = JSON.parse(JSON.stringify(data));
    saveChain = saveChain.then(async () => {
      toast('保存しています…', 10000);
      try {
        await putRemote(snapshot, message);
        writeLS(LS_CACHE, { data, sha });
        toast('保存しました');
        return true;
      } catch (e) {
        data = JSON.parse(before);
        if (e.conflict) {
          try { await loadRemote(); } catch { /* 読み直しに失敗してもひとまず元に戻す */ }
          toast('別の端末で更新されていたため、最新を読み込みました。もう一度お願いします', 4200);
        } else {
          toast(e.message || '保存に失敗しました', 3600);
        }
        writeLS(LS_CACHE, { data, sha });
        render();
        return false;
      }
    });
    return saveChain;
  }

  // ---------- 地図 ----------
  const map = L.map('map', {
    zoomControl: false,
    worldCopyJump: true,
    minZoom: 1.5,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 90,
    attributionControl: true,
  });
  // OpenStreetMapの標準地図（無料・登録不要）。CSSでグレーに加工して淡く見せる
  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  map.attributionControl.setPrefix(false);
  const linesLayer = L.layerGroup().addTo(map);
  const pinsLayer = L.layerGroup().addTo(map);
  const markers = new Map(); // id -> marker

  function isWide() { return window.matchMedia('(min-width: 820px)').matches; }
  function viewPadding() {
    if (isWide()) return { paddingTopLeft: [416 + 40, 60], paddingBottomRight: [60, 60] };
    return { paddingTopLeft: [40, 130], paddingBottomRight: [40, sheet.offsetHeight + 30] };
  }
  function worldView() {
    const w = map.getSize().x - (isWide() ? 416 : 0);
    const zoom = Math.max(1.5, Math.min(3, Math.log2(w / 256) + 0.9));
    // 日本が少し右寄りに来る位置
    return { center: [isWide() ? 32 : 18, isWide() ? 95 : 115], zoom };
  }

  function pinIcon(kind, delay, active) {
    const c = (KINDS[kind] || KINDS.sightseeing).color;
    return L.divIcon({
      className: 'pin-wrap',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
      popupAnchor: [0, -10],
      html: `<span class="pin${active ? ' is-active' : ''}" style="--c:${c};--d:${delay}ms"></span>`,
    });
  }
  function popupHtml(p) {
    const k = KINDS[p.kind] || KINDS.sightseeing;
    return `<div class="popup-kind" style="color:${k.color}">${k.label}</div><div class="popup-name">${esc(p.name)}</div>`;
  }

  function addPin(p, trip, delay) {
    const m = L.marker([p.lat, p.lng], { icon: pinIcon(p.kind, delay), keyboard: false, riseOnHover: true })
      .bindPopup(popupHtml(p), { className: 'travel-popup', closeButton: false, autoPan: false, offset: [0, -2] })
      .addTo(pinsLayer);
    m.on('click', () => {
      if (!selectedId) { selectTrip(trip.id); return; }
      setActive(p.id, { fly: false });
    });
    markers.set(p.id, m);
  }

  // 飛行機は緩やかな弧にする
  function arc(a, b) {
    const pts = [];
    const dx = b.lng - a.lng, dy = b.lat - a.lat;
    const len = Math.hypot(dx, dy);
    const bend = Math.min(0.18 * len, 25);
    const mx = (a.lng + b.lng) / 2 - (dy / (len || 1)) * bend;
    const my = (a.lat + b.lat) / 2 + (dx / (len || 1)) * bend;
    for (let i = 0; i <= 48; i++) {
      const t = i / 48, u = 1 - t;
      pts.push([u * u * a.lat + 2 * u * t * my + t * t * b.lat, u * u * a.lng + 2 * u * t * mx + t * t * b.lng]);
    }
    return pts;
  }

  // 実線は「描かれていく」ように、点線はふわっと表示する
  function animateLine(line, delay = 0) {
    const el = line.getElement && line.getElement();
    if (!el) return;
    if (line.options.dashArray) {
      el.classList.add('route-fade');
      el.style.animationDelay = `${delay}ms`;
      return;
    }
    const len = el.getTotalLength ? el.getTotalLength() : 0;
    if (!len) return;
    el.style.strokeDasharray = `${len}`;
    el.style.strokeDashoffset = `${len}`;
    el.getBoundingClientRect();
    el.style.transition = `stroke-dashoffset ${Math.min(2200, 700 + len * 1.2)}ms cubic-bezier(.45,.05,.25,1) ${delay}ms`;
    el.style.strokeDashoffset = '0';
    const done = () => { el.style.strokeDasharray = ''; el.style.strokeDashoffset = ''; el.style.transition = ''; };
    el.addEventListener('transitionend', done, { once: true });
    map.once('zoomstart', done);
  }

  function clearMap() {
    map.closePopup();
    pinsLayer.clearLayers();
    linesLayer.clearLayers();
    markers.clear();
  }

  // 世界表示：同じ旅行で近い場所（約50km四方）は1つのピンにまとめる
  function drawWorld() {
    clearMap();
    let i = 0;
    for (const t of data.trips) {
      const groups = new Map();
      for (const p of t.places) {
        if (!hasLoc(p)) continue;
        const key = `${Math.round(p.lat * 2)},${Math.round(p.lng * 2)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      }
      for (const ps of groups.values()) {
        const lat = ps.reduce((s, p) => s + p.lat, 0) / ps.length;
        const lng = ps.reduce((s, p) => s + p.lng, 0) / ps.length;
        const m = L.marker([lat, lng], { icon: pinIcon('sightseeing', Math.min(1400, i++ * 60)), keyboard: false })
          .bindPopup(`<div class="popup-kind">${esc(fmtDate(t.start))}</div><div class="popup-name">${esc(t.name)}</div>`,
            { className: 'travel-popup', closeButton: false, autoPan: false, offset: [0, -2] })
          .addTo(pinsLayer);
        m.on('click', () => selectTrip(t.id));
      }
    }
  }

  function drawTrip(t) {
    clearMap();
    const places = orderedPlaces(t).filter(hasLoc);
    // 訪れた順に直線でつなぐ
    if (places.length > 1) {
      const route = L.polyline(places.map(p => [p.lat, p.lng]), {
        color: LINE_COLOR, opacity: 0.8, weight: 1.8, lineCap: 'round', lineJoin: 'round', interactive: false, className: 'route',
      }).addTo(linesLayer);
      animateLine(route, 150);
    }
    t.moves.forEach((m, i) => {
      if (!hasLoc(m.from) || !hasLoc(m.to)) return;
      const md = MODES[m.mode] || MODES.other;
      const pts = md.curve ? arc(m.from, m.to) : [[m.from.lat, m.from.lng], [m.to.lat, m.to.lng]];
      const line = L.polyline(pts, {
        color: LINE_COLOR, opacity: 0.95, weight: md.weight + 0.8, dashArray: md.dash, lineCap: 'round', interactive: false, className: 'route',
      }).addTo(linesLayer);
      animateLine(line, 300 + i * 120);
    });
    places.forEach((p, i) => addPin(p, t, 80 + i * 70));
    if (activeItemId) highlightPin(activeItemId);
  }

  function tripBounds(t) {
    const pts = t.places.filter(hasLoc).map(p => [p.lat, p.lng]);
    if (!pts.length) t.moves.forEach(m => { if (hasLoc(m.from)) pts.push([m.from.lat, m.from.lng]); if (hasLoc(m.to)) pts.push([m.to.lat, m.to.lng]); });
    return pts.length ? L.latLngBounds(pts) : null;
  }

  // 地図を動かし終えてから、ピンと線を描く
  function flyThen(fn, flyFn) {
    let done = false;
    const run = () => { if (done) return; done = true; fn(); };
    map.once('moveend', run);
    flyFn();
    setTimeout(run, 2600);
  }

  function showTripOnMap(t) {
    const b = tripBounds(t);
    clearMap();
    if (!b) { drawTrip(t); return; }
    const pad = viewPadding();
    flyThen(() => drawTrip(t), () => map.flyToBounds(b, { ...pad, maxZoom: 15, duration: 1.5, easeLinearity: 0.15 }));
  }

  function showWorldOnMap(animate = true) {
    const v = worldView();
    clearMap();
    if (!animate) { map.setView(v.center, v.zoom, { animate: false }); drawWorld(); return; }
    flyThen(drawWorld, () => map.flyTo(v.center, v.zoom, { duration: 1.5, easeLinearity: 0.15 }));
  }

  function highlightPin(id) {
    markers.forEach((m, mid) => {
      const el = m.getElement && m.getElement();
      const pin = el && el.querySelector('.pin');
      if (pin) { pin.style.animation = 'none'; pin.classList.toggle('is-active', mid === id); }
    });
  }

  // ---------- 選択 ----------
  function selectTrip(id) {
    selectedId = id;
    activeItemId = null;
    const t = data.trips.find(x => x.id === id);
    if (!t) { selectedId = null; renderSheet(); showWorldOnMap(); return; }
    renderSheet();
    sheetBody.scrollTop = 0;
    showTripOnMap(t);
  }
  function backToAll() {
    selectedId = null;
    activeItemId = null;
    renderSheet();
    sheetBody.scrollTop = 0;
    showWorldOnMap();
  }
  function setActive(id, { fly = true } = {}) {
    activeItemId = id;
    document.querySelectorAll('.tl-item').forEach(el => el.classList.toggle('is-active', el.dataset.id === id));
    const t = data.trips.find(x => x.id === selectedId);
    if (!t) return;
    const p = t.places.find(x => x.id === id);
    const mv = t.moves.find(x => x.id === id);
    highlightPin(id);
    if (p && hasLoc(p)) {
      const m = markers.get(p.id);
      if (fly) {
        map.flyTo([p.lat, p.lng], Math.max(map.getZoom(), 15), { duration: 1.1, easeLinearity: 0.2 });
        map.once('moveend', () => m && m.openPopup());
      } else if (m) m.openPopup();
      const row = sheetBody.querySelector(`.tl-item[data-id="${id}"]`);
      if (row && !fly) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else if (mv && hasLoc(mv.from) && hasLoc(mv.to)) {
      map.closePopup();
      map.flyToBounds(L.latLngBounds([[mv.from.lat, mv.from.lng], [mv.to.lat, mv.to.lng]]), { ...viewPadding(), duration: 1.3, easeLinearity: 0.2 });
    }
  }

  // ---------- 一覧・詳細 ----------
  function renderStats() {
    const trips = data.trips.length;
    const places = data.trips.reduce((s, t) => s + t.places.length, 0);
    $('#stats').textContent = `${trips} trips · ${places} places`;
  }

  function renderList() {
    const trips = [...data.trips].sort((a, b) => (b.start || '').localeCompare(a.start || ''));
    const rows = trips.map((t, i) => {
      const c = tripCost(t);
      const meta = [fmtRange(t.start, t.end).slice(5) || '', nightsLabel(t), t.companions ? `同行 ${esc(t.companions)}` : ''].filter(Boolean).join(' · ');
      return `<li class="trip-row" data-id="${esc(t.id)}" style="--d:${i * 45}ms">
        <div class="trip-year">${esc((t.start || '').slice(0, 4))}</div>
        <div><h3 class="trip-name">${esc(t.name)}</h3><p class="trip-meta">${meta}</p></div>
        <div class="trip-cost">${c == null ? '<small>費用未記入</small>' : yen(c)}</div>
      </li>`;
    }).join('');
    const empty = !connected() && !trips.length
      ? `<p class="empty">右上の設定から、記録データを置いたGitHubリポジトリとつないでください。<br>つなぐと、行った場所が地図に並びます。</p>`
      : !trips.length ? `<p class="empty">まだ旅行がありません。下のボタンから追加できます。</p>` : '';
    return `<div class="view">
      <p class="section-label">All trips</p>
      ${empty}
      <ul class="trip-list">${rows}</ul>
      <div class="actions">
        ${connected() ? '<button class="btn" data-act="add-trip" type="button">＋ 旅行を追加</button>' : '<button class="btn btn-primary" data-act="settings" type="button">GitHubとつなぐ</button>'}
      </div>
    </div>`;
  }

  function renderTrip(t) {
    const c = tripCost(t);
    const n = nights(t);
    let lastDay = '';
    const items = timeline(t).map((x, i) => {
      const it = x.item;
      const day = (it.datetime || '').slice(0, 10);
      let dayLabel = '';
      if (day && day !== lastDay) {
        lastDay = day;
        const idx = t.start ? Math.round((Date.parse(day) - Date.parse(t.start)) / 864e5) + 1 : null;
        dayLabel = `<li class="day-label">${idx && idx > 0 ? `DAY ${idx} · ` : ''}${fmtDate(day)}</li>`;
      }
      const cost = Number.isFinite(it.cost) ? `<span class="tl-cost">${yen(it.cost)}</span>` : '';
      const memo = it.memo ? `<p class="tl-memo">${esc(it.memo)}</p>` : '';
      if (x.type === 'place') {
        const k = KINDS[it.kind] || KINDS.sightseeing;
        return `${dayLabel}<li class="tl-item${activeItemId === it.id ? ' is-active' : ''}" data-id="${esc(it.id)}" style="--c:${k.color};--d:${i * 40}ms">
          <span class="tl-dot"></span>
          <div>
            <div class="tl-time">${timeOf(it.datetime)}${timeOf(it.datetime) ? ' · ' : ''}<span class="kind-tag">${k.label}</span>${hasLoc(it) ? '' : ' · 位置未設定'}</div>
            <p class="tl-name">${esc(it.name)}</p>${memo}
          </div>
          <div class="tl-side">${cost}<button class="edit-link" data-act="edit-place" data-id="${esc(it.id)}" type="button">編集</button></div>
        </li>`;
      }
      const md = MODES[it.mode] || MODES.other;
      return `${dayLabel}<li class="tl-item tl-move${activeItemId === it.id ? ' is-active' : ''}" data-id="${esc(it.id)}" style="--d:${i * 40}ms">
        <span class="tl-dot"></span>
        <div>
          <div class="tl-time">${timeOf(it.datetime)}${timeOf(it.datetime) ? ' · ' : ''}${md.label}${it.number ? ` · ${esc(it.number)}` : ''}</div>
          <p class="tl-name">${esc(it.from?.name || '？')} → ${esc(it.to?.name || '？')}</p>${memo}
        </div>
        <div class="tl-side">${cost}<button class="edit-link" data-act="edit-move" data-id="${esc(it.id)}" type="button">編集</button></div>
      </li>`;
    }).join('');
    return `<div class="view">
      <button class="back" data-act="back" type="button">← すべての旅行</button>
      <div class="trip-head">
        <h2>${esc(t.name)}</h2>
        <p class="dates">${fmtRange(t.start, t.end)}${t.companions ? ` · 同行 ${esc(t.companions)}` : ''}</p>
      </div>
      <div class="figures">
        <div class="figure"><b>${n == null ? '—' : n === 0 ? '日帰り' : n}</b><span>${n ? 'NIGHTS' : ''}</span></div>
        <div class="figure"><b>${t.places.length}</b><span>PLACES</span></div>
        <div class="figure"><b>${c == null ? '—' : yen(c)}</b><span>TOTAL</span></div>
      </div>
      ${t.memo ? `<p class="trip-memo">${esc(t.memo)}</p>` : ''}
      <ul class="timeline">${items || '<li class="empty">まだ場所がありません。</li>'}</ul>
      <div class="actions">
        <button class="btn" data-act="add-place" type="button">＋ 場所</button>
        <button class="btn" data-act="add-move" type="button">＋ 移動</button>
        <button class="btn btn-ghost" data-act="edit-trip" type="button">旅行を編集</button>
      </div>
    </div>`;
  }

  function renderSheet() {
    const t = selectedId && data.trips.find(x => x.id === selectedId);
    if (selectedId && !t) selectedId = null;
    sheetBody.innerHTML = t ? renderTrip(t) : renderList();
    renderStats();
  }

  // データが変わったとき：シートと地図を描き直す（地図は動かさない）
  function render() {
    renderSheet();
    const t = selectedId && data.trips.find(x => x.id === selectedId);
    if (t) drawTrip(t); else drawWorld();
  }

  sheetBody.addEventListener('click', e => {
    const actEl = e.target.closest('[data-act]');
    if (actEl) {
      e.stopPropagation();
      const act = actEl.dataset.act;
      const t = data.trips.find(x => x.id === selectedId);
      if (act === 'back') backToAll();
      else if (act === 'settings') openSettings();
      else if (act === 'add-trip') openTripForm(null);
      else if (act === 'edit-trip') openTripForm(t);
      else if (act === 'add-place') openPlaceForm(t, null);
      else if (act === 'edit-place') openPlaceForm(t, t.places.find(x => x.id === actEl.dataset.id));
      else if (act === 'add-move') openMoveForm(t, null);
      else if (act === 'edit-move') openMoveForm(t, t.moves.find(x => x.id === actEl.dataset.id));
      return;
    }
    const row = e.target.closest('.trip-row');
    if (row) { selectTrip(row.dataset.id); return; }
    const item = e.target.closest('.tl-item');
    if (item) setActive(item.dataset.id);
  });

  $('#grabber').addEventListener('click', () => {
    sheet.classList.toggle('expanded');
  });
  $('#settings-btn').addEventListener('click', () => openSettings());

  // ---------- モーダル・フォーム ----------
  const modal = $('#modal');
  const form = $('#form');
  let formState = null; // { kind, draft, onSubmit, onDelete }

  function openModal() {
    modal.hidden = false;
    modal.classList.remove('closing');
  }
  function closeModal() {
    return new Promise(res => {
      modal.classList.add('closing');
      setTimeout(() => { modal.hidden = true; modal.classList.remove('closing'); res(); }, 280);
    });
  }
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  function confirmDialog(text) {
    return new Promise(res => {
      const ov = $('#confirm');
      $('#confirm-text').textContent = text;
      ov.hidden = false;
      const finish = v => {
        ov.classList.add('closing');
        setTimeout(() => { ov.hidden = true; ov.classList.remove('closing'); }, 280);
        $('#confirm-yes').onclick = $('#confirm-no').onclick = null;
        res(v);
      };
      $('#confirm-yes').onclick = () => finish(true);
      $('#confirm-no').onclick = () => finish(false);
    });
  }

  function chips(name, options, value) {
    return `<div class="chips">${Object.entries(options).map(([k, o]) => `
      <label class="chip"><input type="radio" name="${name}" value="${k}"${k === value ? ' checked' : ''}><span>${o.color ? `<i style="--c:${o.color}"></i>` : ''}${o.label}</span></label>`).join('')}</div>`;
  }
  function locBlock(key, label, loc) {
    const set = hasLoc(loc);
    return `<div class="field-label">${label}</div>
      <div class="loc" data-key="${key}">
        <div class="loc-row">
          <input class="loc-q" type="search" placeholder="名前や住所で検索" enterkeyhint="search">
          <button type="button" class="btn" data-loc="search">検索</button>
          <button type="button" class="btn" data-loc="pick">地図で</button>
        </div>
        <p class="loc-val${set ? '' : ' unset'}">${set ? `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}` : '位置は未設定です'}</p>
        <ul class="loc-results"></ul>
      </div>`;
  }
  function actionsHtml(canDelete) {
    return `<div class="form-actions">
      ${canDelete ? '<button type="button" class="btn-text-danger" data-form="delete">削除</button>' : ''}
      <div class="right">
        <button type="button" class="btn btn-ghost" data-form="cancel">やめる</button>
        <button type="submit" class="btn btn-primary">保存</button>
      </div>
    </div>`;
  }

  // フォームの入力内容を下書きに書き戻す（地図で位置を選ぶ前など）
  function collect() {
    const fd = new FormData(form);
    for (const [k, v] of fd.entries()) formState.draft[k] = v;
  }

  function renderForm() {
    form.innerHTML = formState.html(formState.draft);
    const first = form.querySelector('input:not([type=radio]):not([type=search])');
    if (first && formState.focus) { formState.focus = false; setTimeout(() => first.focus({ preventScroll: true }), 350); }
  }

  form.addEventListener('click', async e => {
    const b = e.target.closest('[data-form],[data-loc]');
    if (b && b.dataset.form === 'cancel') { closeModal(); return; }
    if (b && b.dataset.form === 'delete') {
      if (await confirmDialog(formState.deleteText)) { await closeModal(); formState.onDelete(); }
      return;
    }
    if (b && b.dataset.loc) {
      const box = b.closest('.loc');
      const key = box.dataset.key;
      if (b.dataset.loc === 'search') searchPlace(box, key);
      if (b.dataset.loc === 'pick') { collect(); pickOnMap(key); }
      return;
    }
    const li = e.target.closest('.loc-results li');
    if (li) {
      const box = li.closest('.loc');
      const key = box.dataset.key;
      collect();
      const r = JSON.parse(li.dataset.r);
      formState.draft[`${key}Lat`] = r.lat;
      formState.draft[`${key}Lng`] = r.lng;
      const nameField = key === 'loc' ? 'name' : `${key}Name`;
      if (!String(formState.draft[nameField] || '').trim()) formState.draft[nameField] = r.name;
      renderForm();
    }
  });
  form.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.classList.contains('loc-q')) {
      e.preventDefault();
      const box = e.target.closest('.loc');
      searchPlace(box, box.dataset.key);
    }
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    collect();
    const err = formState.validate ? formState.validate(formState.draft) : '';
    if (err) { toast(err, 2400); return; }
    const d = formState.draft;
    await closeModal();
    formState.onSubmit(d);
  });

  // OpenStreetMapの検索（Nominatim）。無料・登録不要。連打しない
  async function searchPlace(box, key) {
    const input = box.querySelector('.loc-q');
    const nameField = key === 'loc' ? 'name' : `${key}Name`;
    const q = input.value.trim() || String(form.elements[nameField]?.value || '').trim();
    const ul = box.querySelector('.loc-results');
    if (!q) { toast('検索する名前を入れてください'); return; }
    ul.innerHTML = '<li>探しています…</li>';
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=ja&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      const list = await res.json();
      if (!list.length) { ul.innerHTML = '<li>見つかりませんでした。「地図で」から選べます</li>'; return; }
      ul.innerHTML = list.map(r => {
        const name = r.name || r.display_name.split(',')[0];
        const payload = esc(JSON.stringify({ lat: +r.lat, lng: +r.lon, name }));
        return `<li data-r="${payload}">${esc(name)}<small>${esc(r.display_name)}</small></li>`;
      }).join('');
    } catch {
      ul.innerHTML = '<li>検索できませんでした。「地図で」から選べます</li>';
    }
  }

  // 地図を動かして中心の位置を選ぶ
  async function pickOnMap(key) {
    await closeModal();
    const lat = Number(formState.draft[`${key}Lat`]), lng = Number(formState.draft[`${key}Lng`]);
    document.body.classList.add('picking');
    $('#picker').hidden = false;
    map.closePopup();
    if (Number.isFinite(lat) && Number.isFinite(lng) && formState.draft[`${key}Lat`] !== '') {
      map.flyTo([lat, lng], Math.max(map.getZoom(), 15), { duration: 1 });
    }
    const finish = ok => {
      if (ok) {
        // 十字の位置（画面の42%の高さ）にある地点を取る
        const size = map.getSize();
        const ll = map.containerPointToLatLng([size.x / 2, size.y * 0.42]);
        formState.draft[`${key}Lat`] = +ll.lat.toFixed(6);
        formState.draft[`${key}Lng`] = +L.Util.wrapNum(ll.lng, [-180, 180], true).toFixed(6);
      }
      $('#picker').hidden = true;
      document.body.classList.remove('picking');
      $('#picker-ok').onclick = $('#picker-cancel').onclick = null;
      renderForm();
      openModal();
    };
    $('#picker-ok').onclick = () => finish(true);
    $('#picker-cancel').onclick = () => finish(false);
  }

  function locFrom(d, key) {
    const lat = num(d[`${key}Lat`]), lng = num(d[`${key}Lng`]);
    return lat != null && lng != null ? { lat, lng } : {};
  }

  // --- 旅行 ---
  function openTripForm(t) {
    formState = {
      focus: !t,
      draft: t ? { name: t.name, start: t.start || '', end: t.end || '', companions: t.companions || '', memo: t.memo || '' }
               : { name: '', start: '', end: '', companions: '', memo: '' },
      html: d => `<h3 class="form-title">${t ? '旅行を編集' : '旅行を追加'}</h3>
        <label class="field"><span>旅行名</span><input name="name" value="${esc(d.name)}" placeholder="例：金沢" autocomplete="off"></label>
        <div class="field-row">
          <label class="field"><span>出発日</span><input type="date" name="start" value="${esc(d.start)}"></label>
          <label class="field"><span>帰着日</span><input type="date" name="end" value="${esc(d.end)}"></label>
        </div>
        <label class="field"><span>同行者</span><input name="companions" value="${esc(d.companions)}" placeholder="例：妻" autocomplete="off"></label>
        <label class="field"><span>メモ</span><textarea name="memo" rows="3">${esc(d.memo)}</textarea></label>
        <p class="field-hint">合計費用は、場所と移動の費用から自動で計算します。</p>
        ${actionsHtml(!!t)}`,
      validate: d => !String(d.name).trim() ? '旅行名を入れてください' : (d.start && d.end && d.end < d.start ? '帰着日が出発日より前です' : ''),
      onSubmit: d => {
        const vals = { name: d.name.trim(), start: d.start, end: d.end || d.start, companions: d.companions.trim(), memo: d.memo.trim() };
        if (t) {
          commit(`旅行記録：「${vals.name}」を更新`, data => Object.assign(data.trips.find(x => x.id === t.id), vals));
        } else {
          const id = uid();
          commit(`旅行記録：「${vals.name}」を追加`, data => data.trips.push({ id, ...vals, places: [], moves: [] }));
          selectTrip(id);
        }
      },
      deleteText: t ? `「${t.name}」と、その中の場所・移動をすべて削除します。よろしいですか？（GitHubの履歴から戻せます）` : '',
      onDelete: () => {
        selectedId = null;
        commit(`旅行記録：「${t.name}」を削除`, data => { data.trips = data.trips.filter(x => x.id !== t.id); });
        showWorldOnMap();
      },
    };
    renderForm();
    openModal();
  }

  // --- 場所 ---
  function openPlaceForm(t, p) {
    const def = t.start ? `${t.start}T12:00` : '';
    formState = {
      focus: !p,
      draft: p ? { name: p.name, kind: p.kind || 'sightseeing', datetime: p.datetime || '', cost: p.cost ?? '', memo: p.memo || '', locLat: p.lat ?? '', locLng: p.lng ?? '' }
               : { name: '', kind: 'sightseeing', datetime: def, cost: '', memo: '', locLat: '', locLng: '' },
      html: d => `<h3 class="form-title">${p ? '場所を編集' : '場所を追加'}</h3>
        <label class="field"><span>名前</span><input name="name" value="${esc(d.name)}" placeholder="例：ひがし茶屋街" autocomplete="off"></label>
        <div class="field"><span>種類</span>${chips('kind', KINDS, d.kind)}</div>
        ${locBlock('loc', '位置', { lat: num(d.locLat) ?? NaN, lng: num(d.locLng) ?? NaN })}
        <input type="hidden" name="locLat" value="${esc(d.locLat)}"><input type="hidden" name="locLng" value="${esc(d.locLng)}">
        <div class="field-row">
          <label class="field"><span>日時</span><input type="datetime-local" name="datetime" value="${esc(d.datetime)}"></label>
          <label class="field"><span>費用（円）</span><input name="cost" inputmode="numeric" value="${esc(d.cost)}" placeholder="0"></label>
        </div>
        <label class="field"><span>メモ</span><textarea name="memo" rows="3">${esc(d.memo)}</textarea></label>
        ${actionsHtml(!!p)}`,
      validate: d => !String(d.name).trim() ? '名前を入れてください' : (String(d.cost).trim() && num(d.cost) == null ? '費用は数字で入れてください' : ''),
      onSubmit: d => {
        const vals = { name: d.name.trim(), kind: d.kind || 'sightseeing', datetime: d.datetime || '', cost: num(d.cost), memo: d.memo.trim(), ...locFrom(d, 'loc') };
        if (!hasLoc(vals)) { delete vals.lat; delete vals.lng; }
        if (p) {
          commit(`旅行記録：${t.name}の「${vals.name}」を更新`, data => {
            const target = data.trips.find(x => x.id === t.id).places.find(x => x.id === p.id);
            delete target.lat; delete target.lng;
            Object.assign(target, vals);
          });
        } else {
          const id = uid();
          activeItemId = id;
          commit(`旅行記録：${t.name}に「${vals.name}」を追加`, data => data.trips.find(x => x.id === t.id).places.push({ id, ...vals }));
        }
      },
      deleteText: p ? `「${p.name}」を削除します。よろしいですか？` : '',
      onDelete: () => commit(`旅行記録：${t.name}の「${p.name}」を削除`, data => {
        const tr = data.trips.find(x => x.id === t.id);
        tr.places = tr.places.filter(x => x.id !== p.id);
      }),
    };
    renderForm();
    openModal();
  }

  // --- 移動 ---
  function openMoveForm(t, m) {
    const def = t.start ? `${t.start}T09:00` : '';
    formState = {
      focus: false,
      draft: m ? {
        mode: m.mode || 'train', number: m.number || '', datetime: m.datetime || '', cost: m.cost ?? '', memo: m.memo || '',
        fromName: m.from?.name || '', fromLat: m.from?.lat ?? '', fromLng: m.from?.lng ?? '',
        toName: m.to?.name || '', toLat: m.to?.lat ?? '', toLng: m.to?.lng ?? '',
      } : { mode: 'shinkansen', number: '', datetime: def, cost: '', memo: '', fromName: '', fromLat: '', fromLng: '', toName: '', toLat: '', toLng: '' },
      html: d => `<h3 class="form-title">${m ? '移動を編集' : '移動を追加'}</h3>
        <div class="field"><span>手段</span>${chips('mode', MODES, d.mode)}</div>
        <label class="field"><span>出発地</span><input name="fromName" value="${esc(d.fromName)}" placeholder="例：東京駅" autocomplete="off"></label>
        ${locBlock('from', '出発地の位置', { lat: num(d.fromLat) ?? NaN, lng: num(d.fromLng) ?? NaN })}
        <label class="field"><span>到着地</span><input name="toName" value="${esc(d.toName)}" placeholder="例：金沢駅" autocomplete="off"></label>
        ${locBlock('to', '到着地の位置', { lat: num(d.toLat) ?? NaN, lng: num(d.toLng) ?? NaN })}
        <input type="hidden" name="fromLat" value="${esc(d.fromLat)}"><input type="hidden" name="fromLng" value="${esc(d.fromLng)}">
        <input type="hidden" name="toLat" value="${esc(d.toLat)}"><input type="hidden" name="toLng" value="${esc(d.toLng)}">
        <div class="field-row">
          <label class="field"><span>出発日時</span><input type="datetime-local" name="datetime" value="${esc(d.datetime)}"></label>
          <label class="field"><span>便名</span><input name="number" value="${esc(d.number)}" placeholder="例：はくたか557号" autocomplete="off"></label>
        </div>
        <label class="field"><span>費用（円）</span><input name="cost" inputmode="numeric" value="${esc(d.cost)}" placeholder="0"></label>
        <label class="field"><span>メモ</span><textarea name="memo" rows="2">${esc(d.memo)}</textarea></label>
        ${actionsHtml(!!m)}`,
      validate: d => (!String(d.fromName).trim() || !String(d.toName).trim()) ? '出発地と到着地を入れてください'
        : (String(d.cost).trim() && num(d.cost) == null ? '費用は数字で入れてください' : ''),
      onSubmit: d => {
        const vals = {
          mode: d.mode || 'other', number: d.number.trim(), datetime: d.datetime || '', cost: num(d.cost), memo: d.memo.trim(),
          from: { name: d.fromName.trim(), ...locFrom(d, 'from') },
          to: { name: d.toName.trim(), ...locFrom(d, 'to') },
        };
        const label = `${vals.from.name}→${vals.to.name}`;
        if (m) {
          commit(`旅行記録：${t.name}の移動「${label}」を更新`, data => Object.assign(data.trips.find(x => x.id === t.id).moves.find(x => x.id === m.id), vals));
        } else {
          const id = uid();
          commit(`旅行記録：${t.name}に移動「${label}」を追加`, data => data.trips.find(x => x.id === t.id).moves.push({ id, ...vals }));
        }
      },
      deleteText: m ? `移動「${m.from?.name}→${m.to?.name}」を削除します。よろしいですか？` : '',
      onDelete: () => commit(`旅行記録：${t.name}の移動を削除`, data => {
        const tr = data.trips.find(x => x.id === t.id);
        tr.moves = tr.moves.filter(x => x.id !== m.id);
      }),
    };
    renderForm();
    openModal();
  }

  // --- 設定 ---
  function openSettings() {
    formState = {
      draft: { repo: settings.repo, path: settings.path || DEFAULT_PATH, token: settings.token },
      html: d => `<h3 class="form-title">設定</h3>
        <label class="field"><span>記録データのリポジトリ</span><input name="repo" value="${esc(d.repo)}" placeholder="持ち主名/リポジトリ名" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <label class="field"><span>ファイルの場所</span><input name="path" value="${esc(d.path)}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <label class="field"><span>GitHubアクセストークン</span><input name="token" type="password" value="${esc(d.token)}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <p class="field-hint">トークンはこの端末のブラウザの中だけに保存され、どこにも送られません（GitHubとの通信を除く）。端末ごとに一度だけ入力します。</p>
        <div class="form-actions">
          ${settings.token ? '<button type="button" class="btn-text-danger" data-form="delete">この端末から消す</button>' : ''}
          <div class="right">
            <button type="button" class="btn btn-ghost" data-form="cancel">やめる</button>
            <button type="submit" class="btn btn-primary">つなぐ</button>
          </div>
        </div>`,
      validate: d => !/^[\w.-]+\/[\w.-]+$/.test(String(d.repo).trim()) ? 'リポジトリは「持ち主名/リポジトリ名」の形で入れてください'
        : !String(d.token).trim() ? 'トークンを入れてください' : '',
      onSubmit: async d => {
        settings = { repo: d.repo.trim(), path: (d.path || DEFAULT_PATH).trim(), token: d.token.trim() };
        writeLS(LS_SETTINGS, settings);
        await refresh(true);
      },
      deleteText: 'この端末から、トークンと記録データの控えを消します。よろしいですか？（GitHub上のデータは消えません）',
      onDelete: () => {
        settings = { repo: '', path: DEFAULT_PATH, token: '' };
        try { localStorage.removeItem(LS_SETTINGS); localStorage.removeItem(LS_CACHE); } catch { /* 無視 */ }
        data = EMPTY(); sha = null; selectedId = null;
        render();
        toast('この端末から消しました');
      },
    };
    renderForm();
    openModal();
  }

  async function refresh(announce) {
    if (!connected()) return;
    const before = JSON.stringify(data);
    try {
      if (announce) toast('読み込んでいます…', 10000);
      const r = await loadRemote();
      if (r === 'missing') toast(`「${settings.path.trim()}」が見つかりません。ファイルの場所を確認してください（新しく始める場合は、旅行を追加すると作られます）`, 6000);
      else if (announce) toast('つながりました');
      if (JSON.stringify(data) !== before) render();
    } catch (e) {
      toast(e.message, 6000);
    }
  }

  // ---------- 起動 ----------
  function boot() {
    const v = worldView();
    map.setView(v.center, v.zoom, { animate: false });
    renderSheet();
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      document.body.classList.add('ready');
      setTimeout(drawWorld, 700);
    };
    tiles.once('load', start);
    setTimeout(start, 1500); // 通信が遅くても画面は出す
    refresh(false);
  }

  // iPad：画面の向きが変わったとき
  window.addEventListener('resize', () => map.invalidateSize());
  // アプリに戻ってきたら最新を読み込む（編集中は除く）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && modal.hidden) refresh(false);
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  boot();
})();
