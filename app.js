(() => {
  'use strict';

  const STORE_KEY = 'gymlog.v1';
  const TIMER_KEY = 'gymlog.timerEnd';
  const PRESETS = [60, 90, 120, 180];

  const $ = (sel, root = document) => root.querySelector(sel);
  const pad = (n) => String(n).padStart(2, '0');
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(c));
    }
    return el;
  }

  /* ---------- データ ---------- */
  const defaults = () => ({
    machines: [],
    sets: [],
    lastMachine: null,
    owner: null, // クラウドと同期した Firebase ユーザーID
    settings: { interval: 90, autoStart: true, step: 2.5 },
  });

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && Array.isArray(s.machines) && Array.isArray(s.sets)) {
        const d = defaults();
        const st = { ...d, ...s, settings: { ...d.settings, ...s.settings } };
        st.machines.forEach((m, i) => { if (!Number.isFinite(m.createdAt)) m.createdAt = i; });
        return st;
      }
    } catch (e) { /* 壊れていたら初期化 */ }
    return defaults();
  }

  let state = load();

  // cloud.js が読み込めなかった場合でも、ローカル保存だけで動くようにする
  const noop = () => {};
  const Cloud = window.GymCloud || {
    init: noop, signIn: noop, signOut: noop, signedIn: false,
    upsertMachine: noop, upsertSet: noop, removeSet: noop, removeMachineAndSets: noop, bulkUpsert: noop,
  };

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('保存できませんでした(ブラウザの保存領域を確認してください)');
    }
  }

  const machineById = (id) => state.machines.find((m) => m.id === id);
  const fmtW = (n) => (n === 0 ? '自重' : Number.isInteger(n) ? `${n}kg` : `${+n.toFixed(2)}kg`);
  const fmtSet = (s) => `${fmtW(s.weight)} × ${s.reps}`;

  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function dayLabel(key) {
    const [y, m, d] = key.split('-').map(Number);
    const w = '日月火水木金土'[new Date(y, m - 1, d).getDay()];
    return `${m}/${d}(${w})`;
  }
  const timeLabel = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  /* ---------- トースト ---------- */
  let toastTimer = 0;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  /* ---------- タブ ---------- */
  function showTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    if (name === 'history') renderHistory();
    if (name === 'admin') renderAdmin();
    if (name === 'record') renderRecord();
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.goto)));

  /* ---------- 記録 ---------- */
  let selId = null;

  function latestSet(mid) {
    let best = null;
    for (const s of state.sets) if (s.machineId === mid && (!best || s.ts > best.ts)) best = s;
    return best;
  }

  function lastSession(mid) {
    const today = dayKey(Date.now());
    const prev = state.sets.filter((s) => s.machineId === mid && dayKey(s.ts) !== today);
    if (!prev.length) return null;
    const key = dayKey(Math.max(...prev.map((s) => s.ts)));
    return { key, sets: prev.filter((s) => dayKey(s.ts) === key).sort((a, b) => a.ts - b.ts) };
  }

  function selectMachine(id, { prefill = true } = {}) {
    selId = id;
    state.lastMachine = id;
    save();
    if (prefill) {
      const last = latestSet(id);
      $('#weight').value = last ? last.weight : 20;
      $('#reps').value = last ? last.reps : 10;
    }
    renderRecord();
  }

  function renderRecord() {
    const has = state.machines.length > 0;
    $('#record-empty').hidden = has;
    $('#record-body').hidden = !has;
    if (!has) return;

    if (!machineById(selId)) {
      const want = machineById(state.lastMachine) ? state.lastMachine : state.machines[0].id;
      selId = want;
      const last = latestSet(want);
      $('#weight').value = last ? last.weight : 20;
      $('#reps').value = last ? last.reps : 10;
    }

    const chips = $('#machine-chips');
    chips.replaceChildren(...state.machines.map((m) =>
      h('button', {
        class: 'chip', type: 'button', role: 'radio',
        'aria-checked': String(m.id === selId),
        onclick: () => selectMachine(m.id),
      }, m.name)));

    const ls = lastSession(selId);
    const lastBox = $('#last-session');
    lastBox.replaceChildren(
      ls
        ? h('div', {}, '前回 ', h('strong', {}, dayLabel(ls.key)), h('div', { class: 'sets' }, ls.sets.map(fmtSet).join(' / ')))
        : h('div', {}, 'このマシンの前回の記録はまだありません'));

    const today = dayKey(Date.now());
    const todays = state.sets.filter((s) => s.machineId === selId && dayKey(s.ts) === today).sort((a, b) => a.ts - b.ts);
    const box = $('#today-sets');
    if (!todays.length) {
      box.replaceChildren(h('div', { class: 'none' }, '今日はまだ記録がありません'));
    } else {
      box.replaceChildren(...todays.map((s, i) => h('div', { class: 'row' },
        h('span', { class: 'num' }, String(i + 1)),
        h('span', { class: 'grow val' }, fmtSet(s)),
        h('span', { class: 'time' }, timeLabel(s.ts)),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'このセットを削除', onclick: () => deleteSet(s.id) }, '✕'))));
    }
  }

  function deleteSet(id) {
    if (!confirm('このセットを削除しますか?')) return;
    state.sets = state.sets.filter((s) => s.id !== id);
    save();
    Cloud.removeSet(id);
    renderRecord();
    renderHistory();
  }

  document.querySelectorAll('.step').forEach((b) => b.addEventListener('click', () => {
    const input = $(`#${b.dataset.target}`);
    const dir = Number(b.dataset.dir);
    const step = b.dataset.target === 'weight' ? Number(state.settings.step) || 2.5 : 1;
    const min = b.dataset.target === 'weight' ? 0 : 1;
    const cur = parseFloat(input.value);
    const next = Math.max(min, Math.round(((Number.isNaN(cur) ? 0 : cur) + dir * step) * 100) / 100);
    input.value = next;
  }));

  $('#add-set').addEventListener('click', () => {
    const weight = parseFloat($('#weight').value);
    const reps = parseInt($('#reps').value, 10);
    if (!machineById(selId)) return toast('マシンを選んでください');
    if (!(weight >= 0) || !(reps > 0)) return toast('重量と回数を入力してください');
    const set = { id: uid(), machineId: selId, weight, reps, ts: Date.now() };
    state.sets.push(set);
    save();
    Cloud.upsertSet(set);
    renderRecord();
    if (state.settings.autoStart) startTimer();
    toast(`記録しました: ${fmtW(weight)} × ${reps}`);
  });

  /* ---------- 履歴 ---------- */
  function renderHistory() {
    const root = $('#history-list');
    if (!state.sets.length) {
      root.replaceChildren(h('div', { class: 'empty' }, 'まだ記録がありません'));
      return;
    }
    const days = new Map();
    for (const s of [...state.sets].sort((a, b) => a.ts - b.ts)) {
      const k = dayKey(s.ts);
      if (!days.has(k)) days.set(k, new Map());
      const byMachine = days.get(k);
      if (!byMachine.has(s.machineId)) byMachine.set(s.machineId, []);
      byMachine.get(s.machineId).push(s);
    }
    const out = [];
    for (const k of [...days.keys()].sort().reverse()) {
      const dayEl = h('div', { class: 'day' }, h('h3', {}, dayLabel(k)));
      for (const [mid, sets] of days.get(k)) {
        dayEl.append(h('div', { class: 'card' },
          h('div', { class: 'mname' }, machineById(mid)?.name ?? '(削除済みのマシン)'),
          ...sets.map((s, i) => h('div', { class: 'row' },
            h('span', { class: 'num' }, String(i + 1)),
            h('span', { class: 'grow val' }, fmtSet(s)),
            h('span', { class: 'time' }, timeLabel(s.ts)),
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'このセットを削除', onclick: () => deleteSet(s.id) }, '✕')))));
      }
      out.push(dayEl);
    }
    root.replaceChildren(...out);
  }

  /* ---------- 管理 ---------- */
  function renderAdmin() {
    const list = $('#machine-list');
    if (!state.machines.length) {
      list.replaceChildren(h('div', { class: 'none' }, 'マシンを追加してください'));
    } else {
      list.replaceChildren(...state.machines.map((m) => h('div', { class: 'row' },
        h('span', { class: 'grow' }, m.name),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': `${m.name}の名前を変更`, onclick: () => renameMachine(m.id) }, '✎'),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': `${m.name}を削除`, onclick: () => deleteMachine(m.id) }, '✕'))));
    }
    $('#opt-auto').checked = !!state.settings.autoStart;
    $('#opt-step').value = String(state.settings.step);
    renderCloud();
  }

  $('#machine-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#machine-name');
    const name = input.value.trim();
    if (!name) return;
    if (state.machines.some((m) => m.name === name)) return toast('同じ名前のマシンがあります');
    const machine = { id: uid(), name, createdAt: Date.now() };
    state.machines.push(machine);
    save();
    Cloud.upsertMachine(machine);
    input.value = '';
    renderAdmin();
    toast(`追加しました: ${name}`);
  });

  function renameMachine(id) {
    const m = machineById(id);
    const name = (prompt('新しい名前', m.name) || '').trim();
    if (!name || name === m.name) return;
    if (state.machines.some((x) => x.id !== id && x.name === name)) return toast('同じ名前のマシンがあります');
    m.name = name;
    save();
    Cloud.upsertMachine(m);
    renderAdmin();
  }

  function deleteMachine(id) {
    const m = machineById(id);
    const n = state.sets.filter((s) => s.machineId === id).length;
    if (!confirm(`「${m.name}」を削除しますか?${n ? `\nこのマシンの記録 ${n} セットも削除されます。` : ''}`)) return;
    const setIds = state.sets.filter((s) => s.machineId === id).map((s) => s.id);
    state.machines = state.machines.filter((x) => x.id !== id);
    state.sets = state.sets.filter((s) => s.machineId !== id);
    if (selId === id) selId = null;
    save();
    Cloud.removeMachineAndSets(id, setIds);
    renderAdmin();
  }

  $('#opt-auto').addEventListener('change', (e) => { state.settings.autoStart = e.target.checked; save(); });
  $('#opt-step').addEventListener('change', (e) => { state.settings.step = Number(e.target.value); save(); });

  /* ---------- バックアップ / Claudeへの共有 ---------- */
  function buildSummaryText() {
    const lines = ['# Gym Log 記録'];
    const days = new Map();
    for (const s of [...state.sets].sort((a, b) => a.ts - b.ts)) {
      const k = dayKey(s.ts);
      if (!days.has(k)) days.set(k, new Map());
      const bm = days.get(k);
      if (!bm.has(s.machineId)) bm.set(s.machineId, []);
      bm.get(s.machineId).push(s);
    }
    for (const k of [...days.keys()].sort().reverse()) {
      lines.push('', `## ${k}`);
      for (const [mid, sets] of days.get(k)) {
        lines.push(`- ${machineById(mid)?.name ?? '(削除済み)'}: ${sets.map(fmtSet).join(', ')}`);
      }
    }
    return lines.join('\n');
  }

  $('#copy-btn').addEventListener('click', async () => {
    if (!state.sets.length) return toast('記録がまだありません');
    const text = buildSummaryText();
    try {
      await navigator.clipboard.writeText(text);
      toast('コピーしました。Claudeに貼り付けてください');
    } catch (e) {
      prompt('コピーして使ってください', text);
    }
  });

  $('#export-btn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `gymlog-${dayKey(Date.now())}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $('#import-btn').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const machines = (data.machines || []).filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string');
      const sets = (data.sets || []).filter((s) => s && typeof s.machineId === 'string'
        && Number.isFinite(s.weight) && Number.isFinite(s.reps) && Number.isFinite(s.ts));
      if (!machines.length && !sets.length) throw new Error('empty');
      const merge = Cloud.signedIn; // クラウド同期中は、他の端末の記録を消さないよう「追加」にする
      const msg = merge
        ? `マシン ${machines.length} 件、記録 ${sets.length} セットを追加します。\n同じIDの記録は上書きされます。よろしいですか?`
        : `マシン ${machines.length} 件、記録 ${sets.length} セットを読み込みます。\n今のデータは置き換えられます。よろしいですか?`;
      if (!confirm(msg)) return;
      const nm = machines.map((m, i) => ({ id: m.id, name: m.name, createdAt: Number.isFinite(m.createdAt) ? m.createdAt : i }));
      const ns = sets.map((s) => ({ id: typeof s.id === 'string' ? s.id : uid(), machineId: s.machineId, weight: s.weight, reps: s.reps, ts: s.ts }));
      if (merge) {
        const byId = (list, add) => [...new Map([...list, ...add].map((x) => [x.id, x])).values()];
        state.machines = byId(state.machines, nm).sort((a, b) => a.createdAt - b.createdAt);
        state.sets = byId(state.sets, ns);
        Cloud.bulkUpsert(nm, ns);
      } else {
        const d = defaults();
        state = {
          ...d,
          machines: nm,
          sets: ns,
          lastMachine: data.lastMachine ?? null,
          settings: { ...d.settings, ...(data.settings || {}) },
        };
      }
      selId = null;
      save();
      renderAdmin();
      renderRecord();
      toast('読み込みました');
    } catch (err) {
      toast('読み込めませんでした。ファイルを確認してください');
    }
  });

  /* ---------- タイマー ---------- */
  const T = { endAt: 0, doneAt: 0, tickId: 0, ctx: null, wake: null };
  try { T.endAt = Number(localStorage.getItem(TIMER_KEY)) || 0; } catch (e) { /* 無視 */ }

  const fmtTime = (sec) => `${Math.floor(sec / 60)}:${pad(sec % 60)}`;
  function persistTimer() {
    try { localStorage.setItem(TIMER_KEY, String(T.endAt)); } catch (e) { /* 無視 */ }
  }

  function unlockAudio() {
    try {
      T.ctx = T.ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (T.ctx.state === 'suspended') T.ctx.resume();
    } catch (e) { /* 音なしで続行 */ }
  }

  function beep() {
    if (navigator.vibrate) navigator.vibrate([250, 120, 250, 120, 500]);
    if (!T.ctx) return;
    const t0 = T.ctx.currentTime;
    [0, 0.25, 0.5].forEach((off, i) => {
      const osc = T.ctx.createOscillator();
      const gain = T.ctx.createGain();
      osc.frequency.value = i === 2 ? 1175 : 880;
      gain.gain.setValueAtTime(0.0001, t0 + off);
      gain.gain.exponentialRampToValueAtTime(0.4, t0 + off + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.2);
      osc.connect(gain).connect(T.ctx.destination);
      osc.start(t0 + off);
      osc.stop(t0 + off + 0.22);
    });
  }

  async function requestWake() {
    try {
      if (navigator.wakeLock && !T.wake) {
        T.wake = await navigator.wakeLock.request('screen');
        T.wake.addEventListener('release', () => { T.wake = null; });
      }
    } catch (e) { /* 非対応・拒否は無視 */ }
  }
  function releaseWake() {
    try { if (T.wake) T.wake.release(); } catch (e) { /* 無視 */ }
    T.wake = null;
  }

  function startTimer(secs = state.settings.interval) {
    unlockAudio();
    T.endAt = Date.now() + secs * 1000;
    T.doneAt = 0;
    persistTimer();
    requestWake();
    ensureTick();
    tick();
  }

  function stopTimer() {
    T.endAt = 0;
    T.doneAt = 0;
    persistTimer();
    releaseWake();
    clearInterval(T.tickId);
    T.tickId = 0;
    tick();
  }

  function ensureTick() {
    if (!T.tickId) T.tickId = setInterval(tick, 250);
  }

  function tick() {
    const el = $('#timer');
    let left = 0;
    if (T.endAt) {
      left = Math.ceil((T.endAt - Date.now()) / 1000);
      if (left <= 0) {
        T.endAt = 0;
        T.doneAt = Date.now();
        persistTimer();
        releaseWake();
        beep();
      }
    }
    const running = T.endAt > 0;
    const done = !running && T.doneAt && Date.now() - T.doneAt < 6000;
    if (!running && !done) {
      clearInterval(T.tickId);
      T.tickId = 0;
      T.doneAt = 0;
    } else {
      ensureTick();
    }
    el.classList.toggle('running', running);
    el.classList.toggle('done', !!done);
    el.classList.toggle('idle', !running && !done);
    $('#timer-time').textContent = running ? fmtTime(left) : done ? 'GO!' : fmtTime(state.settings.interval);
    $('#timer-label').textContent = running ? '休憩中' : done ? '休憩おわり' : 'インターバル';
    $('#timer-toggle').textContent = running ? 'リセット' : 'スタート';
    $('#timer-add').hidden = !running;
  }

  function renderPresets() {
    $('#presets').replaceChildren(...PRESETS.map((sec) => h('button', {
      class: 'preset', type: 'button', role: 'radio',
      'aria-checked': String(sec === state.settings.interval),
      onclick: () => {
        state.settings.interval = sec;
        save();
        renderPresets();
        if (T.endAt) startTimer(sec); else tick();
      },
    }, sec >= 60 && sec % 60 === 0 ? `${sec / 60}分` : `${sec}秒`)));
  }

  $('#timer-toggle').addEventListener('click', () => (T.endAt ? stopTimer() : startTimer()));
  $('#timer-add').addEventListener('click', () => {
    if (!T.endAt) return;
    T.endAt += 30000;
    persistTimer();
    tick();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && T.endAt) {
      requestWake();
      tick();
    }
  });

  /* ---------- クラウド同期 ---------- */
  let cloudStatus = { phase: 'loading', email: '', pending: false };
  let lastErrorAt = 0;

  function renderCloud() {
    const box = $('#cloud-card');
    const { phase, email, pending } = cloudStatus;
    const note = (t) => h('p', { class: 'muted' }, t);
    let body;
    if (phase === 'loading') {
      body = [note('クラウド機能を準備しています…')];
    } else if (phase === 'unavailable') {
      body = [note('クラウドに接続できません。電波のある場所で開き直すと使えるようになります。それまでは、この端末だけに記録されます。')];
    } else if (phase === 'signedout') {
      body = [
        note('Googleアカウントでログインすると、記録がクラウドに保存され、ほかの端末と共有できます。この端末にある今の記録は、初回ログイン時にクラウドへ移されます。'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => Cloud.signIn() }, 'Googleでログイン'),
      ];
    } else {
      const label = phase === 'error' ? '同期に失敗しました' : phase === 'syncing' ? '同期しています…' : pending ? '同期待ち(オフライン、または送信中)' : '同期済み';
      body = [
        h('div', { class: 'cloud-user' }, h('strong', {}, email || 'ログイン中'), h('span', { class: `sync-state${pending || phase !== 'ready' ? ' wait' : ''}` }, label)),
        h('button', { class: 'btn', type: 'button', onclick: doSignOut }, 'ログアウト'),
      ];
    }
    box.replaceChildren(...body);
  }

  async function doSignOut() {
    if (!confirm('ログアウトします。\nこの端末の記録は消去されます(クラウドには残り、次回ログインで戻ります)。\nよろしいですか?')) return;
    await Cloud.signOut();
    state = defaults();
    selId = null;
    save();
    renderRecord();
    renderHistory();
    renderAdmin();
  }

  function errorMessage(e) {
    const code = (e && e.code) || '';
    if (code === 'permission-denied') return '同期が許可されていません(Firestoreのルールを確認してください)';
    if (code === 'auth/unauthorized-domain') return 'このドメインはFirebaseで許可されていません';
    if (code === 'auth/operation-not-allowed') return 'FirebaseでGoogleログインが有効になっていません';
    if (code === 'auth/network-request-failed' || code === 'unavailable') return '通信できませんでした';
    return `同期エラー: ${code || (e && e.message) || '不明'}`;
  }

  const cloudHooks = {
    getLocal: () => state,
    dropLocal: () => { state = defaults(); selId = null; },
    setOwner: (uid) => { state.owner = uid; save(); },
    onStatus: (s) => { cloudStatus = s; renderCloud(); },
    onError: (e) => {
      console.error(e);
      if (Date.now() - lastErrorAt < 3000) return;
      lastErrorAt = Date.now();
      toast(errorMessage(e));
    },
    onRemote: (kind, items) => {
      if (kind === 'machines') {
        state.machines = items.filter((m) => m.name).sort((a, b) => a.createdAt - b.createdAt);
      } else {
        state.sets = items.filter((s) => s.machineId && Number.isFinite(s.weight) && s.reps > 0 && Number.isFinite(s.ts));
      }
      save();
      renderRecord();
      if ($('#view-history').classList.contains('active')) renderHistory();
      if ($('#view-admin').classList.contains('active')) renderAdmin();
    },
  };

  /* ---------- 起動 ---------- */
  renderCloud();
  Cloud.init(cloudHooks);
  renderPresets();
  if (T.endAt && T.endAt <= Date.now()) { T.endAt = 0; persistTimer(); }
  if (T.endAt) { requestWake(); ensureTick(); }
  tick();
  renderRecord();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* 非対応環境では無視 */ });
    });
  }
})();
