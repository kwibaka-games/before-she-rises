/**
 * 《冰冷的她醒来之前》front-end module.
 *
 * The platform shell owns login/room/chat/spectator chrome. This module only
 * renders `container` (#game-area) from the server-authoritative view and
 * calls `onAction` with an action object from `view.actions`.
 *
 * It deliberately contains no rule engine: server `actions` is the only
 * authority for what is legal. Hidden state is never assumed to exist.
 */

let countdownTimer = null;

const CARD_KEY_LABEL = {
  alien: '外星人',
  infected: '感染者',
  culprit: '犯人',
  accomplice: '从犯',
  president: '学生会长',
  monitor: '班长',
  honors: '优等生',
  discipline: '风纪委员',
  health: '保健委员',
  library: '图书委员',
  ojou: '大小姐',
  news: '新闻部',
  homebody: '归宅部',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clearCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function playerName(view, userId) {
  return view.players.find((player) => player.userId === userId)?.name || userId || '？';
}

function cardLabel(card) {
  if (!card) return '？';
  return card.name || CARD_KEY_LABEL[card.key] || card.key || '？';
}

function cardEl(card, { mini = false, faceDown = false, showArt = false } = {}) {
  if (faceDown || !card) {
    const back = el('div', `ice-card-back${mini ? ' mini' : ''}`);
    back.appendChild(el('span', '', '?'));
    return back;
  }
  const node = el(
    'div',
    `ice-card ice-key-${card.key || 'unknown'}${mini ? ' mini' : ''}`,
  );
  node.title = `${cardLabel(card)}（权重 ${card.weight ?? 0}）\n${card.victoryText ?? ''}\n${card.text ?? ''}`;

  if (!mini || showArt) {
    const art = el('img', `ice-card-art${mini ? ' mini' : ''}`);
    art.src = `/games/ice/cards/${encodeURIComponent(card.key || 'unknown')}.webp`;
    art.alt = cardLabel(card);
    art.loading = 'lazy';
    art.decoding = 'async';
    art.addEventListener('error', () => art.classList.add('hidden'));
    node.appendChild(art);
  }

  const head = el('div', 'ice-card-head');
  head.appendChild(el('span', 'ice-card-name', cardLabel(card)));
  head.appendChild(el('span', 'ice-card-weight', String(card.weight ?? 0)));
  node.appendChild(head);

  if (!mini) {
    node.appendChild(el('div', 'ice-card-victory', card.victoryText || ''));
    node.appendChild(el('div', 'ice-card-text', card.text || ''));
  }
  return node;
}

function miniHand(cards, { faceDownCount = 0, showArt = false } = {}) {
  const wrap = el('div', 'ice-mini-hand');
  for (const card of cards || []) {
    wrap.appendChild(cardEl(card, { mini: true, showArt }));
  }
  if (faceDownCount > 0) {
    wrap.appendChild(el('div', 'ice-mini-count', `×${faceDownCount}`));
  }
  return wrap;
}

function countBacks(count, cls = '') {
  const wrap = el('div', `ice-back-row ${cls}`);
  const shown = Math.min(count, 12);
  for (let index = 0; index < shown; index += 1) {
    wrap.appendChild(cardEl(null, { mini: true, faceDown: true }));
  }
  if (count > shown) wrap.appendChild(el('span', 'ice-more', `+${count - shown}`));
  if (count === 0) wrap.appendChild(el('span', 'ice-empty', '空'));
  return wrap;
}

function makeActionButton(action, label, onAction) {
  const button = el('button', 'ice-action', label);
  button.type = 'button';
  button.addEventListener('click', () => {
    button.disabled = true;
    button.classList.add('used');
    onAction(action);
  });
  return button;
}

function actionLabel(view, action) {
  if (action.label) return action.label;
  const name = cardLabel(
    view.you?.hand?.find((card) => card.id === action.cardId) ||
      view.players
        .flatMap((player) => player.hand || [])
        .find((card) => card.id === action.cardId),
  );
  if (action.type === 'preserve') return `防腐：${name}`;
  if (action.type === 'use') {
    return action.targetPlayerId
      ? `使用【${name}】→ ${playerName(view, action.targetPlayerId)}`
      : `使用【${name}】`;
  }
  if (action.type === 'accuse') {
    return `质疑给 ${playerName(view, action.targetPlayerId)}：${name}`;
  }
  if (action.type === 'resolve') return action.label || '选择';
  return action.type || '操作';
}

function renderTop(root, view, spectator) {
  const config = view.config || {};
  const top = el('div', 'ice-top');

  const info = el('div', 'ice-info');
  info.appendChild(
    el('span', `ice-badge ice-mode-${config.mode || 'standard'}`, config.mode === 'chaos' ? '混沌规则' : '标准规则'),
  );
  info.appendChild(
    el(
      'span',
      'ice-badge',
      `${config.playerCount ?? view.players.length} 人 · 起始 ${config.startingHandSize ?? '?'} 张 · 防腐 ${config.preservationThreshold ?? '?'} 点`,
    ),
  );
  if (spectator) info.appendChild(el('span', 'ice-badge ice-spectator-badge', '观战'));
  top.appendChild(info);

  const turn = el('div', 'ice-turn-status');
  if (view.phase === 'waiting') {
    turn.textContent = '等待所有玩家准备…';
  } else if (view.phase === 'finished') {
    turn.textContent = '对局结束';
  } else if (view.turn) {
    turn.textContent = `当前回合：${playerName(view, view.turn.playerId)}（第 ${view.turn.index} 回合）`;
  } else {
    turn.textContent = '等待中…';
  }
  top.appendChild(turn);

  const remaining = Number(config.decisionRemainingMs || 0);
  const countdown = el('div', 'ice-countdown', remaining > 0 ? `${Math.ceil(remaining / 1000)}s` : '');
  countdown.title = '服务端决策倒计时；超时会自动随机操作';
  top.appendChild(countdown);
  if (remaining > 0 && view.phase === 'playing') {
    const deadline = Date.now() + remaining;
    const tick = () => {
      const left = Math.max(0, deadline - Date.now());
      countdown.textContent = left > 0 ? `${Math.ceil(left / 1000)}s` : '…';
      if (left <= 0) clearCountdown();
    };
    tick();
    countdownTimer = setInterval(tick, 250);
  }

  root.appendChild(top);
}

function renderPlayers(root, view, myUserId) {
  const section = el('section', 'ice-players');
  const current = view.turn?.playerId;
  for (const player of view.players) {
    const box = el(
      'div',
      `ice-player${player.userId === current ? ' current' : ''}${player.connected ? '' : ' disconnected'}`,
    );
    const head = el('div', 'ice-player-head');
    head.appendChild(el('span', `ice-dot${player.connected ? '' : ' off'}`));
    const name = el('span', 'ice-player-name', player.name);
    head.appendChild(name);
    if (player.userId === myUserId) head.appendChild(el('span', 'ice-you', '你'));
    if (player.userId === current) head.appendChild(el('span', 'ice-current-badge', '回合'));
    box.appendChild(head);

    const stats = el('div', 'ice-player-stats');
    stats.appendChild(el('span', '', `手牌 ${player.handCount}`));
    stats.appendChild(el('span', '', `质疑 ${player.accusationCount}`));
    box.appendChild(stats);

    if (player.front?.length) {
      box.appendChild(el('div', 'ice-small-label', '面前'));
      box.appendChild(miniHand(player.front));
    }
    if (player.identity) {
      box.appendChild(el('div', 'ice-small-label', '身份'));
      box.appendChild(miniHand([player.identity]));
    }
    if (player.hand?.length) {
      box.appendChild(el('div', 'ice-small-label', '手牌（观战可见）'));
      box.appendChild(miniHand(player.hand, { showArt: true }));
    }
    section.appendChild(box);
  }
  root.appendChild(section);
}

function renderPiles(root, view) {
  const piles = el('section', 'ice-piles');

  const preservation = el('div', 'ice-pile');
  const preservationHead = el('div', 'ice-pile-head');
  preservationHead.appendChild(el('h3', '', '防腐堆'));
  preservationHead.appendChild(
    el(
      'span',
      'ice-pile-count',
      `${view.piles.preservation.count} 张 / 需要 ${view.config?.preservationThreshold ?? '?'} 点`,
    ),
  );
  preservation.appendChild(preservationHead);
  if (view.piles.preservation.cards) {
    preservation.appendChild(
      miniHand(view.piles.preservation.cards, { showArt: !view.you }),
    );
  } else {
    preservation.appendChild(countBacks(view.piles.preservation.count));
  }
  piles.appendChild(preservation);

  const accusations = el('div', 'ice-pile ice-pile-wide');
  accusations.appendChild(el('h3', '', '质疑堆'));
  const accList = el('div', 'ice-accusations');
  for (const pile of view.piles.accusations) {
    const row = el('div', 'ice-accusation-row');
    row.appendChild(el('span', 'ice-accusation-name', playerName(view, pile.playerId)));
    row.appendChild(el('span', 'ice-accusation-count', `${pile.count} 张`));
    if (pile.cards) {
      row.appendChild(miniHand(pile.cards, { showArt: !view.you }));
    } else row.appendChild(countBacks(pile.count, 'compact'));
    accList.appendChild(row);
  }
  accusations.appendChild(accList);
  piles.appendChild(accusations);

  const discard = el('div', 'ice-pile ice-pile-wide');
  const discardHead = el('div', 'ice-pile-head');
  discardHead.appendChild(el('h3', '', '弃牌堆'));
  discardHead.appendChild(el('span', 'ice-pile-count', `${view.piles.discard.count} 张`));
  discard.appendChild(discardHead);
  const discardList = el('div', 'ice-discard');
  for (const card of view.piles.discard.cards || []) {
    discardList.appendChild(cardEl(card, { mini: true, showArt: true }));
  }
  if (!discardList.children.length) discardList.appendChild(el('span', 'ice-empty', '空'));
  discard.appendChild(discardList);
  piles.appendChild(discard);

  root.appendChild(piles);
}

function renderPeek(root, pending) {
  const box = el('section', 'ice-pending ice-peek');
  box.appendChild(el('h3', '', pending.label || '你查看了隐藏信息'));
  if (pending.players?.length) {
    box.appendChild(
      el(
        'p',
        'ice-pending-note',
        `涉及玩家：${pending.players.map((player) => player.name).join('、')}`,
      ),
    );
  }
  if (pending.cards?.length) box.appendChild(miniHand(pending.cards));
  if (pending.note) box.appendChild(el('p', 'ice-pending-note', pending.note));
  box.appendChild(el('p', 'ice-small-label', '这是私有信息，只显示这一帧；下一次操作后消失。'));
  root.appendChild(box);
}

function renderPending(root, view, actions, onAction) {
  const pending = view.you?.pending || view.pending;
  if (!pending) return;

  if (pending.kind === 'peek') {
    // Spectators never receive a peek; this branch is for the owner.
    renderPeek(root, pending);
    return;
  }

  const isMine = !!view.you?.pending;
  const box = el('section', `ice-pending${isMine ? ' mine' : ''}`);
  box.appendChild(el('h3', '', pending.label || '等待选择'));
  const meta = el('div', 'ice-pending-meta');
  meta.appendChild(el('span', '', isMine ? '轮到你选择' : `等待 ${pending.awaiting?.map((id) => playerName(view, id)).join('、') || '其他玩家'}`));
  if (pending.kind === 'simultaneous') {
    meta.appendChild(
      el(
        'span',
        '',
        `已提交 ${pending.submitted?.length ?? 0}/${pending.participants?.length ?? 0}`,
      ),
    );
  }
  box.appendChild(meta);

  if (pending.kind === 'choose-accusation' && pending.sources?.length) {
    const sources = el('div', 'ice-source-list');
    for (const source of pending.sources) {
      sources.appendChild(
        el('span', 'ice-source', `${source.name}：${source.count} 张（暗牌）`),
      );
    }
    box.appendChild(sources);
  }
  if (pending.count !== undefined && pending.from === 'preservation') {
    box.appendChild(countBacks(pending.count, 'pending-backs'));
  }
  if (pending.from === 'discard' && pending.cards?.length) {
    box.appendChild(miniHand(pending.cards));
  }
  if (pending.kind === 'simultaneous' && pending.options?.length) {
    box.appendChild(miniHand(pending.options));
  }

  const actionWrap = el('div', 'ice-actions');
  if (isMine && actions?.length) {
    for (const action of actions) {
      actionWrap.appendChild(makeActionButton(action, actionLabel(view, action), onAction));
    }
  } else if (isMine && pending.kind === 'simultaneous' && pending.submitted?.includes(view.you?.userId)) {
    actionWrap.appendChild(el('p', 'ice-small-label', '你已提交，等待其他玩家…'));
  } else if (isMine) {
    actionWrap.appendChild(el('p', 'ice-small-label', '没有可选操作，等待服务端超时自动处理。'));
  }
  if (actionWrap.children.length) box.appendChild(actionWrap);
  root.appendChild(box);
}

function renderHandAndActions(root, view, actions, myUserId, onAction) {
  if (!view.you) return;

  const handBox = el('section', 'ice-hand-box');
  const head = el('div', 'ice-hand-head');
  head.appendChild(el('h3', '', '你的手牌'));
  head.appendChild(el('span', 'ice-small-label', `${view.you.hand.length} 张`));
  handBox.appendChild(head);

  const hand = el('div', 'ice-hand');
  const pending = view.you.pending;
  const blockingPending = pending && pending.blocking;
  const myTurn = view.phase === 'playing' && view.turn?.playerId === myUserId;
  const actionsByCard = new Map();
  for (const action of actions || []) {
    if (!action?.cardId) continue;
    const list = actionsByCard.get(action.cardId) || [];
    list.push(action);
    actionsByCard.set(action.cardId, list);
  }

  for (const card of view.you.hand) {
    const cardBox = el('div', 'ice-hand-card');
    cardBox.appendChild(cardEl(card));
    const cardActions = actionsByCard.get(card.id) || [];
    if (!blockingPending && myTurn && cardActions.length) {
      const actionsBox = el('div', 'ice-card-actions');
      for (const action of cardActions) {
        actionsBox.appendChild(makeActionButton(action, actionLabel(view, action), onAction));
      }
      cardBox.appendChild(actionsBox);
    } else if (!blockingPending && myTurn && card.key === 'culprit') {
      cardBox.appendChild(el('p', 'ice-small-label', '不能使用'));
    }
    hand.appendChild(cardBox);
  }
  handBox.appendChild(hand);

  if (view.you.identity) {
    handBox.appendChild(el('p', 'ice-small-label', '最后一张身份牌：不能被使用 / 交换（标准规则）'));
    handBox.appendChild(miniHand([view.you.identity]));
  }

  if (view.phase === 'waiting') {
    handBox.appendChild(el('p', 'ice-small-label', '等待所有玩家准备；倒计时从对局正式开始后开始。'));
  } else if (view.phase === 'playing' && !blockingPending && !myTurn) {
    handBox.appendChild(el('p', 'ice-small-label', '等待当前玩家行动…'));
  } else if (view.phase === 'playing' && !blockingPending && myTurn && !actions?.length) {
    handBox.appendChild(el('p', 'ice-small-label', '当前没有合法动作；回合会自动跳过或超时。'));
  }

  root.appendChild(handBox);
}

function renderLog(root, view) {
  const box = el('section', 'ice-log-box');
  box.appendChild(el('h3', '', '公开记录'));
  const list = el('div', 'ice-log');
  for (const entry of (view.log || []).slice(-30)) {
    list.appendChild(el('div', 'ice-log-line', entry.text));
  }
  if (!list.children.length) list.appendChild(el('p', 'ice-empty', '暂无记录'));
  box.appendChild(list);
  root.appendChild(box);
}

function renderResult(root, view) {
  const result = view.result;
  if (!result) return;
  const box = el('section', 'ice-result');
  box.appendChild(el('h3', '', result.reason || '对局结束'));

  const winners = el('div', 'ice-result-winners');
  if (result.winners?.length) {
    for (const winner of result.winners) {
      winners.appendChild(el('span', 'ice-winner', `${winner.name}：${winner.reason}`));
    }
  } else {
    winners.appendChild(el('span', 'ice-empty', '全体失败'));
  }
  box.appendChild(winners);

  const stats = el('div', 'ice-result-grid');
  stats.appendChild(
    el(
      'div',
      'ice-result-stat',
      `防腐：${result.preservation.total}/${result.preservation.threshold}（${result.success ? '成功' : '失败'}）`,
    ),
  );
  for (const row of result.accusationTotals || []) {
    stats.appendChild(
      el(
        'div',
        'ice-result-stat',
        `${row.name}：质疑 ${row.total}${row.imprisoned ? ' · 被监禁' : ''}`,
      ),
    );
  }
  box.appendChild(stats);

  const identities = el('div', 'ice-identities');
  for (const identity of result.identities || []) {
    const row = el('div', 'ice-identity-row');
    row.appendChild(el('span', '', identity.name));
    row.appendChild(
      identity.card
        ? cardEl(identity.card, { mini: true, showArt: true })
        : el('span', 'ice-empty', '无'),
    );
    identities.appendChild(row);
  }
  box.appendChild(identities);

  const outcomes = el('div', 'ice-outcomes');
  for (const outcome of result.outcomes || []) {
    outcomes.appendChild(
      el(
        'div',
        `ice-outcome${outcome.win ? ' win' : ''}`,
        `${outcome.name}：${outcome.win ? '胜利' : '失败'} — ${outcome.reason}`,
      ),
    );
  }
  box.appendChild(outcomes);
  root.appendChild(box);
}

export function render(container, { view, actions, myUserId, onAction }) {
  clearCountdown();
  container.replaceChildren();
  if (!view) return;

  const root = el('div', 'ice-shell');
  const spectator = !view.you;
  renderTop(root, view, spectator);
  renderPlayers(root, view, myUserId);
  renderPiles(root, view);

  if (view.phase === 'finished') {
    renderResult(root, view);
    renderLog(root, view);
    container.appendChild(root);
    return;
  }

  const pending = view.you?.pending || view.pending;
  if (pending) {
    renderPending(root, view, actions, onAction);
  }
  renderHandAndActions(root, view, actions, myUserId, onAction);
  renderLog(root, view);
  container.appendChild(root);
}
