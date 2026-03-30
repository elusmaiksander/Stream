const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

// ============================================================
// CONFIGURAÇÃO
// ============================================================

const PORT = process.env.PORT || 3000;
const TMDB_KEY =
  "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI1MjAyNTVkNDU4N2I5NjRiMmIzYTRiNTk5NmE3ZTI4OCIsIm5iZiI6MTczNDU0NjY2MC4wMzQsInN1YiI6IjY3NjI2ZTg0MTcwMTdmNDkzMDExOGVlMCIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.NptT5FTIfnZBLx89hvNJJiSaOEVyULTLfCxXsF9W3fE";

const TMDB_API = "https://api.themoviedb.org/3";
const TMDB_IMG = "https://image.tmdb.org/t/p";

// ============================================================
// HTTP CLIENT
// ============================================================

const tmdb = axios.create({
  baseURL: TMDB_API,
  timeout: 10000,
  headers: { authorization: `Bearer ${TMDB_KEY}` },
  params: { language: "pt-BR" },
});

const http = axios.create({
  timeout: 15000,
  headers: {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  },
});

// ============================================================
// TMDB - CATÁLOGO
// ============================================================

async function tmdbPopular(type, page = 1) {
  const mediaType = type === "movie" ? "movie" : "tv";
  try {
    const { data } = await tmdb.get(`/${mediaType}/popular`, {
      params: { page, region: "BR" },
    });
    return data.results.map((item) => formatTmdbItem(item, type));
  } catch (e) {
    console.error(`[TMDB] popular ${type} erro:`, e.message);
    return [];
  }
}

async function tmdbTrending(type) {
  const mediaType = type === "movie" ? "movie" : "tv";
  try {
    const { data } = await tmdb.get(`/trending/${mediaType}/week`, {
      params: { language: "pt-BR" },
    });
    return data.results.map((item) => formatTmdbItem(item, type));
  } catch (e) {
    console.error(`[TMDB] trending ${type} erro:`, e.message);
    return [];
  }
}

async function tmdbSearch(type, query) {
  const mediaType = type === "movie" ? "movie" : "tv";
  try {
    const { data } = await tmdb.get(`/search/${mediaType}`, {
      params: { query, include_adult: false },
    });
    return data.results.map((item) => formatTmdbItem(item, type));
  } catch (e) {
    console.error(`[TMDB] search ${type} "${query}" erro:`, e.message);
    return [];
  }
}

async function tmdbDetails(type, tmdbId) {
  const mediaType = type === "movie" ? "movie" : "tv";
  try {
    const { data } = await tmdb.get(`/${mediaType}/${tmdbId}`, {
      params: {
        append_to_response:
          type === "series" ? "external_ids,credits" : "external_ids,credits",
      },
    });
    return data;
  } catch (e) {
    console.error(`[TMDB] details ${type}/${tmdbId} erro:`, e.message);
    return null;
  }
}

async function tmdbSeasonDetails(tmdbId, seasonNum) {
  try {
    const { data } = await tmdb.get(`/tv/${tmdbId}/season/${seasonNum}`);
    return data;
  } catch (e) {
    return null;
  }
}

function formatTmdbItem(item, type) {
  const title = item.title || item.name || "Sem título";
  const year = (item.release_date || item.first_air_date || "").substring(0, 4);
  return {
    id: `tmdb:${item.id}`,
    type,
    name: title,
    poster: item.poster_path
      ? `${TMDB_IMG}/w500${item.poster_path}`
      : null,
    background: item.backdrop_path
      ? `${TMDB_IMG}/original${item.backdrop_path}`
      : null,
    description: item.overview || "",
    year,
    imdbRating: item.vote_average ? item.vote_average.toFixed(1) : undefined,
    genres: [],
  };
}

// ============================================================
// PROVEDORES DE STREAM ABERTOS
// ============================================================

async function findStreams(type, tmdbId, imdbId, title, year, season, episode) {
  const streams = [];
  const providers = [
    () => getVidSrcStreams(type, tmdbId, season, episode),
    () => getVidSrcToStreams(type, imdbId || tmdbId, season, episode),
    () => getSuperStreams(type, tmdbId, imdbId, season, episode),
    () => getAutoEmbedStreams(type, imdbId || tmdbId, season, episode),
  ];

  const results = await Promise.allSettled(
    providers.map((fn) =>
      Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 12000))])
    )
  );

  for (const result of results) {
    if (result.status === "fulfilled" && Array.isArray(result.value)) {
      streams.push(...result.value);
    }
  }

  console.log(`[STREAM] ${streams.length} streams encontrados para "${title}"`);
  return streams;
}

// Provider 1: VidSrc.xyz
async function getVidSrcStreams(type, tmdbId, season, episode) {
  const streams = [];
  try {
    let url;
    if (type === "movie") {
      url = `https://vidsrc.xyz/embed/movie/${tmdbId}`;
    } else {
      url = `https://vidsrc.xyz/embed/tv/${tmdbId}/${season}/${episode}`;
    }

    streams.push({
      name: "Reflux",
      title: "VidSrc.xyz",
      externalUrl: url,
    });
  } catch (e) {}
  return streams;
}

// Provider 2: VidSrc.to
async function getVidSrcToStreams(type, id, season, episode) {
  const streams = [];
  try {
    let url;
    if (type === "movie") {
      url = `https://vidsrc.to/embed/movie/${id}`;
    } else {
      url = `https://vidsrc.to/embed/tv/${id}/${season}/${episode}`;
    }

    streams.push({
      name: "Reflux",
      title: "VidSrc.to",
      externalUrl: url,
    });
  } catch (e) {}
  return streams;
}

// Provider 3: SuperStream (2embed)
async function getSuperStreams(type, tmdbId, imdbId, season, episode) {
  const streams = [];
  try {
    const id = imdbId || tmdbId;
    let url;
    if (type === "movie") {
      url = `https://www.2embed.cc/embed/${id}`;
    } else {
      url = `https://www.2embed.cc/embedtv/${id}&s=${season}&e=${episode}`;
    }

    streams.push({
      name: "Reflux",
      title: "2Embed",
      externalUrl: url,
    });
  } catch (e) {}
  return streams;
}

// Provider 4: AutoEmbed
async function getAutoEmbedStreams(type, id, season, episode) {
  const streams = [];
  try {
    let url;
    if (type === "movie") {
      url = `https://player.autoembed.cc/embed/movie/${id}`;
    } else {
      url = `https://player.autoembed.cc/embed/tv/${id}/${season}/${episode}`;
    }

    streams.push({
      name: "Reflux",
      title: "AutoEmbed",
      externalUrl: url,
    });
  } catch (e) {}
  return streams;
}

// ============================================================
// ADDON STREMIO
// ============================================================

const manifest = {
  id: "community.reflux.br",
  version: "2.0.0",
  name: "Reflux BR",
  description:
    "Catálogo brasileiro de filmes e séries com múltiplas fontes de stream. Usa TMDB para metadados.",
  logo: "https://raw.githubusercontent.com/Nightfruit/reflux/main/public/images/banner.png",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series"],
  idPrefixes: ["tmdb:", "tt"],
  catalogs: [
    {
      type: "movie",
      id: "reflux-trending-movies",
      name: "Reflux - Em Alta (Filmes)",
      extra: [{ name: "skip", isRequired: false }],
    },
    {
      type: "movie",
      id: "reflux-popular-movies",
      name: "Reflux - Populares (Filmes)",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "series",
      id: "reflux-trending-series",
      name: "Reflux - Em Alta (Séries)",
      extra: [{ name: "skip", isRequired: false }],
    },
    {
      type: "series",
      id: "reflux-popular-series",
      name: "Reflux - Populares (Séries)",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
  ],
};

const builder = new addonBuilder(manifest);

// ============================================================
// HANDLER: CATALOG
// ============================================================

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  console.log(`[CATALOG] ${type} ${id} search=${extra.search || ""} skip=${extra.skip || 0}`);

  let metas = [];
  const page = Math.floor((parseInt(extra.skip) || 0) / 20) + 1;

  if (extra.search) {
    metas = await tmdbSearch(type, extra.search);
  } else if (id.includes("trending")) {
    metas = await tmdbTrending(type);
  } else {
    metas = await tmdbPopular(type, page);
  }

  return {
    metas: metas.map((m) => ({
      id: m.id,
      type: m.type,
      name: m.name,
      poster: m.poster,
      description: m.description,
    })),
  };
});

// ============================================================
// HANDLER: META
// ============================================================

builder.defineMetaHandler(async ({ type, id }) => {
  console.log(`[META] ${type} ${id}`);

  const tmdbId = id.replace("tmdb:", "");
  const details = await tmdbDetails(type, parseInt(tmdbId));

  if (!details) return { meta: null };

  const meta = {
    id,
    type,
    name: details.title || details.name,
    poster: details.poster_path
      ? `${TMDB_IMG}/w500${details.poster_path}`
      : null,
    background: details.backdrop_path
      ? `${TMDB_IMG}/original${details.backdrop_path}`
      : null,
    description: details.overview || "",
    releaseInfo: (
      details.release_date ||
      details.first_air_date ||
      ""
    ).substring(0, 4),
    imdbRating: details.vote_average
      ? details.vote_average.toFixed(1)
      : undefined,
    genres: details.genres ? details.genres.map((g) => g.name) : [],
    runtime: details.runtime
      ? `${details.runtime} min`
      : undefined,
    cast: details.credits?.cast
      ? details.credits.cast.slice(0, 5).map((c) => c.name)
      : undefined,
    director: details.credits?.crew
      ? details.credits.crew
          .filter((c) => c.job === "Director")
          .map((c) => c.name)
      : undefined,
  };

  // Para séries, adicionar episódios
  if (type === "series" && details.seasons) {
    const videos = [];

    for (const season of details.seasons) {
      if (season.season_number === 0) continue; // Pular "Specials"

      const seasonData = await tmdbSeasonDetails(tmdbId, season.season_number);
      if (seasonData && seasonData.episodes) {
        for (const ep of seasonData.episodes) {
          videos.push({
            id: `tmdb:${tmdbId}:${season.season_number}:${ep.episode_number}`,
            title: ep.name || `Episódio ${ep.episode_number}`,
            season: season.season_number,
            episode: ep.episode_number,
            thumbnail: ep.still_path
              ? `${TMDB_IMG}/w300${ep.still_path}`
              : undefined,
            released: ep.air_date
              ? new Date(ep.air_date).toISOString()
              : undefined,
            overview: ep.overview || undefined,
          });
        }
      }
    }

    meta.videos = videos;
  }

  return { meta };
});

// ============================================================
// HANDLER: STREAM
// ============================================================

builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[STREAM] ${type} ${id}`);

  let tmdbId, season, episode;

  const parts = id.replace("tmdb:", "").split(":");
  tmdbId = parts[0];
  season = parts[1] || null;
  episode = parts[2] || null;

  // Buscar IMDb ID e título
  const details = await tmdbDetails(type, parseInt(tmdbId));
  const imdbId = details?.external_ids?.imdb_id || null;
  const title = details?.title || details?.name || "";
  const year = (details?.release_date || details?.first_air_date || "").substring(0, 4);

  const streams = await findStreams(
    type,
    tmdbId,
    imdbId,
    title,
    year,
    season,
    episode
  );

  return { streams };
});

// ============================================================
// INICIAR
// ============================================================

async function start() {
  console.log("===========================================");
  console.log("  REFLUX BR v2.0 - Addon para Stremio");
  console.log("===========================================");

  // Testar TMDB
  try {
    const test = await tmdbPopular("movie", 1);
    console.log(`[TMDB] OK - ${test.length} filmes populares carregados`);
  } catch (e) {
    console.error(`[TMDB] ERRO - verifique a chave: ${e.message}`);
  }

  serveHTTP(builder.getInterface(), { port: PORT });

  console.log(`\nServidor rodando na porta ${PORT}`);
  console.log(`Manifest: http://localhost:${PORT}/manifest.json`);
  console.log();
}

start().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
