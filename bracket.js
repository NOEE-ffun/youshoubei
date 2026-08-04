(function () {
  'use strict';

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch]));
  }

  function debounce(fn, wait) {
    let timer = null;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, wait);
    };
  }

  function save() {
    return window.TournamentApp.idbPut(window.TournamentApp.current);
  }

  function canEdit() {
    const app = window.TournamentApp;
    return !(app.mode === 'cloud' && !app.isAdmin());
  }

  function renderAll() {
    if (!window.TournamentApp || !window.TournamentApp.current) return;
    document.getElementById('reset-scores-btn').disabled = !canEdit();
    renderSidebar();
    renderChampion();
    renderRoster();
    renderBracket();
  }

  /* ---------- 侧边栏 ---------- */

  function renderSidebar() {
    const app = window.TournamentApp;
    const record = app.current;
    const sidebar = document.getElementById('rules-sidebar');
    const wrap = document.getElementById('page-wrap');
    const toggle = document.getElementById('rules-toggle');
    const showBtn = document.getElementById('show-rules-btn');
    const hidden = app.sidebarHidden();

    document.getElementById('rules-text').textContent = record.rules || '';
    sidebar.hidden = hidden;
    wrap.classList.toggle('sidebar-hidden', hidden);
    toggle.textContent = hidden ? '展开' : '收起';
    toggle.setAttribute('aria-expanded', String(!hidden));
    showBtn.hidden = !hidden;
  }

  function bindSidebar() {
    document.getElementById('rules-toggle').addEventListener('click', () => {
      window.TournamentApp.setSidebarHidden(!window.TournamentApp.sidebarHidden());
      renderSidebar();
    });
    document.getElementById('show-rules-btn').addEventListener('click', () => {
      window.TournamentApp.setSidebarHidden(false);
      renderSidebar();
    });
    document.getElementById('rules-edit').addEventListener('click', () => {
      window.TournamentApp.openSettings(true);
    });
  }

  /* ---------- 冠军横幅 ---------- */

  function renderChampion() {
    const app = window.TournamentApp;
    const record = app.current;
    const names = new Map(record.players.map((p) => [p.id, p.name]));
    const standings = BracketModel.deriveStandings(record.players.map((p) => p.id), record.scores);
    const banner = document.getElementById('champion-banner');
    const text = document.getElementById('champion-text');
    if (standings.champion) {
      text.textContent = '冠军：' + (names.get(standings.champion) || '待定') +
        '　·　亚军：' + (names.get(standings.runnerUp) || '待定') +
        '　·　季军：' + (names.get(standings.thirdPlace) || '待定');
      banner.hidden = false;
    } else {
      banner.hidden = true;
      text.textContent = '';
    }
  }

  /* ---------- 选手名单 ---------- */

  function renderRoster() {
    const app = window.TournamentApp;
    const record = app.current;
    const grid = document.getElementById('roster-grid');
    grid.innerHTML = record.players.map((player, index) =>
      '<div class="roster-item">' +
      '<span class="roster-index">' + (index + 1) + '</span>' +
      '<label class="visually-hidden" for="roster-name-' + player.id + '">选手 ' + (index + 1) + ' 姓名</label>' +
      '<input id="roster-name-' + player.id + '" value="' + escapeHtml(player.name) + '" autocomplete="off"' +
      (canEdit() ? '' : ' disabled') + '>' +
      '</div>'
    ).join('');

    grid.querySelectorAll('.roster-item input').forEach((input, index) => {
      const player = record.players[index];
      const commit = () => {
        const next = input.value.trim();
        if (next) player.name = next;
        else input.value = player.name;
        save();
      };
      input.addEventListener('change', commit);
      input.addEventListener('input', debounce(commit, 500));
    });
  }

  /* ---------- 赛程 ---------- */

  function playerRow(match, side, names) {
    const participant = side === 0 ? match.a : match.b;
    const name = participant ? (names.get(participant) || '待定') : '待定';
    const score = side === 0 ? match.scoreA : match.scoreB;
    let className = 'match-player';
    if (!participant) className += ' tbd';
    if (match.played) {
      if (match.winner === participant) className += ' winner';
      if (match.loser === participant) className += ' loser';
    }
    return (
      '<div class="' + className + '">' +
      '<span class="player-name">' + escapeHtml(name) + '</span>' +
      '<span class="player-score">' + (score == null ? '' : score) + '</span>' +
      '</div>'
    );
  }

  function matchCard(match, names, record) {
    const played = match.played;
    const ready = Boolean(match.a && match.b);
    const editable = canEdit();
    const current = record.scores[match.id];
    const isActive = (a, b) => current && current.a === a && current.b === b ? ' active' : '';
    const scoreButtons = [
      [2, 0],
      [2, 1],
      [1, 2],
      [0, 2]
    ].map(([a, b]) =>
      '<button type="button" class="score-btn' + isActive(a, b) + '" data-score="' + a + ',' + b + '"' +
      (editable && ready ? '' : ' disabled') + '>' + a + ':' + b + '</button>'
    ).join('');

    return (
      '<article class="match-card' + (played ? ' played' : '') + '" data-match="' + match.id + '">' +
      '<header class="match-head">' +
      '<h3 class="match-title">' + escapeHtml(match.label) + '</h3>' +
      '<span class="match-state' + (played ? ' done' : '') + '">' + (played ? '已结束' : '未开始') + '</span>' +
      '</header>' +
      playerRow(match, 0, names) +
      playerRow(match, 1, names) +
      '<div class="score-actions" role="group" aria-label="' + escapeHtml(match.label) + ' 比分">' +
      scoreButtons +
      '<button type="button" class="score-btn score-clear" data-clear="1"' +
      (editable && played ? '' : ' disabled') + '>清除</button>' +
      '</div>' +
      '</article>'
    );
  }

  function columnGroup(matches, roundLabels) {
    const rounds = [...new Set(matches.map((m) => m.round))];
    return rounds.map((round) => {
      const list = matches.filter((m) => m.round === round);
      return (
        '<div class="bracket-col">' +
        '<p class="round-label">' + roundLabels[round] + '</p>' +
        list.map((m) => matchCard(m, currentNames(), currentRecord())).join('') +
        '</div>'
      );
    }).join('');
  }

  function currentRecord() {
    return window.TournamentApp.current;
  }

  function currentNames() {
    return new Map(currentRecord().players.map((p) => [p.id, p.name]));
  }

  function renderBracket() {
    const record = currentRecord();
    const seeds = record.players.map((p) => p.id);
    const matches = BracketModel.resolveAll(seeds, record.scores);
    const groups = BracketModel.groupByPhase(matches);

    document.getElementById('wb-flow').innerHTML = columnGroup(
      groups.wb,
      { 1: '第一轮', 2: '半决赛', 3: '决赛' }
    );
    document.getElementById('lb-flow').innerHTML = columnGroup(
      groups.lb,
      { 1: '第一轮', 2: '第二轮', 3: '半决赛', 4: '决赛' }
    );
    document.getElementById('gf-flow').innerHTML = columnGroup(
      groups.gf,
      { 1: '总决赛' }
    );
  }

  function bindBracket() {
    for (const id of ['wb-flow', 'lb-flow', 'gf-flow']) {
      document.getElementById(id).addEventListener('click', async (event) => {
        const btn = event.target.closest('button[data-score], button[data-clear]');
        if (!btn || btn.disabled) return;
        const card = btn.closest('.match-card');
        const record = currentRecord();
        if (btn.dataset.clear) {
          delete record.scores[card.dataset.match];
        } else {
          const [a, b] = btn.dataset.score.split(',').map(Number);
          record.scores[card.dataset.match] = { a, b };
        }
        await save();
        renderAll();
      });
    }
  }

  function bindToolbar() {
    document.getElementById('reset-scores-btn').addEventListener('click', async () => {
      const record = currentRecord();
      if (!Object.keys(record.scores).length) return;
      if (!confirm('确定清空所有比分吗？选手与卡组会保留。')) return;
      record.scores = {};
      await save();
      renderAll();
    });
  }

  document.addEventListener('ts:ready', renderAll);
  document.addEventListener('ts:changed', renderAll);
  bindSidebar();
  bindBracket();
  bindToolbar();
  window.TournamentAppInit('index');
})();
