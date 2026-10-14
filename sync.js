/* ============================================================================
 * sync.js — 健身记录 App 的云备份模块
 * ----------------------------------------------------------------------------
 * 这个文件是自包含的:它不认识 App 的内部代码,也不修改 App 的任何逻辑。
 * 它只利用 App 的三个既成事实:
 *
 *   1. 数据在 localStorage['fitness_app_data'],结构 {fitness:[], diet:[]}
 *   2. App 所有写入都经过 localStorage.setItem (index.html 的 saveData)
 *   3. App 监听 window 的 'storage' 事件,e.key 匹配时执行 loadData()+render()
 *
 * 第 3 点是关键的杠杆:按规范,同文档写入 *不会* 触发 storage 事件,
 * 所以本模块写完数据后要手动派发一个合成的 StorageEvent 让 App 重新读取。
 * 这不是 hack,是规范预留的正规做法。
 *
 * ⚠️ 明确不做的事:不实现"从备份仓库拉取最新 sync.js 并 eval"。
 *    那会把一个"能改我备份数据"的 token 升级成"能在我公开源上执行任意 JS"。
 *    只做版本提示,永不加载代码。请不要"改进"这一点。
 *
 * 加载方式(必须在 <head> 里,且带 defer),见 index.html:
 *   <script src="sync.js?v=1" defer></script>
 * defer 的时序是承重的:它让本文件在 App 代码已存在、但 loadData() 尚未执行
 * 的那个窗口里运行,从而可以在 App 首次读取之前把被清空的数据恢复好。
 * ==========================================================================*/
(function () {
  'use strict';

  /* ==========================================================================
   * 1. 常量
   * ========================================================================*/

  var APP_KEY      = 'fitness_app_data';          // App 的数据键(只读约定)
  var CFG_KEY      = 'fitness_sync_cfg';          // 本模块配置
  var STATE_KEY    = 'fitness_sync_state';        // 本模块运行时状态
  var MIRROR_KEY   = 'fitness_sync_mirror';       // 上次同步成功的快照(含 _m)
  var RESCUE_PREFIX = 'fitness_app_data_rescue_'; // 损坏数据的原样备份

  var SCHEMA       = 'fitness-sync/1';
  var API          = 'https://api.github.com';
  var POLL_MS      = 30000;      // 兜底轮询间隔
  var DEBOUNCE_MS  = 25000;      // 本地写入后多久推送
  var PUT_GAP_MS   = 20000;      // 两次 PUT 的最小间隔(GitHub 次级限流)
  var MAX_PUSH     = 900 * 1024; // 超过就拒绝推送(Contents API 内联上限 1MB)
  var WARN_PUSH    = 500 * 1024;
  var TOMB_DAYS    = 180;        // 墓碑保留天数
  var TOMB_MAX     = 2000;       // 墓碑数量上限
  var LOG_MAX      = 50;
  var TOKEN_WARN_DAYS = 14;      // token 到期前多少天开始提示

  /* ==========================================================================
   * 2. 小工具
   * ========================================================================*/

  function $(sel) { return document.querySelector(sel); }

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // 从 id 还原创建时间。generateId() = Date.now().toString(36) + '-' + rand
  // 好处:两台设备对同一条未经修改的原始记录会得出完全一致的 _m,不受时钟偏差影响。
  function idTime(id) {
    if (!id || typeof id !== 'string') return 0;
    var head = id.split('-')[0];
    var ms = parseInt(head, 36);
    return (isFinite(ms) && ms > 1000000000000) ? ms : 0;
  }

  // 与键顺序无关的记录指纹(用于判断"内容是否真的变了")
  function fingerprint(rec) {
    if (!rec || typeof rec !== 'object') return '';
    var keys = Object.keys(rec).filter(function (k) { return k !== '_m'; }).sort();
    var out = [];
    for (var i = 0; i < keys.length; i++) out.push(keys[i] + '\u0001' + String(rec[keys[i]]));
    return out.join('\u0002');
  }

  // 规范化序列化:剥掉 _m、按键名排序、按 id 排序。
  // 用途是判断"两批记录内容是否相同" —— 不能直接 JSON.stringify,
  // 因为合并结果带 _m 而 App 写的数据不带,直接比会永远判定为"有变化"。
  function canon(list) {
    var arr = (list || []).map(function (r) {
      var keys = Object.keys(r).filter(function (k) { return k !== '_m'; }).sort();
      var o = {};
      for (var i = 0; i < keys.length; i++) o[keys[i]] = r[keys[i]];
      return o;
    });
    arr.sort(function (a, b) { return String(a.id).localeCompare(String(b.id)); });
    return JSON.stringify(arr);
  }

  function nowISO() { return new Date().toISOString(); }

  function todayStamp() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function countOf(obj) {
    if (!obj) return 0;
    return ((obj.fitness || []).length) + ((obj.diet || []).length);
  }

  // ---- UTF-8 安全的 base64(记录里全是中文,直接 btoa 会抛异常)----
  function b64encode(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '', CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function b64decode(b64) {
    var bin = atob(String(b64).replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function deviceId() {
    var id = null;
    try { id = localStorage.getItem('fitness_sync_device'); } catch (e) { /* ignore */ }
    if (!id) {
      id = Math.random().toString(36).slice(2, 8);
      try { localStorage.setItem('fitness_sync_device', id); } catch (e) { /* ignore */ }
    }
    return id;
  }

  /* ==========================================================================
   * 3. 配置与状态
   * ========================================================================*/

  var cfg = { repo: '', branch: 'master', path: 'fitness-data.json',
              token: '', tokenExpiry: '', device: deviceId() };

  var state = {
    lastSha: null, revision: 0,
    lastRawSeen: null,          // 最近一次"已知"的 fitness_app_data 原始串
    pending: false,             // 有未推送的本地改动
    suppressAutoRestore: false, // 用户清空过数据,别再偷偷长回来
    deleted: { fitness: {}, diet: {} },
    lastSyncAt: null, lastError: null,
    log: []
  };

  var mirror = null;            // {fitness:[...含_m], diet:[...含_m]} 或 null

  function loadCfg() {
    try {
      var raw = localStorage.getItem(CFG_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        for (var k in cfg) if (Object.prototype.hasOwnProperty.call(p, k)) cfg[k] = p[k];
      }
    } catch (e) { /* 配置坏了就用默认值 */ }
  }

  function saveCfg() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }
    catch (e) { logLine('error', '保存配置失败:' + e.message); }
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STATE_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        for (var k in state) if (Object.prototype.hasOwnProperty.call(p, k)) state[k] = p[k];
      }
    } catch (e) { /* ignore */ }
  }

  function saveState() {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); }
    catch (e) { logLine('error', '保存状态失败:' + e.message); }
  }

  function loadMirror() {
    try {
      var raw = localStorage.getItem(MIRROR_KEY);
      mirror = raw ? JSON.parse(raw) : null;
    } catch (e) { mirror = null; }
  }

  function saveMirror(m) {
    mirror = m;
    try {
      if (m) localStorage.setItem(MIRROR_KEY, JSON.stringify(m));
      else localStorage.removeItem(MIRROR_KEY);
    } catch (e) { logLine('error', '保存镜像失败:' + e.message); }
  }

  function logLine(level, msg) {
    var entry = { t: new Date().toLocaleTimeString('zh-CN'), level: level, msg: msg };
    state.log.push(entry);
    if (state.log.length > LOG_MAX) state.log = state.log.slice(-LOG_MAX);
    if (level === 'error') state.lastError = msg;
    renderStatus();
  }

  /* ==========================================================================
   * 4. 数据读取
   * ========================================================================*/

  function readRaw() {
    try { return localStorage.getItem(APP_KEY); } catch (e) { return null; }
  }

  function parseRaw(raw) {
    if (!raw) return null;
    try {
      var p = JSON.parse(raw);
      if (p && typeof p === 'object') {
        if (!Array.isArray(p.fitness)) p.fitness = [];
        if (!Array.isArray(p.diet)) p.diet = [];
        return p;
      }
    } catch (e) { /* 交给调用方处理 */ }
    return null;
  }

  function readLocal() {
    // 返回 null 表示"存储里没有或已损坏",这跟"有但为空"是两件事 ——
    // 前者要触发恢复,后者是用户真的清空了。
    var raw = readRaw();
    if (raw === null || raw === '' || raw === 'null') return { present: false, data: null, raw: raw };
    var d = parseRaw(raw);
    if (!d) return { present: true, corrupt: true, data: null, raw: raw };
    return { present: true, data: d, raw: raw };
  }

  /* ==========================================================================
   * 5. 合并(按 id 取并集 + 墓碑)
   * ========================================================================*/

  function mtime(rec) {
    return (rec && typeof rec._m === 'number' && rec._m > 0) ? rec._m : idTime(rec && rec.id);
  }

  function pruneTombs(tombs) {
    var cutoff = Date.now() - TOMB_DAYS * 86400000;
    var out = {};
    var ids = [];
    for (var id in tombs) {
      if (!Object.prototype.hasOwnProperty.call(tombs, id)) continue;
      if (tombs[id] >= cutoff) { out[id] = tombs[id]; ids.push(id); }
    }
    // 数量上限:超了就丢最旧的
    if (ids.length > TOMB_MAX) {
      ids.sort(function (a, b) { return out[a] - out[b]; });
      var drop = ids.length - TOMB_MAX;
      for (var i = 0; i < drop; i++) delete out[ids[i]];
    }
    return out;
  }

  function mergeType(localArr, remoteArr, localTombs, remoteTombs) {
    var tombs = {};
    var id;
    for (id in localTombs) if (Object.prototype.hasOwnProperty.call(localTombs, id)) tombs[id] = localTombs[id];
    for (id in remoteTombs) {
      if (!Object.prototype.hasOwnProperty.call(remoteTombs, id)) continue;
      tombs[id] = Math.max(tombs[id] || 0, remoteTombs[id]);
    }

    var byId = {};
    var L = {}, R = {};
    (localArr || []).forEach(function (r) { if (r && r.id) L[r.id] = r; });
    (remoteArr || []).forEach(function (r) { if (r && r.id) R[r.id] = r; });

    var seen = {};
    for (id in L) seen[id] = true;
    for (id in R) seen[id] = true;

    var order = Object.keys(seen);
    for (var i = 0; i < order.length; i++) {
      id = order[i];
      var l = L[id], r = R[id], t = tombs[id] || 0;

      if (l && r) {
        // 编辑冲突:谁新谁赢
        byId[id] = (mtime(l) >= mtime(r)) ? l : r;
      } else if (l) {
        // 只有本地:对面有更新的墓碑才算真删除,否则一律保留
        if (t && t > mtime(l)) continue;
        byId[id] = l;
      } else {
        // 只有远端:本地有更新的墓碑才算真删除,否则一律保留(这是"被清空后恢复"的路径)
        if (t && t > mtime(r)) continue;
        byId[id] = r;
      }
    }

    var out = [];
    for (id in byId) if (Object.prototype.hasOwnProperty.call(byId, id)) out.push(byId[id]);
    out.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)) || mtime(b) - mtime(a); });

    return { records: out, tombs: pruneTombs(tombs) };
  }

  /* ==========================================================================
   * 6. GitHub API
   * ========================================================================*/

  function ghFetch(path, opts) {
    opts = opts || {};
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 20000);
    var headers = { 'Accept': 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28' };
    if (cfg.token && opts.auth !== false) headers['Authorization'] = 'Bearer ' + cfg.token;
    if (opts.body) headers['Content-Type'] = 'application/json';

    return fetch(API + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body,
      cache: 'no-store',
      signal: ctrl.signal
    }).then(function (res) {
      clearTimeout(timer);
      if (res.status === 404) return { ok: false, status: 404, notFound: true };
      return res.text().then(function (text) {
        var json = null;
        try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
        if (res.ok) return { ok: true, status: res.status, json: json };
        return { ok: false, status: res.status, json: json, headers: res.headers };
      });
    }).catch(function (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') return { ok: false, status: 0, timeout: true };
      return { ok: false, status: 0, network: true, err: err };
    });
  }

  function describeError(r) {
    if (r.network)   return '网络不可用或被拦截,已排队,稍后自动重试';
    if (r.timeout)   return '请求超时,已排队,稍后自动重试';
    if (r.status === 401) return 'token 无效或已过期,请在设置中重新填写';
    if (r.status === 403) {
      var rem = r.headers && r.headers.get && r.headers.get('x-ratelimit-remaining');
      if (rem === '0') return 'GitHub 速率限制,请稍后重试';
      return 'token 权限不足(需要 Contents: Read and write)';
    }
    if (r.status === 404) return '仓库或文件不存在,或 token 未授权该仓库';
    if (r.status === 409) return '云端已被其他设备更新,正在重新合并';
    if (r.status === 422) return '内容过大或编码错误';
    return 'GitHub 返回 HTTP ' + r.status;
  }

  function apiPath() {
    var parts = String(cfg.repo || '').split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return '/repos/' + parts[0] + '/' + parts[1] + '/contents/' + cfg.path;
  }

  function fetchRemote() {
    var base = apiPath();
    if (!base) return Promise.resolve({ ok: false, status: 0, badRepo: true });
    return ghFetch(base + '?ref=' + encodeURIComponent(cfg.branch)).then(function (r) {
      if (r.notFound) return { ok: true, empty: true, sha: null, data: null };
      if (!r.ok) return r;
      var payload = r.json;
      if (!payload || typeof payload.content !== 'string') {
        return { ok: false, status: 0, badPayload: true };
      }
      var text;
      try { text = b64decode(payload.content); }
      catch (e) { return { ok: false, status: 0, badBase64: true }; }
      var data = null;
      try { data = JSON.parse(text); } catch (e) { /* 远端文件坏了 */ }
      return { ok: true, sha: payload.sha, data: data, size: payload.size };
    });
  }

  function putRemote(fileObj, sha, message) {
    var base = apiPath();
    if (!base) return Promise.resolve({ ok: false, status: 0, badRepo: true });
    var body = {
      message: message,
      content: b64encode(JSON.stringify(fileObj, null, 1)),
      branch: cfg.branch
    };
    if (sha) body.sha = sha;
    return ghFetch(base, { method: 'PUT', body: JSON.stringify(body) });
  }

  /* ==========================================================================
   * 7. 写回(唯一的出口,五条不变式都在这里)
   * ========================================================================*/

  var writing = false; // 内部写入期间抑制钩子

  function rescueCurrentRaw(reason) {
    var raw = readRaw();
    if (!raw) return;
    try {
      localStorage.setItem(RESCUE_PREFIX + Date.now(), raw);
      // 只保留最近 1 份,别把配额吃光
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(RESCUE_PREFIX) === 0) keys.push(k);
      }
      keys.sort();
      while (keys.length > 1) {
        localStorage.removeItem(keys.shift());
      }
      logLine('info', '已保留改动前的副本(' + reason + ')');
    } catch (e) { logLine('warn', '保留副本失败:' + e.message); }
  }

  function formIsDirty() {
    var el = document.activeElement;
    if (!el) return false;
    var form = document.getElementById('record-form');
    return !!(form && form.contains(el));
  }

  function dispatchAppReload(raw) {
    try {
      window.dispatchEvent(new StorageEvent('storage', {
        key: APP_KEY, oldValue: null, newValue: raw,
        storageArea: localStorage, url: location.href
      }));
      return true;
    } catch (e) {
      try {
        var ev = document.createEvent('Event');
        ev.initEvent('storage', false, false);
        ev.key = APP_KEY; ev.newValue = raw;
        window.dispatchEvent(ev);
        return true;
      } catch (e2) {
        logLine('warn', '通知 App 刷新失败,请手动刷新页面');
        return false;
      }
    }
  }

  var pendingApply = null; // 因表单正在输入而推迟的合并结果

  function applyMerged(records, reason) {
    var total = countOf(records);
    var floor = Math.max(countOf(mirror), 0);

    // 不变式 1:不能把非空数据写成空
    if (total === 0 && floor > 0) {
      logLine('error', '拒绝写入:合并结果为空,但已有 ' + floor + ' 条记录 —— 已中止以防误删');
      return false;
    }
    // 不变式 2:表单正在输入时推迟,别把用户半截的记录清掉
    if (formIsDirty()) {
      pendingApply = { records: records, reason: reason };
      logLine('info', '云端有更新,等输入完成后自动应用');
      renderStatus();
      return false;
    }

    // 不变式 3:写前先留副本
    rescueCurrentRaw(reason || 'apply');

    var raw = JSON.stringify({ fitness: records.fitness || [], diet: records.diet || [] });

    // 不变式 4:写入 + 通知 App
    writing = true;
    try {
      localStorage.setItem(APP_KEY, raw);
      state.lastRawSeen = raw;
    } catch (e) {
      writing = false;
      logLine('error', '写入本地存储失败(可能已满):' + e.message);
      return false;
    }
    writing = false;

    dispatchAppReload(raw);

    // 不变式 5:更新基线
    saveState();
    return true;
  }

  function flushPendingApply() {
    if (!pendingApply) return;
    if (formIsDirty()) return;
    var p = pendingApply;
    pendingApply = null;
    applyMerged(p.records, p.reason);
  }

  /* ==========================================================================
   * 8. 同步引擎
   * ========================================================================*/

  var busy = false;
  var lastPutAt = 0;
  var lastAttemptAt = 0;
  var mergeResultRef = null;   // sync() 内部把合并结果放这里,供收尾时落地到本地

  function configured() { return !!(cfg.repo && cfg.token); }

  // focus / visibilitychange / 启动定时器都走这里,避免频繁触发时把请求打爆
  function maybeSync() {
    if (!configured() || busy) return;
    if (Date.now() - lastAttemptAt < 15000) return;
    lastAttemptAt = Date.now();
    sync(0);
  }

  // 把当前本地数据 + 镜像 合成"带 _m 的本地视图",并算出被删掉的 id
  function snapshotLocal(localData) {
    var prev = mirror || { fitness: [], diet: [] };
    var out = { fitness: [], diet: [] };
    var tombs = { fitness: {}, diet: {} };
    var now = Date.now();

    ['fitness', 'diet'].forEach(function (type) {
      var prevById = {};
      (prev[type] || []).forEach(function (r) { if (r && r.id) prevById[r.id] = r; });

      var seen = {};
      (localData[type] || []).forEach(function (r) {
        if (!r || !r.id) return;
        seen[r.id] = true;
        var p = prevById[r.id];
        var m;
        if (!p) m = idTime(r.id) || now;                 // 全新记录
        else if (fingerprint(p) === fingerprint(r)) m = p._m || idTime(r.id); // 没动过
        else m = now;                                     // 被编辑过
        var copy = {};
        for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k)) copy[k] = r[k];
        copy._m = m;
        out[type].push(copy);
      });

      // 镜像里有、本地没有 → 用户删了
      (prev[type] || []).forEach(function (p) {
        if (p && p.id && !seen[p.id]) tombs[type][p.id] = now;
      });
    });

    return { records: out, tombs: tombs };
  }

  function buildFile(records, tombs) {
    return {
      schema: SCHEMA,
      updatedAt: nowISO(),
      revision: state.revision + 1,
      writer: cfg.device,
      fitness: records.fitness || [],
      diet: records.diet || [],
      deleted: tombs
    };
  }

  // 一次完整的拉取 → 合并 → 推送。attempt 用于 409 重试。
  function sync(attempt) {
    attempt = attempt || 0;
    if (busy) return Promise.resolve(false);
    if (!configured()) { logLine('warn', '还没配置仓库和 token'); return Promise.resolve(false); }
    busy = true;
    renderStatus();

    var local = readLocal();
    if (!local.data) {
      busy = false;
      logLine('warn', '本地没有可同步的数据');
      renderStatus();
      return Promise.resolve(false);
    }

    var snap = snapshotLocal(local.data);

    return fetchRemote().then(function (remote) {
      if (!remote.ok) {
        logLine('error', describeError(remote));
        state.pending = true; saveState();
        return false;
      }

      var remoteData = remote.data || {};
      var mFit = mergeType(snap.records.fitness, remoteData.fitness, snap.tombs.fitness, (remoteData.deleted || {}).fitness);
      var mDiet = mergeType(snap.records.diet, remoteData.diet, snap.tombs.diet, (remoteData.deleted || {}).diet);

      var mergedRecords = { fitness: mFit.records, diet: mDiet.records };
      var mergedTombs = { fitness: mFit.tombs, diet: mDiet.tombs };

      var file = buildFile(mergedRecords, mergedTombs);
      var size = JSON.stringify(file).length;

      if (size > MAX_PUSH) {
        logLine('error', '数据过大(' + Math.round(size / 1024) + 'KB),已停止推送以免出错');
        return false;
      }
      if (size > WARN_PUSH) {
        logLine('warn', '数据已达 ' + Math.round(size / 1024) + 'KB,接近上限');
      }

      mergeResultRef = mergedRecords;

      var mergedCount = countOf(mergedRecords);
      // 合并结果带 _m、本地数据不带,所以必须走 canon() 比较
      var changedLocally = canon(mergedRecords.fitness) !== canon(local.data.fitness) ||
                           canon(mergedRecords.diet) !== canon(local.data.diet);

      var afterPush = function (r) {
        if (!r.ok) {
          if (r.status === 409 && attempt < 3) {
            logLine('warn', '云端已被其他设备更新,重新合并(第 ' + (attempt + 1) + ' 次)');
            busy = false;
            var wait = [1000, 3000, 8000][attempt];
            return new Promise(function (res) { setTimeout(res, wait); })
              .then(function () { return sync(attempt + 1); });
          }
          logLine('error', describeError(r));
          state.pending = true; saveState();
          return false;
        }
        state.lastSha = (r.json && r.json.content && r.json.content.sha) || state.lastSha;
        state.revision = file.revision;
        state.pending = false;
        state.lastError = null;
        state.lastSyncAt = nowISO();
        saveState();
        lastPutAt = Date.now();
        logLine('info', '已同步:' + mergedCount + ' 条记录');
        return true;
      };

      // 只有内容真的变了才 PUT,避免无意义的提交和触发次限流
      var remoteDiffers = canon(remoteData.fitness) !== canon(mergedRecords.fitness) ||
                          canon(remoteData.diet) !== canon(mergedRecords.diet);
      var needPush = state.pending || changedLocally || remoteDiffers || !remote.sha || attempt > 0;

      if (!needPush) {
        state.lastSha = remote.sha;
        state.pending = false;
        saveState();
        logLine('info', '云端已是最新,无需上传(' + mergedCount + ' 条)');
        return true;
      }

      var gap = Date.now() - lastPutAt;
      if (gap < PUT_GAP_MS) {
        var waitMs = PUT_GAP_MS - gap;
        logLine('info', '稍等 ' + Math.ceil(waitMs / 1000) + ' 秒再上传(避免触发限流)');
        return new Promise(function (res) { setTimeout(res, waitMs); })
          .then(function () {
            return putRemote(file, remote.sha, 'sync: ' + mergedCount + ' 条记录 (设备 ' +
                             cfg.device + ', r' + file.revision + ')');
          }).then(afterPush);
      }

      return putRemote(file, remote.sha, 'sync: ' + mergedCount + ' 条记录 (设备 ' +
                       cfg.device + ', r' + file.revision + ')').then(afterPush);
    }).then(function (result) {
      // 无论推送成功与否,合并结果都要落到本地 —— 否则"从云端恢复"就只发生在内存里。
      // 注意顺序:必须先 applyMerged 再 saveMirror。反过来的话,
      // applyMerged 里"别把非空写成空"的守卫会因为镜像已被提前更新而失效。
      if (mergeResultRef) {
        if (applyMerged(mergeResultRef, 'sync')) saveMirror(mergeResultRef);
        mergeResultRef = null;
      }
      busy = false;
      renderStatus();
      return result;
    }).catch(function (e) {
      mergeResultRef = null;
      busy = false;
      logLine('error', '同步异常:' + (e && e.message ? e.message : e));
      renderStatus();
      return false;
    });
  }

  function schedulePush() {
    if (pushTimer) clearTimeout(pushTimer);
    var jitter = Math.floor(Math.random() * 5000);
    pushTimer = setTimeout(function () {
      pushTimer = null;
      sync(0);
    }, DEBOUNCE_MS + jitter);
    renderStatus();
  }
  var pushTimer = null;

  /* ==========================================================================
   * 9. 钩子:感知 App 的写入
   * ========================================================================*/

  function onLocalWrite() {
    if (writing) return;                       // 我们自己写的,忽略
    var raw = readRaw();
    if (raw === state.lastRawSeen) return;     // 内容没变
    var parsed = parseRaw(raw);

    if (!parsed) return;

    // 判断这次写入是不是"清空所有数据"
    var before = countOf(mirror || {});
    var after = countOf(parsed);
    if (before >= 10 && after < before * 0.5) {
      state.suppressAutoRestore = true;
      state.pending = false;
      saveState();
      logLine('warn', '检测到数据被大量清空,已暂停自动恢复。如需同步请到设置里选择');
      renderStatus();
      return;
    }

    state.lastRawSeen = raw;
    state.pending = true;
    saveState();
    schedulePush();
  }

  function installHooks() {
    // 改造 Storage.prototype,而不是实例属性 ——
    // 在 Firefox 上给实例赋 setItem 会把函数源码当成一个存储项存起来,静默失效。
    try {
      var origSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        origSet.apply(this, arguments);        // 必须是保存下来的原函数
        try {
          if (this === window.localStorage && key === APP_KEY) onLocalWrite();
        } catch (e) { /* 绝不能让同步层拖垮 App 的写入 */ }
      };
      var origRemove = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (key) {
        origRemove.apply(this, arguments);
        try {
          if (this === window.localStorage && key === APP_KEY) onLocalWrite();
        } catch (e) { /* ignore */ }
      };
    } catch (e) {
      logLine('warn', '无法挂载写入钩子,改用轮询(最多 30 秒延迟)');
    }

    // 兜底轮询:万一钩子失效,也只是延迟变大,不会彻底不同步
    setInterval(function () {
      if (writing) return;
      var raw = readRaw();
      if (raw !== state.lastRawSeen) onLocalWrite();
      flushPendingApply();
    }, POLL_MS);

    window.addEventListener('focus', maybeSync);
    document.addEventListener('visibilitychange', function () {
      flushPendingApply();
      if (document.visibilityState === 'visible') {
        maybeSync();
      } else if (state.pending && configured() && !busy) {
        sync(0);   // iOS 冻结页面前争取推一次
      }
    });
  }

  /* ==========================================================================
   * 10. 启动前的同步恢复(承重:必须赶在 App 的 loadData() 之前)
   * ========================================================================*/

  function preInitRestore() {
    var raw = readRaw();

    // 第二层:损坏的原始串先原样另存,再谈别的
    if (raw !== null && raw !== '' && !parseRaw(raw)) {
      try {
        localStorage.setItem(RESCUE_PREFIX + Date.now(), raw);
        logLine('error', '本地数据解析失败,已保留原始副本,请联系备份找回');
      } catch (e) { /* 配额满了就算了,别把启动搞挂 */ }
    }

    var local = readLocal();

    // 第一层:本地为空而镜像有数据 → 同步恢复(不需要联网)
    if (!local.present && mirror && countOf(mirror) > 0) {
      var restored = JSON.stringify({ fitness: mirror.fitness || [], diet: mirror.diet || [] });
      writing = true;
      try {
        localStorage.setItem(APP_KEY, restored);
      } catch (e) { /* ignore */ }
      writing = false;
      state.lastRawSeen = restored;
      logLine('info', '本地数据不见了,已从备份恢复 ' + countOf(mirror) + ' 条记录');
    } else if (local.data) {
      state.lastRawSeen = local.raw;
      if (state.pending) schedulePush();
    }
  }

  /* ==========================================================================
   * 11. UI
   * ========================================================================*/

  var panelEl = null, badgeEl = null, taEl = null;

  var CSS = [
    '.fsync-btn{position:fixed;right:14px;bottom:calc(env(safe-area-inset-bottom) + 74px);',
    'width:46px;height:46px;border-radius:50%;background:#111;color:#fff;border:none;',
    'font-size:20px;line-height:46px;text-align:center;z-index:500;box-shadow:0 2px 10px rgba(0,0,0,.3);}',
    '.fsync-btn .dot{position:absolute;top:4px;right:4px;width:10px;height:10px;border-radius:50%;',
    'background:#e33;display:none;}',
    '.fsync-btn .dot.on{display:block;}',
    '.fsync-panel{position:fixed;inset:0;background:#fff;z-index:500;overflow-y:auto;',
    'padding:16px calc(16px + env(safe-area-inset-right)) calc(24px + env(safe-area-inset-bottom)) 16px;',
    'box-sizing:border-box;display:none;-webkit-user-select:text;user-select:text;}',
    '.fsync-panel.open{display:block;}',
    '.fsync-panel h2{font-size:18px;margin:4px 0 14px;}',
    '.fsync-panel h3{font-size:14px;margin:18px 0 8px;color:#555;}',
    '.fsync-row{margin-bottom:10px;}',
    '.fsync-row label{display:block;font-size:12px;color:#666;margin-bottom:4px;}',
    '.fsync-panel input,.fsync-panel textarea{width:100%;box-sizing:border-box;font-size:16px;',
    'padding:9px 10px;border:1px solid #ddd;border-radius:8px;font-family:inherit;',
    '-webkit-user-select:text;user-select:text;}',
    '.fsync-panel textarea{height:110px;font-size:12px;word-break:break-all;}',
    '.fsync-actions{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0;}',
    '.fsync-actions button{flex:1 1 46%;padding:11px 8px;border-radius:9px;border:1px solid #111;',
    'background:#111;color:#fff;font-size:14px;font-family:inherit;}',
    '.fsync-actions button.ghost{background:#fff;color:#111;}',
    '.fsync-actions button.danger{background:#fff;color:#c00;border-color:#c00;}',
    '.fsync-status{background:#f5f5f5;border-radius:9px;padding:10px;font-size:13px;line-height:1.7;}',
    '.fsync-status b{font-weight:600;}',
    '.fsync-warn{background:#fff4e5;border:1px solid #ffd08a;color:#8a5200;border-radius:9px;',
    'padding:10px;font-size:13px;line-height:1.6;margin-bottom:12px;}',
    '.fsync-log{background:#111;color:#ddd;border-radius:9px;padding:10px;font-size:11px;',
    'line-height:1.6;max-height:190px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;',
    'font-family:ui-monospace,Menlo,monospace;}',
    '.fsync-help{font-size:12px;color:#666;line-height:1.75;}',
    '.fsync-help code{background:#f2f2f2;padding:1px 4px;border-radius:4px;font-size:11px;}'
  ].join('');

  function injectCSS() {
    var s = document.createElement('style');
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function tokenWarning() {
    if (!cfg.tokenExpiry) return '';
    var exp = new Date(cfg.tokenExpiry + 'T00:00:00');
    if (isNaN(exp.getTime())) return '';
    var days = Math.ceil((exp - Date.now()) / 86400000);
    if (days < 0)  return '<div class="fsync-warn">⚠️ token 已于 ' + esc(cfg.tokenExpiry) + ' 过期,同步已停止。请重新生成一个并填写。</div>';
    if (days <= TOKEN_WARN_DAYS) return '<div class="fsync-warn">⚠️ token 还有 ' + days + ' 天过期(' + esc(cfg.tokenExpiry) + '),记得换新的。</div>';
    return '';
  }

  function buildPanel() {
    panelEl = document.createElement('div');
    panelEl.className = 'fsync-panel';
    panelEl.innerHTML = [
      '<h2>备份与同步</h2>',
      '<div id="fsync-warnbox"></div>',
      '<div class="fsync-status" id="fsync-status">读取中…</div>',

      '<h3>先做这件事</h3>',
      '<div class="fsync-actions">',
      '  <button id="fsync-export">导出备份文件</button>',
      '  <button id="fsync-copy" class="ghost">复制备份内容</button>',
      '</div>',
      '<div class="fsync-help">导出的文件请存到网盘或发给自己。<b>这一步不需要联网,也不依赖下面的 token。</b></div>',

      '<h3>云端设置</h3>',
      '<div class="fsync-row"><label>仓库(owner/name)</label>',
      '  <input id="fsync-repo" placeholder="你的用户名/fitness-backup" autocapitalize="off" spellcheck="false"></div>',
      '<div class="fsync-row"><label>分支</label>',
      '  <input id="fsync-branch" placeholder="master" autocapitalize="off" spellcheck="false"></div>',
      '<div class="fsync-row"><label>文件路径</label>',
      '  <input id="fsync-path" placeholder="fitness-data.json" autocapitalize="off" spellcheck="false"></div>',
      '<div class="fsync-row"><label>访问令牌(token)</label>',
      '  <input id="fsync-token" type="password" placeholder="github_pat_…" autocapitalize="off" spellcheck="false"></div>',
      '<div class="fsync-row"><label>token 到期日(自己记的,用于提醒)</label>',
      '  <input id="fsync-expiry" type="date"></div>',
      '<div class="fsync-actions">',
      '  <button id="fsync-save" class="ghost">保存设置</button>',
      '  <button id="fsync-test" class="ghost">测试连接</button>',
      '</div>',
      '<div class="fsync-actions">',
      '  <button id="fsync-now">立即同步</button>',
      '  <button id="fsync-pull" class="ghost">从云端恢复</button>',
      '</div>',

      '<h3>手动恢复</h3>',
      '<div class="fsync-actions">',
      '  <button id="fsync-import" class="ghost">导入备份文件</button>',
      '  <button id="fsync-paste-toggle" class="ghost">粘贴备份内容</button>',
      '</div>',
      '<input type="file" id="fsync-file" accept="application/json,.json" style="display:none">',
      '<div id="fsync-paste-wrap" style="display:none">',
      '  <textarea id="fsync-paste" placeholder="把备份内容粘贴到这里,然后点下面的按钮"></textarea>',
      '  <div class="fsync-actions">',
      '    <button id="fsync-import-text" class="ghost">合并导入</button>',
      '    <button id="fsync-import-text-over" class="ghost danger">覆盖导入</button>',
      '  </div>',
      '</div>',

      '<h3>导出内容(可全选复制)</h3>',
      '<textarea id="fsync-out" readonly placeholder="点上面的「导出备份文件」或「复制备份内容」"></textarea>',

      '<h3>运行日志</h3>',
      '<div class="fsync-log" id="fsync-log"></div>',
      '<div class="fsync-actions"><button id="fsync-copylog" class="ghost">复制日志</button></div>',

      '<h3>怎么用</h3>',
      '<div class="fsync-help">',
      '1. 在 GitHub 上<b>新建一个私有仓库</b>,例如 <code>fitness-backup</code>,可以留空。<br>',
      '2. 生成细粒度 token:Settings → Developer settings → Fine-grained tokens。',
      '   仓库访问选 <b>Only select repositories</b> 并只勾这个备份仓库;',
      '   权限只给 <b>Contents: Read and write</b>,其余全部留空。有效期建议 90 天。<br>',
      '3. 把仓库名 <code>owner/name</code> 和 token 填到上面,保存 → 测试连接 → 立即同步。<br>',
      '4. 换设备时,只要填上同样的仓库和 token,点「从云端恢复」即可。<br>',
      '<b>注意:</b>创建仓库和 token 需要访问 github.com 网页,如果被网络阻断,请换用手机流量。',
      '</div>',

      '<div class="fsync-actions" style="margin-top:18px">',
      '  <button id="fsync-close" class="ghost">关闭</button>',
      '  <button id="fsync-revoke" class="ghost danger">清除本机 token</button>',
      '</div>'
    ].join('');
    document.body.appendChild(panelEl);

    badgeEl = document.createElement('button');
    badgeEl.className = 'fsync-btn';
    badgeEl.innerHTML = '☁<span class="dot" id="fsync-dot"></span>';
    badgeEl.title = '备份与同步';
    badgeEl.addEventListener('click', openPanel);
    document.body.appendChild(badgeEl);

    taEl = $('#fsync-out');

    $('#fsync-close').addEventListener('click', closePanel);
    $('#fsync-save').addEventListener('click', saveSettingsFromUI);
    $('#fsync-test').addEventListener('click', testConnection);
    $('#fsync-now').addEventListener('click', function () {
      state.pending = true; saveState(); sync(0);
    });
    $('#fsync-pull').addEventListener('click', pullOnly);
    $('#fsync-export').addEventListener('click', doExport);
    $('#fsync-copy').addEventListener('click', function () {
      var txt = exportJSON();
      taEl.value = txt;
      copyText(txt, '备份内容已复制,请粘贴到备忘录或发给自己');
    });
    $('#fsync-import').addEventListener('click', function () { $('#fsync-file').click(); });
    $('#fsync-file').addEventListener('change', onFilePicked);
    $('#fsync-paste-toggle').addEventListener('click', function () {
      var w = $('#fsync-paste-wrap');
      w.style.display = (w.style.display === 'none') ? 'block' : 'none';
    });
    $('#fsync-import-text').addEventListener('click', function () { importText(false); });
    $('#fsync-import-text-over').addEventListener('click', function () { importText(true); });
    $('#fsync-copylog').addEventListener('click', function () {
      copyText(state.log.map(function (l) { return l.t + ' [' + l.level + '] ' + l.msg; }).join('\n'), '日志已复制');
    });
    $('#fsync-revoke').addEventListener('click', function () {
      if (!confirm('清除本机保存的 token?清除后同步会停止,直到你重新填写。')) return;
      cfg.token = '';
      saveCfg();
      renderStatus();
      alert('已清除。别忘了去 GitHub 上把那个 token 也撤销掉。');
    });

    fillSettingsUI();
  }

  function fillSettingsUI() {
    $('#fsync-repo').value = cfg.repo || '';
    $('#fsync-branch').value = cfg.branch || '';
    $('#fsync-path').value = cfg.path || '';
    $('#fsync-expiry').value = cfg.tokenExpiry || '';
    $('#fsync-token').value = '';
    $('#fsync-token').placeholder = cfg.token
      ? '已保存(尾号 ' + cfg.token.slice(-4) + '),留空则不修改'
      : 'github_pat_…';
  }

  function openPanel()  { panelEl.classList.add('open'); renderStatus(); }
  function closePanel() { panelEl.classList.remove('open'); }

  function saveSettingsFromUI() {
    cfg.repo = $('#fsync-repo').value.trim();
    cfg.branch = $('#fsync-branch').value.trim() || 'master';
    cfg.path = $('#fsync-path').value.trim() || 'fitness-data.json';
    cfg.tokenExpiry = $('#fsync-expiry').value.trim();
    var t = $('#fsync-token').value.trim();
    if (t) cfg.token = t;                  // 留空表示不改动
    saveCfg();
    fillSettingsUI();
    logLine('info', '设置已保存');
    renderStatus();
  }

  function renderStatus() {
    if (!panelEl) return;
    var st = $('#fsync-status');
    var dot = $('#fsync-dot');
    if (!st) return;

    var local = readLocal();
    var lines = [];
    lines.push('本地记录:<b>' + countOf(local.data) + '</b> 条');
    if (mirror) lines.push('备份快照:<b>' + countOf(mirror) + '</b> 条');
    if (state.lastSyncAt) lines.push('上次同步:<b>' + esc(new Date(state.lastSyncAt).toLocaleString('zh-CN')) + '</b>');
    if (state.pending) lines.push('<b>有改动等待上传</b>');
    if (state.suppressAutoRestore) lines.push('<b>已暂停自动恢复</b>(你清空过数据)');
    if (!configured()) lines.push('尚未配置云备份');
    lines.push('设备编号:<b>' + esc(cfg.device) + '</b>');
    st.innerHTML = lines.join('<br>');

    if (dot) dot.className = 'dot' + (state.pending || state.lastError ? ' on' : '');

    var wb = $('#fsync-warnbox');
    if (wb) wb.innerHTML = tokenWarning();

    var lg = $('#fsync-log');
    if (lg) {
      lg.textContent = state.log.slice(-40).map(function (l) {
        return l.t + ' [' + l.level + '] ' + l.msg;
      }).join('\n') || '(暂无)';
      lg.scrollTop = lg.scrollHeight;
    }
  }

  /* ---- 导出 ---- */

  function exportJSON() {
    var local = readLocal();
    var d = local.data || { fitness: [], diet: [] };
    return JSON.stringify({
      app: 'fitness',
      schema: 1,
      exportedAt: nowISO(),
      counts: { fitness: (d.fitness || []).length, diet: (d.diet || []).length },
      fitness: d.fitness || [],
      diet: d.diet || []
    }, null, 1);
  }

  function doExport() {
    var txt = exportJSON();
    taEl.value = txt;
    var name = 'fitness-backup-' + todayStamp() + '.json';
    try {
      var file = new File([txt], name, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: '健身记录备份' })
          .then(function () { logLine('info', '已通过分享导出'); })
          .catch(function () { downloadFallback(txt, name); });
        return;
      }
    } catch (e) { /* 继续走下面的退路 */ }
    downloadFallback(txt, name);
  }

  function downloadFallback(txt, name) {
    try {
      var blob = new Blob([txt], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      logLine('info', '已生成备份文件:' + name);
    } catch (e) {
      logLine('warn', '无法直接保存文件,请用「复制备份内容」或下面的文本框手动复制');
    }
  }

  function copyText(txt, okMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () {
        logLine('info', okMsg);
      }).catch(function () { selectOut(); });
    } else {
      selectOut();
    }
  }

  function selectOut() {
    taEl.focus();
    taEl.select();
    logLine('warn', '请长按文本框全选并复制');
  }

  /* ---- 导入 ---- */

  function parseImport(text) {
    var p;
    try { p = JSON.parse(text); } catch (e) { return null; }
    if (!p || typeof p !== 'object') return null;
    if (!Array.isArray(p.fitness) || !Array.isArray(p.diet)) return null;
    return { fitness: p.fitness, diet: p.diet };
  }

  function applyImport(incoming, overwrite) {
    var local = readLocal();
    var cur = local.data || { fitness: [], diet: [] };

    var result;
    if (overwrite) {
      var now = Date.now();
      result = {
        fitness: incoming.fitness.map(function (r) {
          var c = {}; for (var k in r) c[k] = r[k];
          c._m = idTime(r.id) || now; return c;
        }),
        diet: incoming.diet.map(function (r) {
          var c = {}; for (var k in r) c[k] = r[k];
          c._m = idTime(r.id) || now; return c;
        })
      };
    } else {
      var f = mergeType(cur.fitness, incoming.fitness, state.deleted.fitness, {});
      var d = mergeType(cur.diet, incoming.diet, state.deleted.diet, {});
      result = { fitness: f.records, diet: d.records };
    }

    if (applyMerged(result, overwrite ? 'import-overwrite' : 'import-merge')) {
      state.suppressAutoRestore = false;
      saveMirror(result);
      state.pending = true;
      saveState();
      schedulePush();
      logLine('info', '导入完成,共 ' + countOf(result) + ' 条记录');
    }
    renderStatus();
  }

  function onFilePicked(e) {
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      var parsed = parseImport(String(reader.result));
      if (!parsed) { alert('文件格式不正确,没有改动任何数据。'); return; }
      var sum = parsed.fitness.length + parsed.diet.length;
      if (confirm('读取到 ' + sum + ' 条记录。\n\n确定 = 与现有记录合并(不会删掉任何东西)\n取消 = 不改动')) {
        applyImport(parsed, false);
      }
    };
    reader.readAsText(f);
    e.target.value = '';
  }

  function importText(overwrite) {
    var txt = $('#fsync-paste').value.trim();
    if (!txt) { alert('请先粘贴备份内容。'); return; }
    var parsed = parseImport(txt);
    if (!parsed) { alert('内容格式不正确,没有改动任何数据。'); return; }
    var sum = parsed.fitness.length + parsed.diet.length;
    var msg = overwrite
      ? '确定要用这 ' + sum + ' 条记录【覆盖】现有数据吗?现有记录会被清掉。'
      : '确定把这 ' + sum + ' 条记录【合并】进来吗?不会删掉任何现有记录。';
    if (confirm(msg)) applyImport(parsed, overwrite);
  }

  /* ---- 网络诊断 ---- */

  function testConnection() {
    saveSettingsFromUI();
    if (!cfg.repo) { alert('请先填写仓库名,格式 owner/name'); return; }
    if (!cfg.token) { alert('请先填写 token'); return; }
    logLine('info', '正在测试连接…');

    ghFetch('/', { auth: false }).then(function (r) {
      if (!r.ok) {
        logLine('error', '网络检测失败:连不上 api.github.com。' + describeError(r));
        renderStatus();
        return null;
      }
      logLine('info', '网络正常,继续校验仓库权限…');
      var parts = cfg.repo.split('/');
      return ghFetch('/repos/' + parts[0] + '/' + parts[1]).then(function (rr) {
        if (rr.notFound) { logLine('error', '仓库不存在或 token 未授权:' + cfg.repo); return null; }
        if (!rr.ok) { logLine('error', describeError(rr)); return null; }
        logLine('info', '仓库可访问。继续校验写权限…');
        return fetchRemote().then(function (fr) {
          if (!fr.ok) { logLine('error', '读取数据文件失败:' + describeError(fr)); return null; }
          logLine('info', fr.empty
            ? '连接正常。云端还没有数据文件,第一次同步会创建它。'
            : '连接正常。云端现有 ' + countOf(fr.data) + ' 条记录。');
          renderStatus();
        });
      });
    });
  }

  function pullOnly() {
    if (!configured()) { alert('请先配置仓库和 token。'); return; }
    var local = readLocal();
    var cur = local.data || { fitness: [], diet: [] };
    logLine('info', '正在从云端拉取…');
    fetchRemote().then(function (r) {
      if (!r.ok) { logLine('error', describeError(r)); renderStatus(); return; }
      if (r.empty || !r.data) { logLine('warn', '云端还没有数据文件'); renderStatus(); return; }
      var f = mergeType(cur.fitness, r.data.fitness, state.deleted.fitness, (r.data.deleted || {}).fitness);
      var d = mergeType(cur.diet, r.data.diet, state.deleted.diet, (r.data.deleted || {}).diet);
      var result = { fitness: f.records, diet: d.records };
      if (applyMerged(result, 'pull')) {
        state.lastSha = r.sha;
        state.suppressAutoRestore = false;
        saveMirror(result);
        saveState();
        renderStatus();
      }
    });
  }

  /* ==========================================================================
   * 12. 启动
   * ========================================================================*/

  function boot() {
    window.addEventListener('error', function (e) {
      logLine('error', '页面脚本报错:' + (e.message || ''));
    });

    loadCfg();
    loadState();
    loadMirror();

    // 承重:必须在这里同步执行,不能放进 DOMContentLoaded 回调 ——
    // App 的 DOMContentLoaded 监听器在解析期间就已注册,会先于我们执行。
    preInitRestore();
    saveState();

    function uiInit() {
      try {
        injectCSS();
        buildPanel();
        installHooks();
        renderStatus();
        if (configured()) {
          setTimeout(function () { sync(0); }, 2000);
        } else {
          logLine('info', '还没配置云备份,可以先用「导出备份文件」保住现在的记录');
        }
      } catch (e) {
        // UI 起不来也绝不能影响 App
        if (window.console) console.warn('[sync] UI init failed:', e);
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', uiInit);
    } else {
      uiInit();
    }
  }

  try { boot(); } catch (e) {
    if (window.console) console.warn('[sync] boot failed:', e);
  }
})();
