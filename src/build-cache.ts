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
 * ## R2 のオブジェクトは作品をまたいで共有される
 *
 * ヒットは「同じソースなら同じ成果物を指す」ことなので、**複数の `games` 行が同一の
 * R2 オブジェクトを指しうる。** これは 3.8 のキャッシュ方針（「実質同一コードの
 * 再ビルドを避ける」）が意図した帰結だが、3.7 のライフサイクルとゴミ掃除（M5-4）は
 * 「作品 1 件 = オブジェクト 1 組」を前提に書かれている。**共有された成果物を、
 * 参照している作品がまだあるうちに消しうる。** 上の実在確認はその状態を「ミス」に
 * 落として作品の生成は守るが、**既に公開済みの作品が壊れることは防げない。**
 * ここは M5-4 と 3.7 の側で解く問題として PR に申し送る（本 issue で 3.7 を書き換えない）。
 */

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
export async function readBuildCache(env: Env, sourceSha256: string): Promise<BuildCacheLookup> {
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
  env: Env,
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
export async function forgetBuildCache(env: Env, sourceSha256: string): Promise<void> {
  await env.DB.prepare('delete from build_cache where source_sha256 = ?')
    .bind(sourceSha256)
    .run();
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
