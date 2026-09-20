/**
 * 生成画面の中の「相談の区画」（#695 / M18-2。仕様 5.16「画面は `/generate` の中の区画」）。
 *
 * ## なぜ別のモジュールなのか
 *
 * **`src/generate-page.ts` のスクリプトは「文字列を DOM へ書き込まない」という不変条件を持つ**
 * （あちらの `GENERATE_SCRIPT` の注記。`textContent` すら経過秒数以外では使わず、
 * `test/generate-page.test.ts` が変異で確かめている）。**相談は返答を描くので、その線を越える。**
 * 同じスクリプトに混ぜると、あちらの不変条件が「一部を除いて成り立つ」に薄まる。
 *
 * **こちらの線はこうである。**
 *
 * - **`innerHTML` を使わない**（`test/chat-ui.test.ts` が変異で確かめる）
 * - 要素は `document.createElement` で作り、本文は **`textContent` だけ**で入れる
 * - **応答から読むのは `text` と `conversationId` と `remainingTokens` の 3 つだけ**で、
 *   分類名（`error`）は固定の文言を選ぶ鍵にしか使わない（8.3。生成画面と同じ）
 *
 * ## 復元した会話はサーバが描く
 *
 * 開いた時点の会話は **HTML としてサーバが `escapeHtml` を通して描く**（`renderChatLog`）。
 * スクリプトが描くのは、その後に足された往復だけである。**最初の 1 画面に、script が
 * 組み立てた DOM を出さない。**
 *
 * ## 残りのトークンは、最初は上限を出すだけにする
 *
 * **画面を開くたびに D1 を 3 回読まない**（3.6。読み取りも従量である）。生成枠（4.4）と違い、
 * 5.16 は相談の残量の常時表示を求めていない。**上限を書いておき、1 往復するたびに口が返す
 * 実測値へ置き換える。** 枠が尽きている状態は、送ったときに固定の文言で返る。
 */
import { CHAT_API_PATH, CHAT_CONVERSATION_DELETE_PATH } from './chat-paths.js';
import { CHAT_MAX_MESSAGES, CHAT_MAX_MESSAGE_LENGTH } from './chat-payload.js';
import { CHAT_DAILY_TOKEN_LIMIT } from './chat-quota.js';
import { CHAT_RETENTION_DAYS } from './chat-conversation.js';
import type { ChatMessage } from './chat-payload.js';
import { escapeHtml } from './html.js';
import { MAX_PROMPT_LENGTH } from './generate.js';

/**
 * 相談の返答の中で、指示文の下書きを囲む見出し。
 *
 * **システムプロンプトと同じ綴りである**（`src/chat-prompt.ts` の「`【指示文】` という見出しの
 * 下に置きます」）。**一致は `test/chat-ui.test.ts` が見る**——ずれると「この指示で作る」が
 * 返答の全文を欄へ入れることになる（壊れはしないが、意図した形ではない）。
 */
export const CHAT_DRAFT_HEADING = '【指示文】';

/** 相談の区画で使う固定の文言（分類名から 1 つだけ選んで見せる。生成画面と同じ形）。 */
export const CHAT_MESSAGES: Readonly<Record<string, string>> = {
  '': '相談できませんでした。時間をおいてもう一度お試しください。',
  '401:': 'ログインの有効期限が切れました。もう一度ログインしてください。',
  '400:invalid-request': '相談の内容を受け取れませんでした。文字数を減らしてお試しください。',
  '422:prompt-blocked':
    '入力の検査で止まりました。表現を変えて、もう一度お試しください（同じ内容では何度でも止まります）。',
  '429:rate-limited': '短い時間に何度も送信されました。少し待ってからお試しください。',
  '429:chat-daily-tokens':
    '本日の相談の枠は終了しました。日付が変わると戻ります（生成はこれまでどおり行えます）。',
  '429:chat-monthly-limit':
    '今月の相談の枠は終了しました（生成はこれまでどおり行えます）。',
  '429:monthly-limit': '今月の生成は終了しました。プレイと共有は引き続きご利用いただけます。',
  '503:busy': '相談が混み合っています。少し待ってからお試しください。',
};

/** 相談の区画へ渡す値。 */
export interface ChatSectionView {
  /** 復元した会話（無ければ空）。 */
  readonly messages: readonly ChatMessage[];
  /** 続きを書き込む会話の id（無ければ null）。 */
  readonly conversationId: string | null;
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
 * 相談の区画の HTML を組み立てる。
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
  // **空のときは `<ol>` の中を本当に空にする。** 改行やインデントを残すと空白のテキストノードが
  // でき、**`:empty`（`public/assets/app.css`）が成立せず余白が残る**（PR #715 の Copilot の指摘）。
  const log = view.messages.length === 0 ? '' : `\n${renderChatLog(view.messages)}\n  `;

  return `<section id="chat" class="gf-block gf-chat"${conversation}>
  <div class="gf-heading-row">
    <h2>先に AI と相談する（任意）</h2>
    <p class="gf-generate-quota" id="chat-quota">1 日 ${CHAT_DAILY_TOKEN_LIMIT.toLocaleString('en-US')} トークンまで</p>
  </div>
  <p class="gf-generate-hint">どんなゲームにするか話しながら、上の欄へ入れる<strong>指示文の下書き</strong>を作れます。
     <strong>コードは出ません。</strong>相談は生成枠とは別の枠で、<strong>相談しても生成できる回数は減りません。</strong>
     会話は<strong>あなただけが見られ</strong>、最後に使ってから ${CHAT_RETENTION_DAYS} 日で消えます。</p>
  <ol id="chat-log" class="gf-chat-log">${log}</ol>
  <label for="chat-input">相談する（${CHAT_MAX_MESSAGE_LENGTH} 文字まで）</label>
  <textarea id="chat-input" rows="3" maxlength="${CHAT_MAX_MESSAGE_LENGTH}"
            placeholder="例: 短い時間で遊べる、避けるゲームを作りたい"></textarea>
  <!-- **主のボタンは「生成する」1 つだけである**（2.5.5）。相談の区画のボタンは、
       区画の主（相談する・この指示で作る）が secondary、記録を消すが tertiary である。 -->
  <div class="gf-chat-actions">
    <button id="chat-send" class="gf-button gf-button-secondary" type="button">相談する</button>
    <button id="chat-apply" class="gf-button gf-button-secondary" type="button" hidden>この指示で作る</button>
    <button id="chat-clear" class="gf-button gf-button-tertiary" type="button">相談の記録を消す</button>
  </div>
  <p id="chat-status" role="status" aria-live="polite" hidden>相談しています…</p>
  <div id="chat-messages" role="status" aria-live="polite">
${messages}
  </div>
  <noscript>
    <p><strong>相談には JavaScript が必要です。</strong>上の欄に直接指示文を書けば、相談なしで生成できます。</p>
  </noscript>
</section>`;
}

/**
 * 相談の区画のスクリプト。
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
  var prompt = document.getElementById('generate-prompt');
  if (section === null || log === null || input === null || send === null) { return; }
  var notices = document.querySelectorAll('[data-chat-message-key]');
  var busy = false;

  /** 会話の全文を DOM から読む。**送るのはサーバが受けた形そのものである。** */
  function history() {
    var turns = log.querySelectorAll('.gf-chat-turn');
    var out = [];
    for (var i = 0; i < turns.length; i += 1) {
      var text = turns[i].querySelector('.gf-chat-text');
      out.push({
        role: turns[i].className.indexOf('gf-chat-user') >= 0 ? 'user' : 'assistant',
        text: text === null ? '' : text.textContent
      });
    }
    return out;
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

  /** すべての文言を隠す。 */
  function quiet() {
    for (var m = 0; m < notices.length; m += 1) { notices[m].hidden = true; }
  }

  /**
   * 送った発話を取り消して、書いた文を欄へ戻す。
   *
   * **通らなかった往復のあとに、user の発話を DOM へ残さない。** 残すと次の送信で
   * user が 2 連続になり、**サーバの検査（役割は交互）が 400 を返し続ける**
   * ——再読み込みするまで相談が回復しない。**断られたときも、通信が落ちたときも、同じ
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
    var turns = log.querySelectorAll('.gf-chat-turn');
    if (turns.length + 1 > ${CHAT_MAX_MESSAGES}) {
      notify(400, 'invalid-request');
      return;
    }
    busy = true;
    quiet();
    send.disabled = true;
    if (status !== null) { status.hidden = false; }
    append('user', text);
    input.value = '';
    var body = { messages: history() };
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
        return;
      }
      append('assistant', result.payload.text);
      if (typeof result.payload.conversationId === 'string') {
        section.setAttribute('data-conversation', result.payload.conversationId);
      }
      if (quota !== null && typeof result.payload.remainingTokens === 'number') {
        quota.textContent = '本日の相談の残り ' + result.payload.remainingTokens + ' トークン';
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
    apply.addEventListener('click', function () {
      var text = draft();
      if (text === '') { return; }
      // **開始の経路は変えない**（5.16）。欄へ入れるだけで、送信は作者が「生成する」を押す。
      prompt.value = text;
      prompt.focus();
      if (typeof prompt.scrollIntoView === 'function') { prompt.scrollIntoView(); }
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
})();
`;
