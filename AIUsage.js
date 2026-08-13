// Variables used by Scriptable.
// These must be at the very top of the file. Comments below the line are OK.
// icon-color: deep-purple; icon-glyph: chart-bar;
//
// AIUsage — Claude / Codex の使用枠ウィジェット
//
// Mac 側の ai_usage_fetch.py が iCloud Drive/Scriptable/ai-usage.json を書く。
// ウィジェットは Dropbox 共有リンク（HTTPS）→ iCloud → 端末内の控え の順に取る。
//
// サービスごとにグループ化し、見出し・区切り・サービス色で Claude / Codex を見分ける。
// サイズごとに入る情報量が違うので、レイアウト自体を変える:
//   small  … 1 列。Claude 2 枠 + Codex。縦 158pt に収めるため副次的な枠は省く
//   medium … 2 列（Claude | Codex）。縦が足りないので横幅を使う
//   large  … 1 列。全枠 + リセット時刻 + 追加クレジット

// ai_usage_fetch.py の __version__ と揃えること
const VERSION = "0.10.0";

const FILE_NAME = "ai-usage.json";
const CACHE_FILE_NAME = "ai-usage-cache.json"; // 端末内の控え（iCloud が読めないとき用）
// Scriptable アプリ内で実行したときにプレビューを出すか。
// ショートカットの「Run In App」を ON にすると、その実行もアプリ内扱いになり
// プレビューが開く。自動実行で画面を出したくないなら false にする。
const PREVIEW_IN_APP = true;
// Dropbox 共有リンクの保存先。スクリプトに直書きすると配布物に混ざるため Keychain に置く。
// 変更したいときは Scriptable で Keychain.remove("ai-usage-url") してから本スクリプトを
// アプリ内で 1 回実行すると、また入力を求められる。
const URL_KEYCHAIN_KEY = "ai-usage-url";
const REMOTE_TIMEOUT_SECONDS = 3; // ウィジェットの実行時間は短い。粘らない
// iOS はファイルを退避するので、ウィジェット実行のたびにダウンロードが要る。
// 待たずに諦めると毎回控えになる。合計で 3 秒ほど粘る。
const ICLOUD_READ_ATTEMPTS = 4;
const ICLOUD_READ_WAIT_MS = 900;
const STALE_AFTER_MINUTES = 150; // これより古ければ警告色にする。
// Mac 側は「中身が変わったとき」＋「無変化でも 2 時間ごと」に書く。
// 2 時間より短い閾値にすると、使っていない時間帯に誤警告が出る。

// small で省く枠。Claude の weekly_scoped はモデル別の内訳で、週次全体の部分集合。
const SMALL_SKIP_KEYS = ["weekly_scoped"];

// --- 表示言語 -------------------------------------------------------------------
// 端末の言語に合わせる。日本語以外はすべて英語にする。
// 枠のラベルは Mac 側の JSON に日本語で入っているが、それは使わず
// key / window_minutes / scope_model から組み立て直す。

function detectLanguage() {
  try {
    const code = String(Device.language() || "").toLowerCase();
    return code.indexOf("ja") === 0 ? "ja" : "en";
  } catch (e) {
    return "en";
  }
}

const LANG = detectLanguage();

const STRINGS = {
  ja: {
    title: "AI Usage",
    unknown: "不明",
    justNow: "たった今",
    minAgo: (n) => `${n}分前`,
    hourAgo: (n) => `${n}時間前`,
    dayAgo: (n) => `${n}日前`,
    soon: "まもなく",
    minIn: (n) => `${n}分後`,
    hourIn: (n) => `${n}時間後`,
    dayIn: (n) => `${n}日後`,
    resets: (t) => `リセット ${t}`,
    valueFrom: (t) => `${t}の値`,
    noData: "データがありません",
    loadFailed: "データを読み込めませんでした",
    fetchFailed: (name) => `${name} を取得できません`,
    renderFailed: (m) => `描画に失敗: ${m}`,
    sourceLink: "リンク",
    sourceICloud: "iCloud",
    staleSource: (src) => `${src}が古い`,
    noSource: "どこからも取れない",
    syncing: "iCloud 同期待ち",
    cacheAge: (t) => `控え ${t}`,
    cacheShown: "控えを表示中",
    extraCredits: (p) => `追加クレジット ${p}%`,
    creditsUnlimited: "クレジット 無制限",
    creditsBalance: (b) => `残高 ${b}`,
    creditsSome: "クレジットあり",
    creditsMessages: (n) => `残り約 ${n} メッセージ`,
    overageReached: "・上限到達",
    codexOld: (h) => `Codex の値は ${h} 時間前の記録`,
    hours: (n) => `${n}時間`,
    days: (n) => `${n}日`,
    weekly: "週次",
    weeks: (n) => `${n}週`,
    minutes: (n) => `${n}分`,
    window: "使用枠",
    setupTitle: "共有リンクの登録",
    setupTitleEdit: "共有リンクの変更",
    setupBodyFailed:
      "登録されている共有リンクから取得できませんでした。\n" +
      "リンクが「リンクを知っている全員」になっているか、\n" +
      "JSON の実体が返る URL かを確認してください。\n" +
      "空にして保存すると登録を消し、iCloud 経由に戻します。",
    keep: "変更しない",
    setupBody:
      "ai-usage.json の共有リンクを貼り付けてください。\n" +
      "Dropbox / Google ドライブ / OneDrive などに対応しています。\n" +
      "空にして保存すると登録を消し、iCloud 経由に戻します。",
    save: "保存",
    later: "あとで",
    probeOk: "取得できました",
    probeNg: "取得できませんでした",
    probeOkBody: (t) => `${t} を読み込めました。`,
    probeNgBody:
      "リンクが「リンクを知っている全員」になっているか、\n" +
      "JSON の実体が返る URL かを確認してください。\n" +
      "このままでも iCloud と端末内の控えは使われます。",
    ok: "OK",
  },
  en: {
    title: "AI Usage",
    unknown: "unknown",
    justNow: "just now",
    minAgo: (n) => `${n}m ago`,
    hourAgo: (n) => `${n}h ago`,
    dayAgo: (n) => `${n}d ago`,
    soon: "any moment",
    minIn: (n) => `in ${n}m`,
    hourIn: (n) => `in ${n}h`,
    dayIn: (n) => `in ${n}d`,
    resets: (t) => `Resets ${t}`,
    valueFrom: (t) => `as of ${t}`,
    noData: "No data",
    loadFailed: "Could not load data",
    fetchFailed: (name) => `Cannot fetch ${name}`,
    renderFailed: (m) => `Render failed: ${m}`,
    sourceLink: "Link",
    sourceICloud: "iCloud",
    staleSource: (src) => `${src} is stale`,
    noSource: "No source reachable",
    syncing: "Waiting for iCloud",
    cacheAge: (t) => `cached ${t}`,
    cacheShown: "showing cache",
    extraCredits: (p) => `Extra credits ${p}%`,
    creditsUnlimited: "Credits: unlimited",
    creditsBalance: (b) => `Balance ${b}`,
    creditsSome: "Credits available",
    creditsMessages: (n) => `~${n} messages left`,
    overageReached: " · limit reached",
    codexOld: (h) => `Codex data is ${h}h old`,
    hours: (n) => (n === 1 ? "1 hour" : `${n} hours`),
    days: (n) => (n === 1 ? "1 day" : `${n} days`),
    weekly: "Weekly",
    weeks: (n) => `${n} weeks`,
    minutes: (n) => `${n} min`,
    window: "Limit",
    setupTitle: "Register share link",
    setupTitleEdit: "Change share link",
    setupBodyFailed:
      "Could not fetch from the registered share link.\n" +
      "Check that it is shared with \"anyone with the link\"\n" +
      "and that the URL returns the raw JSON.\n" +
      "Save an empty field to clear it and fall back to iCloud.",
    keep: "Keep current",
    setupBody:
      "Paste the share link to ai-usage.json.\n" +
      "Dropbox, Google Drive and OneDrive links are supported.\n" +
      "Save an empty field to clear it and fall back to iCloud.",
    save: "Save",
    later: "Later",
    probeOk: "Fetched successfully",
    probeNg: "Could not fetch",
    probeOkBody: (t) => `Loaded ${t}.`,
    probeNgBody:
      "Check that the link is shared with \"anyone with the link\"\n" +
      "and that the URL returns the raw JSON.\n" +
      "iCloud and the on-device cache still work meanwhile.",
    ok: "OK",
  },
};

const T = STRINGS[LANG];

// 枠のラベルを端末の言語で組み立てる。Mac 側の label は最後の保険。
function windowLabel(w) {
  if (!w) return T.window;
  const minutes = typeof w.window_minutes === "number" ? w.window_minutes : null;
  let base = null;
  if (minutes !== null && minutes > 0) {
    if (minutes % 10080 === 0) {
      base = minutes === 10080 ? T.weekly : T.weeks(Math.round(minutes / 10080));
    } else if (minutes % 1440 === 0) {
      base = T.days(Math.round(minutes / 1440));
    } else if (minutes % 60 === 0) {
      base = T.hours(Math.round(minutes / 60));
    } else {
      base = T.minutes(Math.round(minutes));
    }
  }
  if (!base) base = w.label || T.window;
  return w.scope_model ? `${base} (${w.scope_model})` : base;
}

// --- 配色 ---------------------------------------------------------------------

const COLOR = {
  bg: Color.dynamic(new Color("#f5f4f2"), new Color("#16151a")),
  text: Color.dynamic(new Color("#1c1b1f"), new Color("#eceaf0")),
  dim: Color.dynamic(new Color("#6d6a75"), new Color("#918d9c")),
  track: Color.dynamic(new Color("#dedbe4"), new Color("#2e2c36")),
  divider: Color.dynamic(new Color("#d3cfda"), new Color("#34313d")),
  warn: new Color("#d9a441"),
  danger: new Color("#d1584f"),
  claude: new Color("#c96442"),
  codex: new Color("#5b8def"),
};

// 通常時はサービス色。危険域に入ったら色で気づけるよう警告色が優先する。
function barColor(percent, accent) {
  if (percent >= 80) return COLOR.danger;
  if (percent >= 50) return COLOR.warn;
  return accent;
}

// --- サイズごとの寸法 -------------------------------------------------------------
// small / medium は縦 158pt しかないので、リセット時刻の行は large でのみ出す。

const SIZE = {
  small: { title: 10, age: 8, section: 9, label: 10, bar: 4, reset: 0, gapRow: 3, gapGroup: 5 },
  medium: { title: 12, age: 9, section: 10, label: 11, bar: 6, reset: 0, gapRow: 6, gapGroup: 8 },
  large: { title: 13, age: 10, section: 11, label: 12, bar: 7, reset: 9, gapRow: 9, gapGroup: 12 },
};

// バーは幅を明示しないと比率で塗れない。画面幅から実際のウィジェット幅を見積もる。
// iOS のウィジェット幅は画面幅のおおよそ 40%（small）/ 85%（medium・large は同幅）。
// 溢れるとレイアウトが崩れるので、余白を引いたうえで上下限で挟む。
function contentWidthFor(family) {
  const padding = 13 * 2 + 4; // setPadding の左右 + 安全余白
  let screen = 393; // 取得できないときの既定値
  try {
    screen = Device.screenSize().width || screen;
  } catch (e) {
    // Device が使えない環境では既定値のまま
  }
  const ratio = family === "small" ? 0.4 : 0.85;
  const width = Math.round(screen * ratio) - padding;
  return Math.max(90, Math.min(340, width));
}

// --- データ読み込み -------------------------------------------------------------

// iCloud から読む。読めなければ null（例外は投げない）。
//
// 注意: JSON.parse(null) は例外を投げず null を返す。readString() が null を
// 返したときにそのまま通すと、呼び出し側が null を触って落ちる。
async function readFromICloud() {
  try {
    const fm = FileManager.iCloud();
    const path = fm.joinPath(fm.documentsDirectory(), FILE_NAME);
    if (!fm.fileExists(path)) return null;
    // iCloud 上で退避されていることがある。完了を待たずに読むと失敗する
    // ウィジェット拡張ではダウンロードを起こせないと実測済みなので、粘っても無駄。
    // 1 回で諦めて控えに落ちる。ショートカット / アプリ内では待つ価値がある。
    const inWidget = config.runsInWidget || config.runsInAccessoryWidget;
    const attempts = inWidget ? 1 : ICLOUD_READ_ATTEMPTS;

    let text = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await fm.downloadFileFromiCloud(path);
      } catch (e) {
        // ダウンロード要求が弾かれても、読める場合があるので続行する
      }
      try {
        text = fm.readString(path);
      } catch (e) {
        text = null; // 読めなくても次の試行に進む
      }
      if (text) break;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => Timer.schedule(ICLOUD_READ_WAIT_MS, false, resolve));
      }
    }
    if (!text) return null;
    const data = JSON.parse(text);
    return data && typeof data === "object" ? data : null;
  } catch (e) {
    return null;
  }
}

function generatedTime(payload) {
  const t = payload && payload.generated_at ? Date.parse(payload.generated_at) : NaN;
  return isNaN(t) ? 0 : t;
}

// 端末内（iCloud ではない）に置く控え。iCloud が一時的に読めなくても描けるように。
function cachePath(fm) {
  return fm.joinPath(fm.documentsDirectory(), CACHE_FILE_NAME);
}

function readCache() {
  try {
    const fm = FileManager.local();
    const path = cachePath(fm);
    if (!fm.fileExists(path)) return null;
    const text = fm.readString(path);
    if (!text) return null;
    const data = JSON.parse(text);
    return data && typeof data === "object" ? data : null;
  } catch (e) {
    return null;
  }
}

function writeCache(payload) {
  try {
    const fm = FileManager.local();
    // いつ控えを取れたかを残す。ショートカットでの更新が効いているかの判断に使う。
    const copy = Object.assign({}, payload, { cached_at: new Date().toISOString() });
    fm.writeString(cachePath(fm), JSON.stringify(copy));
  } catch (e) {
    // 控えが書けなくても描画は続ける
  }
}

// --- リモート取得（Dropbox 共有リンク）-------------------------------------------
//
// ウィジェット拡張は iCloud のダウンロードを起こせないが、ネットワークは使える。
// URL はスクリプトに直書きせず Keychain に置く（このファイルは配布物に入るため）。

function remoteUrl() {
  try {
    if (!Keychain.contains(URL_KEYCHAIN_KEY)) return null;
    const value = (Keychain.get(URL_KEYCHAIN_KEY) || "").trim();
    return value || null;
  } catch (e) {
    return null;
  }
}

// 共有リンクは、どのサービスでも既定では HTML のプレビュー画面を返す。
// 実体（JSON）を返す URL に直す。サービスごとに規則が違うのでここで吸収する。
//
// ここに無いサービスや自前の HTTP サーバーの URL は、そのまま使う。
// JSON 以外が返れば loadJSON() が失敗し、iCloud → 控え に落ちるだけなので安全。
function directUrl(url) {
  let out = String(url).trim();
  const add = (u, q) => u + (u.indexOf("?") === -1 ? "?" : "&") + q;

  const drive = out.match(/drive\.google\.com\/file\/d\/([^/?#]+)/);
  const driveOpen = out.match(/drive\.google\.com\/open\?[^#]*\bid=([^&#]+)/);
  const driveId = drive ? drive[1] : driveOpen ? driveOpen[1] : null;

  if (driveId) {
    // Google ドライブ: 「リンクを知っている全員」で共有したうえで直リンクにする
    out = "https://drive.usercontent.google.com/download?id=" + driveId + "&export=download";
  } else if (/dropbox\.com/.test(out)) {
    out = out.replace(/([?&])dl=0(&|$)/, "$1dl=1$2");
    if (!/[?&]dl=1(&|$)/.test(out)) out = add(out, "dl=1");
  } else if (/1drv\.ms|onedrive\.live\.com|sharepoint\.com/.test(out)) {
    if (!/[?&]download=1(&|$)/.test(out)) out = add(out, "download=1");
  }

  // 毎回違うクエリを足し、CDN の古い版を掴まないようにする
  return add(out, "_=" + Date.now());
}

async function readFromRemote() {
  const url = remoteUrl();
  if (!url) return null;
  try {
    const req = new Request(directUrl(url));
    req.timeoutInterval = REMOTE_TIMEOUT_SECONDS; // ウィジェットの実行時間を食い潰さない
    req.headers = { "Cache-Control": "no-cache" };
    const data = await req.loadJSON();
    return data && typeof data === "object" ? data : null;
  } catch (e) {
    return null; // 圏外・タイムアウト・壊れた応答。リトライはしない
  }
}

// 取れた候補の中から generated_at がいちばん新しいものを採る。
// 「最初に読めたものを無条件に採用」しないのが要点。iCloud は古いコピーを
// 返してくることがあり、それで控えを巻き戻すと状況が悪化する。
async function loadPayload() {
  const cached = readCache();

  // ネットワーク → iCloud の順。ネットワークで取れたら iCloud は試さない
  // （ウィジェットの実行時間は短い。iCloud はどのみち拡張では読めない）。
  let best = null;
  let bestFrom = null;

  const remote = await readFromRemote();
  if (remote) {
    best = remote;
    bestFrom = T.sourceLink;
  } else {
    const icloud = await readFromICloud();
    if (icloud) {
      best = icloud;
      bestFrom = T.sourceICloud;
    }
  }

  if (best) {
    const bestAt = generatedTime(best);
    const cachedAt = generatedTime(cached);
    // 控えより新しければ採用して控えも更新する
    if (!cached || bestAt > cachedAt) {
      writeCache(best);
      return best;
    }
    // 同じ世代なら正常。控えは書き直さない（cached_at を「たった今」にしない）。
    // ここを「新しくない＝古い」と扱うと、更新が無い間ずっと警告が出てしまう。
    if (bestAt === cachedAt) return best;
    // ここに来るのは、取れたものが控えより本当に古いときだけ
  }

  if (cached) {
    // どの経路で何が起きて控えになったのか分かるようにする（切り分け用）
    cached.from_cache = best ? T.staleSource(bestFrom) : T.noSource;
    return cached;
  }
  return { error: T.fetchFailed(FILE_NAME) };
}

// --- 表示用の整形 ---------------------------------------------------------------

function minutesSince(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 60000);
}

function agoText(iso) {
  const mins = minutesSince(iso);
  if (mins === null) return T.unknown;
  if (mins < 1) return T.justNow;
  if (mins < 60) return T.minAgo(mins);
  const hours = Math.round(mins / 60);
  if (hours < 24) return T.hourAgo(hours);
  return T.dayAgo(Math.round(hours / 24));
}

function untilText(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (isNaN(t)) return "";
  const mins = Math.round((t - Date.now()) / 60000);
  if (mins <= 0) return T.soon;
  if (mins < 60) return T.minIn(mins);
  const hours = Math.round(mins / 60);
  if (hours < 24) return T.hourIn(hours);
  return T.dayIn(Math.round(hours / 24));
}

// その数値がいつのものか。JSONL に落ちた回は fetched_at が「読んだ時刻」で
// 現在に近いため、数値そのものの古さを持つ observed_at を優先する。
function valueTimestamp(data) {
  return (data && (data.observed_at || data.fetched_at)) || null;
}

// 引き継ぎ中の枠のうち、いちばん古い時刻。無ければ null。
function stalestFetchedAt(payload) {
  let oldest = null;
  for (const data of [payload.claude, payload.codex]) {
    if (!data || data.stale !== true) continue;
    const at = valueTimestamp(data);
    if (!at) continue;
    const t = Date.parse(at);
    if (isNaN(t)) continue;
    if (oldest === null || t < Date.parse(oldest)) oldest = at;
  }
  return oldest;
}

// サービス単位のグループを作る。行ラベルは枠の名前だけにして、
// どのサービスかは見出しと色で示す（横幅の節約にもなる）。
function buildGroups(payload, family) {
  const groups = [];
  const sources = [
    { name: "Claude", accent: COLOR.claude, data: payload.claude },
    { name: "Codex", accent: COLOR.codex, data: payload.codex },
  ];

  for (const src of sources) {
    const data = src.data;
    if (!data) continue;
    const rows = (data.windows || [])
      .filter((w) => family !== "small" || SMALL_SKIP_KEYS.indexOf(w.key) === -1)
      // ラベルは Mac 側の日本語を使わず、端末の言語で組み立て直す
      .map((w) => ({ label: windowLabel(w), percent: w.percent, resetsAt: w.resets_at }));
    if (rows.length === 0 && (!data.status || data.status === "ok")) continue;
    groups.push({
      name: src.name,
      accent: src.accent,
      rows: rows,
      stale: data.stale === true,
      fetchedAt: valueTimestamp(data),
    });
  }
  return groups;
}

function statusNote(payload) {
  const notes = [];
  if (payload.from_cache) {
    const reason =
      typeof payload.from_cache === "string" ? payload.from_cache : T.syncing;
    // 控えをいつ取れたかも出す。ショートカットでの更新が効いているかが分かる。
    const when = payload.cached_at ? T.cacheAge(agoText(payload.cached_at)) : T.cacheShown;
    notes.push(`${reason}・${when}`);
  }
  for (const [name, data] of [
    ["Claude", payload.claude],
    ["Codex", payload.codex],
  ]) {
    if (!data) continue;
    if (data.status && data.status !== "ok") {
      notes.push(`${name}: ${data.status}`);
    }
  }
  return notes.join(" / ");
}

function moneyText(value, decimalPlaces, currency) {
  if (typeof value !== "number") return null;
  const dp = typeof decimalPlaces === "number" ? decimalPlaces : 2;
  const amount = (value / Math.pow(10, dp)).toFixed(dp);
  return currency === "USD" ? `$${amount}` : `${amount} ${currency || ""}`.trim();
}

// --- 描画 -----------------------------------------------------------------------

function addBar(stack, percent, accent, width, height) {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  const track = stack.addStack();
  track.layoutHorizontally();
  track.size = new Size(width, height);
  track.cornerRadius = height / 2;
  track.backgroundColor = COLOR.track;

  if (pct > 0) {
    const fill = track.addStack();
    fill.size = new Size(Math.max(height, (width * pct) / 100), height);
    fill.cornerRadius = height / 2;
    fill.backgroundColor = barColor(pct, accent);
  }
  // 余りを吸わせないと中身が中央寄せになる（バーが真ん中から伸びて見える）
  track.addSpacer();
}

function addSectionHeader(stack, group, size, showStale) {
  const head = stack.addStack();
  head.centerAlignContent();
  head.spacing = 5;

  const dot = head.addStack();
  dot.size = new Size(7, 7);
  dot.cornerRadius = 3.5;
  dot.backgroundColor = group.accent;

  const name = head.addText(group.name);
  name.font = Font.boldSystemFont(size.section);
  name.textColor = group.accent;

  head.addSpacer();

  // 更新できていない枠は、その数値がいつのものかをサービス単位で出す
  if (showStale && group.stale) {
    const note = head.addText(T.valueFrom(agoText(group.fetchedAt)));
    note.font = Font.systemFont(size.section - 1);
    note.textColor = COLOR.danger;
    note.lineLimit = 1;
  }
}

function addRow(stack, row, group, size, barWidth) {
  const container = stack.addStack();
  container.layoutVertically();
  container.spacing = 3;

  const head = container.addStack();
  head.centerAlignContent();

  const label = head.addText(row.label);
  label.font = Font.mediumSystemFont(size.label);
  label.textColor = COLOR.text;
  label.lineLimit = 1;
  label.minimumScaleFactor = 0.8;

  head.addSpacer();

  const pct = head.addText(`${Math.round(row.percent)}%`);
  pct.font = Font.boldSystemFont(size.label);
  pct.textColor = group.stale ? COLOR.dim : COLOR.text;

  addBar(container, row.percent, group.accent, barWidth, size.bar);

  if (size.reset > 0 && row.resetsAt) {
    const reset = container.addText(T.resets(untilText(row.resetsAt)));
    reset.font = Font.systemFont(size.reset);
    reset.textColor = COLOR.dim;
  }
}

function addGroup(stack, group, size, barWidth, showStale) {
  addSectionHeader(stack, group, size, showStale);
  group.rows.forEach((row) => {
    stack.addSpacer(size.gapRow);
    addRow(stack, row, group, size, barWidth);
  });
}

// small / large: 縦に積み、グループ間に区切り線を入れる
function addGroupsStacked(widget, groups, size, width) {
  groups.forEach((group, i) => {
    if (i > 0) {
      widget.addSpacer(size.gapGroup);
      const line = widget.addStack();
      line.size = new Size(width, 1);
      line.backgroundColor = COLOR.divider;
    }
    widget.addSpacer(size.gapGroup);
    addGroup(widget, group, size, width, true);
  });
}

// medium: 縦 158pt に 4 枠は入らないので、横幅を使って 2 列に並べる
function addGroupsColumns(widget, groups, size, width) {
  widget.addSpacer(size.gapGroup);
  const body = widget.addStack();
  body.layoutHorizontally();
  body.topAlignContent();
  body.spacing = 14;

  const columnWidth = Math.floor((width - 14 * (groups.length - 1)) / groups.length);
  groups.forEach((group) => {
    const column = body.addStack();
    column.layoutVertically();
    column.size = new Size(columnWidth, 0);
    // 列幅が狭いので「N前の値」は入れず、下部の status 表示に任せる
    addGroup(column, group, size, columnWidth, false);
  });
}

// 下部のクレジット行。どのサービスのものか、色付きの丸とサービス名で示す。
function addCreditLine(widget, service, accent, text) {
  widget.addSpacer(4);
  const line = widget.addStack();
  line.centerAlignContent();
  line.spacing = 5;

  const dot = line.addStack();
  dot.size = new Size(5, 5);
  dot.cornerRadius = 2.5;
  dot.backgroundColor = accent;

  const name = line.addText(service);
  name.font = Font.mediumSystemFont(10);
  name.textColor = accent;

  const body = line.addText(text);
  body.font = Font.systemFont(10);
  body.textColor = COLOR.dim;
  body.lineLimit = 1;

  line.addSpacer();
}

function buildWidget(payload, family) {
  const size = SIZE[family] || SIZE.medium;
  const width = contentWidthFor(family);

  const widget = new ListWidget();
  widget.backgroundColor = COLOR.bg;
  widget.setPadding(12, 13, 12, 13);

  // payload が落ちてくる経路は増えうるので、ここで最終的に守る
  if (!payload || typeof payload !== "object" || payload.error) {
    const title = widget.addText(T.title);
    title.font = Font.boldSystemFont(size.title);
    title.textColor = COLOR.text;
    widget.addSpacer(6);
    const msg = widget.addText(
      (payload && payload.error) || T.loadFailed
    );
    msg.font = Font.systemFont(10);
    msg.textColor = COLOR.danger;
    msg.lineLimit = 3;
    const ver = widget.addText(`v${VERSION}`);
    ver.font = Font.systemFont(8);
    ver.textColor = COLOR.dim;
    return widget;
  }

  const header = widget.addStack();
  header.centerAlignContent();
  const title = header.addText(T.title);
  title.font = Font.boldSystemFont(size.title);
  title.textColor = COLOR.text;
  header.addSpacer();

  // 引き継ぎ中の枠があるなら、generated_at ではなく「その数値がいつのものか」を出す
  const stalest = stalestFetchedAt(payload);
  const shownAt = stalest || payload.generated_at;
  const age = minutesSince(shownAt);
  if (age !== null) {
    const ageText = header.addText(agoText(shownAt));
    ageText.font = Font.systemFont(size.age);
    ageText.textColor =
      stalest || age > STALE_AFTER_MINUTES ? COLOR.danger : COLOR.dim;
  }

  const groups = buildGroups(payload, family);
  if (groups.length === 0) {
    widget.addSpacer(6);
    const msg = widget.addText(T.noData);
    msg.font = Font.systemFont(10);
    msg.textColor = COLOR.dim;
    return widget;
  }

  if (family === "medium" && groups.length > 1) {
    addGroupsColumns(widget, groups, size, width);
  } else {
    addGroupsStacked(widget, groups, size, width);
  }

  widget.addSpacer();

  const note = statusNote(payload);
  if (note) {
    const noteText = widget.addText(note);
    noteText.font = Font.systemFont(family === "small" ? 8 : 9);
    noteText.textColor = COLOR.danger;
    noteText.lineLimit = 1;
    return widget;
  }

  // large は縦に余るので、余白を情報で埋める
  if (family === "large") {
    // クレジットは Claude と Codex の両方にありうるので、必ずサービス名を添える
    const extra = payload.claude && payload.claude.extra_usage;
    if (extra && (typeof extra.percent === "number" || typeof extra.used === "number")) {
      const used = moneyText(extra.used, extra.decimal_places, extra.currency);
      const limit = moneyText(extra.limit, extra.decimal_places, extra.currency);
      // 古い JSON では未使用時に percent が null になる。金額から出せるなら出す
      let pct = extra.percent;
      if (typeof pct !== "number" && typeof extra.used === "number" && extra.limit > 0) {
        pct = (extra.used / extra.limit) * 100;
      }
      const parts = [T.extraCredits(Math.round(pct || 0))];
      if (used && limit) parts.push(`${used} / ${limit}`);
      addCreditLine(widget, "Claude", COLOR.claude, parts.join("  ・  "));
    }

    const credits = payload.codex && payload.codex.credits;
    if (credits) {
      // 実物を見ていないので、取れたものから順に選ぶ
      let text;
      if (credits.unlimited) {
        text = T.creditsUnlimited;
      } else if (typeof credits.approx_local_messages === "number") {
        text = T.creditsMessages(credits.approx_local_messages);
      } else if (typeof credits.balance === "number") {
        text = T.creditsBalance(credits.balance);
      } else {
        text = T.creditsSome;
      }
      if (credits.overage_limit_reached) text += T.overageReached;
      addCreditLine(widget, "Codex", COLOR.codex, text);
    }

    const codexAge = payload.codex && payload.codex.observed_age_seconds;
    if (typeof codexAge === "number" && codexAge >= 3600) {
      const hint = widget.addText(
        T.codexOld(Math.round(codexAge / 3600))
      );
      hint.font = Font.systemFont(9);
      hint.textColor = COLOR.dim;
    }
  }

  return widget;
}

// --- エントリポイント -------------------------------------------------------------

// 未登録のときだけ、アプリ内実行で共有リンクの入力を求める。
// ウィジェットやショートカットからは絶対に出さない（画面を出せないため）。
async function promptForRemoteUrl() {
  const current = remoteUrl() || "";
  const alert = new Alert();
  alert.title = current ? T.setupTitleEdit : T.setupTitle;
  alert.message = current ? T.setupBodyFailed : T.setupBody;
  // 現在の値を入れておく。空にして保存すれば登録を消せる
  alert.addTextField("https://...", current);
  alert.addAction(T.save);
  alert.addCancelAction(current ? T.keep : T.later);
  const tapped = await alert.presentAlert();
  if (tapped !== 0) return;
  const value = (alert.textFieldValue(0) || "").trim();

  if (!value) {
    // 空で保存 = 登録を消して iCloud 経由に戻す
    try {
      if (Keychain.contains(URL_KEYCHAIN_KEY)) Keychain.remove(URL_KEYCHAIN_KEY);
    } catch (e) {
      // 消せなくても描画は続ける
    }
    return;
  }
  if (value === current) return; // 変更が無ければテストもしない
  try {
    Keychain.set(URL_KEYCHAIN_KEY, value);
  } catch (e) {
    return; // 保存できなければテストしても意味がない
  }

  // その場で 1 回取ってみる。サービスごとに直リンクの規則が違うので、
  // 「登録したのに動かない」を後から追うより、ここで白黒つけたほうが早い。
  const probe = await readFromRemote();
  const result = new Alert();
  result.title = probe ? T.probeOk : T.probeNg;
  result.message = probe
    ? T.probeOkBody(probe.generated_at || "")
    : T.probeNgBody;
  result.addAction(T.ok);
  await result.presentAlert();
}

const family = config.runsInWidget ? config.widgetFamily || "medium" : "medium";

// 入力を求めるのは「困っているとき」だけにする。
//   - まだ登録されていない
//   - 登録済みだが取得できない（リンク切れ・共有設定の誤り）
//   - ショートカットから "setup" を渡して明示的に呼んだ
// 問題なく動いているときに毎回聞くと、ただ邪魔になる。
// （ウィジェットからは画面を出せないので絶対に呼ばない）
if (config.runsInApp) {
  const asked = String((typeof args !== "undefined" && args.shortcutParameter) || "").trim();
  if (asked === "setup") {
    await promptForRemoteUrl();
  } else if (!remoteUrl()) {
    await promptForRemoteUrl();
  } else if (!(await readFromRemote())) {
    // 登録されているのに取れない。直せるように編集させる
    await promptForRemoteUrl();
  }
}

// 想定外の例外で Scriptable の赤いエラー画面になるより、
// 読める文言を出したほうが原因を追いやすい
let widget;
try {
  const payload = await loadPayload();
  widget = buildWidget(payload, family);
} catch (e) {
  widget = buildWidget({ error: T.renderFailed(e.message) }, family);
}

// iOS への再描画のヒント。強制力はないが、ショートカットで控えを更新したのに
// 表示が古いまま、という間を縮められる。
widget.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);

if (config.runsInWidget || config.runsInAccessoryWidget) {
  Script.setWidget(widget);
} else if (config.runsInApp && PREVIEW_IN_APP) {
  await widget.presentMedium();
}
// ショートカット / Siri から呼ばれたときは何も表示しない。
// loadPayload() が iCloud を読んで端末内の控えを更新するので、
// ウィジェット拡張（iCloud のダウンロードを起こせない）はその控えを読める。
Script.complete();
