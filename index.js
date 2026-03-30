const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const PORT = process.env.PORT || 3000;
const IPTV_URL = process.env.IPTV_URL || "http://fibercdn.sbs/get.php?username=1093969013&password=dembl88n&type=m3u_plus&output=m3u8";
// TMDB v3 api_key (grátis, não expira como o bearer token)
const TMDB_KEY = process.env.TMDB_KEY || "520255d4587b964b2b3a4b5996a7e288";
const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";

// ============================================================
// HTTP
// ============================================================

const api = axios.create({ timeout: 10000 });

async function tmdbGet(path, params = {}) {
  const { data } = await api.get(TMDB + path, { params: { api_key: TMDB_KEY, language: "pt-BR", ...params } });
  return data;
}

async function httpGet(url, headers = {}) {
  const { data } = await api.get(url, {
    timeout: 12000,
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", referer: new URL(url).origin, ...headers },
  });
  return data;
}

// ============================================================
// IPTV
// ============================================================

let iptv = [], iptvGroups = [], iptvTime = 0;

async function loadIPTV() {
  if (Date.now() - iptvTime < 3600000 && iptv.length > 0) return;
  try {
    console.log("[IPTV] Baixando playlist...");
    const { data } = await api.get(IPTV_URL, { timeout: 60000, headers: { "user-agent": "IPTV Smarters/1.0" }, maxContentLength: 100 * 1024 * 1024 });
    const lines = data.split("\n"), out = [];
    let c = null;
    for (const l of lines) {
      const t = l.trim();
      if (t.startsWith("#EXTINF:")) {
        const n = t.match(/,(.+)$/), lg = t.match(/tvg-logo="([^"]*)"/), g = t.match(/group-title="([^"]*)"/);
        c = { name: n?.[1]?.trim() || "Canal", logo: lg?.[1] || null, group: g?.[1] || "Outros" };
      } else if (t && !t.startsWith("#") && c) {
        c.url = t;
        c.id = "iptv:" + Buffer.from(c.name + "|" + c.group).toString("base64url").substring(0, 50);
        const gl = c.group.toLowerCase();
        c.type = (gl.includes("filme") || gl.includes("movie") || gl.includes("cinema") || gl.includes("telecine") || gl.includes("megapix")) ? "movie"
          : (gl.includes("serie") || gl.includes("series")) ? "series" : "tv";
        out.push(c);
        c = null;
      }
    }
    iptv = out;
    iptvGroups = [...new Set(out.map(c => c.group))].sort();
    iptvTime = Date.now();
    console.log(`[IPTV] ${out.length} canais | ${iptvGroups.length} grupos | Filmes:${out.filter(x=>x.type==="movie").length} Séries:${out.filter(x=>x.type==="series").length} TV:${out.filter(x=>x.type==="tv").length}`);
  } catch (e) {
    console.error("[IPTV] " + e.message);
  }
}

function searchIPTV(q) {
  const n = q.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return iptv.filter(c => {
    const cn = c.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return cn.includes(n) || c.group.toLowerCase().includes(n);
  });
}

// ============================================================
// TMDB
// ============================================================

async function tmdbCatalog(type, mode, page, search) {
  try {
    const mt = type === "movie" ? "movie" : "tv";
    let data;
    if (search) {
      data = await tmdbGet(`/search/${mt}`, { query: search });
    } else if (mode === "trending") {
      data = await tmdbGet(`/trending/${mt}/week`);
    } else if (mode === "top") {
      data = await tmdbGet(`/${mt}/top_rated`, { page });
    } else {
      data = await tmdbGet(`/${mt}/popular`, { page, region: "BR" });
    }
    return (data.results || []).map(i => ({
      id: "tmdb:" + i.id, type,
      name: i.title || i.name || "",
      poster: i.poster_path ? IMG + "/w500" + i.poster_path : null,
      description: i.overview || "",
      releaseInfo: (i.release_date || i.first_air_date || "").substring(0, 4),
      imdbRating: i.vote_average ? i.vote_average.toFixed(1) : undefined,
    }));
  } catch (e) {
    console.error("[TMDB] " + e.message);
    return [];
  }
}

async function tmdbMeta(type, tmdbId) {
  try {
    const mt = type === "movie" ? "movie" : "tv";
    const d = await tmdbGet(`/${mt}/${tmdbId}`, { append_to_response: "external_ids,credits" });
    const meta = {
      id: "tmdb:" + tmdbId, type,
      name: d.title || d.name, poster: d.poster_path ? IMG + "/w500" + d.poster_path : null,
      background: d.backdrop_path ? IMG + "/original" + d.backdrop_path : null,
      description: d.overview || "",
      releaseInfo: (d.release_date || d.first_air_date || "").substring(0, 4),
      imdbRating: d.vote_average ? d.vote_average.toFixed(1) : undefined,
      genres: d.genres?.map(g => g.name) || [],
      runtime: d.runtime ? d.runtime + " min" : undefined,
      cast: d.credits?.cast?.slice(0, 5).map(c => c.name),
    };
    if (type === "series" && d.seasons) {
      meta.videos = [];
      for (const s of d.seasons) {
        if (s.season_number === 0) continue;
        try {
          const sd = await tmdbGet(`/tv/${tmdbId}/season/${s.season_number}`);
          for (const ep of (sd.episodes || [])) {
            meta.videos.push({
              id: `tmdb:${tmdbId}:${s.season_number}:${ep.episode_number}`,
              title: ep.name || `Episódio ${ep.episode_number}`,
              season: s.season_number, episode: ep.episode_number,
              thumbnail: ep.still_path ? IMG + "/w300" + ep.still_path : undefined,
              released: ep.air_date ? new Date(ep.air_date).toISOString() : undefined,
            });
          }
        } catch (e) {}
      }
    }
    return meta;
  } catch (e) {
    console.error("[TMDB] meta: " + e.message);
    return null;
  }
}

// ============================================================
// STREAM PROVIDERS - Extração de URL direta para o player
// ============================================================

async function extractURL(embedUrl) {
  try {
    const html = await httpGet(embedUrl);
    // HLS
    let m = html.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
    if (m) return m[1];
    // MP4
    m = html.match(/(https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*)/i);
    if (m) return m[1];
    // JS vars
    m = html.match(/(?:file|source|src|url|video|stream)["']?\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i);
    if (m) return m[1];
    return null;
  } catch { return null; }
}

async function getStreams(type, tmdbId, imdbId, season, episode) {
  const id = imdbId || tmdbId;
  const embeds = [
    { n: "VidSrc", u: type === "movie" ? `https://vidsrc.xyz/embed/movie/${tmdbId}` : `https://vidsrc.xyz/embed/tv/${tmdbId}/${season}/${episode}` },
    { n: "VidSrc.to", u: type === "movie" ? `https://vidsrc.to/embed/movie/${id}` : `https://vidsrc.to/embed/tv/${id}/${season}/${episode}` },
    { n: "Embed.su", u: type === "movie" ? `https://embed.su/embed/movie/${tmdbId}` : `https://embed.su/embed/tv/${tmdbId}/${season}/${episode}` },
    { n: "AutoEmbed", u: type === "movie" ? `https://player.autoembed.cc/embed/movie/${id}` : `https://player.autoembed.cc/embed/tv/${id}/${season}/${episode}` },
    { n: "2Embed", u: type === "movie" ? `https://www.2embed.cc/embed/${id}` : `https://www.2embed.cc/embedtv/${id}&s=${season}&e=${episode}` },
    { n: "MultiEmbed", u: type === "movie" ? `https://multiembed.mov/?video_id=${id}&tmdb=1` : `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${season}&e=${episode}` },
    { n: "NontonGo", u: type === "movie" ? `https://www.NontonGo.win/embed/movie/${tmdbId}` : `https://www.NontonGo.win/embed/tv/${tmdbId}/${season}/${episode}` },
  ];

  const results = await Promise.allSettled(
    embeds.map(e => Promise.race([
      extractURL(e.u).then(url => ({ name: e.n, embedUrl: e.u, directUrl: url })),
      new Promise((_, r) => setTimeout(() => r("timeout"), 8000)),
    ]))
  );

  const streams = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const { name, embedUrl, directUrl } = r.value;
    if (directUrl) {
      // URL direta → roda no player do Stremio
      streams.push({ name: "Reflux", title: `▶ ${name}`, url: directUrl });
    } else {
      // Fallback → abre no navegador
      streams.push({ name: "Reflux", title: `🌐 ${name} (navegador)`, externalUrl: embedUrl });
    }
  }

  // Também buscar na playlist IPTV por nome do filme/série
  if (type === "movie" || type === "series") {
    try {
      const details = await tmdbGet(`/${type === "movie" ? "movie" : "tv"}/${tmdbId}`);
      const title = (details.title || details.name || "").toLowerCase();
      if (title.length > 3) {
        const iptvMatches = iptv.filter(c => c.name.toLowerCase().includes(title));
        for (const ch of iptvMatches.slice(0, 3)) {
          streams.push({ name: "Reflux IPTV", title: `📺 ${ch.name} (${ch.group})`, url: ch.url });
        }
      }
    } catch {}
  }

  console.log(`[STREAM] ${streams.length} fontes encontradas`);
  return streams;
}

// ============================================================
// STREMIO ADDON
// ============================================================

const manifest = {
  id: "community.reflux.v5",
  version: "5.0.0",
  name: "Reflux BR",
  description: "Filmes, séries e TV ao vivo. TMDB + IPTV + 7 provedores de stream no player.",
  logo: "https://raw.githubusercontent.com/Nightfruit/reflux/main/public/images/banner.png",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series", "tv"],
  idPrefixes: ["tmdb:", "iptv:"],
  catalogs: [
    { type: "movie", id: "reflux-trending-m", name: "🔥 Em Alta", extra: [{ name: "skip" }] },
    { type: "movie", id: "reflux-popular-m", name: "🎬 Populares", extra: [{ name: "search" }, { name: "skip" }] },
    { type: "movie", id: "reflux-top-m", name: "⭐ Mais Avaliados", extra: [{ name: "skip" }] },
    { type: "series", id: "reflux-trending-s", name: "🔥 Em Alta", extra: [{ name: "skip" }] },
    { type: "series", id: "reflux-popular-s", name: "📺 Populares", extra: [{ name: "search" }, { name: "skip" }] },
    { type: "series", id: "reflux-top-s", name: "⭐ Mais Avaliados", extra: [{ name: "skip" }] },
    { type: "tv", id: "reflux-iptv-tv", name: "📡 TV ao Vivo", extra: [{ name: "search" }] },
    { type: "movie", id: "reflux-iptv-filmes", name: "🎥 IPTV Filmes", extra: [{ name: "search" }] },
    { type: "series", id: "reflux-iptv-series", name: "📺 IPTV Séries", extra: [{ name: "search" }] },
  ],
};

const builder = new addonBuilder(manifest);

// CATALOG
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  console.log(`[CAT] ${type}/${id} q=${extra.search||""}`);
  const page = Math.floor((parseInt(extra.skip) || 0) / 20) + 1;

  // IPTV catalogs
  if (id.startsWith("reflux-iptv")) {
    await loadIPTV();
    let list = iptv;
    if (id === "reflux-iptv-tv") list = iptv.filter(c => c.type === "tv");
    else if (id === "reflux-iptv-filmes") list = iptv.filter(c => c.type === "movie");
    else if (id === "reflux-iptv-series") list = iptv.filter(c => c.type === "series");
    if (extra.search) list = searchIPTV(extra.search);
    const skip = parseInt(extra.skip) || 0;
    return { metas: list.slice(skip, skip + 100).map(c => ({ id: c.id, type: c.type, name: c.name, poster: c.logo, posterShape: c.type === "tv" ? "square" : "poster", description: c.group })) };
  }

  // TMDB catalogs
  let mode = "popular";
  if (id.includes("trending")) mode = "trending";
  else if (id.includes("top")) mode = "top";
  return { metas: await tmdbCatalog(type, mode, page, extra.search) };
});

// META
builder.defineMetaHandler(async ({ type, id }) => {
  console.log(`[META] ${id}`);
  if (id.startsWith("iptv:")) {
    await loadIPTV();
    const ch = iptv.find(c => c.id === id);
    if (!ch) return { meta: null };
    return { meta: { id: ch.id, type: ch.type, name: ch.name, poster: ch.logo, posterShape: "square", description: `Canal: ${ch.name}\nGrupo: ${ch.group}` } };
  }
  const tid = id.replace("tmdb:", "");
  const meta = await tmdbMeta(type, parseInt(tid));
  return { meta: meta || null };
});

// STREAM
builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[STREAM] ${type} ${id}`);
  // IPTV
  if (id.startsWith("iptv:")) {
    await loadIPTV();
    const ch = iptv.find(c => c.id === id);
    if (!ch) return { streams: [] };
    return { streams: [{ name: "Reflux", title: `▶ ${ch.name}`, url: ch.url }] };
  }
  // TMDB content
  const parts = id.replace("tmdb:", "").split(":");
  const tmdbId = parts[0], season = parts[1] || null, episode = parts[2] || null;
  let imdbId = null;
  try {
    const mt = type === "movie" ? "movie" : "tv";
    const d = await tmdbGet(`/${mt}/${tmdbId}`, { append_to_response: "external_ids" });
    imdbId = d.external_ids?.imdb_id || null;
  } catch {}
  await loadIPTV();
  return { streams: await getStreams(type, tmdbId, imdbId, season, episode) };
});

// START
async function start() {
  console.log("========================================");
  console.log("  REFLUX BR v5.0 - TMDB + IPTV + Embed");
  console.log("========================================");

  // Test TMDB
  try {
    const d = await tmdbGet("/movie/popular", { page: 1 });
    console.log(`[TMDB] ✅ ${d.results?.length || 0} filmes populares`);
  } catch (e) { console.error("[TMDB] ❌ " + e.message); }

  // Load IPTV
  await loadIPTV();

  serveHTTP(builder.getInterface(), { port: PORT });
  console.log(`\n🚀 Porta ${PORT} | ${iptv.length} canais IPTV`);
  console.log(`📋 http://localhost:${PORT}/manifest.json\n`);
}

start().catch(e => { console.error(e); process.exit(1); });
