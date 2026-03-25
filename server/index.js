/**
 * KidneySphere API Server
 * Express wrapper for video access + play auth APIs.
 * Runs on Alibaba Cloud ECS behind Nginx reverse proxy.
 *
 * Usage:
 *   cp .env.example .env  # fill in your keys
 *   npm install
 *   node index.js         # or use PM2: pm2 start index.js --name ks-api
 */

require('dotenv').config();
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

// ── Adapter: convert Express req/res to Netlify event format ──
function netlifyAdapter(handlerFn) {
  return async (req, res) => {
    const event = {
      path: req.originalUrl.split('?')[0],
      httpMethod: req.method,
      headers: req.headers,
      queryStringParameters: req.query,
      body: req.body ? JSON.stringify(req.body) : null,
    };

    try {
      const result = await handlerFn(event);
      res.status(result.statusCode || 200);
      if (result.headers) {
        for (const [k, v] of Object.entries(result.headers)) {
          res.setHeader(k, v);
        }
      }
      res.send(result.body || '');
    } catch (err) {
      console.error('[API] handler error:', err);
      res.status(500).json({ error: 'internal_error', message: String(err?.message || err) });
    }
  };
}

// ── Load Netlify Function handlers ──
const videoAccess = require('../netlify/functions/video-access.js');
const videoPlayAuth = require('../netlify/functions/video-play-auth.js');
const devGrantAccess = require('../netlify/functions/dev-grant-access.js');

// ── Routes ──
app.get('/api/videos/:id/access', netlifyAdapter(videoAccess.handler));
app.post('/api/videos/:id/play-auth', netlifyAdapter(videoPlayAuth.handler));
app.post('/api/dev/grant-access', netlifyAdapter(devGrantAccess.handler));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[KS-API] Server running on http://127.0.0.1:${PORT}`);
  console.log(`[KS-API] SUPABASE_URL: ${process.env.SUPABASE_URL ? 'configured' : 'MISSING'}`);
  console.log(`[KS-API] ALIYUN_VOD: ${process.env.ALIYUN_VOD_ACCESS_KEY_ID ? 'configured' : 'not configured'}`);
});
