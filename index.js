const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");
const cloudscraper = require("cloudscraper");

const DOMAINS = [
  "https://redecanais.ooo",
  "https://redecanais.ee",
  "https://redecanais.ink",
  "https://redecanais.fi",
  "https://redecanais.zip",
  "https://redecanais.dev",
  "https://redecanais.fm",
  "https://redecanais.gs",
  "https://redecanais.la",
  "https://redecanais.ec",
];

const MOVIES_PATH = "/mapafilmes.html";
const SERIES_PATH = "/mapa.html";
const PLAYER_PATH = "/player3";
const PORT = process.env.PORT || 3000;
const PROXY_URL = process.env.PROXY_URL || "";

let ACTIVE_DOMAIN = DOMAINS[0];
let moviesCache = [];
let seriesCache = [];
let lastCacheTime = 0;
const CACHE_TTL = 6 * 60 * 60 * 1000;
const streamCache = new Map();

const scraper = cloudscraper.defaults({
  headers: { "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7" },
});

function createClient(baseURL) {
  return {
    async get(path) {
      const url = path.startsWith("http") ? path : `${baseURL}${path}`;
      console.log(`[HTTP] GET ${url}`);
      const data = await scraper.get(url, { headers: { referer: baseURL } });
      return { data };
    },
  };
}

async function fetchWithRetry(url, options = {}, retries = 3) {
  const baseURL = new URL(url).origin;
  for (let i = 0; i < retries; i++) {
    try {
      const reqOptions = {
        uri: url,
        method: (options.method || "GET").toUpperCase(),
        headers: { referer: baseURL, ...options.headers },
        followAllRedirects: options.followRedirects !== false,
        resolveWithFullResponse: true,
        timeout: 15000,
      };
      if (options.body) reqOptions.body = options.body;
      const resp = await scraper(reqOptions);
      return { data: resp.body, status: resp.statusCode, headers: resp.headers };
    } catch (err) {
      console.log(`[HTTP] Tentativa ${i + 1}/${retries} falhou: ${err.message}`);
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

async function findActiveDomain() {
  for (const domain of DOMAINS) {
    try {
      const resp = await scraper({ uri: domain, resolveWithFullResponse: true, timeout: 10000, headers: { referer: domain } });
      if (resp.statusCode < 400) {
        console.log(`[DOMAIN] Ativo: ${domain} (${resp.statusCode})`);
        ACTIVE_DOMAIN = domain;
        return domain;
      }
      console.log(`[DOMAIN] ${domain} - ${resp.statusCode}`);
    } catch (e) {
      console.log(`[DOMAIN] ${domain} - ${e.message}`);
    }
  }
  console.log(`[DOMAIN] Nenhum respondeu, usando: ${ACTIVE_DOMAIN}`);
  return ACTIVE_DOMAIN;
}

function decryptScript(script) {
  const results = [];
  const matches = String(script).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of matches) {
    const f = formatDecrypt(match[1]);
    if (f) results.push(f);
  }
  return results.join("\n");
}

function formatDecrypt(content) {
  const arrayMatch = content.match(/(\w+)\s*=\s*\[(.*?)\]\s*;/s);
  const numberMatch = content.match(/(\d{7,})/);
  if (!arrayMatch || !numberMatch) return "";
  const [, , arrayValues] = arrayMatch;
  const dynamicNumber = parseInt(numberMatch[1], 10);
  const b64s = arrayValues.split(",").map((s) => s.trim().replace(/['"]/g, ""));
  let decoded = "";
  for (const b64 of b64s) {
    try {
      const raw = Buffer.from(b64, "base64").toString("binary");
      decoded += String.fromCharCode(parseInt(raw.replace(/\D/g, ""), 10) - dynamicNumber);
    } catch {}
  }
  try { return Buffer.from(decoded, "latin1").toString("utf8"); } catch { return ""; }
}

const RAW_REGEX = /(.*)<a\s*href=".*"\s*target=".*">/g;
const TITLE_REGEX_1 = /^(.+?)(?:\s*\([^)]*\))(?=\s+-\s*|$)/;
const TITLE_REGEX_2 = /^(.+?)(?:\s*\([^)]*\))?(?=\s+-\s*|$)/;
const URL_REGEX = /.*<a\s*href="(.*)"\s*target=".*">/;
const AUDIO_REGEX = /\s\((Dublado|Dubaldo|Duiblado|Legendado|Legendaod|Nacional|Dublado\s\/\sLegendado|Mudo|Original)\)\s[-]?/;
const AUDIO_URL_REGEX = /.*<a\s*href=".*-(dublado|dubaldo|duiblado|legendado|legendaod|nacional)(?:-)?.*"\s*target=".*">/;
const QUALITY_REGEX = /[-]?\s(180p|480p|720p|7200p|1008p|1080p|2160p\s\(4K\))\s[-]?/;
const QUALITY_URL_REGEX = /.*<a\s*href=".*-(180p|480p|720p|7200p|1008p|1080p|2160p-4k)(?:-)?.*"\s*target=".*">/;

function matchRegex(content, regex) { if (!content) return null; const m = content.match(regex); return m ? m[1] : null; }
function classifyAudio(raw) { if (!raw) return "Desconhecido"; const l = raw.toLowerCase(); if (/dublado|dubaldo|duiblado/.test(l)) return "Dublado"; if (/legendado|legendaod/.test(l)) return "Legendado"; if (/nacional/.test(l)) return "Nacional"; if (/mudo/.test(l)) return "Mudo"; if (/original/.test(l)) return "Original"; return "Desconhecido"; }
function classifyQuality(raw) { if (!raw) return "Desconhecido"; if (/480p/.test(raw)) return "SD"; if (/720p|7200p/.test(raw)) return "HD"; if (/180p|1008p|1080p/.test(raw)) return "Full HD"; if (/2160p|4k/i.test(raw)) return "4K"; return "Desconhecido"; }
function normalizeTitle(text) { return String(text).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim().toLowerCase(); }

async function fetchMovieList() {
  console.log("[SCRAPE] Buscando filmes...");
  const client = createClient(ACTIVE_DOMAIN);
  const { data } = await client.get(MOVIES_PATH);
  const rawMatches = data.match(RAW_REGEX) || [];
  console.log(`[SCRAPE] ${rawMatches.length} entradas de filmes`);
  const movies = [];
  for (const raw of rawMatches) {
    const url = matchRegex(raw, URL_REGEX);
    const title = matchRegex(raw, TITLE_REGEX_1) || matchRegex(raw, TITLE_REGEX_2);
    const audioRaw = matchRegex(raw, AUDIO_REGEX) || matchRegex(raw, AUDIO_URL_REGEX);
    const qualityRaw = matchRegex(raw, QUALITY_REGEX) || matchRegex(raw, QUALITY_URL_REGEX);
    if (url && title) movies.push({ url, title: title.trim(), audio: classifyAudio(audioRaw), quality: classifyQuality(qualityRaw), normalizedTitle: normalizeTitle(title) });
  }
  console.log(`[SCRAPE] ${movies.length} filmes OK`);
  return movies;
}

async function fetchSeriesList() {
  console.log("[SCRAPE] Buscando séries...");
  const client = createClient(ACTIVE_DOMAIN);
  const { data } = await client.get(SERIES_PATH);
  const rawMatches = data.match(RAW_REGEX) || [];
  console.log(`[SCRAPE] ${rawMatches.length} entradas de séries`);
  const series = [];
  for (const raw of rawMatches) {
    const url = matchRegex(raw, URL_REGEX);
    const title = matchRegex(raw, TITLE_REGEX_1) || matchRegex(raw, TITLE_REGEX_2);
    if (url && title) series.push({ url, title: title.trim(), normalizedTitle: normalizeTitle(title) });
  }
  console.log(`[SCRAPE] ${series.length} séries OK`);
  return series;
}

async function resolveStream(pageUrl) {
  try {
    console.log(`[STREAM] Resolvendo: ${pageUrl}`);
    const fullUrl = pageUrl.startsWith("http") ? pageUrl : `${ACTIVE_DOMAIN}${pageUrl}`;
    const baseOrigin = new URL(fullUrl).origin;
    const resp1 = await fetchWithRetry(fullUrl, { headers: { referer: baseOrigin } });
    const decrypted1 = decryptScript(resp1.data);
    const iframeMatch = decrypted1.match(/<iframe\s+[^>]*src=["']([^"']*?)["']/i);
    if (!iframeMatch) {
      const srcMatch = resp1.data.match(/src=["'](\/player[^"']*?)["']/i);
      if (!srcMatch) throw new Error("Player não encontrado");
      return await resolveFromPlayer(`${baseOrigin}${srcMatch[1]}`, baseOrigin);
    }
    let playerUrl = iframeMatch[1];
    if (playerUrl.startsWith("/")) playerUrl = `${baseOrigin}${playerUrl}`;
    else if (!playerUrl.startsWith("http")) playerUrl = new URL(playerUrl, baseOrigin).href;
    return await resolveFromPlayer(playerUrl, baseOrigin);
  } catch (err) {
    console.error(`[STREAM] Erro: ${err.message}`);
    return null;
  }
}

async function resolveFromPlayer(playerUrl, referer) {
  const playerOrigin = new URL(playerUrl).origin;
  const resp2 = await fetchWithRetry(playerUrl, { headers: { referer: referer || playerOrigin } });
  const decrypted2 = decryptScript(resp2.data);
  const ajaxMatch = decrypted2.match(/\$.ajax\(([\s\S]*?)\);/i);
  if (!ajaxMatch) {
    const directVod = decrypted2.match(/(?:var|const|let)\s+(?:VID_URL|videoUrl|url)\s*=\s*["']([^"']+)["']/i);
    if (directVod) return directVod[1];
    const sourceMatch = decrypted2.match(/<source[^>]+src=["']([^"']+)["']/i);
    if (sourceMatch) return sourceMatch[1];
    throw new Error("AJAX não encontrado");
  }
  const urlMatch = ajaxMatch[1].match(/url:\s*['"]([^'"]+)['"]/);
  const tokenMatch = ajaxMatch[1].match(/'rctoken':'([^']+)'/);
  if (!urlMatch || !tokenMatch) throw new Error("Token não encontrado");
  const parsedUrl = new URL(urlMatch[1], playerUrl);
  const ajaxUrl = `${playerOrigin}${PLAYER_PATH}${parsedUrl.pathname}${parsedUrl.search}`;
  const resp3 = await fetchWithRetry(ajaxUrl, {
    method: "POST",
    headers: { referer: playerOrigin, "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "x-requested-with": "XMLHttpRequest", origin: playerOrigin },
    body: `rctoken=${encodeURIComponent(tokenMatch[1])}`,
  });
  const vodMatch = resp3.data.match(/(?:const|var|let)\s+VID_URL\s*=\s*["']([^"']+)["']/);
  if (!vodMatch) throw new Error("VID_URL não encontrado");
  const vodUrl = new URL(vodMatch[1], ajaxUrl).href;
  try {
    const resp4 = await scraper({ uri: vodUrl, method: "GET", followRedirect: false, resolveWithFullResponse: true, headers: { referer: playerOrigin }, simple: false });
    return resp4.headers.location || vodUrl;
  } catch (err) {
    if (err.response && err.response.headers && err.response.headers.location) return err.response.headers.location;
    return vodUrl;
  }
}

async function fetchSeriesEpisodes(pageUrl) {
  try {
    const fullUrl = pageUrl.startsWith("http") ? pageUrl : `${ACTIVE_DOMAIN}${pageUrl}`;
    const baseOrigin = new URL(fullUrl).origin;
    const resp = await fetchWithRetry(fullUrl, { headers: { referer: baseOrigin } });
    const decrypted = decryptScript(resp.data);
    const $ = cheerio.load(decrypted);
    let container = "";
    for (const sel of ["div.pm-category-description", 'div[itemprop="description"]']) {
      const html = $(sel).html();
      if (html && html.trim()) { container = html; break; }
    }
    if (!container) container = decrypted;
    const $c = cheerio.load(container);
    const episodes = [];
    $c("a[href]").each((_, el) => {
      const href = $c(el).attr("href");
      const text = $c(el).text().trim();
      if (href && text) {
        const audioMatch = href.toLowerCase().match(/-(dublado|dubaldo|duiblado|legendado|legendaod|nacional)/);
        episodes.push({ title: text, url: href, audio: audioMatch ? classifyAudio(audioMatch[1]) : "Desconhecido" });
      }
    });
    return episodes;
  } catch (err) {
    console.error(`[SERIES] Erro: ${err.message}`);
    return [];
  }
}

async function ensureCache() {
  if (Date.now() - lastCacheTime < CACHE_TTL && moviesCache.length > 0) return;
  console.log("[CACHE] Atualizando...");
  try { await findActiveDomain(); } catch (e) {}
  try { moviesCache = await fetchMovieList(); } catch (e) { console.error(`[CACHE] Filmes: ${e.message}`); }
  try { seriesCache = await fetchSeriesList(); } catch (e) { console.error(`[CACHE] Séries: ${e.message}`); }
  lastCacheTime = Date.now();
  console.log(`[CACHE] OK: ${moviesCache.length} filmes, ${seriesCache.length} séries`);
}

function searchByTitle(list, query) {
  const normalized = normalizeTitle(query);
  const words = normalized.split(/\s+/);
  return list.map((item) => {
    const itemWords = item.normalizedTitle.split(/\s+/);
    let matchCount = 0;
    for (const w of words) { if (itemWords.some((iw) => iw.includes(w) || w.includes(iw))) matchCount++; }
    const score = matchCount / Math.max(words.length, 1);
    if (item.normalizedTitle === normalized) return { ...item, score: 1.0 };
    if (item.normalizedTitle.includes(normalized)) return { ...item, score: 0.95 };
    return { ...item, score };
  }).filter((i) => i.score > 0.4).sort((a, b) => b.score - a.score);
}

const manifest = {
  id: "community.reflux.redecanais",
  version: "1.1.0",
  name: "Reflux - Rede Canais",
  description: "Addon para acessar catálogo de filmes e séries do Rede Canais. Fork corrigido com bypass Cloudflare.",
  logo: "https://raw.githubusercontent.com/Nightfruit/reflux/main/public/images/banner.png",
  resources: ["catalog", "stream", "meta"],
  types: ["movie", "series"],
  catalogs: [
    { type: "movie", id: "reflux-movies", name: "Reflux - Filmes", extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
    { type: "series", id: "reflux-series", name: "Reflux - Séries", extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
  ],
  idPrefixes: ["rc"],
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  await ensureCache();
  const skip = parseInt(extra.skip) || 0;
  let items = type === "movie" ? (extra.search ? searchByTitle(moviesCache, extra.search) : moviesCache) : (extra.search ? searchByTitle(seriesCache, extra.search) : seriesCache);
  const page = items.slice(skip, skip + 50);
  return { metas: page.map((item) => ({ id: `rc:${type}:${Buffer.from(item.url).toString("base64url")}`, type, name: item.title, poster: `https://via.placeholder.com/300x450/1a1a2e/e94560?text=${encodeURIComponent(item.title.substring(0, 20))}`, description: type === "movie" ? `${item.audio} - ${item.quality}` : "Série" })) };
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (!id.startsWith("rc:")) return { meta: null };
  const url = Buffer.from(id.split(":").slice(2).join(":"), "base64url").toString();
  await ensureCache();
  if (type === "movie") {
    const found = moviesCache.find((m) => m.url === url);
    if (!found) return { meta: null };
    return { meta: { id, type: "movie", name: found.title, description: `Áudio: ${found.audio} | Qualidade: ${found.quality}`, poster: `https://via.placeholder.com/300x450/1a1a2e/e94560?text=${encodeURIComponent(found.title.substring(0, 20))}` } };
  }
  if (type === "series") {
    const found = seriesCache.find((s) => s.url === url);
    if (!found) return { meta: null };
    const episodes = await fetchSeriesEpisodes(url);
    return { meta: { id, type: "series", name: found.title, description: `${episodes.length} episódios`, poster: `https://via.placeholder.com/300x450/1a1a2e/e94560?text=${encodeURIComponent(found.title.substring(0, 20))}`, videos: episodes.map((ep, idx) => ({ id: `rc:series:${Buffer.from(ep.url).toString("base64url")}:${idx}`, title: `${ep.title} (${ep.audio})`, season: 1, episode: idx + 1 })) } };
  }
  return { meta: null };
});

builder.defineStreamHandler(async ({ type, id }) => {
  if (!id.startsWith("rc:")) return { streams: [] };
  const url = Buffer.from(id.split(":")[2], "base64url").toString();
  await ensureCache();
  const cached = streamCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return { streams: [{ name: "Reflux", title: cached.title, url: PROXY_URL ? `${PROXY_URL}?url=${encodeURIComponent(cached.videoUrl)}` : cached.videoUrl }] };
  let streamTitle = "Stream";
  if (type === "movie") { const item = moviesCache.find((m) => m.url === url); if (item) streamTitle = `${item.audio} - ${item.quality}`; }
  const videoUrl = await resolveStream(url);
  if (!videoUrl) return { streams: [] };
  streamCache.set(url, { videoUrl, title: streamTitle, expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
  for (const [k, v] of streamCache.entries()) { if (v.expiresAt < Date.now()) streamCache.delete(k); }
  return { streams: [{ name: "Reflux", title: streamTitle, url: PROXY_URL ? `${PROXY_URL}?url=${encodeURIComponent(videoUrl)}` : videoUrl }] };
});

async function start() {
  console.log("=== REFLUX v1.1.0 (Cloudflare Bypass) ===");
  await findActiveDomain();
  await ensureCache();
  serveHTTP(builder.getInterface(), { port: PORT });
  console.log(`Servidor: http://localhost:${PORT}`);
  console.log(`Manifest: http://localhost:${PORT}/manifest.json`);
  console.log(`Catálogo: ${moviesCache.length} filmes, ${seriesCache.length} séries`);
  console.log(`Domínio: ${ACTIVE_DOMAIN}`);
}

start().catch((err) => { console.error("Erro fatal:", err); process.exit(1); });
