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
          /* 小局归属:winnerSide 0 = A 位胜 */
          const winnerGames = m.winnerSide === 0 ? m.scoreA : m.scoreB;
          const loserGames = m.winnerSide === 0 ? m.scoreB : m.scoreA;
          if (Number.isFinite(Number(winnerGames))) ensure(m.winner).gameWins += Math.max(0, Number(winnerGames));
          if (Number.isFinite(Number(loserGames))) ensure(m.loser).gameLosses += Math.max(0, Number(loserGames));
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

  function renderPlayerTable(stats, players) {
    const tbody = document.querySelector('#stats-player-table tbody');
    if (!tbody) return;
    const byPlayer = [...stats.players.entries()]
      .map(([pid, s]) => {
        const player = (players || []).find((p) => p.id === pid) || { id: pid, name: '?' };
        const total = s.wins + s.losses;
        const winRate = total ? Math.round(s.wins / total * 100) : null;
        return { player, s, total, winRate, best: bestRank(s.ranks) };
      })
      .sort((x, y) => y.s.wins - x.s.wins || (x.best ?? 99) - (y.best ?? 99));
    tbody.innerHTML = byPlayer.map((row) => (
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
    /* 范围变化后选中选手可能不在数据里,清掉 */
    if (selectedPlayerId && !lastStats.players.has(selectedPlayerId)) selectedPlayerId = null;
    renderPodium(lastStats.podiums);
    renderClasses(lastStats, lastPlayers);
    renderPlayerTable(lastStats, lastPlayers);
  }

  function selectPlayer(pid) {
    selectedPlayerId = selectedPlayerId === pid ? null : pid;
    if (lastStats) {
      renderClasses(lastStats, lastPlayers);
      renderPlayerTable(lastStats, lastPlayers);
    }
  }

  function bind() {
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
