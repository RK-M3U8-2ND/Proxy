const express = require('express');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const cluster = require('cluster');
const os = require('os');
const https = require('https');
const http = require('http');

// -------------------------------------------------------------------
// Configuration
// -------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
const TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 20;

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 1000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 1000 });

// -------------------------------------------------------------------
// Cluster Master
// -------------------------------------------------------------------
if (cluster.isPrimary) {
    const numCPUs = os.cpus().length || 2;
    console.log(`🌐 MASTER ${process.pid} running with ${numCPUs} workers`);
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
    retries: 3,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => axiosRetry.isNetworkOrIdempotentRequestError(error) || error.response?.status >= 500,
});

// -------------------------------------------------------------------
// CORS Middleware
// -------------------------------------------------------------------
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Range, Cache-Control, Pragma');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition, ETag, Last-Modified');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// Health
app.get('/health', (req, res) => res.send('✅ CORS Proxy Online'));

// -------------------------------------------------------------------
// Proxy Handler – All Methods
// -------------------------------------------------------------------
app.all('/*', async (req, res) => {
    const targetUrl = req.url.slice(1);
    if (!targetUrl || !targetUrl.startsWith('http')) {
        return res.status(400).json({ error: 'Invalid or missing URL' });
    }

    try {
        // Forward all headers except host/connection
        const headers = { ...req.headers };
        delete headers['host'];
        delete headers['connection'];
        // Keep 'accept-encoding' if needed, but we use decompress: false
        // Also remove 'content-length' as axios will set it from body
        delete headers['content-length'];

        const requestOptions = {
            method: req.method,
            url: targetUrl,
            headers,
            data: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
            maxRedirects: MAX_REDIRECTS,
            timeout: TIMEOUT_MS,
            httpAgent,
            httpsAgent,
            decompress: false,
            validateStatus: (status) => status < 400,
            responseType: 'stream', // always stream
        };

        const response = await axios(requestOptions);

        res.status(response.status);

        // Forward all headers from upstream, except those we override
        for (const [key, value] of Object.entries(response.headers)) {
            // Skip 'content-encoding' because we use decompress: false (raw)
            if (key.toLowerCase() === 'content-encoding') continue;
            res.setHeader(key, value);
        }

        // Pipe stream
        response.data.pipe(res);

        req.on('close', () => {
            response.data.destroy();
        });

    } catch (error) {
        const status = error.response?.status || 500;
        if (status >= 500) console.error(`[Worker ${process.pid}] Error:`, error.message);
        if (!res.headersSent) {
            res.status(status).json({ error: 'Proxy error', message: error.message });
        }
    }
});

// -------------------------------------------------------------------
// Start
// -------------------------------------------------------------------
app.listen(PORT, () => {
    console.log(`[Worker ${process.pid}] CORS Proxy listening on port ${PORT}`);
});
