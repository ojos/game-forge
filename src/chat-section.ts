/**
 * 生成画面の主役である「チャット」（#695 / M18-2、#726 / M20-2。仕様 5.16 / 確定38）。
 *
 * ## 区画ではなく主役である（確定38）
 *
 * **#695 では「`/generate` の中の区画」だった**（フォームの後ろに置く「任意」の区画）。
 * **#725 でこの決定が変わり、チャットがこの画面の主役になった**——指示文の欄は
 * `<details>` の中（「チャットせずに指示文を直接書く」）へ移り、**この区画が持つ入力 1 つが
 * 画面の下に貼り付く。** **主のボタンもここへ移った**（「この指示で作る」。2.5.5 は
 * 1 画面に 1 つまでで、`src/generate-page.ts` の「生成する」は副へ下げてある）。
 *
 * **「この指示で作る」は生成のフォームをそのまま送る**（`form="generate-form"` の
 * `type="submit"`）。**開始の経路は変えていない**——送信を受けるのはあちらの
 * `GENERATE_SCRIPT` で、`POST /api/generate` も枠の表示も入力の検査も今までどおりである。
 *
 * ## 履歴は箱の中だけを動かす
 *
 * **往復のたびに最新へ送るのは `.gf-chat-log` の `scrollTop` だけで、画面そのものは動かさない。**
 * 要素を `scrollIntoView` で見せると画面ごと動き、**下に貼り付いた入力欄の位置が往復のたびに
 * 跳ねる。** `test/chat-ui.test.ts` が、スクリプトが `scrollIntoView` を持たないことを見る
 * ——**この理由をスクリプトの中へ書くと、その検査が自分のコメントで落ちる**（実際に踏んだ）。
 *
 * ## なぜ別のモジュールなのか
 *
 * **`src/generate-page.ts` のスクリプトは「文字列を DOM へ書き込まない」という不変条件を持つ**
 * （あちらの `GENERATE_SCRIPT` の注記。`textContent` すら経過秒数以外では使わず、
 * `test/generate-page.test.ts` が変異で確かめている）。**チャットは返答を描くので、その線を越える。**
 * 同じスクリプトに混ぜると、あちらの不変条件が「一部を除いて成り立つ」に薄まる。
 *
 * **こちらの線はこうである。**
 *
 * - **`innerHTML` を使わない**（`test/chat-ui.test.ts` が変異で確かめる）
 * - 要素は `document.createElement` で作り、本文は **`textContent` だけ**で入れる
 * - **応答から読むのは `text` と `conversationId` と `remainingPercent` の 3 つだけ**で、
 *   分類名（`error`）は固定の文言を選ぶ鍵にしか使わない（8.3。生成画面と同じ）
 *
 * ## 復元した会話はサーバが描く
 *
 * 開いた時点の会話は **HTML としてサーバが `escapeHtml` を通して描く**（`renderChatLog`）。
 * スクリプトが描くのは、その後に足された往復だけである。**最初の 1 画面に、script が
 * 組み立てた DOM を出さない。**
 *
 * ## 送る上限を超えたときだけ古い往復を落とし、履歴は切らない（#742 / #749）
 *
 * **画面は履歴の全部を描き、送る上限（`CHAT_MAX_SEND_MESSAGES` 通・`CHAT_MAX_TOTAL_MESSAGE_LENGTH` 文字）以内なら
 * 全部を送る。超えたときだけ最古の往復から落とす**（`windowOf`）。以前は全部を送り、20 通に達すると
 * **送信そのものを止めていた**——10 往復でそのチャットは行き止まりになり、しかも出す文言が「文字数を減らして」だった
 * （通数で止まっているので、減らしても 1 文字も効かない）。#742 は止めずに直近 7 通へ固定で切ったが、
 * 下書きがまだ出ていない会話で決まったことが落ち、AI が同じ質問へ戻り続けた（#749）。**いまは上限を
 * 超えたときだけ落とす。** エッジも同じ規則で切り直す（二重の検査。ルールの分はエッジが空ける）。
 *
 * ## 残りは「今日の残り NN%」で、1 往復してから出す（#751）
 *
 * **円もトークンも利用者に見せない**（利用者の決定）。枠は円で数えているが（`src/chat-quota.ts`）、
 * 画面に出すのは口が返す残りの割合（`remainingPercent`）だけである。
 *
 * **画面を開くたびに D1 を 3 回読まない**（3.6。読み取りも従量である）。生成枠（4.4）と違い、
 * 5.16 はチャットの残量の常時表示を求めていない。**開いた時点では表示を隠しておき、1 往復するたびに
 * 口が返す値で出す。** 以前は開いた時点で上限（「1 日 30,000 トークンまで」）を書いていたが、
 * 額の上限を書くと円を見せることになるので出さない。枠が尽きている状態は、送ったときに固定の文言で返る
 * （そのときは 0% を出す）。
 */
import { CHAT_API_PATH, CHAT_CONVERSATION_DELETE_PATH } from './chat-paths.js';
import { CHAT_MAX_MESSAGE_LENGTH, CHAT_MAX_SEND_MESSAGES, CHAT_MAX_TOTAL_MESSAGE_LENGTH } from './chat-payload.js';
import { CHAT_DAILY_TOKENS_REASON } from './chat-quota.js';
import { CHAT_RETENTION_DAYS } from './chat-conversation.js';
import type { ChatMessage } from './chat-payload.js';
import type { ChatTarget } from './chat-target.js';
import { escapeHtml } from './html.js';
import { MAX_PROMPT_LENGTH } from './generate.js';

/**
 * チャットの返答の中で、指示文の下書きを囲む見出し。
 *
 * **システムプロンプトと同じ綴りである**（`src/chat-prompt.ts` の「`【指示文】` という見出しの
 * 下に置きます」）。**一致は `test/chat-ui.test.ts` が見る**——ずれると「この指示で作る」が
 * 返答の全文を欄へ入れることになる（壊れはしないが、意図した形ではない）。
 */
export const CHAT_DRAFT_HEADING = '【指示文】';

/**
 * 対象ごとの文言（#727 / 確定38）。
 *
 * **3 つの対象で変わるのは、見出し・説明・主のボタンの文言と、そのボタンが送るフォームだけ**
 * である。**会話のしくみも、枠も、保存も同じ**——だから画面は 1 つで足りる（5.16）。
 */
export const CHAT_TARGET_LABELS: Readonly<
  Record<string, { readonly heading: string; readonly hint: string; readonly apply: string; readonly form: string }>
> = {
  new: {
    heading: 'AI とチャットして作る',
    hint: 'どんなゲームにするか話しながら、<strong>指示文の下書き</strong>を作れます。',
    apply: 'この指示で作る',
    form: 'generate-form',
  },
  revise: {
    heading: 'AI とチャットして直す',
    hint: 'この作品をどう直すか話しながら、<strong>リフォージの指示文の下書き</strong>を作れます。<strong>いまのソースをもとに作り直します。</strong>',
    apply: 'この指示で直す',
    form: 'revise-form',
  },
  fork: {
    heading: 'AI とチャットしてフォークする',
    hint: 'この作品をどう変えるか話しながら、<strong>フォークの指示文の下書き</strong>を作れます。<strong>元の作品のソースをもとに、あなたの新しい作品を作ります。</strong>',
    apply: 'この指示でフォークする',
    form: 'fork-form',
  },
};

/**
 * チャットの区画で使う固定の文言（分類名から 1 つだけ選んで見せる。生成画面と同じ形）。
 *
 * **`400:invalid-request` は「1 通の長さ」だけを言う**（#742）。以前は「文字数を減らして」だったが、
 * 実際に断っていたのは**通数**で、減らしても 1 文字も効かなかった。**通数ではもう断らない**
 * （窓へ切る）ので、**利用者が直せる 400 は「1 通が長すぎる」だけ**になった——文言はそれに合わせる。
 * **会話の合計の長さを減らせとは言わない**（古い往復は送らずに落とすので、利用者の側でできることが無い）。
 */
export const CHAT_MESSAGES: Readonly<Record<string, string>> = {
  '': 'チャットできませんでした。時間をおいてもう一度お試しください。',
  '401:': 'ログインの有効期限が切れました。もう一度ログインしてください。',
  '400:invalid-request': `送った内容を受け取れませんでした。1 回に送れるのは ${CHAT_MAX_MESSAGE_LENGTH.toLocaleString('en-US')} 文字までです。短く分けて、もう一度お試しください。`,
  '422:prompt-blocked':
    '入力の検査で止まりました。表現を変えて、もう一度お試しください（同じ内容では何度でも止まります）。',
  '429:rate-limited': '短い時間に何度も送信されました。少し待ってからお試しください。',
  '429:chat-daily-tokens':
    '本日のチャットの枠は終了しました。日付が変わると戻ります（生成はこれまでどおり行えます）。',
  '429:chat-monthly-limit':
    '今月のチャットの枠は終了しました（生成はこれまでどおり行えます）。',
  '429:monthly-limit': '今月の生成は終了しました。プレイと共有は引き続きご利用いただけます。',
  '503:busy': 'チャットが混み合っています。少し待ってからお試しください。',
};

/** チャットの区画へ渡す値。 */
export interface ChatSectionView {
  /** 復元した会話（無ければ空）。 */
  readonly messages: readonly ChatMessage[];
  /** 続きを書き込む会話の id（無ければ null）。 */
  readonly conversationId: string | null;
  /**
   * チャットの対象（#727 / 確定38）。**見出し・説明・主のボタンの文言と行き先が、これで変わる。**
   */
  readonly target: ChatTarget;
}

/**
 * 復元した会話を描く。**サーバ側で `escapeHtml` を通す。**
 *
 * @param messages 発話の列
 * @returns `<li>` の並び
 */
export function renderChatLog(messages: readonly ChatMessage[]): string {
  return messages
    .map(
      (message) =>
        `    <li class="gf-chat-turn gf-chat-${message.role}"><span class="gf-chat-who">${
          message.role === 'user' ? 'あなた' : 'AI'
        }</span><p class="gf-chat-text">${escapeHtml(message.text)}</p></li>`,
    )
    .join('\n');
}

/**
 * チャットの区画の HTML を組み立てる。
 *
 * @param view 画面へ渡す値
 * @returns HTML
 */
export function renderChatSection(view: ChatSectionView): string {
  const messages = Object.entries(CHAT_MESSAGES)
    .map(
      ([key, message]) =>
        `  <p class="generate-message" data-chat-message-key="${escapeHtml(key)}" hidden>${escapeHtml(message)}</p>`,
    )
    .join('\n');
  const conversation = view.conversationId === null ? '' : ` data-conversation="${escapeHtml(view.conversationId)}"`;
  // **対象はスクリプトが毎回の要求に載せる**（`data-target-*`）。**画面が組み立てた値を
  // サーバが信じない**——口の側で同じ規則の検証を通す（`chatTargetFromBody`）。
  const target = ` data-target-kind="${escapeHtml(view.target.kind)}"${
    view.target.id === null ? '' : ` data-target-id="${escapeHtml(view.target.id)}"`
  }`;
  const labels = CHAT_TARGET_LABELS[view.target.kind] ?? CHAT_TARGET_LABELS['new']!;
  // **ソースを見せる操作**（5.16 / 確定38「作者がその会話で明示的に求めたときだけ」）。
  // **#695 から、この操作が画面に無かった**——口は `includeSource` を受けていたのに、
  // **送る側がどこにも無く、決定が 1 度も届いていなかった**（#727 の Copilot の指摘）。
  // **対象があるチャットにだけ出す**（新規のチャットには見せる作品が無い）。
  const sourceToggle =
    view.target.kind === 'new'
      ? ''
      : `      <label class="gf-chat-source"><input type="checkbox" id="chat-source"> いまのソースも見せてチャットする（1 往復が重くなります）</label>\n`;
  // **空のときは `<ol>` の中を本当に空にする。** 改行やインデントを残すと空白のテキストノードが
  // でき、**`:empty`（`public/assets/app.css`）が成立せず余白が残る**（PR #715 の Copilot の指摘）。
  const log = view.messages.length === 0 ? '' : `\n${renderChatLog(view.messages)}\n  `;

  return `<section id="chat" class="gf-block gf-chat"${conversation}${target}>
  <div class="gf-heading-row">
    <h2>${escapeHtml(labels.heading)}</h2>
    <p class="gf-generate-quota" id="chat-quota" hidden></p>
  </div>
  <p class="gf-generate-hint">${labels.hint}
     <strong>コードは出ません。</strong>チャットは生成枠とは別の枠で、<strong>チャットしても生成できる回数は減りません。</strong>
     会話は<strong>あなただけが見られ</strong>、最後に使ってから ${CHAT_RETENTION_DAYS} 日で消えます。</p>
  <ol id="chat-log" class="gf-chat-log" tabindex="0" aria-label="チャットの履歴">${log}</ol>
  <p id="chat-status" role="status" aria-live="polite" hidden>チャットしています…</p>
  <div id="chat-messages" role="status" aria-live="polite">
${messages}
  </div>
  <!-- **この画面の主のボタンはこれ 1 つである**（2.5.5 / 確定38）。下書きが出るまでは隠れており、
       押すと生成のフォームをそのまま送る（\`form\` 属性。**開始の経路は変えない**）。 -->
  <p class="gf-chat-apply-row"><button id="chat-apply" class="gf-button gf-button-primary" type="submit"
          form="${escapeHtml(labels.form)}" hidden>${escapeHtml(labels.apply)}</button></p>
  <!-- **入力は区画の最後の子なので、常にいちばん下にある**（確定38。浮かせない理由は
       \`public/assets/app.css\` の \`.gf-chat\` の冒頭）。区画のボタンは、送るが secondary、
       記録を消すが tertiary である。 -->
  <div class="gf-chat-dock">
    <label class="gf-chat-dock-label" for="chat-input">チャットする（${CHAT_MAX_MESSAGE_LENGTH} 文字まで）</label>
    <div class="gf-chat-dock-row">
      <textarea id="chat-input" rows="2" maxlength="${CHAT_MAX_MESSAGE_LENGTH}"
                placeholder="例: 短い時間で遊べる、避けるゲームを作りたい"></textarea>
      <button id="chat-send" class="gf-button gf-button-secondary" type="button">送る</button>
    </div>
    <div class="gf-chat-actions">
${sourceToggle}      <button id="chat-clear" class="gf-button gf-button-tertiary" type="button">チャットの記録を消す</button>
    </div>
  </div>
  <noscript>
    <p><strong>チャットには JavaScript が必要です。</strong>下の「チャットせずに指示文を直接書く」を開けば、チャットなしで生成できます。</p>
  </noscript>
</section>`;
}

/**
 * チャットの区画のスクリプト。
 *
 * **`innerHTML` を使わない**（モジュール冒頭）。要素は `createElement` で作り、本文は
 * `textContent` だけで入れる。
 *
 * **素朴な書き方（`var` と関数式）に寄せている**のは、この 1 枚がビルド工程を通らずそのまま
 * ブラウザへ届くためである（`src/generate-page.ts` と同じ）。
 */
export const CHAT_SCRIPT = `
(function () {
  var section = document.getElementById('chat');
  var log = document.getElementById('chat-log');
  var input = document.getElementById('chat-input');
  var send = document.getElementById('chat-send');
  var apply = document.getElementById('chat-apply');
  var clear = document.getElementById('chat-clear');
  var status = document.getElementById('chat-status');
  var quota = document.getElementById('chat-quota');
  // **下書きを入れる欄は対象で変わる**（生成 / リフォージ / フォーク）。**主のボタンが属する
  // フォームの欄を引く**ので、ここで 3 つのうち在るものを 1 つ選ぶ。
  var prompt = document.getElementById('generate-prompt')
    || document.getElementById('revise-prompt')
    || document.getElementById('fork-prompt');
  if (section === null || log === null || input === null || send === null) { return; }
  var notices = document.querySelectorAll('[data-chat-message-key]');
  var busy = false;

  /** 会話の全文を DOM から読む（**表示している履歴のすべて**。送るのは windowOf で切ったもの）。 */
  function history() {
    var turns = log.querySelectorAll('.gf-chat-turn');
    var out = [];
    for (var i = 0; i < turns.length; i += 1) {
      var text = turns[i].querySelector('.gf-chat-text');
      // **前後の空白を落としてから数える**（#749 の Copilot の指摘）。エッジは各発話を
      // \`trim()\` してから窓を切る（\`src/chat.ts\` の \`parseChatRequest\`）が、返答は trim せずに
      // 描いている。**ここで揃えないと、12,000 字の境目で画面だけが古い往復を落とす。**
      out.push({
        role: turns[i].className.indexOf('gf-chat-user') >= 0 ? 'user' : 'assistant',
        text: text === null ? '' : (text.textContent || '').trim()
      });
    }
    return out;
  }

  /**
   * 送る範囲を切る（#742 / #749。\`src/chat-payload.ts\` の chatSendWindow と同じ規則）。
   *
   * **上限以内なら 1 通も落とさない。** 超えたときだけ、**往復（2 通）単位で最古から落とす**ので、
   * 先頭と末尾が user で役割が交互のまま残る。文字数はコードポイントで数える。**表示は切らない**
   * ——切るのは送る本文だけである。
   */
  function windowOf(list) {
    var total = 0;
    for (var i = 0; i < list.length; i += 1) { total += Array.from(list[i].text).length; }
    var start = 0;
    while (list.length - start >= 3 && (list.length - start > ${CHAT_MAX_SEND_MESSAGES} || total > ${CHAT_MAX_TOTAL_MESSAGE_LENGTH})) {
      total -= Array.from(list[start].text).length + Array.from(list[start + 1].text).length;
      start += 2;
    }
    return start === 0 ? list : list.slice(start);
  }

  /** 1 往復ぶんを足す。**textContent だけで入れる。** */
  function append(role, text) {
    var item = document.createElement('li');
    item.className = 'gf-chat-turn gf-chat-' + role;
    var who = document.createElement('span');
    who.className = 'gf-chat-who';
    who.textContent = role === 'user' ? 'あなた' : 'AI';
    var body = document.createElement('p');
    body.className = 'gf-chat-text';
    body.textContent = text;
    item.appendChild(who);
    item.appendChild(body);
    log.appendChild(item);
    toBottom();
  }

  /**
   * 履歴をいちばん下まで送る（確定38「往復のたびに最新へスクロールする」）。
   *
   * **動かすのは履歴の箱だけで、画面そのものは動かさない**（\`.gf-chat-log\` が
   * \`overflow-y: auto\` の箱である）。理由はモジュールの冒頭にある。
   */
  function toBottom() {
    log.scrollTop = log.scrollHeight;
  }

  /** 固定の文言を 1 つだけ見せる（生成画面と同じ形。応答の文字列は出さない）。 */
  function notify(status_, code) {
    var candidates = [status_ + ':' + code, status_ + ':', ''];
    var chosen = '';
    for (var c = 0; c < candidates.length && chosen === ''; c += 1) {
      for (var n = 0; n < notices.length; n += 1) {
        if (notices[n].getAttribute('data-chat-message-key') === candidates[c]) { chosen = candidates[c]; }
      }
    }
    for (var m = 0; m < notices.length; m += 1) {
      notices[m].hidden = notices[m].getAttribute('data-chat-message-key') !== chosen;
    }
  }

  /**
   * 今日の残りを割合で出す（#751）。**割合のほかは出さない**（理由はモジュール冒頭）。値は口が切り捨てた整数で、
   * ここでも 0〜100 の整数に収める（古い口や壊れた応答で表示が崩れないように）。
   */
  function showRemaining(percent) {
    if (quota === null) { return; }
    var value = Math.max(0, Math.min(100, Math.floor(percent)));
    if (value !== value) { return; }
    quota.textContent = '今日の残り ' + value + '%';
    quota.hidden = false;
  }

  /** すべての文言を隠す。 */
  function quiet() {
    for (var m = 0; m < notices.length; m += 1) { notices[m].hidden = true; }
  }

  /**
   * 送った発話を取り消して、書いた文を欄へ戻す。
   *
   * **通らなかった往復のあとに、user の発話を DOM へ残さない。** 残すと次の送信で
   * user が 2 連続になり、**サーバの検査（役割は交互）が 400 を返し続ける**
   * ——再読み込みするまでチャットが回復しない。**断られたときも、通信が落ちたときも、同じ
   * 後始末を通す**（片方だけに書くと、もう片方が上の行き止まりを作る）。
   */
  function rollback(text) {
    var last = log.lastElementChild;
    if (last !== null) { log.removeChild(last); }
    input.value = text;
  }

  /** いちばん新しい AI の返答から、指示文の下書きを取り出す。 */
  function draft() {
    var turns = log.querySelectorAll('.gf-chat-assistant .gf-chat-text');
    if (turns.length === 0) { return ''; }
    var text = turns[turns.length - 1].textContent || '';
    var at = text.indexOf(${JSON.stringify(CHAT_DRAFT_HEADING)});
    if (at >= 0) { text = text.slice(at + ${CHAT_DRAFT_HEADING.length}); }
    return text.replace(/^[\\s\\r\\n]+/, '').slice(0, ${MAX_PROMPT_LENGTH});
  }

  /** 「この指示で作る」を出すかどうかを決める。 */
  function refreshApply() {
    if (apply !== null) { apply.hidden = draft() === ''; }
  }

  send.addEventListener('click', function () {
    if (busy) { return; }
    var text = (input.value || '').trim();
    if (text === '') { return; }
    // **通数では止めない**（#742）。上限を超えたら送る本文の古い往復を落とすだけで、何往復目でも送れる。
    busy = true;
    quiet();
    send.disabled = true;
    if (status !== null) { status.hidden = false; }
    append('user', text);
    input.value = '';
    var body = { messages: windowOf(history()) };
    body.targetKind = section.getAttribute('data-target-kind') || 'new';
    // **ソースは、作者がその往復で求めたときだけ載る**（5.16 / 確定38）。**毎往復ごとに読む**
    // ——外せば次の往復からは載らない（重さが戻る）。
    var source = document.getElementById('chat-source');
    if (source !== null && source.checked) { body.includeSource = true; }
    var targetId = section.getAttribute('data-target-id');
    if (targetId !== null && targetId !== '') { body.targetId = targetId; }
    var id = section.getAttribute('data-conversation');
    if (id !== null && id !== '') { body.conversationId = id; }
    fetch(${JSON.stringify(CHAT_API_PATH)}, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (response) {
      return response.json().then(function (payload) { return { status: response.status, payload: payload }; });
    }).then(function (result) {
      if (result.status !== 200) {
        rollback(text);
        notify(result.status, typeof result.payload.error === 'string' ? result.payload.error : '');
        if (result.payload.error === ${JSON.stringify(CHAT_DAILY_TOKENS_REASON)}) { showRemaining(0); }
        return;
      }
      append('assistant', result.payload.text);
      if (typeof result.payload.conversationId === 'string') {
        section.setAttribute('data-conversation', result.payload.conversationId);
      }
      if (typeof result.payload.remainingPercent === 'number') {
        showRemaining(result.payload.remainingPercent);
      }
      refreshApply();
    }).catch(function () {
      // **通信が落ちたときと、応答が JSON でないときもここへ来る。** 上の枝と同じ後始末を
      // 通す（rollback の注記）。
      rollback(text);
      notify(0, '');
    }).then(function () {
      busy = false;
      send.disabled = false;
      if (status !== null) { status.hidden = true; }
    });
  });

  if (apply !== null && prompt !== null) {
    apply.addEventListener('click', function (event) {
      var text = draft();
      // **下書きが無いのに送らない。** 空のまま通すと、直接書く欄に残っていた前の値が飛ぶ。
      if (text === '') { event.preventDefault(); return; }
      // **開始の経路は変えない**（5.16 / 確定38）。欄へ入れてから、このボタン自身が
      // \`generate-form\` を送る（\`type="submit"\` と \`form\` 属性）。送信を受けるのは
      // \`src/generate-page.ts\` の \`GENERATE_SCRIPT\` で、POST /api/generate は今までどおりである。
      prompt.value = text;
    });
  }

  if (clear !== null) {
    clear.addEventListener('click', function () {
      if (busy) { return; }
      busy = true;
      clear.disabled = true;
      fetch(${JSON.stringify(CHAT_CONVERSATION_DELETE_PATH)}, { method: 'POST' })
        .then(function (response) {
          if (response.status !== 200) { notify(response.status, ''); return; }
          while (log.firstChild !== null) { log.removeChild(log.firstChild); }
          section.removeAttribute('data-conversation');
          quiet();
          refreshApply();
        })
        .catch(function () { notify(0, ''); })
        .then(function () { busy = false; clear.disabled = false; });
    });
  }

  refreshApply();
  toBottom();
})();
`;
