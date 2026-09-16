/**
 * ビルド結果キャッシュ（仕様 3.8「ビルド結果キャッシュ」/ #19）。
 *
 * **置き場は選び直さない。** 3.8 が「保存先は関数の `/tmp` に置けない。**関数の外**
 * （R2 の既存オブジェクトと D1 の索引）に置く」と決めている。`/tmp` は実行環境ごとに
 * 分かれ、しかも 7.1 の掃除で毎回消えるためである。このモジュールはその決定の実体で、
 * **D1 の索引**（`migrations/0002_build_cache.sql`）と **R2 の既存オブジェクト**の
 * 突き合わせだけを行う。
 *
 * ## 索引は「ある」と言うだけでは足りない
 *
 * **ヒットの判定に R2 の実在確認を含める。** 3.7（確定13）は「14 日間未公開なら
 * 自動削除」のライフサイクルルールを R2 に置くと定めており、**索引は残っているのに
 * 成果物だけが消えている状態が、運用上ふつうに起こる。** 索引だけを信じると、
 * `games` 行は作られるのに 404 を返す作品が生まれる。head を 1 往復（Class B。
 * 3.7 の無料枠 1,000 万/月に対して生成 1 件あたり 2 回）足して、消えていたら
 * ミスとして扱い、索引の行も落とす。
 *
 * ## 成果物を書くのはこのモジュールではない
 *
 * **R2 への書き込みと `games` 行の作成は #21（3.3-6 / 3.3-8）が持つ。** ここが持つのは
 * 「どのキーに何が入っているか」を覚えることだけである。したがって索引の記録
 * （{@link recordBuildCache}）は、**成果物が R2 に入ったあとで #21 が呼ぶ**。ビルド
 * 直後にここで書くと、まだ存在しないオブジェクトを指す索引ができる。
 *
 * ## R2 のオブジェクトは作品をまたいで共有される（確定26 / #116）
 *
 * ヒットは「同じソースなら同じ成果物を指す」ことなので、**複数の `games` 行が同一の
 * R2 オブジェクトを指しうる。** これは 3.8 のキャッシュ方針（「実質同一コードの
 * 再ビルドを避ける」）が意図した帰結で、**フォークは同一ソースからの派生を作る経路**
 * である以上（1.3 / 5.3）、稀事象として扱えない。
 *
 * **確定26 は共有を正とし、削除する側に被参照チェックを課した**（3.4-7 / 3.7）。
 * 複製（作品ごとにオブジェクトを持つ）を採らなかったのは、ヒット時にはビルド関数を
 * 呼ばないため、複製できる主体が「R2 の認証情報を持つ側」（3.3-6 はビルド関数だけと
 * 定めている）にいないからである。**費用ではなく経路が決め手**で、複製するには
 * 3.3-6 の分担を変えるか、ヒット時にも関数を呼ぶ（＝ 3.8 が要求するキャッシュを失う）
 * ことになる。
 *
 * **参照カウントの列も持たない。** 答えは `games` を引けば導出でき、複製した数は
 * 静かにずれる。ずれの下振れは「参照されている成果物を消す」ことであり、
 * **確定26 が防ごうとしている事象そのもの**になる（shared-ai-rules 12 章が
 * 「一覧の複製は機械照合で担保する」と言うのと同じ理由で、導出できるものを複製しない）。
 *
 * したがって削除側（M5-4 のゴミ掃除、8.4 の削除依頼）が守る規約は次の 3 つである。
 * 実装は {@link planArtifactDeletion} と {@link deleteUnreferencedArtifacts} が持つ。
 *
 * 1. **R2 のオブジェクトを消す前に、他の作品が参照していないことを `games` と
 *    `game_revisions` で確かめる。** `status` は見ない（`removed` の tombstone も、5.3 が
 *    残すと決めた `source.go` の参照者である）。**版も参照者である**（5.7 / 確定28。
 *    #516 で引くようになった——それまでは `games` だけを数えており、作者が戻すために
 *    持っている版の実体を消しえた）。
 * 2. **索引を先に落とし、そのあとで数え直してから消す。** 逆順にすると、消した直後の
 *    生成がまだ索引に当たり、**消えたオブジェクトを指す新しい作品**が生まれる。
 *    **数え直した結果として消さないことに決めたら、落とした索引を戻す**（成果物は残って
 *    いるので、戻した索引は生きているオブジェクトを指す。戻さないと要らない再ビルドが
 *    1 回増える）。
 * 3. **年齢だけで消すライフサイクルルールに、共有されうるオブジェクトを載せない。**
 *    R2 のライフサイクルは `games` を引けないため、規約 1 を構造的に満たせない
 *    （3.7 の注記）。
 */

/**
 * **D1 と R2 だけを持つ環境**（#586 / M15-3a）。
 *
 * このモジュールと `src/game-deletion.ts` が `env` から読むのは `DB` と `BUCKET` の 2 つだけで、
 * ホスト名も生成モデルも Lambda の関数名も見ない。**`Env` をそのまま要求すると、
 * Pages 以外からは呼べない**——退会の後続の処理は別の Worker（`game-forge-cleanup`）で走り、
 * あちらは自分のバインディングだけを持つ手書きの型（`workers/cleanup/src/hub.ts` の `CleanupEnv`）
 * を使う（`workers/likes/src/hub.ts` の `LikesEnv` と同じ形）。
 *
 * **綴りをここ 1 か所に置く。** 7 か所へ `Pick<Env, 'DB' | 'BUCKET'>` を書き写すと、
 * 読む束縛を増やした日に片方だけが古くなる（shared-ai-rules 12 章）。
 *
 * **型注釈だけの変更なので、オーケストレータの束（このモジュールは束に入る）の `CodeSha256` は
 * 変わらない**——esbuild は型を落とすだけで、出力される JavaScript は 1 バイトも動かない。
 * 確かめ方は `scripts/orchestrator-bundle-changed.sh`。
 */
export type StorageEnv = Pick<Env, 'DB' | 'BUCKET'>;

/** 索引 1 行分。`migrations/0002_build_cache.sql` の列と 1 対 1 に対応する。 */
export interface BuildCacheEntry {
  /** 生成ソース（UTF-8）の SHA-256（小文字 16 進）。3.8 の「コンテンツハッシュ」。 */
  readonly sourceSha256: string;
  /** ビルドに使った Go の版（3.5 の `wasm_exec.js` 出し分け）。 */
  readonly goVersion: string;
  /** `source.go` の R2 キー。命名は #21 が持つ。 */
  readonly sourceKey: string;
  /** `.wasm.br` の R2 キー。命名は #21 が持つ。 */
  readonly wasmKey: string;
  /** 未圧縮 wasm のバイト数（本体は返らない。8〜12 MB あるため）。 */
  readonly wasmBytes: number;
  /** 未圧縮 wasm の SHA-256。 */
  readonly wasmSha256: string;
  /** `.wasm.br` のバイト数。 */
  readonly compressedBytes: number;
  /** `.wasm.br` の SHA-256。 */
  readonly compressedSha256: string;
  /** 3.4-1 が R2 のメタデータへ求める値（`br`）。 */
  readonly contentEncoding: string;
  /** 索引を書いた時刻（UNIX 秒）。 */
  readonly createdAt: number;
}

/** 索引へ記録する内容（`createdAt` は書き込み時に決める）。 */
export type BuildCacheRecord = Omit<BuildCacheEntry, 'createdAt'>;

/**
 * 生成ソースのコンテンツハッシュ（3.8 のキャッシュ鍵）を計算する。
 *
 * **UTF-8 のバイト列に対して SHA-256 を取る。** 文字列のまま扱う経路を作らないのは、
 * 同じ内容が正規化の違いで別の鍵になるのを避けるためで、ここでは入力をそのまま
 * バイト列にする（生成物へ手を入れずに素通しするのは `src/bedrock.ts` と同じ方針）。
 *
 * **Go の版を鍵に混ぜていない。** 3.8 の文言が「生成ソースのコンテンツハッシュ」で
 * あることに従う。結果として **Go を更新してもヒットは続き、その作品は古い版の
 * 成果物と `go_version` を受け取る。** 3.5 は「以後の新規ビルドのみ新バージョンに
 * なる」「過去の行は `go_version` に従って旧 `wasm_exec.js` で配信され続ける」と
 * 定めており、**索引が版を持ち回る限り配信は壊れない**（壊れるのは版と成果物が
 * ずれたときで、ここはずれない）。ただし「更新後の新規生成が旧版の成果物を受け取る」
 * ことは 3.5 の意図と読み方が割れうるため、PR で申し送る。
 *
 * @param source 生成された Go ソース
 * @returns SHA-256 の小文字 16 進表現（64 文字）
 */
export async function sourceCacheKey(source: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return toHex(new Uint8Array(digest));
}

/**
 * バイト列を小文字 16 進へ変換する。
 *
 * @param bytes 変換するバイト列
 * @returns 16 進表現
 */
export function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** 索引を引いた結果。 */
export type BuildCacheLookup =
  | { readonly hit: true; readonly entry: BuildCacheEntry }
  /**
   * ミス。`reason` は「索引が無い」と「索引はあるが成果物が消えていた」を分ける。
   * 後者は 3.7 のライフサイクルが効いた状態で、**異常ではない。**
   */
  | { readonly hit: false; readonly reason: 'not-indexed' | 'artifact-missing' };

/**
 * 索引を引き、成果物が R2 に実在することまで確かめる。
 *
 * 索引だけが残って成果物が消えている場合（3.7 のライフサイクル）は、その行を落として
 * ミスとして返す。**落とすのは、次の生成で同じ 2 回の head を繰り返さないためである。**
 *
 * @param env バインディングと環境変数
 * @param sourceSha256 生成ソースのコンテンツハッシュ
 * @returns ヒットなら索引の行、ミスなら理由
 */
export async function readBuildCache(env: StorageEnv, sourceSha256: string): Promise<BuildCacheLookup> {
  const row = await env.DB.prepare(
    `select source_sha256, go_version, source_key, wasm_key,
            wasm_bytes, wasm_sha256, compressed_bytes, compressed_sha256,
            content_encoding, created_at
       from build_cache where source_sha256 = ?`,
  )
    .bind(sourceSha256)
    .first<BuildCacheRow>();

  if (row === null) {
    return { hit: false, reason: 'not-indexed' };
  }

  const entry = fromRow(row);
  const [wasm, source] = await Promise.all([
    env.BUCKET.head(entry.wasmKey),
    env.BUCKET.head(entry.sourceKey),
  ]);
  if (wasm === null || source === null) {
    // ハッシュは公開できる（ソースそのものではない）。**キーとソースは出さない。**
    console.warn(`[build-cache] 索引が指す成果物がありません: ${sourceSha256.slice(0, 12)}`);
    await forgetBuildCache(env, sourceSha256);
    return { hit: false, reason: 'artifact-missing' };
  }
  return { hit: true, entry };
}

/**
 * 索引へ記録する。**成果物が R2 に入ったあとで呼ぶこと**（#21 / 3.3-6）。
 *
 * 同じ鍵での再記録を許す（`insert or replace`）。R2 のキーが変わる経路
 * （成果物を置き直した、ミスの直後に別の書き込みが走った）で、古い行が残るほうが
 * 害が大きいためである。
 *
 * @param env バインディングと環境変数
 * @param record 記録する内容
 * @param now 記録時刻（UNIX 秒。既定は現在時刻）
 */
export async function recordBuildCache(
  env: StorageEnv,
  record: BuildCacheRecord,
  now: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  await env.DB.prepare(
    `insert or replace into build_cache
       (source_sha256, go_version, source_key, wasm_key,
        wasm_bytes, wasm_sha256, compressed_bytes, compressed_sha256,
        content_encoding, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      record.sourceSha256,
      record.goVersion,
      record.sourceKey,
      record.wasmKey,
      record.wasmBytes,
      record.wasmSha256,
      record.compressedBytes,
      record.compressedSha256,
      record.contentEncoding,
      now,
    )
    .run();
}

/**
 * 索引の行を落とす。
 *
 * @param env バインディングと環境変数
 * @param sourceSha256 生成ソースのコンテンツハッシュ
 */
export async function forgetBuildCache(env: StorageEnv, sourceSha256: string): Promise<void> {
  await env.DB.prepare('delete from build_cache where source_sha256 = ?')
    .bind(sourceSha256)
    .run();
}

/**
 * 索引の行を、R2 のキーの側から**読み出してから落とす**（{@link deleteUnreferencedArtifacts} が使う）。
 *
 * 削除側は `games` 行しか持たず、キャッシュ鍵（生成ソースの SHA-256）を知らない。
 * `games` は鍵を持たないため（5.1）、索引を消すにはキーで引くほかない。
 *
 * **落とす前に中身を返すのは、戻せるようにするためである。** 呼び出し側は「消す」と
 * 決めた対象の索引を先に落とすが（確定26 の規約 2）、数え直しの結果として**消さないことに
 * 決め直す**ことがある。そのとき索引が失われたままだと、成果物は残っているのに以後の
 * 同一ソースの生成が再ビルドになる（Lambda の実測でビルド 1 回は約 21 秒。3.8）。
 * **正しさではなく無駄の問題**だが、戻せる情報を捨てる理由が無い。
 *
 * **索引にキー側の索引を張っていない。** 引くのは削除のときだけで、削除は月数百件
 * （3.6）である。一方 `build_cache` へ索引を足せば**ビルドのたびに書き込みが増える**側に
 * 効く。読み取りは書き込みの 1/1000 の単価であり（3.6）、いまはこの向きが正しい。
 * M5-4 が実測を持ったら見直す。
 *
 * # 文の本数をキーの数に比例させない（#516）
 *
 * **キーの一覧を JSON の配列 1 つとして束縛し、`json_each` で展開する。** 版を持つ作品は
 * 候補のキーが「版の数 × 2」あり（#515 で推敲の上限が無くなる）、キーごとに select と
 * delete を打つと、版が 30 個で 120 本を超えて D1 の 1 呼び出しあたりの枠（50）を越える。
 * **キーを 1 つずつ `?` に束縛する形（`in (?, ?, …)`）も採らない**——1 文あたりの束縛数の
 * 上限（100）に、候補のキーの数が届きうる。JSON の配列なら束縛は常に 2 つである。
 *
 * **読むのと落とすのは 2 文のまま**（先に読んだ行だけを返す。落としてから読むことはできない）。
 * 落とす文を `delete from build_cache` で始めるのは、並行して起きる出来事を文の直後に差し込む
 * 検査（`test/build-cache.test.ts` の `hookedEnv`）がその綴りを見るためである。
 *
 * @param env バインディングと環境変数
 * @param keys 落とす対象の R2 キー（`source_key` か `wasm_key` のいずれかに一致する行を落とす）
 * @returns 実際に落とした索引の行（落とす前の内容。戻すときに使う）
 */
export async function takeBuildCacheByArtifact(
  env: StorageEnv,
  keys: readonly string[],
): Promise<readonly BuildCacheEntry[]> {
  if (keys.length === 0) {
    return [];
  }
  const list = JSON.stringify(keys);
  const matches =
    'wasm_key in (select value from json_each(?)) or source_key in (select value from json_each(?))';
  const found = await env.DB.prepare(
    `select source_sha256, go_version, source_key, wasm_key,
            wasm_bytes, wasm_sha256, compressed_bytes, compressed_sha256,
            content_encoding, created_at
       from build_cache where ${matches}`,
  )
    .bind(list, list)
    .all<BuildCacheRow>();
  await env.DB.prepare(`delete from build_cache where ${matches}`)
    .bind(list, list)
    .run();

  const taken = new Map<string, BuildCacheEntry>();
  for (const row of found.results) {
    // 2 つのキーが同じ行を指すことがある。行は 1 回だけ数える。
    taken.set(row.source_sha256, fromRow(row));
  }
  return [...taken.values()];
}

/**
 * あるキーを参照している**他の作品の**行を数える式（`games` と `game_revisions` の和）。
 *
 * **束縛は 2 つで、順に「除く作品 id」「除く作品 id」**である。キーは外側の問い合わせの
 * 列（`keyExpression`）を読む。**定数だけから組み立てる**（利用者の入力は入らない）。
 *
 * **関数にする。** モジュールの最上位にテンプレートリテラルの定数を置くと、このモジュールが
 * 入るオーケストレータの束に、呼ばれない式が残りうる（`src/games.ts` の
 * `reviewStateAfterAuthorEditSql` と同じ事情）。
 *
 * @param keyExpression キーを表す SQL の式（例: `k.key` / `?`）
 * @returns 件数を返す SQL の式
 */
function referenceCountSql(keyExpression: string): string {
  // **`or` を 1 本の副問い合わせに置く。** SQLite は 2 本の索引（0004 / 0041）を
  // `MULTI-INDEX OR` で使う（`test/build-cache.test.ts` が実行計画を見る）。
  return `((select count(*) from games g
             where g.id <> ? and (g.source_key = ${keyExpression} or g.wasm_key = ${keyExpression}))
         + (select count(*) from game_revisions r
             where r.game_id <> ? and (r.source_key = ${keyExpression} or r.wasm_key = ${keyExpression})))`;
}

/**
 * ある R2 キーを、指定した作品**以外**が参照している件数を数える。
 *
 * **`status` で絞らない。** 5.3 は「親の削除は物理削除せず tombstone 化し、子は残す」と
 * 定めており、`removed` の行もフォーク元の `source.go` を指し続ける。絞ると、
 * tombstone だけが参照している成果物を消せてしまう。
 *
 * **両方の列を見る。** `source_key` と `wasm_key` は別々に落ちうる（5.3 の tombstone は
 * wasm を落として source を残しうる）ため、キー 1 本がどちらの列に現れても参照とみなす。
 *
 * **版（`game_revisions`）も数える**（5.7 / 確定28 / #516）。推敲した作品は、いま `games` が
 * 指していない古い版の成果物も「版に戻す」ために持っている。**数えないと、戻した瞬間に
 * 配信が壊れる**（しかも壊れるのは削除の何日も後である。`migrations/0009_game_revisions.sql`）。
 * 除く作品の版は数えない（その作品ごと消すので、自分の版は参照者ではない）。
 *
 * **返すのは参照している行の数である**（作品の数ではない。同じ作品の版が 3 つ同じキーを指せば
 * 3 と数える）。判定に使うのは 0 かどうかだけである。
 *
 * @param env バインディングと環境変数
 * @param key R2 のキー
 * @param excludeGameId 数えから除く作品 id（削除しようとしている作品自身）
 * @returns 参照している行（他の作品の `games` 行と版）の件数
 */
export async function countArtifactReferences(
  env: StorageEnv,
  key: string,
  excludeGameId: string,
): Promise<number> {
  // キーは束縛 1 つで CTE に置き、式の中では列として読む（式の中に `?` を 4 つ散らさない）。
  const row = await env.DB.prepare(`with k(key) as (select ?) select ${referenceCountSql('k.key')} as n from k`)
    .bind(key, excludeGameId, excludeGameId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** 他の作品に参照されているため残すキー。 */
export interface RetainedArtifact {
  /** R2 のキー。 */
  readonly key: string;
  /** 参照している他の作品の行（`games` 行と版）の件数。 */
  readonly referencedBy: number;
}

/**
 * 1 件の作品について、R2 のオブジェクトを消してよいかをキーごとに判定した結果。
 */
export interface ArtifactDeletionPlan {
  /** 判定の対象にした作品 id。 */
  readonly gameId: string;
  /** 他の作品が参照していないので消してよいキー。 */
  readonly deletable: readonly string[];
  /** 他の作品が参照しているため残すキー。 */
  readonly retained: readonly RetainedArtifact[];
}

/**
 * 候補のキーと、それぞれを参照している他の作品の行数を 1 本で引く SQL（{@link planArtifactDeletion}）。
 *
 * **束縛は 6 つで、すべて同じ作品 id である。** 候補を集める 4 つと、数えから除く 2 つ
 * （{@link referenceCountSql}）。**キーそのものは束縛しない**——候補は SQL の中で `games` の行と
 * 版から集めるので、版がいくつあっても束縛数も文の本数も変わらない（#516）。
 *
 * **並びは「`games` の source → wasm → 版の番号順に source → wasm」**である（同じキーは最初に
 * 現れた位置で 1 回だけ）。`deletable` / `retained` の並びが実行ごとに揺れないようにする。
 *
 * @returns SELECT 文（列は `key` / `referenced_by`）
 */
export function artifactDeletionPlanSql(): string {
  return `with candidates(key, ord) as (
            select source_key, 0 from games where id = ?
            union all select wasm_key, 1 from games where id = ?
            union all select source_key, 2 * seq from game_revisions where game_id = ?
            union all select wasm_key, 2 * seq + 1 from game_revisions where game_id = ?
          ),
          keys(key, ord) as (
            select key, min(ord) from candidates
             where key is not null and key <> ''
             group by key
          )
          select k.key as key, ${referenceCountSql('k.key')} as referenced_by
            from keys k
           order by k.ord`;
}

/**
 * 作品 1 件を削除するときに、R2 のどのオブジェクトを消してよいかを判定する（確定26）。
 *
 * **削除側（M5-4 のゴミ掃除、8.4 の削除依頼、作者の削除と退会。#516）は、この判定を通してから
 * R2 を消すこと。** ビルド結果キャッシュ（3.8）により **1 つのオブジェクトを複数の作品が
 * 指しうる**ため、作品を消したついでに成果物を消すと、**同じ成果物を指す公開済みの作品が壊れる**。
 *
 * # 候補は `games` 行と、その作品の全版から集める（#516）
 *
 * 推敲した作品は、いま `games` が指していない古い版の成果物も持っている。**作品ごと消すなら
 * それも候補である**（残すと、どの行からも指されない成果物が R2 に残り続ける）。参照者の側も
 * 版を数える（{@link countArtifactReferences}）。
 *
 * # 文は 1 本である（版の数に比例させない）
 *
 * 候補の収集と被参照の数えを {@link artifactDeletionPlanSql} の 1 文で行う。**キーごとに
 * 数える形（#116 の実装）のまま候補を版まで広げると、版が 30 個の作品で 62 本になり**、索引の出し入れと数え直しを
 * 足すと D1 の 1 呼び出しあたりの枠（50）を越える。
 *
 * `games` 行も版も無い（既に消えている）場合は、消してよいものも残すものも無い空の計画を
 * 返す。**キーを推測して消しに行かない。**
 *
 * @param env バインディングと環境変数
 * @param gameId 削除しようとしている作品の id
 * @returns 消してよいキーと、残すキー
 */
export async function planArtifactDeletion(
  env: StorageEnv,
  gameId: string,
): Promise<ArtifactDeletionPlan> {
  const { results } = await env.DB.prepare(artifactDeletionPlanSql())
    .bind(gameId, gameId, gameId, gameId, gameId, gameId)
    .all<{ key: string; referenced_by: number }>();

  const deletable: string[] = [];
  const retained: RetainedArtifact[] = [];
  for (const row of results) {
    // 空文字と NULL は SQL の側で落としてある。**それでも型ではなく値を見る**（`isPresentKey`）。
    if (!isPresentKey(row.key)) {
      continue;
    }
    if (row.referenced_by === 0) {
      deletable.push(row.key);
    } else {
      retained.push({ key: row.key, referencedBy: row.referenced_by });
    }
  }
  return { gameId, deletable, retained };
}

/**
 * 作品 1 件が指す R2 のオブジェクトのうち、**他の作品が参照していないものだけ**を消す
 * （確定26 の規約 1・2 の実体）。
 *
 * 順序は次のとおりで、**入れ替えてはいけない。**
 *
 * 1. 被参照を数える（{@link planArtifactDeletion}）。消してよいものが無ければ何もしない。
 * 2. 消す対象のキーを指す索引の行を落とす。**先に落とすのは、これ以降の生成が
 *    消えかけのオブジェクトにヒットして、`games` 行だけが新しく作られるのを止めるため**
 *    である（ヒット判定の R2 実在確認は、判定の時点で存在すれば通ってしまう）。
 * 3. **数え直してから**消す。1 と 2 のあいだに新しい参照が生まれていれば、ここで残す。
 * 4. **残すことに決め直した分の索引を戻す**（下記）。
 *
 * ## 消さないと決めたら索引を戻す（PR #121 のレビュー指摘）
 *
 * 2 と 3 のあいだに並行してキャッシュヒットの生成が走ると、**成果物は残るのに索引だけが
 * 失われる。** 以後の同一ソースの生成は `not-indexed` になり、要らないビルドを 1 回する
 * （Lambda の実測で約 21 秒。ウォーム 21,219 ms / コールド 23,685 ms。3.8）。**正しさでは
 * なく無駄の問題**だが、成果物は現に残っているので、戻した索引は生きているオブジェクトを
 * 指す。**規約 2（先に落とす）は変えない。落とす順序は保ったまま、消さないと決めたときに
 * 限って戻す。**
 *
 * **戻すことで新しい窓を開けないよう、2 つの条件を課す。**
 *
 * - **1 つでも消したキーを指す索引は戻さない。** 索引の行は `source.go` と `.wasm.br` の
 *   両方を指すため、片方でも消えていれば、戻した索引は壊れた組を指す（読み出し側の実在
 *   確認がミスへ落とすだけで、得るものが無い）。
 * - **戻す直前に R2 の実在を確かめる。** 別の掃除が並行して消していれば戻さない。
 *   ここを省くと、**消えたオブジェクトを指す索引を自分で作り直す**ことになり、規約 2 で
 *   塞いだはずの経路が復活する。
 *
 * **`games` 行そのものは触らない。** 行ごと消すか中身だけ消すか（5.3）と、R2 と D1 の
 * 順序は `src/game-deletion.ts` が持つ（#516）。ここが持つのは「R2 のオブジェクトを、
 * 参照が無いときだけ消す」ことだけである。
 *
 * **D1 の文の本数は、戻す索引が無ければ 4 本で固定である**（数える 1・索引を読んで落とす 2・
 * 数え直す 1。#516）。版の数に比例しない。
 *
 * **残る隙間を隠さない。** 3.3 はヒット判定（3.3-5）から `games` 行の作成（3.3-8）まで
 * 数十秒あきうるため、2 の直前にヒットした生成が 3 のあとで行を作る経路は残る。**その
 * 作品は公開前に壊れていることが分かる**（作者が試遊してから公開する。5.4）のに対し、
 * この関数が防ぐのは**公開済みの作品が黙って壊れること**である。掃除の対象を
 * 「作成から 14 日たった未公開分」に限る（確定13）ことで、この窓はさらに狭まる。
 *
 * @param env バインディングと環境変数
 * @param gameId 削除しようとしている作品の id
 * @returns 実際に消したキーと、残したキー（2 回目の数え直しの結果）
 */
export async function deleteUnreferencedArtifacts(
  env: StorageEnv,
  gameId: string,
): Promise<ArtifactDeletionPlan> {
  const planned = await planArtifactDeletion(env, gameId);
  if (planned.deletable.length === 0) {
    return planned;
  }

  const suspended = await takeBuildCacheByArtifact(env, planned.deletable);

  const confirmed = await planArtifactDeletion(env, gameId);
  // **1 回の呼び出しで消す**（R2 の `delete` はキーの配列を受ける。版の多い作品でも往復が増えない）。
  if (confirmed.deletable.length > 0) {
    await env.BUCKET.delete([...confirmed.deletable]);
  }

  const deleted = new Set(confirmed.deletable);
  for (const entry of suspended) {
    if (deleted.has(entry.wasmKey) || deleted.has(entry.sourceKey)) {
      continue;
    }
    const [wasm, source] = await Promise.all([
      env.BUCKET.head(entry.wasmKey),
      env.BUCKET.head(entry.sourceKey),
    ]);
    if (wasm === null || source === null) {
      continue;
    }
    // `createdAt` は元の値のまま戻す。3.7 の掃除が索引の年齢を見る形になったとき、
    // 戻した行だけが若返っていると、掃除の対象から静かに外れる。
    await recordBuildCache(env, entry, entry.createdAt);
  }
  return confirmed;
}

/**
 * R2 のキーとして扱える値か（NULL と空文字を落とす）。
 *
 * tombstone 化（5.3）で `games.source_key` / `games.wasm_key` は NULL になりうる。
 * 空文字を弾くのは、`where source_key = ''` が別の tombstone 行に当たって
 * 「参照されている」と誤判定するのを避けるためである。
 *
 * @param key 判定する値
 * @returns キーとして扱えるなら true
 */
function isPresentKey(key: string | null | undefined): key is string {
  return typeof key === 'string' && key.length > 0;
}

/** D1 から読んだ生の行。列名は SQL の綴りそのもの。 */
interface BuildCacheRow {
  source_sha256: string;
  go_version: string;
  source_key: string;
  wasm_key: string;
  wasm_bytes: number;
  wasm_sha256: string;
  compressed_bytes: number;
  compressed_sha256: string;
  content_encoding: string;
  created_at: number;
}

/**
 * D1 の行をアプリ側の型へ写す。
 *
 * @param row D1 から読んだ行
 * @returns 索引 1 行分
 */
function fromRow(row: BuildCacheRow): BuildCacheEntry {
  return {
    sourceSha256: row.source_sha256,
    goVersion: row.go_version,
    sourceKey: row.source_key,
    wasmKey: row.wasm_key,
    wasmBytes: row.wasm_bytes,
    wasmSha256: row.wasm_sha256,
    compressedBytes: row.compressed_bytes,
    compressedSha256: row.compressed_sha256,
    contentEncoding: row.content_encoding,
    createdAt: row.created_at,
  };
}
