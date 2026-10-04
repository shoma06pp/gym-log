// Firebase (Auth + Firestore) によるクラウド同期。
// SDK は初回だけネットから読み込む。読み込めなくても、アプリ本体はローカル保存だけで動く。
(() => {
  'use strict';

  const SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';
  const SYNCED_KEY = 'gymlog.synced.'; // + uid : 初回の移行が済んだ印
  const BATCH_MAX = 400;

  let hooks = null;
  let auth = null;
  let db = null;
  let user = null;
  let unsubs = [];
  const pending = { machines: false, sets: false };
  let status = { phase: 'loading', email: '', pending: false };

  function setStatus(patch) {
    status = { ...status, ...patch };
    if (hooks) hooks.onStatus({ ...status });
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.crossOrigin = 'anonymous'; // Service Worker でキャッシュできるようにする
      s.onload = resolve;
      s.onerror = () => reject(new Error(`load failed: ${src}`));
      document.head.append(s);
    });
  }

  const col = (name) => db.collection('users').doc(user.uid).collection(`gymlog_${name}`);
  // 部位・種類は、設定があるときだけ保存する(筋トレの記録は、古いルールのままでも通るように)
  const machineData = (m) => {
    const d = { name: m.name, createdAt: m.createdAt };
    if (m.part) d.part = m.part;
    if (m.kind === 'cardio') d.kind = 'cardio';
    return d;
  };
  // 有酸素の記録は distance と calories、筋トレの記録は weight と reps を持つ
  const isCardioSet = (s) => Number.isFinite(s.distance);
  const setData = (s) => (isCardioSet(s)
    ? { machineId: s.machineId, distance: s.distance, calories: s.calories, ts: s.ts }
    : { machineId: s.machineId, weight: s.weight, reps: s.reps, ts: s.ts });
  const num = (v) => (typeof v === 'number' ? v : undefined);

  async function commit(ops) {
    for (let i = 0; i < ops.length; i += BATCH_MAX) {
      const batch = db.batch();
      for (const op of ops.slice(i, i + BATCH_MAX)) op(batch);
      await batch.commit();
    }
  }

  // この端末で初めてログインしたとき、ローカルの記録をクラウドに移す
  async function migrate(u) {
    if (localStorage.getItem(SYNCED_KEY + u.uid)) return;
    const [ms, ss] = await Promise.all([
      col('machines').get({ source: 'server' }),
      col('sets').get({ source: 'server' }),
    ]);
    const local = hooks.getLocal();
    if (local.owner && local.owner !== u.uid) {
      hooks.dropLocal(); // 別アカウントの記録は取り込まない
    } else {
      const haveM = new Set(ms.docs.map((d) => d.id));
      const haveS = new Set(ss.docs.map((d) => d.id));
      const ops = [
        ...local.machines.filter((m) => !haveM.has(m.id)).map((m) => (b) => b.set(col('machines').doc(m.id), machineData(m))),
        ...local.sets.filter((s) => !haveS.has(s.id)).map((s) => (b) => b.set(col('sets').doc(s.id), setData(s))),
      ];
      await commit(ops);
    }
    hooks.setOwner(u.uid);
    localStorage.setItem(SYNCED_KEY + u.uid, '1');
  }

  function attach() {
    const watch = (name, toItem) => col(name).onSnapshot({ includeMetadataChanges: true }, (snap) => {
      pending[name] = snap.metadata.hasPendingWrites;
      setStatus({ phase: 'ready', pending: pending.machines || pending.sets });
      // オフラインで空のキャッシュが返ってきたときに、手元の記録を消さない
      if (snap.metadata.fromCache && snap.empty && hooks.getLocal()[name].length) return;
      hooks.onRemote(name, snap.docs.map((d) => ({ id: d.id, ...toItem(d.data()) })));
    }, (err) => hooks.onError(err));
    unsubs = [
      watch('machines', (d) => ({
        name: String(d.name ?? ''), createdAt: Number(d.createdAt) || 0,
        part: typeof d.part === 'string' ? d.part : '', kind: d.kind === 'cardio' ? 'cardio' : 'strength',
      })),
      watch('sets', (d) => ({
        machineId: String(d.machineId ?? ''), ts: Number(d.ts),
        weight: num(d.weight), reps: num(d.reps), distance: num(d.distance), calories: num(d.calories),
      })),
    ];
  }

  function detach() {
    unsubs.forEach((f) => f());
    unsubs = [];
    pending.machines = pending.sets = false;
  }

  async function onAuth(u) {
    detach();
    user = u;
    if (!u) {
      setStatus({ phase: 'signedout', email: '', pending: false });
      return;
    }
    setStatus({ phase: 'syncing', email: u.email || '', pending: false });
    try {
      await migrate(u);
      attach();
    } catch (e) {
      hooks.onError(e);
      setStatus({ phase: 'error' });
    }
  }

  const guard = (promise) => { if (promise) promise.catch((e) => hooks.onError(e)); };

  const api = {
    async init(h) {
      hooks = h;
      const config = window.GYMLOG_FIREBASE_CONFIG;
      if (!config) { setStatus({ phase: 'unavailable' }); return; }
      try {
        await loadScript(`${SDK}firebase-app-compat.js`);
        await Promise.all([loadScript(`${SDK}firebase-auth-compat.js`), loadScript(`${SDK}firebase-firestore-compat.js`)]);
        firebase.initializeApp(config);
        auth = firebase.auth();
        db = firebase.firestore();
        try { await db.enablePersistence({ synchronizeTabs: true }); } catch (e) { /* 非対応でも続行 */ }
        auth.getRedirectResult().catch((e) => hooks.onError(e));
        auth.onAuthStateChanged(onAuth);
      } catch (e) {
        setStatus({ phase: 'unavailable' });
      }
    },

    async signIn() {
      if (!auth) return;
      const provider = new firebase.auth.GoogleAuthProvider();
      try {
        await auth.signInWithPopup(provider);
      } catch (e) {
        if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
          await auth.signInWithRedirect(provider);
        } else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
          hooks.onError(e);
        }
      }
    },

    async signOut() {
      if (!auth) return;
      const uid = user && user.uid;
      await auth.signOut();
      if (uid) localStorage.removeItem(SYNCED_KEY + uid);
    },

    get signedIn() { return !!user; },

    upsertMachine(m) { if (user) guard(col('machines').doc(m.id).set(machineData(m))); },
    upsertSet(s) { if (user) guard(col('sets').doc(s.id).set(setData(s))); },
    removeSet(id) { if (user) guard(col('sets').doc(id).delete()); },
    removeMachineAndSets(id, setIds) {
      if (!user) return;
      guard(commit([
        (b) => b.delete(col('machines').doc(id)),
        ...setIds.map((sid) => (b) => b.delete(col('sets').doc(sid))),
      ]));
    },
    bulkUpsert(machines, sets) {
      if (!user) return;
      guard(commit([
        ...machines.map((m) => (b) => b.set(col('machines').doc(m.id), machineData(m))),
        ...sets.map((s) => (b) => b.set(col('sets').doc(s.id), setData(s))),
      ]));
    },
  };

  window.GymCloud = api;
})();
