// 取代 claude.ai 的 window.claude.use(...)，改接自己的後端（worker/index.js）。
// 生成器本身的程式不用改：sample / db / assets / downloads 的介面和原本一樣。
(function () {
  const API = '/api';

  /* ---------- 登入 ---------- */
  let ready = null;
  function whenLoggedIn() {
    if (!ready) ready = fetch(API + '/me', { credentials: 'same-origin' })
      .then(r => r.ok ? true : askPassword())
      .catch(() => askPassword());
    return ready;
  }

  function askPassword() {
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-modal', 'true');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.55)';
      wrap.innerHTML = `<form style="background:var(--panel,#F7F7F7);color:var(--ink,#161616);border-radius:18px;padding:22px;width:100%;max-width:340px;font:15px/1.6 -apple-system,'PingFang TC','Noto Sans TC',sans-serif">
        <div style="font-family:'Noto Serif TC',serif;font-weight:700;font-size:20px;margin-bottom:6px">Undertone</div>
        <p style="margin:0 0 12px;color:var(--soft,#6E6E6E);font-size:14px">輸入密碼才能使用 Claude 和測試紀錄。</p>
        <input type="password" autocomplete="current-password" aria-label="密碼" required style="width:100%;font:inherit;padding:10px 12px;border:1px solid var(--line,#CDCDCD);border-radius:12px;background:var(--chip,#fff);color:inherit">
        <p class="err" style="margin:8px 0 0;color:#B3122E;font-size:13px" hidden></p>
        <button type="submit" style="margin-top:14px;width:100%;font:inherit;font-weight:600;padding:12px;border-radius:12px;border:0;background:var(--lacquer,#161616);color:var(--lacquer-ink,#fff);cursor:pointer">進入</button>
      </form>`;
      const show = () => { document.body.appendChild(wrap); wrap.querySelector('input').focus(); };
      document.body ? show() : document.addEventListener('DOMContentLoaded', show);
      const form = wrap.querySelector('form'), err = wrap.querySelector('.err'), btn = wrap.querySelector('button');
      form.addEventListener('submit', async e => {
        e.preventDefault();
        btn.disabled = true; err.hidden = true;
        try {
          const r = await fetch(API + '/login', {
            method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: wrap.querySelector('input').value }),
          });
          if (r.ok) { wrap.remove(); resolve(true); return; }
          err.textContent = r.status === 401 ? '密碼不對，再試一次。' : '登入失敗，請稍後再試。';
        } catch (e2) { err.textContent = '連不上伺服器，請稍後再試。'; }
        err.hidden = false; btn.disabled = false;
      });
    });
  }

  function apiError(code, extra) { const e = new Error(code); e.code = code; Object.assign(e, extra || {}); return e; }

  async function call(path, opts) {
    const r = await fetch(API + path, Object.assign({ credentials: 'same-origin' }, opts));
    if (r.status === 401) { ready = null; throw apiError('not_signed_in'); }
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw apiError(body.error || 'http_' + r.status, { status: r.status, detail: body.detail });
    return body;
  }
  const sendJson = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

  /* ---------- 圖片縮小 ---------- */
  // 送給 Claude 的圖長邊 1568px 就夠；存檔的圖要小於 D1 一列的上限。
  async function shrink(blob, maxSide, maxBytes) {
    if (!/^image\//.test(blob.type || '')) return blob;
    let bmp;
    try { bmp = await createImageBitmap(blob); } catch (e) { return blob; }
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    if (scale === 1 && blob.size <= maxBytes && /^image\/(png|jpeg|gif|webp)$/.test(blob.type)) { bmp.close && bmp.close(); return blob; }
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close && bmp.close();
    let q = 0.9, out;
    do { out = await new Promise(res => c.toBlob(res, 'image/jpeg', q)); q -= 0.15; } while (out && out.size > maxBytes && q > 0.3);
    return out || blob;
  }
  const toBase64 = blob => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1]);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });

  /* ---------- sample：Claude ---------- */
  const sample = {
    async limits() { return call('/limits'); },
    async json(prompt, opts) {
      opts = opts || {};
      const images = [];
      for (const f of opts.images || []) {
        const b = await shrink(f, 1568, 3.5 * 1024 * 1024);
        images.push({ media_type: b.type || 'image/jpeg', data: await toBase64(b) });
      }
      try {
        const r = await call('/ai', sendJson('POST', { prompt, images }));
        return r.result;
      } catch (e) {
        if (e.code === 'daily_limit') console.warn('今天的 Claude 呼叫次數已達上限');
        throw e;
      }
    },
  };

  /* ---------- db：類似 Firestore 的小介面 ---------- */
  const KB_URL = new URL('kb/backend.json', document.baseURI).href;
  function snap(id, data) { return { id, exists: data !== undefined, data: () => data }; }
  function docRef(col, id) {
    const p = '/db/' + encodeURIComponent(col) + '/' + encodeURIComponent(id);
    return {
      id,
      async get() {
        if (col === 'kb' && id === 'backend') {
          const r = await fetch(KB_URL, { cache: 'no-cache' });
          return snap(id, r.ok ? await r.json() : undefined);
        }
        try { return snap(id, (await call(p)).data); }
        catch (e) { if (e.status === 404) return snap(id, undefined); throw e; }
      },
      async set(data) { await call(p, sendJson('PUT', data)); },
      async update(patch) { await call(p, sendJson('PATCH', patch)); },
      async delete() { await call(p, { method: 'DELETE' }); },
    };
  }
  function query(col, dir) {
    return {
      orderBy(field, d) { return query(col, d === 'desc' ? 'desc' : 'asc'); }, // 只有 createdAt 會用到
      async get() {
        const r = await call('/db/' + encodeURIComponent(col) + '?dir=' + (dir || 'asc'));
        const docs = r.docs.map(x => snap(x.id, x.data));
        return { size: docs.length, docs, empty: !docs.length };
      },
    };
  }
  const db = {
    collection(col) {
      return Object.assign(query(col), {
        doc: id => docRef(col, id),
        async add(data) { const r = await call('/db/' + encodeURIComponent(col), sendJson('POST', data)); return docRef(col, r.id); },
      });
    },
  };

  /* ---------- assets：圖片 ---------- */
  const assets = {
    async upload(blob, opts) {
      let b = blob;
      if (opts && opts.type && !b.type) b = new Blob([b], { type: opts.type });
      b = await shrink(b, 2400, 1800 * 1024);
      const r = await call('/blob', { method: 'POST', headers: { 'Content-Type': b.type || 'image/png' }, body: b });
      return { id: r.id, url: '/_blob/' + r.id };
    },
    async delete(id) { await call('/blob/' + encodeURIComponent(id), { method: 'DELETE' }); },
  };

  /* ---------- downloads：直接讓瀏覽器下載 ---------- */
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: /\.csv$/i.test(filename) ? 'text/csv;charset=utf-8' : 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    },
  };

  const caps = { sample, db, assets, downloads };
  window.claude = {
    async use(name) {
      if (!caps[name]) throw apiError('not_granted');
      if (name !== 'downloads') await whenLoggedIn();
      return caps[name];
    },
  };
})();
