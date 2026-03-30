const http = require("http");
const https = require("https");
const { URL } = require("url");

const PORT = process.env.PROXY_PORT || 3001;

const server = http.createServer((req, res) => {
  // CORS preflight
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  const params = new URL(req.url, `http://localhost:${PORT}`);
  const targetUrl = params.searchParams.get("url");

  if (!targetUrl) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Missing ?url= parameter");
    return;
  }

  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Invalid URL");
    return;
  }

  const client = target.protocol === "https:" ? https : http;

  const headers = {
    referer: target.origin,
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    origin: target.origin,
  };

  // Pass Range header for seeking support
  if (req.headers.range) {
    headers.range = req.headers.range;
  }

  const proxyReq = client.request(
    target,
    {
      method: req.method,
      headers,
      timeout: 30000,
    },
    (proxyRes) => {
      // Handle redirects by proxying them too
      if (
        proxyRes.statusCode >= 300 &&
        proxyRes.statusCode < 400 &&
        proxyRes.headers.location
      ) {
        const redirectUrl = proxyRes.headers.location;
        res.writeHead(302, {
          Location: `http://localhost:${PORT}?url=${encodeURIComponent(redirectUrl)}`,
          "Access-Control-Allow-Origin": "*",
        });
        res.end();
        return;
      }

      // Forward response headers
      const responseHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
      };

      // Copy relevant headers
      const copyHeaders = [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
        "content-disposition",
      ];

      for (const h of copyHeaders) {
        if (proxyRes.headers[h]) {
          responseHeaders[h] = proxyRes.headers[h];
        }
      }

      // Default content type for video
      if (!responseHeaders["content-type"]) {
        responseHeaders["content-type"] = "video/mp4";
      }

      res.writeHead(proxyRes.statusCode, responseHeaders);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (err) => {
    console.error(`[PROXY] Error: ${err.message} for ${targetUrl}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Proxy error: ${err.message}`);
    }
  });

  proxyReq.on("timeout", () => {
    proxyReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { "Content-Type": "text/plain" });
      res.end("Proxy timeout");
    }
  });

  proxyReq.end();
});

server.listen(PORT, () => {
  console.log(`[PROXY] Proxy de vídeo rodando em http://localhost:${PORT}`);
  console.log(`[PROXY] Uso: http://localhost:${PORT}?url=<URL_DO_VIDEO>`);
});
