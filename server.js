const express = require('express');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const cluster = require('cluster');
const os = require('os');
const https = require('https');
const http = require('http');
const { URL } = require('url');
// npm install mime-types

// -------------------------------------------------------------------
// Configuration
// -------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS) || 30000;
const MAX_REDIRECTS = 20;
const RETRY_COUNT = 3;

// Keep-alive agents for performance
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 1000, maxFreeSockets: 100 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 1000, maxFreeSockets: 100 });

// -------------------------------------------------------------------
// Cluster Master
// -------------------------------------------------------------------
if (cluster.isPrimary) {
    const numCPUs = os.cpus().length || 2;
    console.log(`🔥 MASTER ${process.pid} running with ${numCPUs} workers`);

    for (let i = 0; i < numCPUs; i++) cluster.fork();

    cluster.on('exit', (worker) => {
        console.log(`⚠️ Worker ${worker.process.pid} died. Respawning...`);
        setTimeout(() => cluster.fork(), 3000);
    });
    return;
}

// -------------------------------------------------------------------
// Worker: Express App
// -------------------------------------------------------------------
const app = express();

// Axios retry
axiosRetry(axios, {
    retries: RETRY_COUNT,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => axiosRetry.isNetworkOrIdempotentRequestError(error) || error.response?.status >= 500,
});

// -------------------------------------------------------------------
// CORS & Global Headers
// -------------------------------------------------------------------
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Range, Cache-Control, Pragma');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition, ETag, Last-Modified');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
    res.setHeader('Timing-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// Health check
app.get('/health', (req, res) => res.send('✅ Smart Proxy Online'));

// -------------------------------------------------------------------
// HTML5 Player (with better HLS.js configuration)
// -------------------------------------------------------------------
const playerHtml = (streamUrl) => `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Smart Player</title>
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body, html { width:100%; height:100%; background:#000; overflow:hidden; }
        video { width:100%; height:100%; object-fit:contain; }
    </style>
    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
</head>
<body>
    <video id="video" controls playsinline crossorigin="anonymous"></video>
    <script>
        const video = document.getElementById('video');
        const src = "${streamUrl}";
        if (Hls.isSupported()) {
            const hls = new Hls({
                maxBufferLength: 30,
                maxMaxBufferLength: 600,
            });
            hls.loadSource(src);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(e => {}));
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = src;
            video.addEventListener('loadedmetadata', () => video.play().catch(e => {}));
        }
    </script>
</body>
</html>
`;

// -------------------------------------------------------------------
// Helper: Rewrite HLS Manifest
// -------------------------------------------------------------------
function rewriteHlsManifest(content, proxyBaseUrl, originalUrl) {
    const lines = content.split('\n');
    const baseUrl = originalUrl.substring(0, originalUrl.lastIndexOf('/') + 1);

    const rewritten = lines.map(line => {
        // Skip empty lines and comments (except those with URI attributes)
        if (!line.trim()) return line;

        // If it's a tag, check for URI attribute
        if (line.startsWith('#')) {
            // Rewrite any URI="..." attribute
            let newLine = line;
            const uriMatches = line.match(/URI="([^"]*)"/g);
            if (uriMatches) {
                uriMatches.forEach(match => {
                    const originalUri = match.slice(5, -1); // remove URI=" and "
                    const resolvedUri = originalUri.startsWith('http') ? originalUri : new URL(originalUri, baseUrl).href;
                    const proxiedUri = `${proxyBaseUrl}${resolvedUri}`;
                    newLine = newLine.replace(match, `URI="${proxiedUri}"`);
                });
            }
            // Also handle EXT-X-STREAM-INF (URI on next line) – we'll handle below
            return newLine;
        } else {
            // It's a plain URL (segment, key, or variant)
            if (line.startsWith('http')) {
                return `${proxyBaseUrl}${line}`;
            } else {
                const resolved = new URL(line, baseUrl).href;
                return `${proxyBaseUrl}${resolved}`;
            }
        }
    });

    // Handle EXT-X-STREAM-INF: the URI is on the next line after the tag
    // We'll do a second pass to rewrite URIs that are on lines after a tag
    // But since we already rewrite every non-tag line, it's already done.
    // However, we must ensure we don't rewrite lines that are part of a tag's attribute (already done).

    return rewritten.join('\n');
}

// -------------------------------------------------------------------
// Helper: Rewrite DASH MPD
// -------------------------------------------------------------------
async function rewriteDashManifest(xmlContent, proxyBaseUrl, originalUrl) {
    const parser = new xml2js.Parser({ explicitArray: false });
    const builder = new xml2js.Builder();
    const parsed = await parser.parseStringPromise(xmlContent);

    const baseUrl = originalUrl.substring(0, originalUrl.lastIndexOf('/') + 1);

    // Recursively traverse object to find URL fields
    function rewriteUrls(obj) {
        if (!obj || typeof obj !== 'object') return;
        for (const key of Object.keys(obj)) {
            if (typeof obj[key] === 'string') {
                // Check if it looks like a URL (starts with http or relative)
                const val = obj[key];
                if (val.startsWith('http') || val.startsWith('/') || (!val.startsWith('#') && val.includes('.'))) {
                    // Rewrite only if it's a URL-like string in specific elements
                    if (['BaseURL', 'media', 'initialization', 'mediaRange', 'indexRange'].includes(key)) {
                        const resolved = val.startsWith('http') ? val : new URL(val, baseUrl).href;
                        obj[key] = `${proxyBaseUrl}${resolved}`;
                    }
                }
            } else if (typeof obj[key] === 'object') {
                rewriteUrls(obj[key]);
            }
        }
    }

    rewriteUrls(parsed);
    return builder.buildObject(parsed);
}

// -------------------------------------------------------------------
// Proxy Handler
// -------------------------------------------------------------------
app.get('/*', async (req, res) => {
    const fullUrl = req.url.slice(1); // remove leading /
    const targetUrl = fullUrl; // we don't use raw flag anymore (separate endpoint)

    if (!targetUrl || !targetUrl.startsWith('http')) {
        return res.status(400).json({ error: 'Missing or invalid URL' });
    }

    const isBrowser = req.headers.accept && req.headers.accept.includes('text/html');
    const isM3u8 = targetUrl.includes('.m3u8');
    const isMpd = targetUrl.includes('.mpd');

    // Player for browser HLS
    if (isBrowser && isM3u8 && !req.query.raw) {
        const playerSrc = req.originalUrl + (req.originalUrl.includes('?') ? '&' : '?') + 'raw=true';
        res.setHeader('Content-Type', 'text/html');
        return res.send(playerHtml(playerSrc));
    }

    // Determine if we need to rewrite
    const shouldRewrite = isM3u8 || isMpd;

    // Build proxy base URL (scheme + host)
    const proxyBase = `${req.protocol}://${req.get('host')}/`;

    try {
        // Prepare headers (forward relevant ones)
        const headers = {
            'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (compatible; SmartProxy)',
            'Accept': req.headers['accept'] || '*/*',
            'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
            'Connection': 'keep-alive',
        };
        if (req.headers.range) headers['Range'] = req.headers.range;
        if (req.headers.authorization) headers['Authorization'] = req.headers.authorization;
        if (req.headers.cookie) headers['Cookie'] = req.headers.cookie;

        const responseType = shouldRewrite ? 'text' : 'stream';
        const response = await axios.get(targetUrl, {
            headers,
            responseType,
            maxRedirects: MAX_REDIRECTS,
            timeout: TIMEOUT_MS,
            httpAgent,
            httpsAgent,
            decompress: false, // don't decompress automatically
            validateStatus: (status) => status < 400,
        });

        // Handle HEAD requests (we are in GET, but we can support HEAD via separate route)
        // We'll implement HEAD separately.

        if (shouldRewrite) {
            let content = response.data;
            if (typeof content !== 'string') content = content.toString();

            let rewritten;
            if (isM3u8) {
                rewritten = rewriteHlsManifest(content, proxyBase, targetUrl);
                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            } else if (isMpd) {
                rewritten = await rewriteDashManifest(content, proxyBase, targetUrl);
                res.setHeader('Content-Type', 'application/dash+xml');
            }
            // Cache control for manifests
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            return res.send(rewritten);
        }

        // Stream other content (segments, keys, etc.)
        res.status(response.status);

        // Forward relevant headers
        const forwardHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control'];
        for (const h of forwardHeaders) {
            if (response.headers[h]) res.setHeader(h, response.headers[h]);
        }
        // Set default content-type if missing
        if (!response.headers['content-type']) {
            const ext = targetUrl.split('.').pop().toLowerCase();
            const ct = mime.lookup(ext) || 'application/octet-stream';
            res.setHeader('Content-Type', ct);
        }

        // Enable caching for segments (if not a manifest)
        if (!res.getHeader('Cache-Control')) {
            res.setHeader('Cache-Control', 'public, max-age=86400');
        }

        // Pipe response data (stream) to client
        response.data.pipe(res);

        req.on('close', () => {
            response.data.destroy();
        });

    } catch (error) {
        const status = error.response?.status || 500;
        if (status >= 500) console.error(`[Worker ${process.pid}] Error fetching ${targetUrl}:`, error.message);
        if (!res.headersSent) {
            res.status(status).json({ error: 'Proxy error', message: error.message });
        }
    }
});

// -------------------------------------------------------------------
// HEAD support
// -------------------------------------------------------------------
app.head('/*', async (req, res) => {
    const targetUrl = req.url.slice(1);
    if (!targetUrl || !targetUrl.startsWith('http')) {
        return res.status(400).end();
    }
    try {
        const headers = {
            'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
            'Accept': req.headers['accept'] || '*/*',
        };
        if (req.headers.authorization) headers['Authorization'] = req.headers.authorization;
        if (req.headers.cookie) headers['Cookie'] = req.headers.cookie;

        const response = await axios.head(targetUrl, {
            headers,
            maxRedirects: MAX_REDIRECTS,
            timeout: TIMEOUT_MS,
            httpAgent,
            httpsAgent,
            validateStatus: (status) => status < 400,
        });
        res.status(response.status);
        for (const h of ['content-type', 'content-length', 'accept-ranges', 'etag', 'last-modified', 'cache-control']) {
            if (response.headers[h]) res.setHeader(h, response.headers[h]);
        }
        res.end();
    } catch (error) {
        const status = error.response?.status || 500;
        if (!res.headersSent) res.status(status).end();
    }
});

// -------------------------------------------------------------------
// Start Server
// -------------------------------------------------------------------
app.listen(PORT, () => {
    console.log(`[Worker ${process.pid}] Smart Proxy listening on port ${PORT}`);
});
