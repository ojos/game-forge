/**
 * MCP の認可（#696 / M19-1 / 仕様 5.15）の綴りと寿命。**値だけの葉である。**
 *
 * 経路表（`src/app.ts`）・入口の振り分け（`src/index.ts`）・同意画面（`src/oauth-authorize.ts`）・
 * 登録情報のタブ（`src/account-apps.ts`）・ハンドル名の予約語の導出が同じ綴りを読む。
 * **オーケストレータの束に入れない**——どれも画面と口だけが読む値で、Lambda は読まない
 * （`src/account-paths.ts` の冒頭と同じ理由で、`src/paths.ts` には置かない）。
 */

/**
 * 認可のエンドポイント（**アプリが書く**。同意画面）。GET で同意画面を出し、POST で同意を受ける。
 *
 * **部品（`@cloudflare/workers-oauth-provider`）はこの口を処理しない**——メタデータに載せるだけで、
 * 中身はアプリの経路表に置く（`src/oauth-authorize.ts`）。
 */
export const AUTHORIZE_PATH = '/authorize';

/**
 * ログインから戻った後に、認可の要求を受け直す固定の戻り先（#696）。
 *
 * **ログインの戻り先は「定数だけ」「512 文字まで」という規則**（`src/auth/google.ts` の `safeReturnPath`）を
 * 崩さないために、認可の要求そのもの（長い query）は戻り先にせず、署名した一時 cookie に積む。
 * ログインの戻り先はこの定数だけで、ここが cookie を読んで `/authorize?…` へ送り直す。
 */
export const AUTHORIZE_RESUME_PATH = '/authorize/resume';

/** トークンのエンドポイント（部品が持つ。発行・refresh・失効）。 */
export const TOKEN_PATH = '/token';

/** クライアントの動的登録（DCR。RFC 7591。部品が持つ）。 */
export const REGISTER_PATH = '/register';

/**
 * MCP サーバーの口（部品がトークンを検証してから、アプリの処理へ渡す）。
 *
 * **#696 PR① の時点では道具が無い**——トークンの検証を通った要求に 404 を返すだけである
 * （`src/oauth-provider.ts` の仮の処理。PR② で MCP サーバーに差し替える）。
 */
export const MCP_PATH = '/mcp';

/** 認可サーバーのメタデータ（RFC 8414。部品が持つ）。 */
export const AUTHORIZATION_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server';

/**
 * 保護されたリソースのメタデータ（RFC 9728。部品が持つ）。**`/mcp` 付きの形**
 * （`/.well-known/oauth-protected-resource/mcp`）も同じ部品が返す。
 */
export const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

/**
 * 部品（`OAuthProvider`）へ渡す口の一覧。**アプリの経路表には載らない。**
 *
 * `src/index.ts` がこの一覧でアプリのホストの要求を振り分け、ハンドル名の予約語（`src/app.ts` の
 * `appReservedHandles`）もここから導く——経路表に無い口の名前を、利用者がハンドル名として名乗れないようにする。
 */
export const OAUTH_PROVIDER_PATHS: readonly string[] = [
  TOKEN_PATH,
  REGISTER_PATH,
  MCP_PATH,
  AUTHORIZATION_SERVER_METADATA_PATH,
  PROTECTED_RESOURCE_METADATA_PATH,
];

/** 読む道具の scope（自作の一覧・詳細・ソースと、自分の情報）。 */
export const SCOPE_WORKS_READ = 'works:read';

/** 書く道具の scope（生成と推敲。1 回あたり約 21 円かかり、日次の枠を使う）。 */
export const SCOPE_WORKS_GENERATE = 'works:generate';

/**
 * 許可できる scope（並び順どおりに同意画面へ出す）。**利用者の決定で 2 つに分けた**（仕様 5.15）。
 */
export const OAUTH_SCOPES: readonly string[] = [SCOPE_WORKS_READ, SCOPE_WORKS_GENERATE];

/** scope を利用者に見せるときの名前と説明（同意画面と「接続中のアプリ」のタブが使う）。 */
export const OAUTH_SCOPE_LABELS: Readonly<Record<string, { readonly name: string; readonly note: string }>> = {
  [SCOPE_WORKS_READ]: {
    name: '自分の作品を読む',
    note: 'あなたの作品の一覧・状況・版・最初の指示文・ソースと、あなたの情報と残りの生成枠を読みます。',
  },
  [SCOPE_WORKS_GENERATE]: {
    name: '作品を生成・推敲する',
    note: 'あなたの代わりに作品の生成と推敲を始めます。1 日の生成枠を使います。',
  },
};

/** アクセストークンの寿命（秒）。**1 時間**（利用者の決定。KV の書き込みの見込みとの釣り合い。仕様 5.15）。 */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * リフレッシュトークンの寿命（秒）。**30 日**（利用者の決定）。
 *
 * **同意（最初の code の交換）から数えた 30 日で、使っていても延びない**——部品（0.10.3）は許可の期限を code の交換の
 * ときに決め、refresh では動かさない（refresh で寿命を変える指定は部品が断る）。期限が近づくと、発行するアクセストークンの
 * 寿命も残りに合わせて縮む。期限が来たら同意からやり直す。許可の記録（KV）も同じ期限で消える。
 */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * 未ログインで接続を始めたときに、認可の要求をログインの往復のあいだ積む一時 cookie の名前（`src/oauth-authorize.ts`）。
 *
 * **`__Host-` 接頭辞にする**（7.2 必須要件 2）。sandbox のホストから上書きできると、別の要求を積み替えられる。
 * ログインの一時 cookie（`__Host-gf_oauth`）とは別の cookie にする——あちらはログインが作り直す。
 */
export const PENDING_AUTHORIZATION_COOKIE = '__Host-gf_mcp_authz';

/** その一時 cookie の寿命（秒）。**10 分**（ログインの一時 cookie と同じ。Google の同意画面で迷う時間）。 */
export const PENDING_AUTHORIZATION_MAX_AGE_SECONDS = 600;
