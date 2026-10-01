(() => {
  "use strict";

  const STORAGE_KEY = "baseball_handicap_pwa_shared_v02_cache";
  const VERSION = 5;
  // POSと同じFirebase Realtime Databaseを利用し、野球アプリ専用パスへ分離。
  const FIREBASE_DATABASE_URL = "https://blow-pos-default-rtdb.asia-southeast1.firebasedatabase.app";
  const CLOUD_ROOT = "blow2nd/baseball_handicap";

  const BASE_TEAMS = {
    "セ・リーグ": ["阪神タイガース","横浜DeNAベイスターズ","読売ジャイアンツ","中日ドラゴンズ","広島東洋カープ","東京ヤクルトスワローズ"],
    "パ・リーグ": ["福岡ソフトバンクホークス","北海道日本ハムファイターズ","オリックス・バファローズ","東北楽天ゴールデンイーグルス","埼玉西武ライオンズ","千葉ロッテマリーンズ"],
    "ア・リーグ": ["ボルチモア・オリオールズ","ボストン・レッドソックス","ニューヨーク・ヤンキース","タンパベイ・レイズ","トロント・ブルージェイズ","シカゴ・ホワイトソックス","クリーブランド・ガーディアンズ","デトロイト・タイガース","カンザスシティ・ロイヤルズ","ミネソタ・ツインズ","ヒューストン・アストロズ","ロサンゼルス・エンゼルス","アスレチックス","シアトル・マリナーズ","テキサス・レンジャーズ"],
    "ナ・リーグ": ["アトランタ・ブレーブス","マイアミ・マーリンズ","ニューヨーク・メッツ","フィラデルフィア・フィリーズ","ワシントン・ナショナルズ","シカゴ・カブス","シンシナティ・レッズ","ミルウォーキー・ブルワーズ","ピッツバーグ・パイレーツ","セントルイス・カージナルス","アリゾナ・ダイヤモンドバックス","コロラド・ロッキーズ","ロサンゼルス・ドジャース","サンディエゴ・パドレス","サンフランシスコ・ジャイアンツ"]
  };

  // ハンデは打ち込み式。数値ハンデは0.1刻みで4.0まで対応。
  // 「1.5」と「1半」は別ルール。半系は 1半〜3半9 まで対応する。
  // 旧版の 1H / 1H3 形式も読み込み時に互換変換する。
  const HANDICAP_SUGGESTIONS = [
    ...Array.from({length:40}, (_,i)=>{
      const n=(i+1)/10;
      return Number.isInteger(n) ? String(n) : n.toFixed(1);
    }),
    ...[1,2,3].flatMap(base => [
      `${base}半`,
      ...Array.from({length:9}, (_,i)=>`${base}半${i+1}`)
    ])
  ];

  function normalizeHandicapInput(raw) {
    let v = String(raw ?? "").trim()
      .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/[．。・]/g, ".")
      .replace(/\s+/g, "")
      .replace(/^([1-3])[hH](\d?)$/, (_,base,d)=>`${base}半${d||""}`);
    if (!v) return "";

    const half = v.match(/^([1-3])半([1-9])?$/);
    if (half) return `${half[1]}半${half[2] || ""}`;

    if (!/^\d+(?:\.\d+)?$/.test(v)) return "";
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 4) return "";
    const tenth = Math.round(n * 10) / 10;
    if (Math.abs(n - tenth) > 1e-9) return ""; // 0.1刻みのみ
    if (tenth === 0) return "0";
    if (Number.isInteger(tenth)) return String(tenth);
    return tenth.toFixed(1);
  }

  function giverMultiplier(handicapId, margin) {
    if (margin < 0) return -1;
    const h = normalizeHandicapInput(handicapId);
    if (!h) throw new Error("未対応ハンデ");

    // n半 / n半1〜n半9
    // 例: 2半 → 2点差までは丸負け、3点差で丸勝ち。
    //     2半3 → 2点差までは丸負け、3点差で7分勝ち、4点差以上で丸勝ち。
    const half = h.match(/^([1-3])半([1-9])?$/);
    if (half) {
      const base = Number(half[1]);
      const suffix = half[2] ? Number(half[2]) : null;
      if (margin <= base) return -1;
      if (suffix === null) return 1; // base+1点差以上
      if (margin === base + 1) return (10 - suffix) / 10;
      return 1; // base+2点差以上
    }

    const n = Number(h);
    const base = Math.floor(n + 1e-9);
    const frac = Math.round((n - base) * 10) / 10;

    // 整数ハンデ: 例 4 → 3点差以下=丸負け / 4点差=勝負無し / 5点差以上=丸勝ち
    if (frac === 0) {
      if (margin < base) return -1;
      if (margin === base) return 0;
      return 1;
    }

    // 0.xだけは元表どおり、1点差勝ちで残り割合が勝ちになる。
    // 例 0.3 → 引分3分負け / 1点差7分勝ち / 2点差以上丸勝ち
    if (base === 0) {
      if (margin === 0) return -frac;
      if (margin === 1) return 1 - frac;
      return 1;
    }

    // 1.1〜3.9: 整数部分の点差までは負け側、次の1点で丸勝ち。
    // 例 2.3 → 1点差以下丸負け / 2点差3分負け / 3点差以上丸勝ち
    if (margin < base) return -1;
    if (margin === base) return -frac;
    return 1;
  }

  function handicapRuleRow(handicapId, maxMargin=5) {
    const h = normalizeHandicapInput(handicapId);
    if (!h) return null;
    return Array.from({length:maxMargin+1}, (_,m)=>outcomeLabel(giverMultiplier(h, m)));
  }

  function outcomeLabel(mult) {
    const abs = Math.abs(mult);
    if (mult === 0) return "勝負無し";
    if (mult === 1) return "丸勝ち";
    if (mult === -1) return "丸負け";
    const n = Math.round(abs * 10);
    return `${n}分${mult > 0 ? "勝ち" : "負け"}`;
  }

  const defaultState = () => ({
    version: VERSION,
    games: [],
    bettors: [],
    customTeams: {"セ・リーグ":[],"パ・リーグ":[],"ア・リーグ":[],"ナ・リーグ":[]},
    settings: {rounding:"round"}
  });

  let state = loadCache();
  let route = "today";
  let deferredPrompt = null;
  let syncTimer = null;
  let cloudReady = false;
  let editingDirty = false;
  let cloudWriteInFlight = 0;

  function isEditableElement(el) {
    return !!el && (
      el.matches?.("input, textarea, select") ||
      el.isContentEditable
    );
  }

  function shouldDeferCloudRender() {
    const modal = document.getElementById("modal");
    return cloudWriteInFlight > 0 || editingDirty || isEditableElement(document.activeElement) || !!modal?.open;
  }

  function loadCache() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      return normalizeState(JSON.parse(raw));
    } catch {
      return defaultState();
    }
  }

  function saveCache() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function normalizeState(raw) {
    const base = defaultState();
    if (!raw || typeof raw !== "object") return base;

    const gamesRaw = raw.games || {};
    const games = (Array.isArray(gamesRaw) ? gamesRaw.filter(Boolean) : Object.values(gamesRaw)).map(g => {
      const betsRaw = g?.bets || {};
      const bets = Array.isArray(betsRaw) ? betsRaw.filter(Boolean) : Object.values(betsRaw);
      return {...g, bets};
    }).filter(g => g && g.id);

    const customTeams = {...base.customTeams};
    for (const league of Object.keys(customTeams)) {
      const x = raw.customTeams?.[league];
      if (Array.isArray(x)) customTeams[league] = x.filter(Boolean).map(v => typeof v === "string" ? v : v?.name).filter(Boolean);
      else if (x && typeof x === "object") customTeams[league] = Object.values(x).map(v => typeof v === "string" ? v : v?.name).filter(Boolean);
    }

    const bettors = [...new Set(games.flatMap(g => (g.bets || []).map(b => b.bettor).filter(Boolean)))];
    return {...base, ...raw, games, bettors, customTeams};
  }

  function toCloudState(src) {
    const games = {};
    for (const g of src.games || []) {
      const bets = {};
      for (const b of g.bets || []) bets[b.id] = b;
      games[g.id] = {...g, bets};
    }
    const customTeams = {};
    for (const [league, list] of Object.entries(src.customTeams || {})) {
      customTeams[league] = {};
      for (const name of list || []) customTeams[league][uid("team")] = {name};
    }
    return {version:VERSION, games, customTeams, settings:src.settings || {rounding:"round"}};
  }

  function cloudUrl(path="") {
    const clean = String(path).split("/").filter(Boolean).map(encodeURIComponent).join("/");
    return `${FIREBASE_DATABASE_URL}/${CLOUD_ROOT}${clean ? "/" + clean : ""}.json`;
  }

  function setSyncStatus(kind, text) {
    const el = document.getElementById("syncStatus");
    if (!el) return;
    el.className = `sync-status ${kind}`;
    el.textContent = text;
  }

  async function cloudRequest(method, path="", body=undefined) {
    const options = {method, cache:"no-store"};
    if (body !== undefined) {
      options.headers = {"Content-Type":"application/json"};
      options.body = JSON.stringify(body);
    }
    const res = await fetch(cloudUrl(path), options);
    const txt = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}${txt ? " " + txt : ""}`);
    if (res.status === 204 || !txt) return null;
    return JSON.parse(txt);
  }

  async function refreshFromCloud({silent=false}={}) {
    try {
      const remote = await cloudRequest("GET");
      cloudReady = true;
      setSyncStatus("online", shouldDeferCloudRender() ? "全員共通・入力中" : "全員共通・同期中");

      // 入力中に app.innerHTML を作り直すと、未保存の文字が消える。
      // Firebase の取得自体は続けるが、フォーム編集中は state / DOM へ反映しない。
      // 入力確定・画面遷移後の次回ポーリングで最新状態を反映する。
      if (shouldDeferCloudRender()) {
        if (!silent) toast("共通データに接続しました");
        return;
      }

      state = normalizeState(remote || {});
      saveCache();
      render();
      if (!silent) toast("共通データに接続しました");
    } catch (err) {
      cloudReady = false;
      const detail = err?.message || String(err);
      setSyncStatus("offline", navigator.onLine ? `共通データ読込エラー: ${detail}` : "オフライン");
      if (!silent) toast("共通データへ接続できません");
      console.error(err);
    }
  }

  function scheduleCloudRefresh() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => refreshFromCloud({silent:true}), 120);
  }

  let cloudPollTimer = null;
  function startCloudPolling() {
    clearInterval(cloudPollTimer);
    cloudPollTimer = setInterval(() => {
      if (navigator.onLine) refreshFromCloud({silent:true});
    }, 2500);
  }

  async function writeCloud(method, path, body, successText) {
    cloudWriteInFlight++;
    try {
      setSyncStatus("connecting", "保存中…");
      await cloudRequest(method, path, body);
      saveCache();
      setSyncStatus("online", "全員共通・同期中");
      if (successText) toast(successText);
      scheduleCloudRefresh();
      return true;
    } catch (err) {
      console.error(err);
      setSyncStatus("offline", "クラウド保存エラー");
      toast("保存に失敗しました。通信を確認してください");
      return false;
    } finally {
      cloudWriteInFlight = Math.max(0, cloudWriteInFlight - 1);
      if (!cloudWriteInFlight && navigator.onLine) scheduleCloudRefresh();
    }
  }

  function uid(prefix="id") {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
  }

  function yen(n) {
    const sign = n > 0 ? "+" : "";
    return `${sign}¥${Math.round(n).toLocaleString("ja-JP")}`;
  }

  function hcapLabel(id) {
    return normalizeHandicapInput(id) || String(id || "");
  }

  function teamsFor(league) {
    return [...(BASE_TEAMS[league]||[]), ...(state.customTeams[league]||[])];
  }

  function leagueGroup(league) {
    return ["セ・リーグ","パ・リーグ"].includes(league) ? "NPB" : "MLB";
  }

  function todayStr() {
    const d = new Date();
    const z = n => String(n).padStart(2,"0");
    return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`;
  }

  function esc(v="") {
    return String(v).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

  function settleGame(game) {
    if (game.scoreA === null || game.scoreB === null || game.scoreA === "" || game.scoreB === "") return null;
    const scoreA = Number(game.scoreA), scoreB = Number(game.scoreB);
    const giverIsA = game.handicapGiver === game.teamA;
    const giverScore = giverIsA ? scoreA : scoreB;
    const recvScore = giverIsA ? scoreB : scoreA;
    const margin = giverScore - recvScore;
    const gm = giverMultiplier(game.handicapId, margin);
    const bets = game.bets.map(b => {
      const mult = b.team === game.handicapGiver ? gm : -gm;
      const profit = Math.round(Number(b.amount) * mult);
      return {...b, multiplier:mult, outcome:outcomeLabel(mult), profit};
    });
    return {margin, giverMultiplier:gm, giverOutcome:outcomeLabel(gm), bets};
  }

  function gameStatus(game) {
    return settleGame(game) ? "settled" : "open";
  }

  function render() {
    // render() はユーザー操作で入力が確定した時か、編集中でないクラウド同期時だけ呼ぶ。
    editingDirty = false;
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.route === route));
    const app = document.getElementById("app");
    if (route === "today") app.innerHTML = renderToday();
    if (route === "new") app.innerHTML = renderNew();
    if (route === "settlement") app.innerHTML = renderSettlement();
    if (route === "history") app.innerHTML = renderHistory();
    if (route === "settings") app.innerHTML = renderSettings();
    bindRouteEvents();
  }

  function renderToday() {
    const date = todayStr();
    const games = state.games.filter(g => g.date === date).sort((a,b)=>b.createdAt-a.createdAt);
    return `
      <div class="section-title">
        <div><h2>今日の試合</h2><div class="muted small">${date}</div></div>
        <button class="primary-btn" data-go="new">＋ 試合</button>
      </div>
      ${games.length ? games.map(renderGameCard).join("") : `
        <div class="card empty">まだ試合がありません。<br>「試合登録」から追加できます。</div>
      `}
      <div class="card">
        <div class="section-title"><h3>今日の客別合計</h3><span class="badge">結果入力済のみ</span></div>
        ${renderAggregate(date)}
      </div>
    `;
  }

  function renderGameCard(game) {
    const settled = settleGame(game);
    const status = settled ? "settled" : "open";
    return `
      <section class="card game-card">
        <div class="game-head">
          <div>
            <div class="inline-actions">
              <span class="badge">${esc(leagueGroup(game.league))}</span>
              <span class="badge">${esc(game.league)}</span>
              <span class="badge ${status}">${settled ? "結果入力済" : "受付中"}</span>
            </div>
            <div class="matchup" style="margin-top:9px">${esc(game.teamA)} <span class="muted">vs</span> ${esc(game.teamB)}</div>
            <div class="hcap-line">ハンデ：<b>${esc(game.handicapGiver)}</b> が <b>${esc(hcapLabel(game.handicapId))}</b> 出し</div>
          </div>
        </div>

        ${settled ? `
          <div class="score-line">
            <div><div class="score-team">${esc(game.teamA)}</div>${game.scoreA}</div>
            <span class="muted">-</span>
            <div><div class="score-team">${esc(game.teamB)}</div>${game.scoreB}</div>
          </div>
          <div class="note">ハンデ出し側判定：${esc(settled.giverOutcome)}</div>
        ` : ""}

        <div class="divider"></div>
        <div class="section-title"><h3>賭け登録</h3><span class="muted small">${game.bets.length}件</span></div>
        ${game.bets.length ? game.bets.map(b => {
          const sb = settled?.bets.find(x=>x.id===b.id);
          return `<div class="bet-row">
            <strong>${esc(b.bettor)}</strong>
            <span>${esc(b.team)}</span>
            <span class="money">¥${Number(b.amount).toLocaleString("ja-JP")}</span>
            ${sb ? `<span class="${sb.profit>0?'positive':sb.profit<0?'negative':'zero'}">${esc(sb.outcome)} ${yen(sb.profit)}</span>` : `<button class="ghost-btn small" data-delete-bet="${b.id}" data-game="${game.id}">削除</button>`}
          </div>`;
        }).join("") : `<div class="muted small">まだ登録なし</div>`}

        <div class="inline-actions" style="margin-top:14px">
          ${!settled ? `<button class="secondary-btn" data-add-bet="${game.id}">＋ 賭け</button>` : ""}
          <button class="secondary-btn" data-result="${game.id}">${settled ? "結果を修正" : "結果入力"}</button>
          <button class="danger-btn" data-delete-game="${game.id}">試合削除</button>
        </div>
      </section>
    `;
  }

  function renderNew() {
    const defaultLeague = "セ・リーグ";
    return `
      <div class="section-title"><div><h2>試合登録</h2><div class="muted small">リーグ → 対戦 → ハンデを登録</div></div></div>
      <form id="newGameForm" class="card">
        <div class="grid grid-2">
          <div>
            <label>日付</label>
            <input type="date" name="date" value="${todayStr()}" required>
          </div>
          <div>
            <label>リーグ</label>
            <select name="league" id="leagueSelect">
              <option>セ・リーグ</option><option>パ・リーグ</option><option>ア・リーグ</option><option>ナ・リーグ</option>
            </select>
          </div>
          <div>
            <label>チームA</label>
            <select name="teamA" id="teamA" required></select>
          </div>
          <div>
            <label>チームB</label>
            <select name="teamB" id="teamB" required></select>
          </div>
          <div>
            <label>ハンデを出すチーム</label>
            <select name="giver" id="giverSelect" required></select>
          </div>
          <div>
            <label>ハンデ（打ち込み）</label>
            <input name="handicap" id="handicapInput" list="handicapSuggestions" inputmode="decimal" autocomplete="off" placeholder="例: 0.1 / 2.3 / 3.7 / 4.0 / 2半3" required>
            <datalist id="handicapSuggestions">
              ${HANDICAP_SUGGESTIONS.map(h=>`<option value="${h}"></option>`).join("")}
            </datalist>
          </div>
        </div>
        <div id="handicapPreview" class="note" style="margin:14px 0">0.1〜4.0を0.1刻みで直接入力できます。「1.5」と「1半」は別ルールです。</div>
        <button class="primary-btn full" type="submit">試合を登録</button>
      </form>
    `;
  }

  function renderSettlement() {
    const dates = [...new Set(state.games.map(g=>g.date))].sort().reverse();
    const chosen = dates[0] || todayStr();
    return `
      <div class="section-title"><div><h2>客別まとめ精算</h2><div class="muted small">結果入力済み試合を合算</div></div></div>
      <div class="card">
        <label>対象日</label>
        <select id="settlementDate">
          ${dates.length ? dates.map(d=>`<option value="${d}" ${d===chosen?"selected":""}>${d}</option>`).join("") : `<option value="${todayStr()}">${todayStr()}</option>`}
        </select>
        <div id="aggregateArea" style="margin-top:14px">${renderAggregate(chosen)}</div>
      </div>
    `;
  }

  function renderAggregate(date) {
    const games = state.games.filter(g=>g.date===date);
    const map = new Map();
    let totalStake = 0, settledCount = 0;
    games.forEach(g=>{
      const s = settleGame(g);
      if (!s) return;
      settledCount++;
      s.bets.forEach(b=>{
        totalStake += Number(b.amount);
        const prev = map.get(b.bettor) || {stake:0, profit:0, bets:0};
        prev.stake += Number(b.amount);
        prev.profit += b.profit;
        prev.bets++;
        map.set(b.bettor, prev);
      });
    });
    if (!map.size) return `<div class="empty">精算できる結果がありません。</div>`;
    const rows = [...map.entries()].sort((a,b)=>b[1].profit-a[1].profit);
    const net = rows.reduce((a,[,v])=>a+v.profit,0);
    return `
      <div class="summary-box">
        <div class="metric"><div class="k">結果入力済み試合</div><div class="v">${settledCount}</div></div>
        <div class="metric"><div class="k">登録金額合計</div><div class="v">¥${totalStake.toLocaleString("ja-JP")}</div></div>
        <div class="metric"><div class="k">客側損益合計</div><div class="v ${net>0?'positive':net<0?'negative':'zero'}">${yen(net)}</div></div>
      </div>
      <div style="margin-top:14px">
        ${rows.map(([name,v])=>`
          <div class="settlement-row">
            <strong>${esc(name)}</strong>
            <span>${v.bets}件</span>
            <span class="money">¥${v.stake.toLocaleString("ja-JP")}</span>
            <span class="${v.profit>0?'positive':v.profit<0?'negative':'zero'}">${yen(v.profit)}</span>
          </div>`).join("")}
      </div>
    `;
  }

  function renderHistory() {
    const games = [...state.games].sort((a,b)=> (b.date+a.createdAt).localeCompare(a.date+a.createdAt));
    return `
      <div class="section-title"><div><h2>履歴</h2><div class="muted small">全試合</div></div></div>
      ${games.length ? games.map(g=>`
        <div class="card">
          <div class="game-head">
            <div>
              <div class="muted small">${esc(g.date)} / ${esc(g.league)}</div>
              <div class="matchup">${esc(g.teamA)} vs ${esc(g.teamB)}</div>
              <div class="hcap-line">${esc(g.handicapGiver)} が ${esc(hcapLabel(g.handicapId))} 出し</div>
            </div>
            <span class="badge ${gameStatus(g)}">${settleGame(g) ? `${g.scoreA}-${g.scoreB}` : "未結果"}</span>
          </div>
          <button class="secondary-btn" data-open-game="${g.id}">今日画面で開く</button>
        </div>
      `).join("") : `<div class="card empty">履歴なし</div>`}
    `;
  }

  function renderSettings() {
    return `
      <div class="section-title"><div><h2>設定</h2><div class="muted small">ルール・チーム・バックアップ</div></div></div>

      <div class="card">
        <div class="section-title"><h3>ハンデ計算マスター</h3><span class="badge">0.1刻み</span></div>
        <div class="table-wrap">
          <table class="rule-table">
            <thead><tr><th>出し</th><th>引分</th><th>1点差勝ち</th><th>2点差勝ち</th><th>3点差勝ち</th><th>4点差勝ち</th><th>5点差勝ち</th></tr></thead>
            <tbody>
              ${HANDICAP_SUGGESTIONS.map(h=>`<tr><th>${h}</th>${handicapRuleRow(h).map(x=>`<td>${x}</td>`).join("")}</tr>`).join("")}
            </tbody>
          </table>
        </div>
        <p class="muted small">ハンデを出しているチーム側から見た判定。相手側に賭けた場合は勝敗率を反転します。数値は0.1〜4.0を0.1刻みで対応。半系は1半〜3半9に対応。</p>
      </div>

      <div class="card">
        <h3>チーム追加</h3>
        <form id="customTeamForm" class="grid grid-2" style="margin-top:12px">
          <div>
            <label>リーグ</label>
            <select name="league"><option>セ・リーグ</option><option>パ・リーグ</option><option>ア・リーグ</option><option>ナ・リーグ</option></select>
          </div>
          <div>
            <label>チーム名</label>
            <input name="team" placeholder="チーム名" required>
          </div>
          <button class="secondary-btn" type="submit">追加</button>
        </form>
      </div>

      <div class="card">
        <h3>バックアップ</h3>
        <p class="muted small">データ本体は全員共通のFirebaseに保存し、この端末には表示用キャッシュも保持します。JSONは手動バックアップ用です。</p>
        <div class="inline-actions">
          <button class="secondary-btn" id="exportBtn">JSON書き出し</button>
          <label class="secondary-btn" style="display:inline-block;color:var(--text);margin:0">
            JSON読み込み
            <input id="importInput" type="file" accept="application/json" class="hidden">
          </label>
          <button class="danger-btn" id="resetBtn">全データ削除</button>
        </div>
      </div>

      <div class="card">
        <h3>計算仕様</h3>
        <p class="muted small">3分=30%、5分=50%、7分=70%、丸=100%、勝負無し=0%。金額の端数は1円単位で四捨五入します。</p>
      </div>
    `;
  }

  function bindRouteEvents() {
    document.querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>{route=b.dataset.go;render();});

    const league = document.getElementById("leagueSelect");
    if (league) {
      const updateTeams = () => {
        const list = teamsFor(league.value);
        const a = document.getElementById("teamA"), b = document.getElementById("teamB");
        a.innerHTML = list.map(t=>`<option>${esc(t)}</option>`).join("");
        b.innerHTML = list.map((t,i)=>`<option ${i===1?"selected":""}>${esc(t)}</option>`).join("");
        updateGiver();
      };
      const updateGiver = () => {
        const a = document.getElementById("teamA").value;
        const b = document.getElementById("teamB").value;
        document.getElementById("giverSelect").innerHTML = `<option>${esc(a)}</option><option>${esc(b)}</option>`;
      };
      league.onchange = updateTeams;
      document.getElementById("teamA").onchange = updateGiver;
      document.getElementById("teamB").onchange = updateGiver;
      updateTeams();
    }

    const handicapInput = document.getElementById("handicapInput");
    const handicapPreview = document.getElementById("handicapPreview");
    if (handicapInput && handicapPreview) {
      const updateHandicapPreview = () => {
        const h = normalizeHandicapInput(handicapInput.value);
        if (!h) {
          handicapPreview.textContent = "入力例: 0.1 / 2.3 / 3.7 / 4.0 / 2半3（0.1刻み）";
          return;
        }
        const r = handicapRuleRow(h, 5);
        handicapPreview.innerHTML = `<b>${esc(h)}</b>：引分 ${esc(r[0])} / 1点差 ${esc(r[1])} / 2点差 ${esc(r[2])} / 3点差 ${esc(r[3])} / 4点差 ${esc(r[4])} / 5点差 ${esc(r[5])}`;
      };
      handicapInput.addEventListener("input", updateHandicapPreview);
      updateHandicapPreview();
    }

    const newForm = document.getElementById("newGameForm");
    if (newForm) newForm.onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(newForm);
      const teamA = fd.get("teamA"), teamB = fd.get("teamB");
      if (teamA === teamB) return toast("同じチーム同士は登録できません");
      const giver = fd.get("giver");
      if (![teamA,teamB].includes(giver)) return toast("ハンデ出しチームを確認してください");
      const handicap = normalizeHandicapInput(fd.get("handicap"));
      if (!handicap) return toast("ハンデは0.1〜4.0の0.1刻み、または1半〜3半系で入力してください");
      const game = {
        id:uid("game"),
        createdAt:Date.now(),
        date:fd.get("date"),
        league:fd.get("league"),
        teamA, teamB,
        handicapGiver:giver,
        handicapId:handicap,
        bets:[],
        scoreA:null, scoreB:null
      };
      state.games.push(game);
      saveCache();
      route="today";
      render();
      await writeCloud("PUT", `games/${game.id}`, {...game, bets:{}}, "試合を共通データへ登録しました");
    };

    document.querySelectorAll("[data-add-bet]").forEach(b=>b.onclick=()=>openBetModal(b.dataset.addBet));
    document.querySelectorAll("[data-result]").forEach(b=>b.onclick=()=>openResultModal(b.dataset.result));
    document.querySelectorAll("[data-delete-game]").forEach(b=>b.onclick=()=>deleteGame(b.dataset.deleteGame));
    document.querySelectorAll("[data-delete-bet]").forEach(b=>b.onclick=()=>deleteBet(b.dataset.game,b.dataset.deleteBet));
    document.querySelectorAll("[data-open-game]").forEach(b=>b.onclick=()=>{
      const game=state.games.find(g=>g.id===b.dataset.openGame);
      if(game){ route="today"; render(); setTimeout(()=>document.querySelector(`[data-result="${game.id}"]`)?.scrollIntoView({behavior:"smooth",block:"center"}),50); }
    });

    const sd = document.getElementById("settlementDate");
    if (sd) sd.onchange = ()=> document.getElementById("aggregateArea").innerHTML=renderAggregate(sd.value);

    const ctf = document.getElementById("customTeamForm");
    if (ctf) ctf.onsubmit=async e=>{
      e.preventDefault();
      const fd=new FormData(ctf), league=fd.get("league"), team=String(fd.get("team")||"").trim();
      if(!team) return;
      if(teamsFor(league).includes(team)) return toast("そのチームは登録済みです");
      state.customTeams[league].push(team);
      saveCache(); ctf.reset(); render();
      await writeCloud("PUT", `customTeams/${league}/${uid("team")}`, {name:team}, "チームを共通データへ追加しました");
    };

    const exportBtn = document.getElementById("exportBtn");
    if (exportBtn) exportBtn.onclick=exportData;
    const importInput = document.getElementById("importInput");
    if (importInput) importInput.onchange=importData;
    const resetBtn = document.getElementById("resetBtn");
    if (resetBtn) resetBtn.onclick=async ()=>{
      if(confirm("全員共通の試合・賭け・履歴をすべて削除します。よろしいですか？")){
        state=defaultState(); saveCache(); render();
        await writeCloud("DELETE", "", undefined, "全員共通データを削除しました");
      }
    };
  }

  function openBetModal(gameId) {
    const game = state.games.find(g=>g.id===gameId);
    if(!game) return;
    if(settleGame(game)) return toast("結果入力済みの試合には追加できません");
    const modal=document.getElementById("modal"), body=document.getElementById("modalBody");
    body.innerHTML=`
      <h2>賭けを追加</h2>
      <div class="muted small">${esc(game.teamA)} vs ${esc(game.teamB)}</div>
      <div style="height:12px"></div>
      <label>客名</label>
      <input name="bettor" list="bettorList" required placeholder="名前">
      <datalist id="bettorList">${state.bettors.map(x=>`<option value="${esc(x)}">`).join("")}</datalist>
      <div style="height:10px"></div>
      <label>賭けるチーム</label>
      <select name="team"><option>${esc(game.teamA)}</option><option>${esc(game.teamB)}</option></select>
      <div style="height:10px"></div>
      <label>金額</label>
      <input name="amount" type="number" min="1" step="1" inputmode="numeric" placeholder="10000" required>
      <div class="inline-actions" style="margin-top:16px">
        <button type="button" class="primary-btn" id="saveBetBtn">登録</button>
        <button type="submit" class="ghost-btn">閉じる</button>
      </div>`;
    modal.showModal();
    document.getElementById("saveBetBtn").onclick=async ()=>{
      const bettor=String(body.elements.bettor.value||"").trim();
      const team=body.elements.team.value;
      const amount=Number(body.elements.amount.value);
      if(!bettor || !Number.isFinite(amount) || amount<=0) return toast("客名と金額を確認してください");
      const bet={id:uid("bet"),bettor,team,amount};
      game.bets.push(bet);
      if(!state.bettors.includes(bettor)) state.bettors.push(bettor);
      saveCache();modal.close();render();
      await writeCloud("PUT", `games/${game.id}/bets/${bet.id}`, bet, "賭けを共通データへ登録しました");
    };
  }

  function openResultModal(gameId) {
    const game = state.games.find(g=>g.id===gameId);
    if(!game) return;
    const modal=document.getElementById("modal"), body=document.getElementById("modalBody");
    body.innerHTML=`
      <h2>試合結果</h2>
      <div class="grid grid-2">
        <div><label>${esc(game.teamA)}</label><input name="scoreA" type="number" min="0" step="1" inputmode="numeric" value="${game.scoreA ?? ""}" required></div>
        <div><label>${esc(game.teamB)}</label><input name="scoreB" type="number" min="0" step="1" inputmode="numeric" value="${game.scoreB ?? ""}" required></div>
      </div>
      <div class="note" style="margin-top:12px">${esc(game.handicapGiver)} が ${esc(hcapLabel(game.handicapId))} 出し</div>
      <div class="inline-actions" style="margin-top:16px">
        <button type="button" class="primary-btn" id="saveResultBtn">計算して保存</button>
        ${settleGame(game)?`<button type="button" class="secondary-btn" id="clearResultBtn">結果を未入力へ戻す</button>`:""}
        <button type="submit" class="ghost-btn">閉じる</button>
      </div>`;
    modal.showModal();
    document.getElementById("saveResultBtn").onclick=async ()=>{
      const a=Number(body.elements.scoreA.value), b=Number(body.elements.scoreB.value);
      if(!Number.isInteger(a)||!Number.isInteger(b)||a<0||b<0) return toast("得点を確認してください");
      game.scoreA=a;game.scoreB=b;saveCache();modal.close();render();
      await writeCloud("PATCH", `games/${game.id}`, {scoreA:a,scoreB:b}, "結果と精算を共通保存しました");
    };
    const clear=document.getElementById("clearResultBtn");
    if(clear) clear.onclick=async ()=>{
      game.scoreA=null;game.scoreB=null;saveCache();modal.close();render();
      await writeCloud("PATCH", `games/${game.id}`, {scoreA:null,scoreB:null}, "結果を未入力に戻しました");
    };
  }

  async function deleteGame(id) {
    if(!confirm("この試合と登録された賭けを全員共通データから削除しますか？")) return;
    state.games=state.games.filter(g=>g.id!==id);
    saveCache();render();
    await writeCloud("DELETE", `games/${id}`, undefined, "試合を共通データから削除しました");
  }

  async function deleteBet(gameId, betId) {
    const g=state.games.find(x=>x.id===gameId); if(!g)return;
    g.bets=g.bets.filter(b=>b.id!==betId);saveCache();render();
    await writeCloud("DELETE", `games/${gameId}/bets/${betId}`, undefined, "賭けを削除しました");
  }

  function exportData() {
    const blob=new Blob([JSON.stringify(state,null,2)],{type:"application/json"});
    const a=document.createElement("a");
    a.href=URL.createObjectURL(blob);
    a.download=`baseball-handicap-backup-${todayStr()}.json`;
    a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  }

  function importData(e) {
    const file=e.target.files?.[0]; if(!file)return;
    const reader=new FileReader();
    reader.onload=async ()=>{
      try{
        const data=JSON.parse(reader.result);
        if(!Array.isArray(data.games)) throw new Error();
        state=normalizeState({...defaultState(),...data,customTeams:{...defaultState().customTeams,...(data.customTeams||{})}});
        saveCache();render();
        await writeCloud("PUT", "", toCloudState(state), "バックアップを全員共通データへ復元しました");
      }catch{toast("JSONを読み込めませんでした");}
    };
    reader.readAsText(file);
  }

  function toast(msg) {
    const el=document.getElementById("toast");
    el.textContent=msg;el.classList.add("show");
    clearTimeout(toast._t);toast._t=setTimeout(()=>el.classList.remove("show"),1800);
  }

  document.addEventListener("input", e => {
    if (isEditableElement(e.target)) editingDirty = true;
  }, true);
  document.addEventListener("change", e => {
    if (isEditableElement(e.target)) editingDirty = true;
  }, true);

  const modalRoot = document.getElementById("modal");
  if (modalRoot) modalRoot.addEventListener("close", () => {
    editingDirty = false;
    if (navigator.onLine) scheduleCloudRefresh();
  });

  document.querySelectorAll(".nav-btn").forEach(b=>b.onclick=()=>{route=b.dataset.route;render(); if(navigator.onLine) scheduleCloudRefresh();});

  window.addEventListener("beforeinstallprompt", e=>{
    e.preventDefault();deferredPrompt=e;
    const btn=document.getElementById("installBtn");btn.classList.remove("hidden");
    btn.onclick=async()=>{deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;btn.classList.add("hidden");};
  });

  if("serviceWorker" in navigator) window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js"));
  window.addEventListener("online",()=>refreshFromCloud({silent:true}));
  window.addEventListener("offline",()=>setSyncStatus("offline","オフライン"));
  render();
  refreshFromCloud();
  startCloudPolling();
})();
