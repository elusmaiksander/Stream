const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");

// ============================================================
// CONFIGURAÇÃO
// ============================================================

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

// ============================================================
// ESTADO GLOBAL
// ============================================================

let ACTIVE_DOMAIN = DOMAINS[0];
let moviesCache = [];
let seriesCache = [];
let lastCacheTime = 0;
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 horas
const streamCache = new Map(); // url -> { videoUrl, expiresAt }

// ============================================================
// UTILITÁRIOS HTTP
// ============================================================

const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  "accept-encoding": "gzip, deflate, br",
  "cache-control": "no-cache",
  "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
};

function createClient(baseURL) {
  return axios.create({
    baseURL,
    timeout: 15000,
    headers: {
      ...BROWSER_HEADERS,
      referer: baseURL,
    },
  });
}

async function fetchWithRetry(url, options = {}, retries = 3) {
  const baseURL = new URL(url).origin;
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await axios({
        url,
        method: options.method || "GET",
        headers: {
          ...BROWSER_HEADERS,
          referer: baseURL,
          ...options.headers,
        },
        data: options.body,
        maxRedirects: options.followRedirects === false ? 0 : 5,
        validateStatus: (s) => s < 500,
        timeout: 15000,
      });
      return resp;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

// ============================================================
// DESCOBERTA DE DOMÍNIO ATIVO
// ============================================================

async function findActiveDomain() {
  for (const domain of DOMAINS) {
    try {
      const resp = await axios.get(domain, {
        timeout: 8000,
        maxRedirects: 3,
        validateStatus: (s) => s < 500,
        headers: {
          ...BROWSER_HEADERS,
          referer: domain,
        },
      });
      if (resp.status < 400) {
        console.log(`[DOMAIN] Domínio ativo: ${domain}`);
        ACTIVE_DOMAIN = domain;
        return domain;
      } else {
        console.log(`[DOMAIN] ${domain} - status ${resp.status}`);
      }
    } catch (e) {
      console.log(`[DOMAIN] ${domain} - falhou: ${e.message}`);
    }
  }
  console.log(`[DOMAIN] Nenhum domínio respondeu, usando: ${ACTIVE_DOMAIN}`);
  return ACTIVE_DOMAIN;
}

// ============================================================
// DESCRIPTOGRAFIA (do código original)
// ============================================================

function decryptScript(script) {
  const results = [];
  const content = String(script);
  const matches = content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi);

  for (const match of matches) {
    const formatted = formatDecrypt(match[1]);
    if (formatted) results.push(formatted);
  }

  return results.join("\n");
}

function formatDecrypt(content) {
  const arrayMatch = content.match(/(\w+)\s*=\s*\[(.*?)\]\s*;/s);
  const numberMatch = content.match(/(\d{7,})/);

  if (!arrayMatch || !numberMatch) return "";

  const [, , arrayValues] = arrayMatch;
  const dynamicNumber = parseInt(numberMatch[1], 10);
  const base64Strings = arrayValues
    .split(",")
    .map((s) => s.trim().replace(/['"]/g, ""));

  let decoded = "";

  for (const b64 of base64Strings) {
    try {
      const raw = Buffer.from(b64, "base64").toString("binary");
      const numbersOnly = raw.replace(/\D/g, "");
      const charCode = parseInt(numbersOnly, 10) - dynamicNumber;
      decoded += String.fromCharCode(charCode);
    } catch {}
  }

  try {
    return Buffer.from(decoded, "latin1").toString("utf8");
  } catch {
    return "";
  }
}

// ============================================================
// PARSING DO MAPA DE FILMES
// ============================================================

const RAW_REGEX = /(.*)<a\s*href=".*"\s*target=".*">/g;
const TITLE_REGEX_1 = /^(.+?)(?:\s*\([^)]*\))(?=\s+-\s*|$)/;
const TITLE_REGEX_2 = /^(.+?)(?:\s*\([^)]*\))?(?=\s+-\s*|$)/;
const URL_REGEX = /.*<a\s*href="(.*)"\s*target=".*">/;

const AUDIO_REGEX =
  /\s\((Dublado|Dubaldo|Duiblado|Legendado|Legendaod|Nacional|Dublado\s\/\sLegendado|Mudo|Original)\)\s[-]?/;
const AUDIO_URL_REGEX =
  /.*<a\s*href=".*-(dublado|dubaldo|duiblado|legendado|legendaod|nacional)(?:-)?.*"\s*target=".*">/;
const QUALITY_REGEX =
  /[-]?\s(180p|480p|720p|7200p|1008p|1080p|2160p\s\(4K\))\s[-]?/;
const QUALITY_URL_REGEX =
  /.*<a\s*href=".*-(180p|480p|720p|7200p|1008p|1080p|2160p-4k)(?:-)?.*"\s*target=".*">/;

function matchRegex(content, regex) {
  if (!content) return null;
  const m = content.match(regex);
  return m ? m[1] : null;
}

function classifyAudio(raw) {
  if (!raw) return "Desconhecido";
  const lower = raw.toLowerCase();
  if (/dublado|dubaldo|duiblado/.test(lower)) return "Dublado";
  if (/legendado|legendaod/.test(lower)) return "Legendado";
  if (/nacional/.test(lower)) return "Nacional";
  if (/mudo/.test(lower)) return "Mudo";
  if (/original/.test(lower)) return "Original";
  return "Desconhecido";
}

function classifyQuality(raw) {
  if (!raw) return "Desconhecido";
  if (/480p/.test(raw)) return "SD";
  if (/720p|7200p/.test(raw)) return "HD";
  if (/180p|1008p|1080p/.test(raw)) return "Full HD";
  if (/2160p|4k/i.test(raw)) return "4K";
  return "Desconhecido";
}

function normalizeTitle(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function fetchMovieList() {
  console.log("[SCRAPE] Buscando lista de filmes...");
  const client = createClient(ACTIVE_DOMAIN);
  const { data } = await client.get(MOVIES_PATH);
  const rawMatches = data.match(RAW_REGEX) || [];
  console.log(`[SCRAPE] ${rawMatches.length} entradas encontradas no mapa de filmes`);

  const movies = [];
  for (const raw of rawMatches) {
    const url = matchRegex(raw, URL_REGEX);
    const title = matchRegex(raw, TITLE_REGEX_1) || matchRegex(raw, TITLE_REGEX_2);
    const audioRaw = matchRegex(raw, AUDIO_REGEX) || matchRegex(raw, AUDIO_URL_REGEX);
    const qualityRaw = matchRegex(raw, QUALITY_REGEX) || matchRegex(raw, QUALITY_URL_REGEX);

    if (url && title) {
      movies.push({
        url,
        title: title.trim(),
        audio: classifyAudio(audioRaw),
        quality: classifyQuality(qualityRaw),
        normalizedTitle: normalizeTitle(title),
      });
    }
  }

  console.log(`[SCRAPE] ${movies.length} filmes parseados com sucesso`);
  return movies;
}

async function fetchSeriesList() {
  console.log("[SCRAPE] Buscando lista de séries...");
  const client = createClient(ACTIVE_DOMAIN);
  const { data } = await client.get(SERIES_PATH);
  const rawMatches = data.match(RAW_REGEX) || [];
  console.log(`[SCRAPE] ${rawMatches.length} entradas encontradas no mapa de séries`);

  const series = [];
  for (const raw of rawMatches) {
    const url = matchRegex(raw, URL_REGEX);
    const title = matchRegex(raw, TITLE_REGEX_1) || matchRegex(raw, TITLE_REGEX_2);

    if (url && title) {
      series.push({
        url,
        title: title.trim(),
        normalizedTitle: normalizeTitle(title),
      });
    }
  }

  console.log(`[SCRAPE] ${series.length} séries parseadas com sucesso`);
  return series;
}

// ============================================================
// RESOLUÇÃO DE STREAM (do código original movie-series.service.ts)
// ============================================================

async function resolveStream(pageUrl) {
  try {
    console.log(`[STREAM] Resolvendo: ${pageUrl}`);

    // Passo 1: Buscar a página e descriptografar para encontrar iframe do player
    const fullUrl = pageUrl.startsWith("http") ? pageUrl : `${ACTIVE_DOMAIN}${pageUrl}`;
    const baseOrigin = new URL(fullUrl).origin;

    const resp1 = await fetchWithRetry(fullUrl, {
      headers: { referer: baseOrigin },
    });

    const decrypted1 = decryptScript(resp1.data);
    const iframeMatch = decrypted1.match(/<iframe\s+[^>]*src=["']([^"']*?)["']/i);

    if (!iframeMatch) {
      console.log("[STREAM] Iframe não encontrado, tentando src direto...");
      // Tentar encontrar player URL diretamente
      const srcMatch = resp1.data.match(/src=["'](\/player[^"']*?)["']/i);
      if (!srcMatch) {
        throw new Error("Player iframe não encontrado");
      }
      return await resolveFromPlayer(`${baseOrigin}${srcMatch[1]}`, baseOrigin);
    }

    let playerUrl = iframeMatch[1];
    // Resolve URL relativa
    if (playerUrl.startsWith("/")) {
      playerUrl = `${baseOrigin}${playerUrl}`;
    } else if (!playerUrl.startsWith("http")) {
      playerUrl = new URL(playerUrl, baseOrigin).href;
    }

    console.log(`[STREAM] Player URL: ${playerUrl}`);
    return await resolveFromPlayer(playerUrl, baseOrigin);
  } catch (err) {
    console.error(`[STREAM] Erro: ${err.message}`);
    return null;
  }
}

async function resolveFromPlayer(playerUrl, referer) {
  // Passo 2: Buscar dados do player (AJAX url + token)
  const playerOrigin = new URL(playerUrl).origin;

  const resp2 = await fetchWithRetry(playerUrl, {
    headers: { referer: referer || playerOrigin },
  });

  const decrypted2 = decryptScript(resp2.data);
  const ajaxMatch = decrypted2.match(/\$.ajax\(([\s\S]*?)\);/i);

  if (!ajaxMatch) {
    // Fallback: tentar encontrar video URL diretamente no conteúdo
    const directVod = decrypted2.match(/(?:var|const|let)\s+(?:VID_URL|videoUrl|url)\s*=\s*["']([^"']+)["']/i);
    if (directVod) {
      console.log(`[STREAM] URL de vídeo direta encontrada`);
      return directVod[1];
    }

    // Tentar encontrar fonte de vídeo em tags source/video
    const sourceMatch = decrypted2.match(/<source[^>]+src=["']([^"']+)["']/i);
    if (sourceMatch) {
      return sourceMatch[1];
    }

    throw new Error("Padrão AJAX não encontrado no player");
  }

  const urlMatch = ajaxMatch[1].match(/url:\s*['"]([^'"]+)['"]/);
  const tokenMatch = ajaxMatch[1].match(/'rctoken':'([^']+)'/);

  if (!urlMatch || !tokenMatch) {
    throw new Error("URL ou token não encontrado no AJAX");
  }

  const parsedUrl = new URL(urlMatch[1], playerUrl);
  const ajaxUrl = `${playerOrigin}${PLAYER_PATH}${parsedUrl.pathname}${parsedUrl.search}`;
  const token = tokenMatch[1];

  console.log(`[STREAM] AJAX URL: ${ajaxUrl}`);

  // Passo 3: POST para obter VID_URL
  const resp3 = await fetchWithRetry(ajaxUrl, {
    method: "POST",
    headers: {
      referer: playerOrigin,
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
      origin: playerOrigin,
    },
    body: `rctoken=${encodeURIComponent(token)}`,
  });

  const vodMatch = resp3.data.match(
    /(?:const|var|let)\s+VID_URL\s*=\s*["']([^"']+)["']/
  );

  if (!vodMatch) {
    throw new Error("VID_URL não encontrado na resposta");
  }

  const vodUrl = new URL(vodMatch[1], ajaxUrl).href;
  console.log(`[STREAM] VOD URL: ${vodUrl}`);

  // Passo 4: Seguir redirect para URL final do vídeo
  try {
    const resp4 = await axios({
      url: vodUrl,
      method: "GET",
      maxRedirects: 0,
      validateStatus: (s) => s >= 200 && s < 400,
      headers: {
        ...BROWSER_HEADERS,
        referer: playerOrigin,
      },
    });

    const videoUrl = resp4.headers.location || resp4.request?.res?.responseUrl || vodUrl;
    console.log(`[STREAM] Video URL final resolvida`);
    return videoUrl;
  } catch (err) {
    if (err.response && err.response.headers.location) {
      return err.response.headers.location;
    }
    // Se não redireciona, a própria VOD URL pode ser o stream
    return vodUrl;
  }
}

// ============================================================
// PARSING DE TEMPORADAS/EPISÓDIOS DE SÉRIES
// ============================================================

const SEASON_SELECTORS = [
  "div.pm-category-description",
  'div[itemprop="description"]',
];

async function fetchSeriesEpisodes(pageUrl) {
  try {
    const fullUrl = pageUrl.startsWith("http") ? pageUrl : `${ACTIVE_DOMAIN}${pageUrl}`;
    const baseOrigin = new URL(fullUrl).origin;

    const resp = await fetchWithRetry(fullUrl, {
      headers: { referer: baseOrigin },
    });

    const decrypted = decryptScript(resp.data);
    const $ = cheerio.load(decrypted);

    // Encontrar container de episódios
    let container = "";
    for (const sel of SEASON_SELECTORS) {
      const html = $(sel).html();
      if (html && html.trim()) {
        container = html;
        break;
      }
    }

    if (!container) {
      // Fallback: tentar usar o HTML decriptado inteiro
      container = decrypted;
    }

    const $c = cheerio.load(container);
    const episodes = [];

    // Encontrar links com episódios
    $c("a[href]").each((_, el) => {
      const href = $c(el).attr("href");
      const text = $c(el).text().trim();
      if (href && text) {
        const audioMatch = href
          .toLowerCase()
          .match(/-(dublado|dubaldo|duiblado|legendado|legendaod|nacional)/);
        let audio = "Desconhecido";
        if (audioMatch) audio = classifyAudio(audioMatch[1]);

        episodes.push({
          title: text,
          url: href,
          audio,
        });
      }
    });

    return episodes;
  } catch (err) {
    console.error(`[SERIES] Erro ao buscar episódios: ${err.message}`);
    return [];
  }
}

// ============================================================
// CACHE DE CATÁLOGO
// ============================================================

async function ensureCache() {
  const now = Date.now();
  if (now - lastCacheTime < CACHE_TTL && moviesCache.length > 0) {
    return;
  }

  console.log("[CACHE] Atualizando cache do catálogo...");

  try {
    await findActiveDomain();
  } catch (e) {
    console.error("[CACHE] Falha ao encontrar domínio ativo");
  }

  try {
    moviesCache = await fetchMovieList();
  } catch (e) {
    console.error(`[CACHE] Erro ao buscar filmes: ${e.message}`);
    if (moviesCache.length === 0) moviesCache = [];
  }

  try {
    seriesCache = await fetchSeriesList();
  } catch (e) {
    console.error(`[CACHE] Erro ao buscar séries: ${e.message}`);
    if (seriesCache.length === 0) seriesCache = [];
  }

  lastCacheTime = now;
  console.log(
    `[CACHE] Cache atualizado: ${moviesCache.length} filmes, ${seriesCache.length} séries`
  );
}

// ============================================================
// BUSCA POR TÍTULO (matching fuzzy simples)
// ============================================================

function searchByTitle(list, query) {
  const normalized = normalizeTitle(query);
  const words = normalized.split(/\s+/);

  return list
    .map((item) => {
      const itemWords = item.normalizedTitle.split(/\s+/);
      let matchCount = 0;
      for (const w of words) {
        if (itemWords.some((iw) => iw.includes(w) || w.includes(iw))) {
          matchCount++;
        }
      }
      const score = matchCount / Math.max(words.length, 1);

      // Bonus para match exato
      if (item.normalizedTitle === normalized) return { ...item, score: 1.0 };
      if (item.normalizedTitle.includes(normalized)) return { ...item, score: 0.95 };

      return { ...item, score };
    })
    .filter((item) => item.score > 0.4)
    .sort((a, b) => b.score - a.score);
}

// ============================================================
// ADDON STREMIO
// ============================================================

const manifest = {
  id: "community.reflux.redecanais",
  version: "1.0.0",
  name: "Reflux - Rede Canais",
  description:
    "Addon para acessar catálogo de filmes e séries do Rede Canais. Fork corrigido e funcional.",
  logo: "https://raw.githubusercontent.com/Nightfruit/reflux/main/public/images/banner.png",
  resources: ["catalog", "stream", "meta"],
  types: ["movie", "series"],
  catalogs: [
    {
      type: "movie",
      id: "reflux-movies",
      name: "Reflux - Filmes",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "series",
      id: "reflux-series",
      name: "Reflux - Séries",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
  ],
  idPrefixes: ["rc"],
};

const builder = new addonBuilder(manifest);

// ============================================================
// HANDLER: CATALOG
// ============================================================

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  await ensureCache();

  const skip = parseInt(extra.skip) || 0;
  const limit = 50;

  let items = [];

  if (type === "movie") {
    items = extra.search
      ? searchByTitle(moviesCache, extra.search)
      : moviesCache;
  } else if (type === "series") {
    items = extra.search
      ? searchByTitle(seriesCache, extra.search)
      : seriesCache;
  }

  const page = items.slice(skip, skip + limit);

  const metas = page.map((item, idx) => ({
    id: `rc:${type}:${Buffer.from(item.url).toString("base64url")}`,
    type,
    name: item.title,
    poster: `https://via.placeholder.com/300x450/1a1a2e/e94560?text=${encodeURIComponent(item.title.substring(0, 20))}`,
    description:
      type === "movie"
        ? `${item.audio} - ${item.quality}`
        : "Série disponível no Rede Canais",
  }));

  return { metas };
});

// ============================================================
// HANDLER: META
// ============================================================

builder.defineMetaHandler(async ({ type, id }) => {
  if (!id.startsWith("rc:")) return { meta: null };

  const parts = id.split(":");
  const urlB64 = parts.slice(2).join(":");
  const url = Buffer.from(urlB64, "base64url").toString();

  await ensureCache();

  if (type === "movie") {
    const found = moviesCache.find((m) => m.url === url);
    if (!found) return { meta: null };

    return {
      meta: {
        id,
        type: "movie",
        name: found.title,
        description: `Áudio: ${found.audio} | Qualidade: ${found.quality}\n\nDisponível no Rede Canais via Reflux.`,
        poster: `https://via.placeholder.com/300x450/1a1a2e/e94560?text=${encodeURIComponent(found.title.substring(0, 20))}`,
      },
    };
  }

  if (type === "series") {
    const found = seriesCache.find((s) => s.url === url);
    if (!found) return { meta: null };

    // Buscar episódios da série
    const episodes = await fetchSeriesEpisodes(url);

    const videos = episodes.map((ep, idx) => ({
      id: `rc:series:${Buffer.from(ep.url).toString("base64url")}:${idx}`,
      title: `${ep.title} (${ep.audio})`,
      season: 1,
      episode: idx + 1,
    }));

    return {
      meta: {
        id,
        type: "series",
        name: found.title,
        description: `${episodes.length} episódios encontrados.\n\nDisponível no Rede Canais via Reflux.`,
        poster: `https://via.placeholder.com/300x450/1a1a2e/e94560?text=${encodeURIComponent(found.title.substring(0, 20))}`,
        videos: videos.length > 0 ? videos : undefined,
      },
    };
  }

  return { meta: null };
});

// ============================================================
// HANDLER: STREAM
// ============================================================

builder.defineStreamHandler(async ({ type, id }) => {
  if (!id.startsWith("rc:")) return { streams: [] };

  const parts = id.split(":");
  const urlB64 = parts[2];
  const url = Buffer.from(urlB64, "base64url").toString();

  await ensureCache();

  // Verificar cache de stream
  const cached = streamCache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`[STREAM] Cache hit para: ${url}`);
    return {
      streams: [
        {
          name: "Reflux",
          title: cached.title || "Stream",
          url: PROXY_URL
            ? `${PROXY_URL}?url=${encodeURIComponent(cached.videoUrl)}`
            : cached.videoUrl,
        },
      ],
    };
  }

  // Encontrar o item no cache
  let item = null;
  let streamTitle = "Stream";

  if (type === "movie") {
    item = moviesCache.find((m) => m.url === url);
    if (item) streamTitle = `${item.audio} - ${item.quality}`;
  } else {
    // Para séries, a URL do episódio vem diretamente
    streamTitle = "Episódio";
  }

  // Resolver stream
  const videoUrl = await resolveStream(url);

  if (!videoUrl) {
    return { streams: [] };
  }

  // Salvar no cache (12h)
  streamCache.set(url, {
    videoUrl,
    title: streamTitle,
    expiresAt: Date.now() + 12 * 60 * 60 * 1000,
  });

  // Limpar cache antigo
  for (const [key, val] of streamCache.entries()) {
    if (val.expiresAt < Date.now()) streamCache.delete(key);
  }

  return {
    streams: [
      {
        name: "Reflux",
        title: streamTitle,
        url: PROXY_URL
          ? `${PROXY_URL}?url=${encodeURIComponent(videoUrl)}`
          : videoUrl,
      },
    ],
  };
});

// ============================================================
// INICIAR SERVIDOR
// ============================================================

async function start() {
  console.log("===========================================");
  console.log("  REFLUX - Addon para Stremio (Rede Canais)");
  console.log("===========================================");

  // Encontrar domínio ativo
  await findActiveDomain();

  // Pre-carregar cache
  await ensureCache();

  // Iniciar servidor
  serveHTTP(builder.getInterface(), { port: PORT });

  console.log();
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Manifest: http://localhost:${PORT}/manifest.json`);
  console.log(
    `Instalar no Stremio: stremio://localhost:${PORT}/manifest.json`
  );
  console.log();
  console.log(
    `Catálogo: ${moviesCache.length} filmes, ${seriesCache.length} séries`
  );
  console.log(`Domínio ativo: ${ACTIVE_DOMAIN}`);
  if (PROXY_URL) console.log(`Proxy: ${PROXY_URL}`);
  console.log();
}

start().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
