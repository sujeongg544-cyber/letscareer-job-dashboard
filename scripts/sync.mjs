// letscareer.job 게시물 성과 + 캠페인명에 '오공고'가 포함된 광고 성과 수집
// 결과: docs/data/posts.json, docs/data/sync.json, docs/covers/{게시물ID}.jpg
import { access, mkdir, readFile, writeFile } from "node:fs/promises";

function env(key, fallback) {
  const v = process.env[key] ?? fallback;
  if (v === undefined || v === "") throw new Error(`환경변수 ${key}가 설정되지 않았습니다`);
  return v;
}
const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

const cfg = {
  token: env("META_ACCESS_TOKEN"),
  graph: `https://graph.facebook.com/${env("GRAPH_VERSION", "v26.0")}`,
  adAccount: env("META_AD_ACCOUNT_ID"),
  igUsername: env("IG_USERNAME", "letscareer.job"),
  igUserId: process.env.IG_USER_ID ?? "",
  keyword: env("CAMPAIGN_KEYWORD", "오공고"),
  startDate: env("START_DATE", "2026-01-01"),
  profileVisitTypes: list(env("AD_PROFILE_VISIT_ACTION_TYPES", "ig_profile_visit,profile_visit")),
};

const DATA_DIR = "docs/data";
const COVER_DIR = "docs/covers";
const MANUAL_FOLLOWS = "manual/ad-follows.csv"; // 광고 팔로우 수 직접 입력 파일

// ── 공통 유틸 ─────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RATE_LIMIT_CODES = [4, 17, 32, 613, 80004];

class GraphError extends Error {
  constructor(detail) {
    super(`Meta API 오류 ${detail.code}: ${detail.message}`);
    this.detail = detail;
  }
}

async function graph(pathOrUrl, params = {}) {
  let url;
  if (pathOrUrl.startsWith("https://")) {
    url = new URL(pathOrUrl); // paging.next (토큰 포함)
  } else {
    url = new URL(`${cfg.graph}/${pathOrUrl}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("access_token", cfg.token);
  }
  for (let attempt = 0; ; attempt++) {
    const json = await (await fetch(url)).json();
    if (!json.error) return json;
    if (RATE_LIMIT_CODES.includes(json.error.code) && attempt < 3) {
      console.log(`호출 한도 도달, ${10 * (attempt + 1)}초 대기 후 재시도`);
      await sleep(10_000 * (attempt + 1));
      continue;
    }
    throw new GraphError(json.error);
  }
}

async function graphAll(path, params) {
  const out = [];
  let page = await graph(path, params);
  while (true) {
    out.push(...(page.data ?? []));
    if (!page.paging?.next) return out;
    page = await graph(page.paging.next);
  }
}

async function pool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

// "2026-09-12T03:00:00+0000" → "2026-09-12T03:00:00+00:00"
const normTs = (ts) => ts.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
const toKstDate = (ts) => new Date(new Date(normTs(ts)).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const exists = (p) => access(p).then(() => true, () => false);

// ── 1. 인스타그램 콘텐츠 (letscareer.job) ─────────────────
const MEDIA_FIELDS =
  "id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count," +
  "children{media_type,media_url,thumbnail_url}";
const INSIGHT_METRICS = ["views", "reach", "likes", "comments", "saved", "shares", "profile_visits", "follows"];
const unsupported = new Map(); // 게시물 유형별 미지원 지표 (오류 메시지에 지표 이름이 있을 때만 기록)
const insightErrors = new Map(); // "유형 | 오류 메시지" → 게시물 수

async function resolveIgUserId() {
  if (cfg.igUserId) return cfg.igUserId;
  const pages = await graphAll("me/accounts", {
    fields: "name,instagram_business_account{id,username}",
    limit: "100",
  });
  const hit = pages.map((p) => p.instagram_business_account).find((a) => a?.username === cfg.igUsername);
  if (!hit) {
    throw new Error(
      `토큰으로 접근 가능한 페이지 중 ${cfg.igUsername} 계정이 연결된 곳이 없습니다. ` +
        `시스템 사용자에게 letscareer.job이 연결된 페이지 자산 권한을 부여했는지 확인하세요.`,
    );
  }
  return hit.id;
}

async function listMedia(igUserId) {
  const since = new Date(`${cfg.startDate}T00:00:00+09:00`).getTime();
  const out = [];
  let page = await graph(`${igUserId}/media`, { fields: MEDIA_FIELDS, limit: "50" });
  while (true) {
    for (const m of page.data ?? []) {
      if (new Date(normTs(m.timestamp)).getTime() < since) return out; // 최신순이므로 여기서 종료
      out.push(m);
    }
    if (!page.paging?.next) return out;
    page = await graph(page.paging.next);
  }
}

function coverUrl(m) {
  if (m.media_type === "CAROUSEL_ALBUM") {
    const first = m.children?.data?.[0];
    if (first) return first.media_type === "VIDEO" ? first.thumbnail_url : first.media_url;
  }
  if (m.media_type === "VIDEO") return m.thumbnail_url;
  return m.media_url;
}

async function saveCover(m) {
  const file = `${COVER_DIR}/${m.id}.jpg`;
  if (await exists(file)) return `covers/${m.id}.jpg`;
  const src = coverUrl(m);
  if (!src) return null;
  const res = await fetch(src);
  if (!res.ok) return null;
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return `covers/${m.id}.jpg`;
}

function parseInsights(json) {
  const r = {};
  for (const d of json.data ?? []) r[d.name] = d.values?.[0]?.value ?? d.total_value?.value ?? null;
  return r;
}

async function fetchInsights(m) {
  const type = m.media_product_type ?? m.media_type;
  if (!unsupported.has(type)) unsupported.set(type, new Set());
  const skip = unsupported.get(type);
  const metrics = INSIGHT_METRICS.filter((x) => !skip.has(x));
  try {
    return parseInsights(await graph(`${m.id}/insights`, { metric: metrics.join(",") }));
  } catch (e) {
    if (!(e instanceof GraphError) || RATE_LIMIT_CODES.includes(e.detail.code)) throw e;
    // 지표를 하나씩 다시 요청해 받을 수 있는 것만 사용
    const result = {};
    for (const metric of metrics) {
      try {
        Object.assign(result, parseInsights(await graph(`${m.id}/insights`, { metric })));
      } catch (err) {
        if (!(err instanceof GraphError) || RATE_LIMIT_CODES.includes(err.detail.code)) throw err;
        const key = `${type} | ${err.detail.message}`;
        insightErrors.set(key, (insightErrors.get(key) ?? 0) + 1);
        if (err.detail.message.includes(metric)) {
          skip.add(metric); // 이 유형에서 지원하지 않는 지표 → 같은 유형 게시물은 다음부터 제외
          continue;
        }
        break; // 게시물 자체의 문제 → 나머지 지표도 같은 이유로 실패하므로 중단
      }
    }
    return result;
  }
}

function typeLabel(m) {
  if (m.media_product_type === "REELS") return "릴스";
  if (m.media_type === "CAROUSEL_ALBUM") return "캐러셀";
  if (m.media_type === "VIDEO") return "동영상";
  return "이미지";
}

// ── 2. 광고 ('오공고' 캠페인만, 시작일부터 오늘까지 누적) ──
const sumActions = (actions, types) =>
  (actions ?? []).filter((a) => types.includes(a.action_type)).reduce((s, a) => s + Number(a.value), 0);
const sumResults = (results, types) =>
  (results ?? []).filter((r) => types.includes(r.indicator)).reduce((s, r) => s + Number(r.values?.[0]?.value ?? 0), 0);
// https://www.instagram.com/p/ABC123/ → ABC123
const shortcode = (url) => String(url ?? "").match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([^/?#]+)/)?.[1] ?? null;

const CREATIVE_FIELDS = "creative{effective_instagram_media_id,instagram_permalink_url}";
const campaignFilter = () => JSON.stringify([{ field: "campaign.name", operator: "CONTAIN", value: cfg.keyword }]);

async function fetchAdInsights() {
  const base = "ad_id,ad_name,campaign_name,spend,impressions,actions";
  const params = {
    level: "ad",
    time_range: JSON.stringify({ since: cfg.startDate, until: kstToday() }),
    filtering: campaignFilter(),
    limit: "500",
  };
  try {
    return await graphAll(`${cfg.adAccount}/insights`, { ...params, fields: `${base},objective,optimization_goal,results` });
  } catch (e) {
    if (!(e instanceof GraphError) || e.detail.code !== 100) throw e;
    return await graphAll(`${cfg.adAccount}/insights`, { ...params, fields: base });
  }
}

// media 배열에 광고로 찾은 letscareer.job 게시물을 추가할 수 있음
async function fetchAds(media) {
  const rows = (await fetchAdInsights()).filter((r) => String(r.campaign_name ?? "").includes(cfg.keyword));

  const resultIndicators = new Set();
  const objectives = new Set();
  for (const r of rows) {
    (r.results ?? []).forEach((x) => resultIndicators.add(x.indicator));
    if (r.objective) objectives.add(`${r.objective} / ${r.optimization_goal ?? "-"}`);
  }

  // 광고 소재에 연결된 게시물
  const linkOf = new Map();
  const toLink = (ad) => ({
    mediaId: ad.creative?.effective_instagram_media_id ?? null,
    permalink: ad.creative?.instagram_permalink_url ?? null,
  });
  const adList = await graphAll(`${cfg.adAccount}/ads`, { fields: `id,${CREATIVE_FIELDS}`, filtering: campaignFilter(), limit: "200" });
  for (const ad of adList) linkOf.set(ad.id, toLink(ad));
  for (const r of rows) {
    if (linkOf.has(r.ad_id)) continue;
    try {
      linkOf.set(r.ad_id, toLink(await graph(r.ad_id, { fields: CREATIVE_FIELDS })));
    } catch (e) {
      if (!(e instanceof GraphError) || RATE_LIMIT_CODES.includes(e.detail.code)) throw e;
      linkOf.set(r.ad_id, { mediaId: null, permalink: null });
    }
  }

  const ids = new Set(media.map((m) => m.id));
  const byCode = new Map(media.map((m) => [shortcode(m.permalink), m.id]));
  const since = new Date(`${cfg.startDate}T00:00:00+09:00`).getTime();
  const lookedUp = new Map(); // 게시물 ID → 조회 결과
  let addedFromAds = 0;

  // 목록에서 못 찾은 게시물은 ID로 직접 조회해서 letscareer.job 게시물이면 추가
  async function resolve(link) {
    if (ids.has(link.mediaId)) return { target: link.mediaId };
    const code = shortcode(link.permalink);
    if (code && byCode.has(code)) return { target: byCode.get(code) };
    if (!link.mediaId) return { target: null, owner: null };
    if (!lookedUp.has(link.mediaId)) {
      try {
        lookedUp.set(link.mediaId, await graph(link.mediaId, { fields: `${MEDIA_FIELDS},username` }));
      } catch (e) {
        if (!(e instanceof GraphError) || RATE_LIMIT_CODES.includes(e.detail.code)) throw e;
        lookedUp.set(link.mediaId, { error: e.detail.message });
      }
    }
    const m = lookedUp.get(link.mediaId);
    if (m.error) return { target: null, owner: `조회 실패: ${m.error}` };
    const isOurs = m.username === cfg.igUsername && new Date(normTs(m.timestamp)).getTime() >= since;
    if (!isOurs) return { target: null, owner: `${m.username ?? "알 수 없음"} (${m.timestamp ? toKstDate(m.timestamp) : "-"})` };
    if (!ids.has(m.id)) {
      m.fromAd = true; // 게시물 목록에는 없고 광고로 찾은 게시물
      media.push(m);
      ids.add(m.id);
      byCode.set(shortcode(m.permalink), m.id);
      addedFromAds++;
    }
    return { target: m.id };
  }

  const byMedia = new Map();
  let adsWithoutPost = 0;
  let adsUnmatched = 0;
  const unmatchedSample = [];
  for (const r of rows) {
    const link = linkOf.get(r.ad_id);
    if (!link.mediaId && !link.permalink) { adsWithoutPost++; continue; }
    const { target, owner } = await resolve(link);
    if (!target) {
      adsUnmatched++;
      if (unmatchedSample.length < 5) unmatchedSample.push({ ad: r.ad_name, permalink: link.permalink, owner });
      continue;
    }
    const agg = byMedia.get(target) ?? { adCount: 0, adNames: [], spend: 0, impressions: 0, profileVisits: 0, follows: null };
    agg.adCount += 1;
    agg.adNames.push(r.ad_name);
    agg.spend += Number(r.spend ?? 0);
    agg.impressions += Number(r.impressions ?? 0);
    agg.profileVisits += sumActions(r.actions, cfg.profileVisitTypes) + sumResults(r.results, cfg.profileVisitTypes);
    byMedia.set(target, agg);
  }

  return {
    byMedia,
    adCount: rows.length,
    adsMatched: rows.length - adsWithoutPost - adsUnmatched,
    adsWithoutPost,
    adsUnmatched,
    addedFromAds,
    unmatchedSample,
    objectives: [...objectives].sort(),
    resultIndicators: [...resultIndicators].sort(),
  };
}

// ── 3. 광고 팔로우 수 (manual/ad-follows.csv 직접 입력) ──────
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}
const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

async function loadManualFollows() {
  const map = new Map(); // 게시물 코드 → { follows, row }
  const text = await readFile(MANUAL_FOLLOWS, "utf8").catch(() => "");
  const [, ...rows] = parseCsv(text.replace(/^\uFEFF/, ""));
  for (const [date, ads, link, follows] of rows) {
    const code = shortcode(link);
    if (!code) continue;
    const n = String(follows ?? "").replace(/[^\d]/g, "");
    map.set(code, { date, ads, link, follows: n === "" ? null : Number(n) });
  }
  return map;
}

// 광고 집행 게시물을 파일에 채워 넣음 (이미 입력한 팔로우 수는 유지)
async function writeManualFollows(manual, posts) {
  for (const p of posts) {
    if (!p.ad) continue;
    const code = shortcode(p.permalink);
    const prev = manual.get(code);
    manual.set(code, { date: p.date, ads: p.ad.adNames.join(" / "), link: p.permalink, follows: prev?.follows ?? null });
  }
  const rows = [...manual.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const lines = ["게시일,광고명,게시물 링크,광고 팔로우", ...rows.map((r) => [r.date, r.ads, r.link, r.follows ?? ""].map(csvCell).join(","))];
  await mkdir("manual", { recursive: true });
  await writeFile(MANUAL_FOLLOWS, lines.join("\n") + "\n");
}

// ── 실행 ─────────────────────────────────────────────────
async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(COVER_DIR, { recursive: true });

  const igUserId = await resolveIgUserId();
  const media = await listMedia(igUserId);
  const listed = media.length;
  console.log(`${cfg.igUsername} 게시물 목록 ${listed}개 확인`);

  const ads = await fetchAds(media); // 목록에 없던 광고 게시물이 media에 추가될 수 있음
  media.sort((a, b) => normTs(b.timestamp).localeCompare(normTs(a.timestamp)));

  const covers = new Map();
  const organic = new Map();
  await pool(media, 5, async (m) => {
    covers.set(m.id, await saveCover(m));
    organic.set(m.id, await fetchInsights(m));
  });

  const manual = await loadManualFollows();

  const posts = media.map((m) => {
    const o = organic.get(m.id) ?? {};
    const ad = ads.byMedia.get(m.id) ?? null;
    if (ad) ad.follows = manual.get(shortcode(m.permalink))?.follows ?? null;
    return {
      id: m.id,
      date: toKstDate(m.timestamp),
      type: typeLabel(m),
      caption: m.caption ?? "",
      permalink: m.permalink,
      cover: covers.get(m.id),
      organic: {
        views: o.views ?? null,
        likes: o.likes ?? m.like_count ?? null, // 광고 게시물은 인사이트 대신 게시물 정보의 좋아요·댓글 수 사용
        comments: o.comments ?? m.comments_count ?? null,
        saves: o.saved ?? null,
        shares: o.shares ?? null,
        profileVisits: o.profile_visits ?? null,
        follows: o.follows ?? null,
      },
      ad,
    };
  });

  await writeManualFollows(manual, posts);

  // 광고로 추가한 게시물이 목록의 게시물과 겹치는지 확인 (같은 날짜 + 같은 캡션 앞부분)
  const sig = (m) => `${toKstDate(m.timestamp)}|${String(m.caption ?? "").replace(/\s+/g, "").slice(0, 40)}`;
  const listedSigs = new Map(media.filter((m) => !m.fromAd).map((m) => [sig(m), m.permalink]));
  const possibleDuplicates = media
    .filter((m) => m.fromAd && listedSigs.has(sig(m)))
    .map((m) => ({ adPost: m.permalink, listedPost: listedSigs.get(sig(m)) }));

  const times = media.map((m) => toKstDate(m.timestamp)).sort();
  const sync = {
    syncedAt: new Date().toISOString(),
    account: cfg.igUsername,
    campaignKeyword: cfg.keyword,
    startDate: cfg.startDate,
    mediaListed: listed,
    mediaCount: media.length,
    mediaRange: { oldest: times[0] ?? null, newest: times.at(-1) ?? null },
    addedFromAds: ads.addedFromAds,
    possibleDuplicates: { count: possibleDuplicates.length, sample: possibleDuplicates.slice(0, 5) },
    adCount: ads.adCount,
    adsMatched: ads.adsMatched,
    adsWithoutPost: ads.adsWithoutPost,
    adsUnmatched: ads.adsUnmatched,
    unmatchedSample: ads.unmatchedSample,
    adPostsWithFollows: posts.filter((p) => p.ad?.follows != null).length,
    adPosts: posts.filter((p) => p.ad).length,
    objectives: ads.objectives,
    resultIndicators: ads.resultIndicators,
    unsupportedMetrics: Object.fromEntries([...unsupported].filter(([, v]) => v.size).map(([k, v]) => [k, [...v]])),
    insightErrors: [...insightErrors].sort((x, y) => y[1] - x[1]).slice(0, 20).map(([error, posts]) => ({ error, posts })),
  };

  await writeFile(`${DATA_DIR}/posts.json`, JSON.stringify(posts, null, 2));
  await writeFile(`${DATA_DIR}/sync.json`, JSON.stringify(sync, null, 2));
  console.log(JSON.stringify(sync, null, 2));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
