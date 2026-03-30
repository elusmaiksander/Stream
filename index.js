const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const PORT = process.env.PORT || 3000;
const TMDB_KEY = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI1MjAyNTVkNDU4N2I5NjRiMmIzYTRiNTk5NmE3ZTI4OCIsIm5iZiI6MTczNDU0NjY2MC4wMzQsInN1YiI6IjY3NjI2ZTg0MTcwMTdmNDkzMDExOGVlMCIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.NptT5FTIfnZBLx89hvNJJiSaOEVyULTLfCxXsF9W3fE";
const TMDB_API = "https://api.themoviedb.org/3";
const TMDB_IMG = "https://image.tmdb.org/t/p";
const IPTV_URL = "http://fibercdn.sbs/get.php?username=1093969013&password=dembl88n&type=m3u_plus&output=m3u8";

const tmdb = axios.create({ baseURL: TMDB_API, timeout: 10000, headers: { authorization: `Bearer ${TMDB_KEY}` }, params: { language: "pt-BR" } });
const http = axios.create({ timeout: 15000, headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" } });

let iptvChannels = [];
let iptvLastFetch = 0;

async function loadIPTV() {
  if (Date.now() - iptvLastFetch < 43200000 && iptvChannels.length > 0) return iptvChannels;
  try {
    console.log("[IPTV] Carregando playlist...");
    const { data } = await http.get(IPTV_URL, { timeout: 30000 });
    const lines = data.split("\n");
    const channels = [];
    let cur = null;
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith("#EXTINF:")) {
        const nm = t.match(/,(.+)$/);
        const lg = t.match(/tvg-logo="([^"]*)"/);
        const gr = t.match(/group-title="([^"]*)"/);
        cur = { name: nm ? nm[1].trim() : "Canal", logo: lg ? lg[1] : null, group: gr ? gr[1] : "Outros" };
      } else if (t && !t.startsWith("#") && cur) {
        cur.url = t;
        cur.id = "iptv:" + Buffer.from(cur.name + cur.url).toString("base64url").substring(0, 40);
        channels.push(cur);
        cur = null;
      }
    }
    iptvChannels = channels;
    iptvLastFetch = Date.now();
    console.log("[IPTV] " + channels.length + " canais carregados");
    return channels;
  } catch (e) {
    console.error("[IPTV] Erro: " + e.message);
    return iptvChannels;
  }
}

async function tmdbPopular(type, page) {
  try {
    const { data } = await tmdb.get("/" + (type === "movie" ? "movie" : "tv") + "/popular", { params: { page: page || 1, region: "BR" } });
    return data.results.map(i => fmtMeta(i, type));
  } catch (e) { console.error("[TMDB] " + e.message); return []; }
}

async function tmdbTrending(type) {
  try {
    const { data } = await tmdb.get("/trending/" + (type === "movie" ? "movie" : "tv") + "/week");
    return data.results.map(i => fmtMeta(i, type));
  } catch (e) { return []; }
}

async function tmdbSearch(type, query) {
  try {
    const { data } = await tmdb.get("/search/" + (type === "movie" ? "movie" : "tv"), { params: { query } });
    return data.results.map(i => fmtMeta(i, type));
  } catch (e) { return []; }
}

async function tmdbDetails(type, id) {
  try {
    const { data } = await tmdb.get("/" + (type === "movie" ? "movie" : "tv") + "/" + id, { params: { append_to_response: "external_ids,credits" } });
    return data;
  } catch (e) { return null; }
}

async function tmdbSeason(id, s) {
  try { const { data } = await tmdb.get("/tv/" + id + "/season/" + s); return data; } catch (e) { return null; }
}

function fmtMeta(i, type) {
  return {
    id: "tmdb:" + i.id, type,
    name: i.title || i.name || "",
    poster: i.poster_path ? TMDB_IMG + "/w500" + i.poster_path : null,
    background: i.backdrop_path ? TMDB_IMG + "/original" + i.backdrop_path : null,
    description: i.overview || "",
    releaseInfo: (i.release_date || i.first_air_date || "").substring(0, 4),
    imdbRating: i.vote_average ? i.vote_average.toFixed(1) : undefined,
  };
}

async function extractDirect(url) {
  try {
    const { data } = await http.get(url, { headers: { referer: new URL(url).origin } });
    let m = data.match(/(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/i);
    if (m) return { url: m[1], label: "HLS" };
    m = data.match(/(https?:\/\/[^\s"']+\.mp4[^\s"']*)/i);
    if (m) return { url: m[1], label: "MP4" };
    m = data.match(/["']?(?:file|source|src|url|video)["']?\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i);
    if (m) return { url: m[1], label: m[1].includes(".m3u8") ? "HLS" : "MP4" };
    return null;
  } catch (e) { return null; }
}

async function findStreams(type, tmdbId, imdbId, title, season, episode) {
  const streams = [];
  const id = imdbId || tmdbId;

  const providers = [
    { name: "VidSrc", fn: () => type === "movie" ? `https://vidsrc.xyz/embed/movie/${tmdbId}` : `https://vidsrc.xyz/embed/tv/${tmdbId}/${season}/${episode}` },
    { name: "VidSrc.to", fn: () => type === "movie" ? `https://vidsrc.to/embed/movie/${id}` : `https://vidsrc.to/embed/tv/${id}/${season}/${episode}` },
    { name: "2Embed", fn: () => type === "movie" ? `https://www.2embed.cc/embed/${id}` : `https://www.2embed.cc/embedtv/${id}&s=${season}&e=${episode}` },
    { name: "AutoEmbed", fn: () => type === "movie" ? `https://player.autoembed.cc/embed/movie/${id}` : `https://player.autoembed.cc/embed/tv/${id}/${season}/${episode}` },
    { name: "MultiEmbed", fn: () => type === "movie" ? `https://multiembed.mov/?video_id=${id}&tmdb=1` : `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${season}&e=${episode}` },
    { name: "NontonGo", fn: () => type === "movie" ? `https://www.NontonGo.win/embed/movie/${tmdbId}` : `https://www.NontonGo.win/embed/tv/${tmdbId}/${season}/${episode}` },
    { name: "Embed.su", fn: () => type === "movie" ? `https://embed.su/embed/movie/${tmdbId}` : `https://embed.su/embed/tv/${tmdbId}/${season}/${episode}` },
  ];

  const results = await Promise.allSettled(
    providers.map(async (p) => {
      const url = p.fn();
      const direct = await Promise.race([
        extractDirect(url),
        new Promise(r => setTimeout(() => r(null), 8000)),
      ]);
      return { provider: p.name, url, direct };
    })
  );

  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const { provider, url, direct } = r.value;
    if (direct) {
      streams.push({ name: "Reflux", title: "▶ " + provider + " (" + direct.label + ")", url: direct.url });
    } else {
      streams.push({ name: "Reflux", title: "🌐 " + provider, externalUrl: url });
    }
  }

  console.log("[STREAM] " + streams.length + " streams para " + title);
  return streams;
}

const manifest = {
  id: "community.reflux.br.v3",
  version: "3.0.0",
  name: "Reflux BR",
  description: "Filmes, séries e TV ao vivo com múltiplas fontes.",
  logo: "https://raw.githubusercontent.com/Nightfruit/reflux/main/public/images/banner.png",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series", "tv"],
  idPrefixes: ["tmdb:", "iptv:"],
  catalogs: [
    { type: "movie", id: "reflux-trending-movies", name: "Reflux - Em Alta", extra: [{ name: "skip", isRequired: false }] },
    { type: "movie", id: "reflux-popular-movies", name: "Reflux - Populares", extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
    { type: "series", id: "reflux-trending-series", name: "Reflux - Em Alta", extra: [{ name: "skip", isRequired: false }] },
    { type: "series", id: "reflux-popular-series", name: "Reflux - Populares", extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
    { type: "tv", id: "reflux-iptv", name: "Reflux - TV ao Vivo", extra: [{ name: "search", isRequired: false }] },
  ],
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  console.log("[CATALOG] " + type + "/" + id);
  if (type === "tv") {
    const chs = await loadIPTV();
    let f = chs;
    if (extra.search) { const q = extra.search.toLowerCase(); f = chs.filter(c => c.name.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)); }
    return { metas: f.slice(0, 200).map(c => ({ id: c.id, type: "tv", name: c.name, poster: c.logo, posterShape: "square", description: c.group })) };
  }
  const page = Math.floor((parseInt(extra.skip) || 0) / 20) + 1;
  if (extra.search) return { metas: await tmdbSearch(type, extra.search) };
  if (id.includes("trending")) return { metas: await tmdbTrending(type) };
  return { metas: await tmdbPopular(type, page) };
});

builder.defineMetaHandler(async ({ type, id }) => {
  console.log("[META] " + id);
  if (id.startsWith("iptv:")) {
    const chs = await loadIPTV();
    const ch = chs.find(c => c.id === id);
    if (!ch) return { meta: null };
    return { meta: { id: ch.id, type: "tv", name: ch.name, poster: ch.logo, posterShape: "square", description: "Canal: " + ch.name + "\nGrupo: " + ch.group } };
  }
  const tid = id.replace("tmdb:", "");
  const d = await tmdbDetails(type, parseInt(tid));
  if (!d) return { meta: null };
  const meta = {
    id, type, name: d.title || d.name,
    poster: d.poster_path ? TMDB_IMG + "/w500" + d.poster_path : null,
    background: d.backdrop_path ? TMDB_IMG + "/original" + d.backdrop_path : null,
    description: d.overview || "",
    releaseInfo: (d.release_date || d.first_air_date || "").substring(0, 4),
    imdbRating: d.vote_average ? d.vote_average.toFixed(1) : undefined,
    genres: d.genres ? d.genres.map(g => g.name) : [],
    runtime: d.runtime ? d.runtime + " min" : undefined,
    cast: d.credits?.cast?.slice(0, 5).map(c => c.name),
    director: d.credits?.crew?.filter(c => c.job === "Director").map(c => c.name),
  };
  if (type === "series" && d.seasons) {
    meta.videos = [];
    for (const s of d.seasons) {
      if (s.season_number === 0) continue;
      const sd = await tmdbSeason(tid, s.season_number);
      if (sd?.episodes) for (const ep of sd.episodes) {
        meta.videos.push({
          id: "tmdb:" + tid + ":" + s.season_number + ":" + ep.episode_number,
          title: ep.name || "Episódio " + ep.episode_number,
          season: s.season_number, episode: ep.episode_number,
          thumbnail: ep.still_path ? TMDB_IMG + "/w300" + ep.still_path : undefined,
          released: ep.air_date ? new Date(ep.air_date).toISOString() : undefined,
        });
      }
    }
  }
  return { meta };
});

builder.defineStreamHandler(async ({ type, id }) => {
  console.log("[STREAM] " + type + " " + id);
  if (id.startsWith("iptv:")) {
    const chs = await loadIPTV();
    const ch = chs.find(c => c.id === id);
    if (!ch) return { streams: [] };
    return { streams: [{ name: "Reflux TV", title: "📺 " + ch.name, url: ch.url }] };
  }
  const parts = id.replace("tmdb:", "").split(":");
  const d = await tmdbDetails(type, parseInt(parts[0]));
  const imdbId = d?.external_ids?.imdb_id || null;
  const title = d?.title || d?.name || "";
  return { streams: await findStreams(type, parts[0], imdbId, title, parts[1], parts[2]) };
});

async function start() {
  console.log("=== REFLUX BR v3.0 ===");
  try { const t = await tmdbPopular("movie"); console.log("[TMDB] OK - " + t.length + " filmes"); } catch (e) { console.error("[TMDB] " + e.message); }
  try { const c = await loadIPTV(); console.log("[IPTV] OK - " + c.length + " canais"); } catch (e) { console.error("[IPTV] " + e.message); }
  serveHTTP(builder.getInterface(), { port: PORT });
  console.log("Porta " + PORT + " | Manifest: http://localhost:" + PORT + "/manifest.json");
}

start().catch(e => { console.error(e); process.exit(1); });
