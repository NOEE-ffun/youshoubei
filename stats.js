(function () {
  'use strict';

  /* 数据统计页:单届 + 全部届汇总。
   * 数据源全部现算:resolveCanvas(比赛/胜场/小局)、deriveStandings(名次)、
   * canvas.cards 的 classLinks.a/b(职业登场,按选手位归属)。 */

  const { escapeHtml, avatarMarkup } = window.TournamentUtils;

  const SCOPE_ALL = '__all__';
  let currentScope = SCOPE_ALL;

  function playerNameMap(players) {
    return new Map((players || []).map((p) => [p.id, p.name || p.id]));
  }

  /* 统计引擎:records 为完整记录数组(单届传 [record],汇总传 storageGetAll()) */
  function computeStats(records, players) {
    const names = playerNameMap(players);
    const stats = {
      players: new Map(),   // pid -> { wins, losses, gameWins, gameLosses, ranks: [] }
      classes: new Map(),   // cls -> count
      matches: [],          // { label, phase, aName, bName, scoreText, winnerName, played }
      podiums: []           // 每届 { name, champion, runnerUp, thirdPlace }
    };
    const ensure = (pid) => {
      if (!stats.players.has(pid)) {
        stats.players.set(pid, { wins: 0, losses: 0, gameWins: 0, gameLosses: 0, ranks: [] });
      }
      return stats.players.get(pid);
    };

    for (const record of records || []) {
      if (!record || !record.canvas) continue;
      const resolved = CanvasModel.resolveCanvas(record.canvas, record.roster || [], record.scores || {});
      const cardById = new Map((record.canvas.cards || []).map((c) => [c.id, c]));

      for (const m of resolved.cards) {
        const aName = m.a ? (names.get(m.a) || '?') : null;
        const bName = m.b ? (names.get(m.b) || '?') : null;
        const scoreText = m.played || m.draw
          ? (m.scoreA == null ? '?' : m.scoreA) + ':' + (m.scoreB == null ? '?' : m.scoreB)
          : '';
        stats.matches.push({
          phase: m.phase || '',
          label: m.label || m.id,
          aName,
          bName,
          scoreText,
          winnerName: m.winner ? (names.get(m.winner) || '?') : null,
          played: Boolean(m.played)
        });

        if (m.played && m.winner && m.loser) {
          ensure(m.winner).wins += 1;
          ensure(m.loser).losses += 1;
          /* 小局归属:winnerSide 0 = A 位胜 */
          const winnerGames = m.winnerSide === 0 ? m.scoreA : m.scoreB;
          const loserGames = m.winnerSide === 0 ? m.scoreB : m.scoreA;
          if (Number.isFinite(Number(winnerGames))) ensure(m.winner).gameWins += Math.max(0, Number(winnerGames));
          if (Number.isFinite(Number(loserGames))) ensure(m.loser).gameLosses += Math.max(0, Number(loserGames));
        }

        /* 职业登场:该场该选手位填了职业即计一次 */
        const card = cardById.get(m.id);
        const cl = (card && card.classLinks) || {};
        for (const [group, pid] of [['a', m.a], ['b', m.b]]) {
          if (!pid || !Array.isArray(cl[group])) continue;
          for (const entry of cl[group]) {
            if (!entry || !entry.cls) continue;
            stats.classes.set(entry.cls, (stats.classes.get(entry.cls) || 0) + 1);
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

  function renderScopeSelect(app) {
    const select = document.getElementById('stats-scope-select');
    if (!select) return;
    const options = ['<option value="' + SCOPE_ALL + '"' + (currentScope === SCOPE_ALL ? ' selected' : '') + '>全部届汇总</option>']
      .concat((app.list || []).map((t) =>
        '<option value="' + t.id + '"' + (t.id === currentScope ? ' selected' : '') + '>' + escapeHtml(t.name) + '</option>'
      ));
    const next = options.join('');
    if (select.dataset.sig !== next) {
      select.dataset.sig = next;
      select.innerHTML = next;
    }
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

  function renderClasses(classes) {
    const list = document.getElementById('stats-class-list');
    if (!list) return;
    const entries = CanvasModel.CLASS_LIST
      .map((cls) => ({ cls, count: classes.get(cls) || 0 }))
      .sort((x, y) => y.count - x.count);
    const max = Math.max(1, ...entries.map((e) => e.count));
    list.innerHTML = entries.map((e) => (
      '<div class="class-bar' + (e.count ? '' : ' empty') + '" title="' + escapeHtml(e.cls) + ' ' + e.count + ' 次">' +
      '<img class="icon" src="icons/classes/' + escapeHtml(e.cls) + '.svg" alt="' + escapeHtml(e.cls) + '">' +
      '<div class="class-bar-track"><div class="class-bar-fill" style="width:' + Math.round(e.count / max * 100) + '%"></div></div>' +
      '<span class="class-bar-count">' + e.count + '</span>' +
      '</div>'
    )).join('');
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
      '<tr>' +
      '<td class="stats-player-cell">' + avatarMarkup(row.player, 'avatar-sm') + '<span>' + escapeHtml(row.player.name) + '</span></td>' +
      '<td class="num">' + row.s.wins + '</td>' +
      '<td class="num">' + row.s.losses + '</td>' +
      '<td class="num">' + (row.winRate == null ? '—' : row.winRate + '%') + '</td>' +
      '<td class="num">' + (row.s.gameWins || row.s.gameLosses ? row.s.gameWins + '-' + row.s.gameLosses : '—') + '</td>' +
      '<td class="num">' + (row.best == null ? '—' : '第 ' + row.best + ' 名') + '</td>' +
      '</tr>'
    )).join('') || '<tr><td colspan="6" class="stats-empty">暂无对战数据</td></tr>';
  }

  function renderMatchTable(matches) {
    const tbody = document.querySelector('#stats-match-table tbody');
    if (!tbody) return;
    const rows = [...matches].reverse(); // 最近的场次在前
    tbody.innerHTML = rows.map((m) => (
      '<tr' + (m.played ? '' : ' class="pending"') + '>' +
      '<td>' + (m.phase ? '<span class="stats-phase">' + escapeHtml(m.phase) + '</span>' : '') + escapeHtml(m.label) + '</td>' +
      '<td>' + escapeHtml(m.aName || '待定') + ' vs ' + escapeHtml(m.bName || '待定') + '</td>' +
      '<td class="num">' + (m.scoreText || '—') + '</td>' +
      '<td>' + (m.winnerName ? escapeHtml(m.winnerName) : '—') + '</td>' +
      '</tr>'
    )).join('') || '<tr><td colspan="4" class="stats-empty">暂无比赛</td></tr>';
  }

  async function recordsForScope(app) {
    if (currentScope === SCOPE_ALL) return app.storageGetAll();
    const all = await app.storageGetAll();
    return all.filter((r) => r.id === currentScope);
  }

  async function render() {
    const app = window.TournamentApp;
    if (!app) return;
    renderScopeSelect(app);
    let records = [];
    try {
      records = await recordsForScope(app);
    } catch (error) {
      records = app.current ? [app.current] : [];
    }
    const stats = computeStats(records, app.players);
    renderPodium(stats.podiums);
    renderClasses(stats.classes);
    renderPlayerTable(stats, app.players);
    renderMatchTable(stats.matches);
  }

  function bind() {
    const select = document.getElementById('stats-scope-select');
    if (select) {
      select.addEventListener('change', () => {
        currentScope = select.value;
        render();
      });
    }
  }

  document.addEventListener('ts:ready', () => {
    bind();
    render();
    document.addEventListener('ts:changed', render);
  });
  window.TournamentAppInit('stats').catch((error) => {
    if (window.TournamentApp) window.TournamentApp.fatalError(error);
  });
})();
