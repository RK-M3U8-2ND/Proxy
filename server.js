const express = require('express');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const cluster = require('cluster');
const os = require('os');
const https = require('https');
const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 8080;
const TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 15;

// Optimization: Keep sockets open
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 1000, maxFreeSockets: 100 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 1000, maxFreeSockets: 100 });

// -------------------------------------------------------------------
// CLUSTER MASTER: Fork workers and handle respawn
// -------------------------------------------------------------------
if (cluster.isPrimary) {
    const numCPUs = os.cpus().length || 4;
    console.log(`🔥 PROXY V5 (BROWSER FIX): Master ${process.pid} running`);

    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    cluster.on('exit', (worker) => {
        console.log(`⚠️ Worker ${worker.process.pid} died. Respawning...`);
        setTimeout(() => cluster.fork(), 5000);
    });
} else {
    // -------------------------------------------------------------------
    // WORKER: Express app
    // -------------------------------------------------------------------
    const app = express();

    // Resilience: Retry only on network errors
    axiosRetry(axios, {
        retries: 3,
        retryDelay: axiosRetry.exponentialDelay,
        retryCondition: (error) => axiosRetry.isNetworkOrIdempotentRequestError(error)
    });

// Global CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Range, Cache-Control, Pragma, Referer, User-Agent, DNT, If-Modified-Since, Keep-Alive');
    res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Type, Content-Range, Accept-Ranges, Content-Disposition, ETag, Last-Modified, Cache-Control');
    res.header('Access-Control-Max-Age', '86400');
    res.header('Cross-Origin-Resource-Policy', 'cross-origin');
    res.header('Cross-Origin-Embedder-Policy', 'unsafe-none');
    res.header('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.header('Timing-Allow-Origin', '*');

    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

    app.get('/health', (req, res) => res.send('🔥 PROXY ONLINE'));

    // -------------------------------------------------------------------
    // HTML5 PLAYER GENERATOR (based on server1.js, no spinner)
    // -------------------------------------------------------------------
    const getHtmlPlayer = (streamUrl) => `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
            <title>FANCOD Player</title>
            <style>
                /* Reset & Fullscreen Fit */
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body, html { width: 100%; height: 100%; background-color: #000; overflow: hidden; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }

                #video-container { width: 100%; height: 100%; position: relative; display: flex; justify-content: center; align-items: center; background: #0a0a0a; }

                /* The Video Element */
                video { width: 100%; height: 100%; object-fit: contain; outline: none; z-index: 5; }

                /* Custom RK Watermark */
                .watermark { position: absolute; top: 15px; left: 15px; z-index: 10; color: rgba(255, 255, 255, 0.6); font-size: 13px; font-weight: 800; letter-spacing: 1px; pointer-events: none; text-shadow: 1px 1px 3px rgba(0,0,0,0.8); }
                .watermark span { color: #00ff00; }
            </style>
            <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
        </head>
        <body>
            <div id="video-container">
                <div class="watermark">FANCOD <span>·</span> RK</div>
                <video id="video" controls playsinline crossorigin="anonymous"></video>
            </div>

            <script>
                const video = document.getElementById('video');
                const videoSrc = "${streamUrl}";

                // HLS Engine with recovery and buffering optimizations
                if (Hls.isSupported()) {
                    const hls = new Hls({
                        maxBufferLength: 30,
                        maxMaxBufferLength: 600,
                    });

                    hls.config.xhrSetup = function(xhr, url) {
                        xhr.withCredentials = false;
                    };

                    hls.loadSource(videoSrc);
                    hls.attachMedia(video);

                    hls.on(Hls.Events.MANIFEST_PARSED, function() {
                        video.play().catch(e => console.log("Autoplay blocked by browser policy"));
                    });

                    hls.on(Hls.Events.ERROR, function(event, data) {
                        if (data.fatal) {
                            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                                hls.startLoad();
                            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                                hls.recoverMediaError();
                            } else {
                                hls.destroy();
                            }
                        }
                    });
                } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                    // Native Safari / iOS fallback
                    video.src = videoSrc;
                    video.addEventListener('loadedmetadata', function() {
                        video.play().catch(e => console.log("Autoplay blocked"));
                    });
                }
            </script>
        </body>
        </html>
    `;

    // -------------------------------------------------------------------
    // MAIN PROXY HANDLER
    // -------------------------------------------------------------------
    app.get('/*', async (req, res) => {
        let rawRequest = req.url.slice(1);
        const wantsRaw = rawRequest.includes('raw=true');
        // Clean the internal flag from the target URL
        let targetUrl = rawRequest.replace(/[?&]raw=true/, '');

        if (!targetUrl || !targetUrl.startsWith('http')) {
            if (targetUrl.includes('favicon')) return res.status(404).end();
            return res.status(400).json({ error: 'Invalid URL' });
        }

        const isM3u8 = targetUrl.includes('.m3u8');
        const isBrowser = req.headers.accept && req.headers.accept.includes('text/html');

        // 1. SERVE PLAYER (if browser + m3u8 + no raw flag)
        if (isBrowser && isM3u8 && !wantsRaw) {
            const separator = req.originalUrl.includes('?') ? '&' : '?';
            const playerSrc = req.originalUrl + separator + 'raw=true';
            res.setHeader('Content-Type', 'text/html');
            return res.send(getHtmlPlayer(playerSrc));
        }

        try {
        // 2. PREPARE HEADERS (Chrome Stealth Mode)
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'keep-alive'
        };

            if (req.headers.range) headers['Range'] = req.headers.range;

            const responseType = isM3u8 ? 'text' : 'stream';

            console.log(`[Worker ${process.pid}] Fetching: ${targetUrl}`);

            const response = await axios.get(targetUrl, {
                headers,
                responseType: responseType,
                maxRedirects: MAX_REDIRECTS,
                timeout: TIMEOUT_MS,
                httpAgent: httpAgent,
                httpsAgent: httpsAgent,
                decompress: false,
                validateStatus: (status) => status < 400
            });

            // 3. MANIFEST REWRITER (force HTTPS via proxy)
            if (isM3u8) {
                const targetBaseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
                const currentProtocol = req.headers['x-forwarded-proto'] === 'https' ? 'https' : req.protocol;
                const currentHost = req.headers.host;
                const proxyBase = `${currentProtocol}://${currentHost}/`;

                let m3u8Content = response.data;
                if (typeof m3u8Content !== 'string') m3u8Content = m3u8Content.toString();

                const rewrittenM3u8 = m3u8Content.split('\n').map(line => {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) return line;
                    const absoluteUrl = trimmed.startsWith('http')
                        ? trimmed
                        : url.resolve(targetBaseUrl, trimmed);
                    return `${proxyBase}${absoluteUrl}`;
                }).join('\n');

                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                res.send(rewrittenM3u8);
                return;
            }

            // 4. STREAM DATA (TS Segments)
            res.status(response.status);

            // Forward safe headers
            const headersToForward = ['content-length', 'content-range', 'accept-ranges', 'content-type'];
            Object.entries(response.headers).forEach(([key, value]) => {
                if (headersToForward.includes(key.toLowerCase())) res.setHeader(key, value);
            });

            // Fix Content-Type for TS
            if (targetUrl.includes('.ts')) res.setHeader('Content-Type', 'video/MP2T');

            res.removeHeader('Content-Disposition');
            response.data.pipe(res);

            req.on('close', () => response.data.destroy && response.data.destroy());

        } catch (error) {
            const status = error.response?.status || 500;
            if (status !== 404) console.error(`[Worker ${process.pid}] Error: ${error.message}`);
            if (!res.headersSent) res.status(status).end();
        }
    });

    // -------------------------------------------------------------------
    // START SERVER
    // -------------------------------------------------------------------
    app.listen(PORT, () => {
        console.log(`[Worker ${process.pid}] Listening on port ${PORT}`);
    });
}