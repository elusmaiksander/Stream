const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const IPTV_URL = process.env.IPTV_URL || "http://fibercdn.sbs/get.php?username=1093969013&password=dembl88n&type=m3u_plus&output=m3u8";
const TMDB_KEY = process.env.TMDB_KEY || ""; // Opcional: crie em themoviedb.org/settings/api

// ============================================================
// HTTP HELPER - sem axios, usa http/https nativo para evitar problemas
// ============================================================

function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(u, {
      method: opts.method || "GET",
      timeout: opts.timeout || 15000,
      headers: {
        "User-Agent": opts.ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        ...(opts.headers || {}),
      },
    }, (res) => {
      // Seguir redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location, opts).then(resolve).catch(reject);
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", d => body += d);
      res.on("end", () => resolve({ status: res.statusCode, data: body, headers: res.headers }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

// ============================================================
// IPTV LOADER
// ============================================================

let channels = [], groups = [], lastLoad = 0;

async function loadIPTV() {
  if (Date.now() - lastLoad < 3600000 && channels.length > 0) return;
  try {
    console.log("[IPTV] Baixando playlist de " + IPTV_URL.substring(0, 60) + "...");
    // Usar user-agent de player IPTV para evitar 403
    const res = await fetch(IPTV_URL, { timeout: 60000, ua: "IPTV Smarters Pro" });
    if (res.status !== 200) {
      // Tentar com user-agent diferente
      console.log("[IPTV] Status " + res.status + ", tentando com outro User-Agent...");
      const res2 = await fetch(IPTV_URL, { timeout: 60000, ua: "Lavf/60.3.100" });
      if (res2.status !== 200) {
        // Terceira tentativa - VLC
        const res3 = await fetch(IPTV_URL, { timeout: 60000, ua: "VLC/3.0.20 LibVLC/3.0.20" });
        if (res3.status !== 200) throw new Error("Status " + res3.status);
        res.data = res3.data;
      } else {
        res.data = res2.data;
      }
    }
    parseM3U(res.data);
  } catch (e) {
    console.error("[IPTV] ERRO: " + e.message);
  }
}

function parseM3U(data) {
  const lines = data.split("\n"), out = [];
  let c = null;
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith("#EXTINF:")) {
      const n = t.match(/,(.+)$/);
      const lg = t.match(/tvg-logo="([^"]*)"/);
      const g = t.match(/group-title="([^"]*)"/);
      c = { name: n?.[1]?.trim() || "Canal", logo: lg?.[1] || null, group: g?.[1] || "Outros" };
    } else if (t && !t.startsWith("#") && c) {
      c.url = t;
      c.id = "iptv:" + Buffer.from(c.name + "|" + c.group).toString("base64url").substring(0, 50);
      // Classificar tipo pelo nome do grupo
      const gl = (c.group + " " + c.name).toLowerCase();
      if (gl.includes("filme") || gl.includes("movie") || gl.includes("cinema") || gl.includes("telecine") || gl.includes("megapix")) c.type = "movie";
      else if (gl.includes("serie") || gl.includes("series") || gl.includes("temporada") || gl.includes("episod")) c.type = "series";
      else c.type = "tv";
      out.push(c);
      c = null;
    }
  }
  channels = out;
  groups = [...new Set(out.map(x => x.group))].sort();
  lastLoad = Date.now();
  const m = out.filter(x => x.type === "movie").length;
  const s = out.filter(x => x.type === "series").length;
  const tv = out.filter(x => x.type === "tv").length;
  console.log("[IPTV] ✅ " + out.length + " canais | " + groups.length + " grupos");
  console.log("[IPTV] 🎬 Filmes:" + m + " 📺 Séries:" + s + " 📡 TV:" + tv);
  if (groups.length > 0) console.log("[IPTV] Grupos: " + groups.slice(0, 25).join(" | "));
}

function searchCh(list, q) {
  const n = q.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return list.filter(c => {
    const t = (c.name + " " + c.group).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return t.includes(n);
  });
}

// ============================================================
// TMDB (opcional)
// ============================================================

async function tmdbGet(path, params = {}) {
  if (!TMDB_KEY) return null;
  const qs = new URLSearchParams({ api_key: TMDB_KEY, language: "pt-BR", ...params }).toString();
  const url = "https://api.themoviedb.org/3" + path + "?" + qs;
  try {
    const r = await fetch(url, { timeout: 8000 });
    if (r.status !== 200) return null;
    return JSON.parse(r.data);
  } catch { return null; }
}

async function tmdbCatalog(type, mode, page, search) {
  const mt = type === "movie" ? "movie" : "tv";
  let d;
  if (search) d = await tmdbGet("/search/" + mt, { query: search });
  else if (mode === "trending") d = await tmdbGet("/trending/" + mt + "/week");
  else if (mode === "top") d = await tmdbGet("/" + mt + "/top_rated", { page: String(page) });
  else d = await tmdbGet("/" + mt + "/popular", { page: String(page), region: "BR" });
  if (!d || !d.results) return [];
  return d.results.map(i => ({
    id: "tmdb:" + i.id, type,
    name: i.title || i.name || "",
    poster: i.poster_path ? "https://image.tmdb.org/t/p/w500" + i.poster_path : null,
    description: i.overview || "",
    releaseInfo: (i.release_date || i.first_air_date || "").substring(0, 4),
    imdbRating: i.vote_average ? i.vote_average.toFixed(1) : undefined,
  }));
}

async function tmdbMeta(type, id) {
  const mt = type === "movie" ? "movie" : "tv";
  const d = await tmdbGet("/" + mt + "/" + id, { append_to_response: "external_ids,credits" });
  if (!d) return null;
  const meta = {
    id: "tmdb:" + id, type, name: d.title || d.name,
    poster: d.poster_path ? "https://image.tmdb.org/t/p/w500" + d.poster_path : null,
    background: d.backdrop_path ? "https://image.tmdb.org/t/p/original" + d.backdrop_path : null,
    description: d.overview || "",
    releaseInfo: (d.release_date || d.first_air_date || "").substring(0, 4),
    imdbRating: d.vote_average ? d.vote_average.toFixed(1) : undefined,
    genres: d.genres?.map(g => g.name) || [],
    cast: d.credits?.cast?.slice(0, 5).map(c => c.name),
  };
  if (type === "series" && d.seasons) {
    meta.videos = [];
    for (const s of d.seasons) {
      if (s.season_number === 0) continue;
      const sd = await tmdbGet("/tv/" + id + "/season/" + s.season_number);
      if (sd?.episodes) for (const e of sd.episodes)
        meta.videos.push({ id: "tmdb:" + id + ":" + s.season_number + ":" + e.episode_number, title: e.name || "Ep " + e.episode_number, season: s.season_number, episode: e.episode_number, thumbnail: e.still_path ? "https://image.tmdb.org/t/p/w300" + e.still_path : undefined, released: e.air_date ? new Date(e.air_date).toISOString() : undefined });
    }
  }
  return meta;
}

// ============================================================
// EMBED STREAM EXTRACTION
// ============================================================

async function extractStream(url) {
  try {
    const r = await fetch(url, { timeout: 8000, headers: { referer: new URL(url).origin } });
    let m = r.data.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
    if (m) return m[1];
    m = r.data.match(/(https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*)/i);
    if (m) return m[1];
    m = r.data.match(/(?:file|source|src|url|video|stream)["']?\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i);
    if (m) return m[1];
  } catch {} return null;
}

async function findStreams(type, tmdbId, imdbId, season, episode) {
  const id = imdbId || tmdbId;
  const embeds = [
    { n: "VidSrc", u: type === "movie" ? "https://vidsrc.xyz/embed/movie/" + tmdbId : "https://vidsrc.xyz/embed/tv/" + tmdbId + "/" + season + "/" + episode },
    { n: "VidSrc.to", u: type === "movie" ? "https://vidsrc.to/embed/movie/" + id : "https://vidsrc.to/embed/tv/" + id + "/" + season + "/" + episode },
    { n: "Embed.su", u: type === "movie" ? "https://embed.su/embed/movie/" + tmdbId : "https://embed.su/embed/tv/" + tmdbId + "/" + season + "/" + episode },
    { n: "AutoEmbed", u: type === "movie" ? "https://player.autoembed.cc/embed/movie/" + id : "https://player.autoembed.cc/embed/tv/" + id + "/" + season + "/" + episode },
    { n: "2Embed", u: type === "movie" ? "https://www.2embed.cc/embed/" + id : "https://www.2embed.cc/embedtv/" + id + "&s=" + season + "&e=" + episode },
    { n: "MultiEmbed", u: type === "movie" ? "https://multiembed.mov/?video_id=" + id + "&tmdb=1" : "https://multiembed.mov/?video_id=" + id + "&tmdb=1&s=" + season + "&e=" + episode },
    { n: "NontonGo", u: type === "movie" ? "https://www.NontonGo.win/embed/movie/" + tmdbId : "https://www.NontonGo.win/embed/tv/" + tmdbId + "/" + season + "/" + episode },
  ];
  const results = await Promise.allSettled(embeds.map(e =>
    Promise.race([extractStream(e.u).then(d => ({ n: e.n, u: e.u, d })), new Promise((_, r) => setTimeout(() => r(), 8000))])
  ));
  const streams = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    if (r.value.d) streams.push({ name: "Reflux", title: "▶ " + r.value.n, url: r.value.d });
    else streams.push({ name: "Reflux", title: "🌐 " + r.value.n, externalUrl: r.value.u });
  }

  // Buscar matches na IPTV
  await loadIPTV();
  if (tmdbId && TMDB_KEY) {
    try {
      const mt = type === "movie" ? "movie" : "tv";
      const d = await tmdbGet("/" + mt + "/" + tmdbId);
      if (d) {
        const title = (d.title || d.name || "").toLowerCase();
        if (title.length > 3) {
          const matches = channels.filter(c => c.name.toLowerCase().includes(title));
          matches.slice(0, 3).forEach(c => streams.push({ name: "IPTV", title: "📺 " + c.name, url: c.url }));
        }
      }
    } catch {}
  }

  console.log("[STREAM] " + streams.length + " fontes");
  return streams;
}

// ============================================================
// STREMIO MANIFEST & HANDLERS
// ============================================================

const catalogs = [
  { type: "tv", id: "iptv-tv", name: "📡 TV ao Vivo", extra: [{ name: "search" }, { name: "skip" }] },
  { type: "movie", id: "iptv-filmes", name: "🎬 IPTV Filmes", extra: [{ name: "search" }, { name: "skip" }] },
  { type: "series", id: "iptv-series", name: "📺 IPTV Séries", extra: [{ name: "search" }, { name: "skip" }] },
];
// Adicionar catálogos TMDB se a chave existir
if (TMDB_KEY) {
  catalogs.push(
    { type: "movie", id: "tmdb-trend-m", name: "🔥 Em Alta", extra: [{ name: "skip" }] },
    { type: "movie", id: "tmdb-pop-m", name: "🎬 Populares", extra: [{ name: "search" }, { name: "skip" }] },
    { type: "series", id: "tmdb-trend-s", name: "🔥 Em Alta", extra: [{ name: "skip" }] },
    { type: "series", id: "tmdb-pop-s", name: "📺 Populares", extra: [{ name: "search" }, { name: "skip" }] },
  );
}

const manifest = {
  id: "community.reflux.v6",
  version: "6.0.0",
  name: "Reflux BR",
  description: TMDB_KEY
    ? "Filmes, séries e TV ao vivo. IPTV + TMDB + 7 provedores."
    : "TV ao vivo, filmes e séries da sua playlist IPTV.",
  logo: "https://raw.githubusercontent.com/Nightfruit/reflux/main/public/images/banner.png",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series", "tv"],
  idPrefixes: ["iptv:", "tmdb:"],
  catalogs,
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  console.log("[CAT] " + type + "/" + id);
  const skip = parseInt(extra.skip) || 0;
  const page = Math.floor(skip / 20) + 1;

  if (id.startsWith("iptv")) {
    await loadIPTV();
    let list = channels;
    if (id === "iptv-tv") list = channels.filter(c => c.type === "tv");
    else if (id === "iptv-filmes") list = channels.filter(c => c.type === "movie");
    else if (id === "iptv-series") list = channels.filter(c => c.type === "series");
    if (extra.search) list = searchCh(list, extra.search);
    return { metas: list.slice(skip, skip + 100).map(c => ({ id: c.id, type: c.type, name: c.name, poster: c.logo, posterShape: c.type === "tv" ? "square" : "poster", description: c.group })) };
  }

  if (id.startsWith("tmdb") && TMDB_KEY) {
    let mode = "popular";
    if (id.includes("trend")) mode = "trending";
    return { metas: await tmdbCatalog(type, mode, page, extra.search) };
  }

  return { metas: [] };
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (id.startsWith("iptv:")) {
    await loadIPTV();
    const ch = channels.find(c => c.id === id);
    if (!ch) return { meta: null };
    return { meta: { id: ch.id, type: ch.type, name: ch.name, poster: ch.logo, posterShape: "square", description: "Canal: " + ch.name + "\nGrupo: " + ch.group } };
  }
  if (id.startsWith("tmdb:") && TMDB_KEY) {
    const tid = id.replace("tmdb:", "");
    const meta = await tmdbMeta(type, parseInt(tid));
    return { meta };
  }
  return { meta: null };
});

builder.defineStreamHandler(async ({ type, id }) => {
  console.log("[STREAM] " + id);
  if (id.startsWith("iptv:")) {
    await loadIPTV();
    const ch = channels.find(c => c.id === id);
    if (!ch) return { streams: [] };
    return { streams: [{ name: "Reflux", title: "▶ " + ch.name, url: ch.url }] };
  }
  if (id.startsWith("tmdb:") && TMDB_KEY) {
    const parts = id.replace("tmdb:", "").split(":");
    let imdbId = null;
    try {
      const d = await tmdbGet("/" + (type === "movie" ? "movie" : "tv") + "/" + parts[0], { append_to_response: "external_ids" });
      imdbId = d?.external_ids?.imdb_id;
    } catch {}
    return { streams: await findStreams(type, parts[0], imdbId, parts[1], parts[2]) };
  }
  return { streams: [] };
});

// ============================================================
// START
// ============================================================

async function start() {
  console.log("========================================");
  console.log("  REFLUX BR v6.0");
  console.log("========================================");
  console.log("[CONFIG] TMDB: " + (TMDB_KEY ? "✅ Ativo" : "⚠️ Sem chave (só IPTV)"));
  console.log("[CONFIG] IPTV: " + IPTV_URL.substring(0, 50) + "...");

  if (TMDB_KEY) {
    const d = await tmdbGet("/movie/popular", { page: "1" });
    console.log("[TMDB] " + (d ? "✅ " + d.results.length + " filmes" : "❌ Falhou"));
  }

  await loadIPTV();

  serveHTTP(builder.getInterface(), { port: PORT });
  console.log("\n🚀 Porta " + PORT + " | " + channels.length + " canais IPTV");
  console.log("📋 http://localhost:" + PORT + "/manifest.json\n");
}

start().catch(e => { console.error(e); process.exit(1); });
