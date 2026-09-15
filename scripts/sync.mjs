// letscareer.job 게시물 성과 + 캠페인명에 '오공고'가 포함된 광고 성과 수집
// 결과: docs/data/posts.json, docs/data/sync.json, docs/covers/{게시물ID}.jpg
import { access, mkdir, writeFile } from "node:fs/promises";

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
  followTypes: list(env("AD_FOLLOW_ACTION_TYPES", "ig_follow,follow")),
};

const DATA_DIR = "docs/data";
const COVER_DIR = "docs/covers";

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
  "id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp," +
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

async function fetchAds(mediaIds) {
  const rows = (
    await graphAll(`${cfg.adAccount}/insights`, {
      level: "ad",
      fields: "ad_id,ad_name,campaign_name,spend,impressions,actions",
      time_range: JSON.stringify({ since: cfg.startDate, until: kstToday() }),
      filtering: JSON.stringify([{ field: "campaign.name", operator: "CONTAIN", value: cfg.keyword }]),
      limit: "500",
    })
  ).filter((r) => String(r.campaign_name ?? "").includes(cfg.keyword));

  const actionTypes = new Set();
  rows.forEach((r) => (r.actions ?? []).forEach((a) => actionTypes.add(a.action_type)));

  // 광고 소재에 연결된 인스타그램 게시물 ID ('오공고' 캠페인 광고 목록에서 한 번에 조회)
  const mediaOf = new Map();
  const adList = await graphAll(`${cfg.adAccount}/ads`, {
    fields: "id,creative{effective_instagram_media_id}",
    filtering: JSON.stringify([{ field: "campaign.name", operator: "CONTAIN", value: cfg.keyword }]),
    limit: "200",
  });
  for (const ad of adList) mediaOf.set(ad.id, ad.creative?.effective_instagram_media_id ?? null);

  // 목록에서 빠진 광고(보관·삭제 등)는 하나씩 조회
  for (const r of rows) {
    if (mediaOf.has(r.ad_id)) continue;
    try {
      const ad = await graph(r.ad_id, { fields: "creative{effective_instagram_media_id}" });
      mediaOf.set(r.ad_id, ad.creative?.effective_instagram_media_id ?? null);
    } catch (e) {
      if (!(e instanceof GraphError) || RATE_LIMIT_CODES.includes(e.detail.code)) throw e;
      mediaOf.set(r.ad_id, null);
    }
  }

  const byMedia = new Map();
  let adsWithoutPost = 0;
  let adsOnOtherAccount = 0;
  for (const r of rows) {
    const mediaId = mediaOf.get(r.ad_id);
    if (!mediaId) { adsWithoutPost++; continue; }
    if (!mediaIds.has(mediaId)) { adsOnOtherAccount++; continue; } // letscareer.job 게시물이 아닌 광고
    const agg = byMedia.get(mediaId) ?? { adCount: 0, spend: 0, impressions: 0, profileVisits: 0, follows: 0 };
    agg.adCount += 1;
    agg.spend += Number(r.spend ?? 0);
    agg.impressions += Number(r.impressions ?? 0);
    agg.profileVisits += sumActions(r.actions, cfg.profileVisitTypes);
    agg.follows += sumActions(r.actions, cfg.followTypes);
    byMedia.set(mediaId, agg);
  }

  return { byMedia, adCount: rows.length, adsWithoutPost, adsOnOtherAccount, actionTypes: [...actionTypes].sort() };
}

// ── 실행 ─────────────────────────────────────────────────
async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(COVER_DIR, { recursive: true });

  const igUserId = await resolveIgUserId();
  const media = await listMedia(igUserId);
  console.log(`${cfg.igUsername} 게시물 ${media.length}개 확인`);

  const covers = new Map();
  const organic = new Map();
  await pool(media, 5, async (m) => {
    covers.set(m.id, await saveCover(m));
    organic.set(m.id, await fetchInsights(m));
  });

  const ads = await fetchAds(new Set(media.map((m) => m.id)));

  const posts = media.map((m) => {
    const o = organic.get(m.id) ?? {};
    return {
      id: m.id,
      date: toKstDate(m.timestamp),
      type: typeLabel(m),
      caption: m.caption ?? "",
      permalink: m.permalink,
      cover: covers.get(m.id),
      organic: {
        views: o.views ?? null,
        likes: o.likes ?? null,
        comments: o.comments ?? null,
        saves: o.saved ?? null,
        shares: o.shares ?? null,
        profileVisits: o.profile_visits ?? null,
        follows: o.follows ?? null,
      },
      ad: ads.byMedia.get(m.id) ?? null,
    };
  });

  const sync = {
    syncedAt: new Date().toISOString(),
    account: cfg.igUsername,
    campaignKeyword: cfg.keyword,
    startDate: cfg.startDate,
    mediaCount: media.length,
    adCount: ads.adCount,
    adsWithoutPost: ads.adsWithoutPost,
    adsOnOtherAccount: ads.adsOnOtherAccount,
    actionTypes: ads.actionTypes,
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
