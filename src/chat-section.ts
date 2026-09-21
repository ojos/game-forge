/**
 * 生成画面の主役である「チャット」（#695 / M18-2、#726 / M20-2、#738 / M21-2。仕様 5.16 / 確定38）。
 *
 * ## 欄は 1 つ、ボタンは 2 つ（#738。5.16「仕上げの 6 つの決定」）
 *
 * **#726 では欄が 2 つあった**——チャットの入力（見えている）と、指示文の欄（`<details>` の中。
 * 「チャットせずに指示文を直接書く」）。**#738 で 1 つにした。** 欄は生成のフォームの欄そのもの
 * （`generate-prompt` / `revise-prompt` / `fork-prompt`）で、**この区画の最後の子として置く**
 * （{@link renderChatSection} の `composer`）。**その欄の中身をどちらへ送るかは、押したボタンが決める**
 * ——「チャットする」（副）はこのスクリプトが `POST /api/chat` へ送り、「生成する」（主。2.5.5 の
 * 1 画面に 1 つ）はフォームの送信で、受けるのは今までどおり `src/generate-page.ts` の
 * `GENERATE_SCRIPT`（リフォージとフォークは素のフォーム送信）である。**開始の経路は 1 本も増えない。**
 * 自動判定もコマンドも作らない（誤ったときの損失が非対称である。理由は 5.16）。
 *
 * **キーは安い側にだけ割り当てる**——**Enter ＝ 改行 / Shift+Enter ＝ チャットを送る / 生成には
 * キーを割り当てない**（`sendsChat`）。**IME の変換確定の Enter は修飾キーを伴わないので、
 * そもそも拾わない**が、それでも 3 段で守る（`isComposing` / `keyCode === 229` /
 * `compositionend` の直後に来た Enter）。
 *
 * **会話の中の下書きを欄へ入れる手段は残す**（「下書きを欄へ入れる」。控えめのボタン）。
 * **欄へ入れるだけで、送らない**——生成は必ず作者が「生成する」を押して始まる。**置く場所は
 * 欄の下の操作の並びで、返答の 1 つ 1 つには付けない**（返答の本文を描く形は #739 が Markdown の
 * 描画で作り替えるので、そこへ押す物を混ぜない）。入れるのは**いちばん新しい返答の下書き**である。
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
 * 画面に出すのは口が返す残りの割合（`remainingPercent`）だけである。**この割合は「次の 1 回を送れる分」**
 * で、次の 1 往復の最大の見積もりを先に引いてある（`src/chat.ts` の `worstNextChatCharacters`）——
 * **0% より大きい間は、どの長さの発話も見積もりで断られない。** 朝いちばんでも 100% にはならない。
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
 * 下に置きます」）。**一致は `test/chat-ui.test.ts` が見る**——ずれると「下書きを欄へ入れる」が
 * 返答の全文を欄へ入れることになる（壊れはしないが、意図した形ではない）。
 */
export const CHAT_DRAFT_HEADING = '【指示文】';

/**
 * 変換の確定（`compositionend`）の直後に来た Enter を送らない時間（ミリ秒。#738 の IME の防御の 3 段目）。
 *
 * **確定と同じ押下から来る keydown を捨てるための幅**で、人が確定してから Shift+Enter を押し直すまでの
 * 間よりずっと短い。捨てた側に倒れても、押し直せば送れる。
 */
export const COMPOSITION_GUARD_MS = 100;

/**
 * 対象ごとの文言（#727 / 確定38）。
 *
 * **3 つの対象で変わるのは、見出しと説明だけ**である。**会話のしくみも、枠も、保存も同じ**
 * ——だから画面は 1 つで足りる（5.16）。**#738 で「この指示で作る」を無くした**ので、主のボタンの
 * 文言と行き先はここから消え、生成のフォームを描く `src/generate-page.ts` が持つ。
 */
export const CHAT_TARGET_LABELS: Readonly<Record<string, { readonly heading: string; readonly hint: string }>> = {
  new: {
    heading: 'AI とチャットして作る',
    hint: 'どんなゲームにするか話しながら、<strong>指示文の下書き</strong>を作れます。',
  },
  revise: {
    heading: 'AI とチャットして直す',
    hint: 'この作品をどう直すか話しながら、<strong>リフォージの指示文の下書き</strong>を作れます。<strong>いまのソースをもとに作り直します。</strong>',
  },
  fork: {
    heading: 'AI とチャットしてフォークする',
    hint: 'この作品をどう変えるか話しながら、<strong>フォークの指示文の下書き</strong>を作れます。<strong>元の作品のソースをもとに、あなたの新しい作品を作ります。</strong>',
  },
};

/**
 * キーの案内の要素の id（#738）。**欄の `aria-describedby` がこれを指す**——欄を描くのは
 * `src/generate-page.ts` なので、綴りを書き写さずにここから引く。
 */
export const CHAT_KEY_HINT_ID = 'chat-key-hint';

/**
 * キーの案内（#738。5.16「キー」）。**生成にキーが無いことも言う**——「Enter で送れない」を
 * 不具合だと思わせないためである。
 *
 * **主のボタンの文言から組み立てる**（PR #754 の Copilot の指摘）。リフォージ／フォークの画面の主は
 * 「リフォージする」「フォークする」で、「生成する」は存在しない。**案内が実在しない操作を指さないよう、
 * 文言は `ChatComposer.submitLabel` の 1 か所から、ボタンと案内の両方へ流す。**
 */
export function chatKeyHint(submitLabel: string): string {
  return `Shift+Enter でチャットを送れます（Enter は改行です）。「${submitLabel}」はボタンを押したときだけ始まります。`;
}

/**
 * 1 つの欄を持つ入力の塊（#738）。**中身は `src/generate-page.ts` が組み立てた HTML である。**
 *
 * **欄と「生成する」は生成のフォームのもの**なので、あちらが描く（開始の経路・項目名・`maxlength`
 * を 2 か所に書かない）。**この区画が足すのは、チャットの操作だけ**——「チャットする」と、
 * キーの案内と、ソースを見せるチェック・下書きを欄へ入れる・記録を消す、である。
 */
export interface ChatComposer {
  /** フォームの開きタグ（隠しの項目を含む）。閉じタグはこの区画が書く。 */
  readonly open: string;
  /** 欄より上に置く行（欄の名前・生成枠・題名の案内）。 */
  readonly head: string;
  /** 欄（`<textarea>`。区画の中でただ 1 つ）。 */
  readonly field: string;
  /** 生成のボタン（**この画面の主**。`type="submit"`）。 */
  readonly submit: string;
  /**
   * 主のボタンの文言（「生成する」「リフォージする」「フォークする」）。**ボタンとキーの案内の両方が
   * ここから作られる**——別々に書くと、案内だけが古い文言を指す（PR #754 の Copilot の指摘）。
   */
  readonly submitLabel: string;
}

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
 * **入力の塊（`composer`）は区画の最後の子である**——伸び縮みするのは会話の箱だけで、欄は常に
 * いちばん下にある（`public/assets/app.css` の `.gf-chat`）。
 *
 * @param view 画面へ渡す値
 * @param composer 生成のフォームの部品（欄と「生成する」。#738）
 * @returns HTML
 */
export function renderChatSection(view: ChatSectionView, composer: ChatComposer): string {
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
  // **対象があるチャットにだけ出す**（新規のチャットには見せる作品が無い）。**`name` を持たない**
  // ——生成のフォームの中にあるので、名前を付けるとリフォージとフォークの素の送信に載ってしまう。
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
  <noscript>
    <p><strong>チャットには JavaScript が必要です。</strong></p>
  </noscript>
  <!-- **欄は 1 つ、ボタンは 2 つ**（#738 / 5.16）。欄と主のボタン（新規は生成・対象があればリフォージ／フォーク）は
       そのフォームのもので、「チャットする」は同じ欄の中身をチャットへ送る。**主はその 1 つだけ**（2.5.5）で、
       区画のほかのボタンは、チャットするが secondary、下書きを入れる・記録を消すが tertiary である。
       **入力は区画の最後の子なので、常にいちばん下にある**（浮かせない理由は
       \`public/assets/app.css\` の \`.gf-chat\` の冒頭）。 -->
  ${composer.open}
    ${composer.head}
    ${composer.field}
    <p class="gf-generate-hint" id="${CHAT_KEY_HINT_ID}">${escapeHtml(chatKeyHint(composer.submitLabel))}</p>
    <div class="gf-chat-composer-row">
      <button id="chat-send" class="gf-button gf-button-secondary" type="button">チャットする</button>
      ${composer.submit}
    </div>
    <div class="gf-chat-actions">
${sourceToggle}      <button id="chat-draft" class="gf-button gf-button-tertiary" type="button" hidden>下書きを欄へ入れる</button>
      <button id="chat-clear" class="gf-button gf-button-tertiary" type="button">チャットの記録を消す</button>
    </div>
  </form>
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
  var send = document.getElementById('chat-send');
  var insert = document.getElementById('chat-draft');
  var clear = document.getElementById('chat-clear');
  var status = document.getElementById('chat-status');
  var quota = document.getElementById('chat-quota');
  if (section === null || log === null || send === null) { return; }
  // **欄は 1 つである**（#738）。生成のフォームの欄（生成 / リフォージ / フォークで id が違う）が
  // この区画の中にただ 1 つあるので、id を書き写さずに区画の中から引く。
  var input = section.querySelector('textarea');
  if (input === null) { return; }
  var notices = document.querySelectorAll('[data-chat-message-key]');
  var busy = false;
  // 変換の確定（compositionend）を最後に見た時刻。IME の防御の 3 段目に使う。
  var composedAt = -Infinity;

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

  /** 「下書きを欄へ入れる」を出すかどうかを決める（下書きが無ければ隠す）。 */
  function refreshDraft() {
    if (insert !== null) { insert.hidden = draft() === ''; }
  }

  /**
   * そのキーの押下でチャットを送るか（#738。仕様 5.16「キー」）。
   *
   * **送るのは Shift+Enter だけ**で、Enter は改行のまま（既定の動きを止めない）。**生成にはキーを
   * 割り当てない**——生成は押し間違えたときに戻せない側なので、ボタンだけにする。
   *
   * **IME の防御は 3 段である。** 変換を確定する Enter は修飾キーを伴わないので、そもそも
   * 1 行目で落ちる。それでも、変換中の押下（isComposing）・変換中を示す keyCode 229・変換を
   * 確定した直後に来た Enter（ブラウザによっては確定の後に isComposing の外れた押下が届く）の
   * 3 つを送らない側へ倒す。**押し直せば送れる**ので、迷ったら送らない。
   */
  function sendsChat(event, composedAt) {
    if (event.key !== 'Enter' || !event.shiftKey) { return false; }
    if (event.ctrlKey || event.altKey || event.metaKey) { return false; }
    if (event.isComposing || event.keyCode === 229) { return false; }
    if (event.timeStamp - composedAt < ${COMPOSITION_GUARD_MS}) { return false; }
    return true;
  }

  /** 欄の中身をチャットへ送る（「チャットする」と Shift+Enter の両方がここを通る）。 */
  function sendChat() {
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
      refreshDraft();
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
  }

  send.addEventListener('click', sendChat);

  input.addEventListener('compositionend', function (event) { composedAt = event.timeStamp; });
  input.addEventListener('keydown', function (event) {
    if (!sendsChat(event, composedAt)) { return; }
    // Shift+Enter の既定（改行）を止めて、チャットへ送る。
    event.preventDefault();
    sendChat();
  });

  if (insert !== null) {
    insert.addEventListener('click', function () {
      var text = draft();
      if (text === '') { return; }
      // **欄へ入れるだけで、送らない**（5.16 / #738）。生成は作者が「生成する」を押して始まる。
      // 欄に書きかけがあっても置き換える（下書きは毎回全文なので、足すと重なる）。
      input.value = text;
      input.focus();
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
          refreshDraft();
        })
        .catch(function () { notify(0, ''); })
        .then(function () { busy = false; clear.disabled = false; });
    });
  }

  refreshDraft();
  toBottom();
})();
`;
