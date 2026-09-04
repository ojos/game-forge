/**
 * 出力側モデレーションの NG ワード表（8.3 / #38）。
 *
 * **このファイルはデータだけを持つ。** 突き合わせの規則（正規化・部分一致か語一致か・
 * 拒否の形）は `src/output-moderation.ts` にあり、そちらには語が 1 つも書かれていない。
 * 分ける理由は 2 つある。**語の増減はレビューで 1 ファイルに閉じる**ことと、
 * **検査の振る舞いを試すテストが語を 1 つも要らなくなる**ことである（`test/output-moderation.test.ts`
 * はダミー語を注入して規則だけを試す）。
 *
 * ## なぜコードへ直書きなのか（この issue の scope。#38）
 *
 * **外（D1 / 環境変数 / R2）へ出さない。** 3 つの理由による。
 *
 * 1. **検査段は同期の純粋関数で、`Env` を受け取らない**（`GenerationPipeline['inspectSource']`）。
 *    しかも**エッジ（`src/generate.ts` の `defaultPipeline`）とオーケストレータ
 *    （`src/orchestrator/pipeline.ts`）が同じ関数を借りている。** 外から読む形にすると、
 *    読めなかった実行環境で**表が空のまま検査が緑を返す。** 引き継ぎ 4 章
 *    「検査そのものを疑うこと」が記録している #160 の事故（消えた output と消えた
 *    環境変数を突き合わせ、空どうしが一致して緑）と同じ形であり、
 *    **確かめていない検査は、確かめた証拠として読まれるぶん赤より悪い。**
 * 2. **環境ごとに違ってよい値ではない。** 8.1 の招待枠（`INVITE_QUOTA`）を環境変数に
 *    しなかったのと同じ理由である。本番だけ厳しく、開発は緩い、という状態に意味がない。
 * 3. **先例がある。** 許可 import の一覧（`src/go-import-allowlist.ts`）も
 *    「この配列が唯一の正である」としてコード側に置いている。検査に使う表の所在を
 *    2 種類にしない。
 *
 * **リポジトリが公開であることは承知のうえである。** 表が読めることで回避（同義語・
 * 綴りの崩し）は容易になるが、8.3 は元より「安い検査で大半を捕まえる層」であって、
 * 残りは 8.4 の通報と審査キューが受ける設計である。**表を隠して得られる強度は、
 * 表が空になりうる経路を作る危険に見合わない。**
 *
 * ## それでも注入できるようにしてある
 *
 * `inspectStringLiterals` / `createSourceInspector` は表を引数で受け取り、既定が
 * {@link DENIED_TERMS} である。**運用（8.4）から語を流し込む口が要ると分かった時点で、
 * 継ぎ目はもう空いている。** 空の表を渡せてしまうが、**既定の表が空でないことは
 * `test/output-moderation.test.ts` が機械で見る**（空にすると赤になる）。
 *
 * ## 表は網羅ではない
 *
 * ここに並ぶのは**着手時点の種**であり、完全な一覧ではない。8.3 が自ら
 * 「8.3 が通ったことをもって『差別的な表示が無い』とは主張しない」と書いているとおり、
 * 算術ピクセル描画・`strconv` での組み立て・同義語・綴りの崩しは素通りする。
 * **語を足すのは運用の仕事**（8.4 の通報から来る）であって、この検査の完成条件ではない。
 *
 * ## 片仮名の綴りを別の行として持つ（#285）
 *
 * **正規化は片仮名と平仮名を同じにしない。** `normalizeForMatching`（NFKC ＋ 小文字化）は
 * 半角片仮名を全角片仮名へ寄せるので `ﾒｸﾗ` は `メクラ` で拾えるが、**`めくら` の行では
 * 拾えない。** 平仮名だけを持つ語は、片仮名で書かれた瞬間に素通りする。
 *
 * **#285 で生成物が日本語を画面へ出せるようになった**（`jpfont`。仕様 6.1）。焼いたのは
 * ドットのフォントで、そこへ出る日本語は片仮名の割合が高い。**穴が塞がっていなかった
 * のではなく、通る文字列の量が変わった**ので種を厚くする。`きちがい` / `キチガイ` は
 * 元から両方あり、揃っていなかったのは残りのほうである。
 *
 * **平仮名へ寄せて正規化する形は採らない。** 突き合わせ側で片仮名を平仮名へ畳むと、
 * **表の全行に効く**——`おし` を落とした理由（「おしまい」に含まれる）と同じ衝突が、
 * 片仮名側の語（`オシ` → 「オシャレ」）でも起きる。**誤検出は 1 回ぶんの枠と費用を
 * 消す**ので、効く範囲を 1 語ずつに閉じられる「行を足す」ほうを採る。
 *
 * ## 誤検出を避けるために `match` を持つ
 *
 * 日本語には語の区切りが無いので部分一致で見るしかない。一方、英字の語を部分一致に
 * すると**無関係な語の中に埋もれた綴り**を拾う（いわゆる Scunthorpe 問題）。
 * **誤検出は「作れたはずのゲームが作れない」であり、1 回ぶんの枠と費用が消える**
 * （4.3 / 4.2）ので、軸を分けて持つ。
 */

/** 突き合わせの単位。 */
export type DeniedTermMatch =
  /** 部分一致。語の区切りが無い文字体系（日本語など）で使う。 */
  | 'substring'
  /** 語一致。前後が英数字・アンダースコアでないときだけ当たる。英字の語で使う。 */
  | 'word';

/** 拒否する語 1 件。 */
export interface DeniedTerm {
  /**
   * 語の綴り。**正規化前の形で書いてよい。**
   *
   * 突き合わせ側が表の綴りにも入力にも**同じ正規化**（`src/output-moderation.ts` の
   * `normalizeForMatching`）を掛けるので、ここで小文字化や全角半角を揃える必要はない。
   * 揃える作業を人に課すと、揃え忘れた行が黙って当たらなくなる。
   */
  readonly term: string;
  /** 突き合わせの単位。 */
  readonly match: DeniedTermMatch;
  /**
   * 分類。**拒否したときに外へ出るのはこれだけで、当たった語そのものは出さない。**
   *
   * 8.3 の #133 注記は「生成物由来でない固定語彙はこの節の対象にならない」とするので、
   * 語を出しても規約違反ではない。それでも出さないのは、**422 の応答が表を 1 語ずつ
   * 引き出せる口になる**ためである（当てては消し、を繰り返せば一覧が復元できる）。
   * 分類なら、運用側が「何の理由で落ちたか」を読むには足りる。
   */
  readonly category: DeniedTermCategory;
}

/**
 * 分類。**固定語彙である**（応答とログへ出る）。
 *
 * **いまは 1 つしかない。** 8.3 が名指ししているのは差別語だけなので、使わない分類を
 * 先回りして並べない（`union` に並んでいる値は「表にその種類がある」と読まれる）。
 * 別の種類を扱うと決めた時点で足す。
 */
export type DeniedTermCategory =
  /** 属性（人種・出自・障害・性的指向など）にもとづく差別語。 */
  'discriminatory';

/**
 * 拒否する語の表。
 *
 * **並び順に意味は無い。** 分類ごとにまとめてあるのは読みやすさのためだけである。
 *
 * 語を足すときは、**誤検出の側を先に考えること。** 「その綴りを含む正当な日本語が
 * あるか」を確かめずに足すと、無関係なゲームが 422 で落ちる。実際に落とした候補を
 * 下に残しておく（同じ検討を次の人にやり直させないため）。
 *
 * - `かたわ` — 「かたわら（傍ら）」に含まれる。
 * - `鮮人` — 「朝鮮人」に含まれる。**こちらは差別語ではない。**
 * - `おし` — 「おしまい」「おしえる」ほか多数に含まれる。
 * - `chink` — 英語の "a chink of light" / "a chink in the armor" が正当な用法。
 * - `カタワ` — 「カタワレ時」（片割れ時）に含まれる。
 * - `オシ` — 「オシャレ」「オシロスコープ」ほかに含まれる（`おし` と同じ理由）。
 * - `気ちがい` — 「雰囲気ちがいますね」に含まれる。
 * - `チョン` — 「チョンボ」「チョンマゲ」に含まれる。
 * - `おかま` — 「おかまいなく」に含まれる。
 * - `ホモ` — 「ホモサピエンス」に含まれる。
 * - `エタ` — 「エタノール」に含まれる。
 * - `非人` — 「非人道的」「非人間的」に含まれる。
 * - `盲` — 「盲点」「色盲」「盲導犬」に含まれる。
 */
export const DENIED_TERMS: readonly DeniedTerm[] = [
  // 日本語。**語の区切りが無いので部分一致で見る。**
  { term: 'きちがい', match: 'substring', category: 'discriminatory' },
  { term: 'キチガイ', match: 'substring', category: 'discriminatory' },
  { term: '気違い', match: 'substring', category: 'discriminatory' },
  { term: '気狂い', match: 'substring', category: 'discriminatory' },
  { term: 'つんぼ', match: 'substring', category: 'discriminatory' },
  { term: 'ツンボ', match: 'substring', category: 'discriminatory' },
  { term: 'めくら', match: 'substring', category: 'discriminatory' },
  { term: 'メクラ', match: 'substring', category: 'discriminatory' },
  { term: 'びっこ', match: 'substring', category: 'discriminatory' },
  { term: 'ビッコ', match: 'substring', category: 'discriminatory' },
  { term: '白痴', match: 'substring', category: 'discriminatory' },
  { term: '土人', match: 'substring', category: 'discriminatory' },
  { term: '支那人', match: 'substring', category: 'discriminatory' },
  { term: 'シナ人', match: 'substring', category: 'discriminatory' },
  { term: '三国人', match: 'substring', category: 'discriminatory' },

  // 英字。**語一致で見る**（部分一致にすると無関係な語の中の綴りを拾う）。
  { term: 'nigger', match: 'word', category: 'discriminatory' },
  { term: 'nigga', match: 'word', category: 'discriminatory' },
  { term: 'faggot', match: 'word', category: 'discriminatory' },
  { term: 'retard', match: 'word', category: 'discriminatory' },
  { term: 'tranny', match: 'word', category: 'discriminatory' },
  { term: 'kike', match: 'word', category: 'discriminatory' },
  { term: 'wetback', match: 'word', category: 'discriminatory' },
];
