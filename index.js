const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const PORT = process.env.PORT || 3000;
const IPTV_URL = process.env.IPTV_URL || "http://fibercdn.sbs/get.php?username=1093969013&password=dembl88n&type=m3u_plus&output=m3u8";

const http = axios.create({
  timeout: 60000,
  headers: {
    "user-agent": "IPTV Smarters/1.0",
    accept: "*/*",
  },
  maxContentLength: 50 * 1024 * 1024,
});

let channels = [];
let groups = [];
let lastFetch = 0;

async function loadPlaylist() {
  if (Date.now() - lastFetch < 3600000 && channels.length > 0) return;
  try {
    console.log("[M3U] Baixando playlist...");
    const { data } = await http.get(IPTV_URL);
    const lines = data.split("\n");
    const parsed = [];
    let cur = null;

    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith("#EXTINF:")) {
        const nm = t.match(/,(.+)$/);
        const lg = t.match(/tvg-logo="([^"]*)"/);
        const gr = t.match(/group-title="([^"]*)"/);
        cur = {
          name: nm ? nm[1].trim() : "Canal",
          logo: lg && lg[1] ? lg[1] : null,
          group: gr ? gr[1] : "Outros",
        };
      } else if (t && !t.startsWith("#") && cur) {
        cur.url = t;
        cur.id = "iptv:" + Buffer.from(cur.name + "|" + cur.group).toString("base64url").substring(0, 50);
        // Detectar tipo pelo grupo
        const gl = cur.group.toLowerCase();
        if (gl.includes("filme") || gl.includes("movie") || gl.includes("cinema") || gl.includes("hbo") || gl.includes("telecine") || gl.includes("megapix") || gl.includes("paramount") || gl.includes("star+")) {
          cur.type = "movie";
        } else if (gl.includes("serie") || gl.includes("series") || gl.includes("netflix") || gl.includes("amazon") || gl.includes("disney") || gl.includes("apple") || gl.includes("max") || gl.includes("globoplay")) {
          cur.type = "series";
        } else {
          cur.type = "tv";
        }
        parsed.push(cur);
        cur = null;
      }
    }

    channels = parsed;
    groups = [...new Set(parsed.map(c => c.group))].sort();
    lastFetch = Date.now();
    console.log("[M3U] " + parsed.length + " canais em " + groups.length + " grupos");
    console.log("[M3U] Grupos: " + groups.slice(0, 30).join(" | "));

    const movies = parsed.filter(c => c.type === "movie").length;
    const series = parsed.filter(c => c.type === "series").length;
    const tv = parsed.filter(c => c.type === "tv").length;
    console.log("[M3U] Filmes: " + movies + " | Séries: " + series + " | TV: " + tv);
  } catch (e) {
    console.error("[M3U] ERRO: " + e.message);
    if (e.response) console.error("[M3U] Status: " + e.response.status + " Headers:", JSON.stringify(e.response.headers).substring(0, 200));
  }
}

function search(list, query) {
  const q = query.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return list.filter(c => {
    const n = c.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const g = c.group.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return n.includes(q) || g.includes(q);
  });
}

function toMeta(c) {
  return {
    id: c.id,
    type: c.type,
    name: c.name,
    poster: c.logo || null,
    posterShape: c.type === "tv" ? "square" : "poster",
    description: c.group,
    background: c.logo || null,
  };
}

// Construir catálogos dinâmicos baseados nos grupos da playlist
function buildCatalogs() {
  return [
    { type: "tv", id: "reflux-tv", name: "📺 TV ao Vivo", extra: [{ name: "search", isRequired: false }, { name: "genre", isRequired: false, options: groups.filter(g => { const l = g.toLowerCase(); return !l.includes("filme") && !l.includes("movie") && !l.includes("serie"); }).slice(0, 30) }] },
    { type: "movie", id: "reflux-filmes", name: "🎬 Filmes", extra: [{ name: "search", isRequired: false }, { name: "genre", isRequired: false, options: groups.filter(g => { const l = g.toLowerCase(); return l.includes("filme") || l.includes("movie") || l.includes("cinema") || l.includes("telecine") || l.includes("megapix"); }).slice(0, 20) }] },
    { type: "series", id: "reflux-series", name: "📺 Séries", extra: [{ name: "search", isRequired: false }, { name: "genre", isRequired: false, options: groups.filter(g => { const l = g.toLowerCase(); return l.includes("serie") || l.includes("netflix") || l.includes("amazon") || l.includes("disney"); }).slice(0, 20) }] },
    { type: "tv", id: "reflux-todos", name: "📡 Todos os Canais", extra: [{ name: "search", isRequired: false }, { name: "genre", isRequired: false, options: groups.slice(0, 50) }] },
  ];
}

const manifest = {
  id: "community.reflux.iptv.v4",
  version: "4.0.0",
  name: "Reflux IPTV",
  description: "Filmes, séries e TV ao vivo da sua playlist IPTV direto no player do Stremio.",
  logo: "https://raw.githubusercontent.com/Nightfruit/reflux/main/public/images/banner.png",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series", "tv"],
  idPrefixes: ["iptv:"],
  catalogs: [
    { type: "tv", id: "reflux-tv", name: "📺 TV ao Vivo", extra: [{ name: "search", isRequired: false }] },
    { type: "movie", id: "reflux-filmes", name: "🎬 Filmes", extra: [{ name: "search", isRequired: false }] },
    { type: "series", id: "reflux-series", name: "📺 Séries", extra: [{ name: "search", isRequired: false }] },
    { type: "tv", id: "reflux-todos", name: "📡 Todos os Canais", extra: [{ name: "search", isRequired: false }] },
  ],
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  await loadPlaylist();
  console.log("[CAT] " + type + "/" + id + " search=" + (extra.search || "") + " genre=" + (extra.genre || ""));

  let list = channels;

  // Filtrar por catálogo
  if (id === "reflux-filmes") list = channels.filter(c => c.type === "movie");
  else if (id === "reflux-series") list = channels.filter(c => c.type === "series");
  else if (id === "reflux-tv") list = channels.filter(c => c.type === "tv");
  // reflux-todos = tudo

  // Filtrar por gênero (grupo)
  if (extra.genre) list = list.filter(c => c.group === extra.genre);

  // Busca
  if (extra.search) list = search(list, extra.search);

  // Paginação
  const skip = parseInt(extra.skip) || 0;
  const page = list.slice(skip, skip + 100);

  return { metas: page.map(toMeta) };
});

builder.defineMetaHandler(async ({ type, id }) => {
  await loadPlaylist();
  const ch = channels.find(c => c.id === id);
  if (!ch) return { meta: null };
  return { meta: { ...toMeta(ch), description: "Canal: " + ch.name + "\nGrupo: " + ch.group + "\n\nToque para assistir no player do Stremio." } };
});

builder.defineStreamHandler(async ({ type, id }) => {
  await loadPlaylist();
  console.log("[STREAM] " + id);
  const ch = channels.find(c => c.id === id);
  if (!ch) return { streams: [] };
  return {
    streams: [{
      name: "Reflux",
      title: "▶ " + ch.name + " (" + ch.group + ")",
      url: ch.url,
    }],
  };
});

async function start() {
  console.log("=== REFLUX IPTV v4.0 ===");
  console.log("[CONFIG] Playlist: " + IPTV_URL.substring(0, 50) + "...");
  await loadPlaylist();

  // Atualizar manifest com gêneros dinâmicos se tiver canais
  if (groups.length > 0) {
    manifest.catalogs = buildCatalogs();
  }

  serveHTTP(builder.getInterface(), { port: PORT });
  console.log("\n🚀 Porta " + PORT);
  console.log("📋 Manifest: http://localhost:" + PORT + "/manifest.json");
  console.log("📺 " + channels.length + " canais disponíveis\n");
}

start().catch(e => { console.error(e); process.exit(1); });
