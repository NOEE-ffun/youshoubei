(function () {
  'use strict';

  /* 数据统计页:单届 + 全部届汇总。
   * 数据源全部现算:resolveCanvas(胜场/小局)、deriveStandings(名次)、
   * canvas.cards 的 classLinks.a/b(职业登场,按选手位归属,支持按选手筛选)。 */

  const { escapeHtml, avatarMarkup } = window.TournamentUtils;

  let selectedIds = new Set();  // 选中的届;空集 = 不统计任何数据
  let selectedPlayerId = null;

  function playerNameMap(players) {
    return new Map((players || []).map((p) => [p.id, p.name || p.id]));
  }

  /* 统计引擎:records 为完整记录数组;classesByPlayer 记录每位选手的职业登场 */
  function computeStats(records, players) {
    const names = playerNameMap(players);
    const stats = {
      players: new Map(),        // pid -> { wins, losses, gameWins, gameLosses, ranks }
      classes: new Map(),        // cls -> count(全部选手合计)
      classesByPlayer: new Map(), // pid -> Map(cls -> count)
      podiums: []
    };
    const ensure = (pid) => {
      if (!stats.players.has(pid)) {
        stats.players.set(pid, { wins: 0, losses: 0, gameWins: 0, gameLosses: 0, ranks: [] });
      }
      return stats.players.get(pid);
    };
    const ensurePlayerClasses = (pid) => {
      if (!stats.classesByPlayer.has(pid)) stats.classesByPlayer.set(pid, new Map());
      return stats.classesByPlayer.get(pid);
    };

    for (const record of records || []) {
      if (!record || !record.canvas) continue;
      const resolved = CanvasModel.resolveCanvas(record.canvas, record.roster || [], record.scores || {});
      const effLinksMap = CanvasModel.resolveEffectiveClassLinks(record.canvas, record.scores || {});

      for (const m of resolved.cards) {
        if (m.played && m.winner && m.loser) {
          ensure(m.winner).wins += 1;
          ensure(m.loser).losses += 1;
          /* 小局按选手位归属:A 位记 scoreA 胜 scoreB 负,B 位反之。
           * 胜者丢的局和败者赢的局都要入账;弃权比分可能为负值,钳到 0 */
          const gamesA = Math.max(0, Number(m.scoreA) || 0);
          const gamesB = Math.max(0, Number(m.scoreB) || 0);
          if (m.a) { const gs = ensure(m.a); gs.gameWins += gamesA; gs.gameLosses += gamesB; }
          if (m.b) { const gb2 = ensure(m.b); gb2.gameWins += gamesB; gb2.gameLosses += gamesA; }
        }

        /* 职业登场:该场该选手位的有效卡组(自己填的或连线继承)计一次 */
        const eff = effLinksMap.get(m.id) || {};
        for (const [group, pid] of [['a', m.a], ['b', m.b]]) {
          if (!pid || !Array.isArray(eff[group])) continue;
          const pc = ensurePlayerClasses(pid);
          for (const entry of eff[group]) {
            if (!entry || !entry.cls) continue;
            stats.classes.set(entry.cls, (stats.classes.get(entry.cls) || 0) + 1);
            pc.set(entry.cls, (pc.get(entry.cls) || 0) + 1);
          }
        }
      }

      const st = CanvasModel.deriveStandings(record);
      if (st && st.playerRanks) {
        for (const [pid, rank] of st.playerRanks) {
          if (Number.isFinite(Number(rank))) ensure(pid).ranks.push(Number(rank));
        }
      }
      stats.podiums.push({
        name: record.name || '未命名',
        champion: st && st.champion ? (names.get(st.champion) || '?') : null,
        runnerUp: st && st.runnerUp ? (names.get(st.runnerUp) || '?') : null,
        thirdPlace: st && st.thirdPlace ? (names.get(st.thirdPlace) || '?') : null
      });
    }
    return stats;
  }

  function bestRank(ranks) {
    return ranks && ranks.length ? Math.min(...ranks) : null;
  }

  /* ---------- 渲染 ---------- */

  /* 复选框列表:全选框 + 各届;空集=不统计,全选=汇总全部 */
  function renderScopeChecks(app) {
    const list = document.getElementById('stats-check-list');
    const all = document.getElementById('stats-check-all');
    if (!list || !all) return;
    const items = (app.list || []).map((t) =>
      '<label class="stats-check"><input type="checkbox" data-scope-id="' + t.id + '"' +
      (selectedIds.has(t.id) ? ' checked' : '') + '> ' + escapeHtml(t.name) + '</label>'
    ).join('');
    if (list.dataset.sig !== items) {
      list.dataset.sig = items;
      list.innerHTML = items;
    }
    all.checked = selectedIds.size >= (app.list || []).length && (app.list || []).length > 0;
  }

  function renderPodium(podiums) {
    const banner = document.getElementById('stats-podium');
    const text = document.getElementById('stats-podium-text');
    if (!banner || !text) return;
    const done = podiums.filter((p) => p.champion);
    if (!done.length) {
      banner.hidden = true;
      return;
    }
    const parts = done.map((p) => {
      let s = (podiums.length > 1 ? escapeHtml(p.name) + ':' : '') + '🥇 ' + escapeHtml(p.champion);
      if (p.runnerUp) s += ' · 🥈 ' + escapeHtml(p.runnerUp);
      if (p.thirdPlace) s += ' · 🥉 ' + escapeHtml(p.thirdPlace);
      return s;
    });
    text.textContent = '';
    text.append(parts.join('　'));
    banner.hidden = false;
  }

  /* 职业登场条:按百分比显示;selectedPlayerId 非空时只统计该选手 */
  function renderClasses(stats, players) {
    const list = document.getElementById('stats-class-list');
    const title = document.querySelector('.stats-section[aria-label="职业统计"] .stats-section-title');
    if (!list) return;
    const source = selectedPlayerId
      ? (stats.classesByPlayer.get(selectedPlayerId) || new Map())
      : stats.classes;
    const player = selectedPlayerId
      ? (players || []).find((p) => p.id === selectedPlayerId)
      : null;
    if (title) {
      title.textContent = selectedPlayerId
        ? (player ? player.name : '?') + ' · 职业使用率'
        : '职业登场(全部选手)';
    }
    /* 固定顺序:精灵/皇家/法师/龙族/梦魇/主教/复仇者,不按次数排序 */
    const entries = CanvasModel.CLASS_LIST
      .map((cls) => ({ cls, count: source.get(cls) || 0 }));
    const total = entries.reduce((sum, e) => sum + e.count, 0);
    list.innerHTML = entries.map((e) => {
      const pct = total ? Math.round(e.count / total * 100) : 0;
      return (
        '<div class="class-bar' + (e.count ? '' : ' empty') + '" title="' + escapeHtml(e.cls) + ' ' + pct + '%">' +
        '<img class="icon" src="icons/classes/' + escapeHtml(e.cls) + '.svg" alt="' + escapeHtml(e.cls) + '">' +
        '<div class="class-bar-track"><div class="class-bar-fill" style="width:' + pct + '%"></div></div>' +
        '<span class="class-bar-count">' + pct + '%</span>' +
        '</div>'
      );
    }).join('');
  }

  function renderPlayerTable(rows) {
    const tbody = document.querySelector('#stats-player-table tbody');
    if (!tbody) return;
    tbody.innerHTML = rows.map((row) => (
      '<tr class="stats-player-row' + (selectedPlayerId === row.player.id ? ' selected' : '') + '"' +
      ' data-player="' + row.player.id + '" tabindex="0" role="button" aria-label="查看 ' + escapeHtml(row.player.name) + ' 的职业使用率">' +
      '<td class="stats-player-cell">' + avatarMarkup(row.player, 'avatar-sm') + '<span>' + escapeHtml(row.player.name) + '</span></td>' +
      '<td class="num">' + row.s.wins + '</td>' +
      '<td class="num">' + row.s.losses + '</td>' +
      '<td class="num">' + (row.winRate == null ? '—' : row.winRate + '%') + '</td>' +
      '<td class="num">' + (row.s.gameWins || row.s.gameLosses ? row.s.gameWins + '-' + row.s.gameLosses : '—') + '</td>' +
      '<td class="num">' + (row.best == null ? '—' : '第 ' + row.best + ' 名') + '</td>' +
      '</tr>'
    )).join('') || '<tr><td colspan="6" class="stats-empty">暂无对战数据</td></tr>';
  }

  async function recordsForScope(app) {
    const all = await app.storageGetAll();
    return all.filter((r) => selectedIds.has(r.id));
  }

  let lastStats = null;
  let lastPlayers = null;
  let lastRows = [];

  /* 行数据一次推导:表格渲染与图片/文本导出共用,胜率/名次/排序不再算两遍 */
  function computeRows(stats, players) {
    return [...stats.players.entries()]
      .map(([pid, s]) => {
        const player = (players || []).find((p) => p.id === pid) || { id: pid, name: '?' };
        const total = s.wins + s.losses;
        return { player, s, total, winRate: total ? Math.round(s.wins / total * 100) : null, best: bestRank(s.ranks) };
      })
      .sort((x, y) => y.s.wins - x.s.wins || (x.best ?? 99) - (y.best ?? 99));
  }

  async function render() {
    const app = window.TournamentApp;
    if (!app) return;
    /* 清理已删除届的悬空 id,防全选框状态错乱 */
    const validIds = new Set((app.list || []).map((t) => t.id));
    for (const id of [...selectedIds]) {
      if (!validIds.has(id)) selectedIds.delete(id);
    }
    renderScopeChecks(app);
    let records = [];
    try {
      records = await recordsForScope(app);
    } catch (error) {
      records = [];
    }
    lastStats = computeStats(records, app.players);
    lastPlayers = app.players;
    lastRows = computeRows(lastStats, lastPlayers);
    /* 范围变化后选中选手可能不在数据里,清掉 */
    if (selectedPlayerId && !lastStats.players.has(selectedPlayerId)) selectedPlayerId = null;
    renderPodium(lastStats.podiums);
    renderClasses(lastStats, lastPlayers);
    renderPlayerTable(lastRows);
  }

  function selectPlayer(pid) {
    selectedPlayerId = selectedPlayerId === pid ? null : pid;
    if (lastStats) {
      renderClasses(lastStats, lastPlayers);
      renderPlayerTable(lastRows);
    }
  }

  /* ---------- 导出(图片 PNG / 文本) ---------- */

  function scopeLabel() {
    const app = window.TournamentApp;
    const list = app.list || [];
    if (selectedIds.size >= list.length && list.length > 0) return '全部届汇总';
    const names = list.filter((t) => selectedIds.has(t.id)).map((t) => t.name);
    return names.length === 1 ? names[0] : names.length + ' 届汇总';
  }

  function playerRows() {
    return lastRows.map(({ player, s, winRate, best }) => ({
      name: player.name || '?',
      wins: s.wins,
      losses: s.losses,
      winRate,
      games: (s.gameWins || s.gameLosses) ? s.gameWins + '-' + s.gameLosses : null,
      best
    }));
  }

  function classRows() {
    if (!lastStats) return [];
    const source = selectedPlayerId
      ? (lastStats.classesByPlayer.get(selectedPlayerId) || new Map())
      : lastStats.classes;
    const entries = CanvasModel.CLASS_LIST.map((cls) => ({ cls, count: source.get(cls) || 0 }));
    const total = entries.reduce((s, e) => s + e.count, 0);
    return entries.map((e) => ({ ...e, pct: total ? Math.round(e.count / total * 100) : 0 }));
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  /** 选手战绩+职业登场画成 2x 缔率清晰 PNG(深色卡片,直接发群) */
  function exportImage() {
    const rows = playerRows();
    const cls = classRows();
    if (!rows.length && !cls.some((c) => c.count)) {
      window.TournamentUtils.notify('当前范围没有可导出的数据', 'danger');
      return;
    }
    const W = 1080;
    const PAD = 60;
    const ROW_H = 56;
    const HEAD_H = 130;
    const CLS_H = 200;
    const H = HEAD_H + Math.max(rows.length, 1) * ROW_H + (cls.some((c) => c.count) ? CLS_H : 0) + PAD;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const FONT = '"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif';

    /* 底+头 */
    ctx.fillStyle = '#0a0e1a';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#8fabff';
    ctx.font = '700 40px ' + FONT;
    ctx.fillText('右手杯 · 数据统计', PAD, 72);
    ctx.fillStyle = '#9aa7c7';
    ctx.font = '400 24px ' + FONT;
    ctx.fillText(scopeLabel(), PAD, 108);

    /* 选手表 */
    let y = HEAD_H;
    const cols = [
      { label: '选手', x: PAD, w: 260, align: 'left' },
      { label: '胜', x: 420, w: 80, align: 'right' },
      { label: '负', x: 530, w: 80, align: 'right' },
      { label: '胜率', x: 640, w: 100, align: 'right' },
      { label: '小局', x: 790, w: 110, align: 'right' },
      { label: '名次', x: 940, w: 80, align: 'right' }
    ];
    ctx.fillStyle = '#9aa7c7';
    ctx.font = '700 22px ' + FONT;
    for (const c of cols) {
      ctx.textAlign = c.align;
      ctx.fillText(c.label, c.align === 'right' ? c.x + c.w : c.x, y + 30);
    }
    ctx.textAlign = 'left';
    y += 46;
    ctx.strokeStyle = 'rgba(143,171,255,0.3)';
    ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
    for (const r of rows) {
      y += ROW_H;
      ctx.font = '600 26px ' + FONT;
      for (const [i, c] of cols.entries()) {
        const val = i === 0 ? r.name
          : i === 1 ? String(r.wins)
          : i === 2 ? String(r.losses)
          : i === 3 ? (r.winRate == null ? '—' : r.winRate + '%')
          : i === 4 ? (r.games || '—')
          : (r.best == null ? '—' : '第' + r.best + '名');
        ctx.fillStyle = i === 0 ? '#e8ecf8' : i === 1 ? '#7ee787' : i === 2 ? '#ff8b8b' : '#c8d2ec';
        ctx.textAlign = c.align;
        ctx.fillText(val, c.align === 'right' ? c.x + c.w : c.x, y - 14);
      }
      ctx.textAlign = 'left';
      ctx.strokeStyle = 'rgba(143,171,255,0.12)';
      ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
    }

    /* 职业登场 */
    if (cls.some((c) => c.count)) {
      y += 50;
      ctx.fillStyle = '#8fabff';
      ctx.font = '700 28px ' + FONT;
      ctx.fillText(selectedPlayerId ? '职业使用率' : '职业登场', PAD, y);
      y += 26;
      const barW = W - PAD * 2 - 100;
      cls.forEach((c, i) => {
        const cy = y + i * 26;
        ctx.fillStyle = '#c8d2ec';
        ctx.font = '400 18px ' + FONT;
        ctx.fillText(c.cls, PAD, cy + 14);
        ctx.fillStyle = '#1a2337';
        ctx.fillRect(PAD + 60, cy + 2, barW, 14);
        ctx.fillStyle = '#3563e9';
        ctx.fillRect(PAD + 60, cy + 2, Math.max(2, barW * c.pct / 100), 14);
        ctx.fillStyle = '#9aa7c7';
        ctx.font = '600 18px ' + FONT;
        ctx.textAlign = 'right';
        ctx.fillText(c.pct + '%', W - PAD, cy + 14);
        ctx.textAlign = 'left';
      });
    }

    canvas.toBlob((blob) => {
      if (!blob) return;
      download(blob, '数据统计-' + scopeLabel() + '.png');
    }, 'image/png');
  }

  /** 文本版:选手战绩 + 职业百分比,复制到剪贴板(失败则下载 .txt) */
  async function exportText() {
    const rows = playerRows();
    const cls = classRows();
    if (!rows.length && !cls.some((c) => c.count)) {
      window.TournamentUtils.notify('当前范围没有可导出的数据', 'danger');
      return;
    }
    const lines = ['右手杯 · 数据统计(' + scopeLabel() + ')', ''];
    if (rows.length) {
      lines.push('【选手战绩】');
      for (const r of rows) {
        const wr = r.winRate == null ? '—' : r.winRate + '%';
        const gm = r.games || '—';
        const bk = r.best == null ? '—' : '第' + r.best + '名';
        lines.push(r.name + ':' + r.wins + '胜' + r.losses + '负(' + wr + ') 小局' + gm + ' ' + bk);
      }
      lines.push('');
    }
    if (cls.some((c) => c.count)) {
      lines.push(selectedPlayerId ? '【职业使用率】' : '【职业登场】');
      lines.push(cls.filter((c) => c.count).map((c) => c.cls + ' ' + c.pct + '%').join(' | '));
    }
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      window.TournamentUtils.notify('已复制到剪贴板');
    } catch (error) {
      download(new Blob([text], { type: 'text/plain;charset=utf-8' }), '数据统计-' + scopeLabel() + '.txt');
      window.TournamentUtils.notify('剪贴板不可用,已下载 txt');
    }
  }

  function bind() {
    const imgBtn = document.getElementById('stats-export-image');
    const txtBtn = document.getElementById('stats-export-text');
    if (imgBtn) imgBtn.addEventListener('click', exportImage);
    if (txtBtn) txtBtn.addEventListener('click', exportText);
    const list = document.getElementById('stats-check-list');
    const all = document.getElementById('stats-check-all');
    if (list) {
      list.addEventListener('change', (event) => {
        const id = event.target.dataset.scopeId;
        if (!id) return;
        if (event.target.checked) selectedIds.add(id);
        else selectedIds.delete(id);
        selectedPlayerId = null;
        render();
      });
    }
    if (all) {
      all.addEventListener('change', () => {
        const app = window.TournamentApp;
        if (all.checked) selectedIds = new Set((app.list || []).map((t) => t.id));
        else selectedIds = new Set();
        selectedPlayerId = null;
        render();
      });
    }
    const table = document.getElementById('stats-player-table');
    if (table) {
      table.addEventListener('click', (event) => {
        const row = event.target.closest('.stats-player-row');
        if (row) selectPlayer(row.dataset.player);
      });
      table.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const row = event.target.closest('.stats-player-row');
        if (row) {
          event.preventDefault();
          selectPlayer(row.dataset.player);
        }
      });
    }
  }

  document.addEventListener('ts:ready', () => {
    bind();
    /* 默认全选(等价于原先的"全部届汇总") */
    const app = window.TournamentApp;
    selectedIds = new Set((app && app.list || []).map((t) => t.id));
    render();
    document.addEventListener('ts:changed', render);
  });
  window.TournamentAppInit('stats').catch((error) => {
    if (window.TournamentApp) window.TournamentApp.fatalError(error);
  });
})();
