/**
 * Ori Local CORS Proxy
 * Run: node local-proxy.js
 * Forwards API requests from the dashboard to Replicate / Instagram Graph API / Anthropic
 * Also provides /imgup endpoint to re-host images for Instagram (which can't fetch Replicate CDN URLs)
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = 4001;

// Download a URL and return its content as a Buffer + content-type
function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    mod.get(parsed, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect once
        return fetchBuffer(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ data: Buffer.concat(chunks), type: res.headers['content-type'] || 'image/webp' }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Upload a buffer to catbox.moe (free, no-auth, 200MB limit, permanent URLs)
function uploadToCatbox(imageBuffer, contentType) {
  return new Promise((resolve, reject) => {
    const boundary = '----FormBoundary' + Math.random().toString(16).slice(2);
    const ext = contentType.includes('png') ? 'png' : contentType.includes('gif') ? 'gif' : 'jpg';
    const filename = `ori-${Date.now()}.${ext}`;

    // catbox.moe multipart: reqtype field + file field
    const part1 = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="reqtype"\r\n\r\nfileupload\r\n`
    );
    const part2 = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="fileToUpload"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([part1, part2, imageBuffer, footer]);

    const options = {
      hostname: 'catbox.moe',
      path: '/user/api.php',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        'User-Agent': 'Ori-Dashboard/1.0',
      },
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        const url = raw.trim();
        if (url.startsWith('https://')) {
          resolve(url);
        } else {
          reject(new Error('catbox.moe upload failed: ' + url));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── /imgup — Download image from URL, re-host publicly for Instagram ──────────
  if (req.method === 'POST' && req.url === '/imgup') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { url } = JSON.parse(body);
        console.log(`  📸 Downloading image from Replicate...`);
        const { data, type } = await fetchBuffer(url);
        console.log(`  ⬆️  Uploading ${Math.round(data.length/1024)}KB to catbox.moe...`);
        const publicUrl = await uploadToCatbox(data, type);
        console.log(`  ✅ Public URL: ${publicUrl}`);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ url: publicUrl }));
      } catch (err) {
        console.error('  ❌ imgup error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── /proxy — Generic HTTPS proxy for Replicate, Instagram, Claude, etc. ───────
  if (req.method === 'POST' && req.url === '/proxy') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { url, method = 'GET', headers = {}, body: reqBody } = JSON.parse(body);
        const parsed = new URL(url);
        const mod = parsed.protocol === 'https:' ? https : http;

        const proxyReq = mod.request(parsed, {
          method,
          headers: { ...headers, 'Content-Type': headers['Content-Type'] || 'application/json' },
        }, proxyRes => {
          const chunks = [];
          proxyRes.on('data', c => chunks.push(c));
          proxyRes.on('end', () => {
            const raw = Buffer.concat(chunks);
            const ct = proxyRes.headers['content-type'] || 'application/json';
            // For binary responses (images), return as base64 JSON to avoid corruption
            if (ct.startsWith('image/') || ct.includes('octet-stream')) {
              res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
              res.end(JSON.stringify({ base64: raw.toString('base64'), contentType: ct }));
            } else {
              res.writeHead(proxyRes.statusCode, {
                'Content-Type': ct,
                'Access-Control-Allow-Origin': '*',
              });
              res.end(raw.toString('utf8'));
            }
          });
        });

        proxyReq.on('error', err => {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });

        if (reqBody && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
          proxyReq.write(typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody));
        }
        proxyReq.end();
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request: ' + err.message }));
      }
    });
    return;
  }

  // ── Status page ───────────────────────────────────────────────────────────────
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'Ori Local Proxy running', port: PORT, endpoints: ['/proxy', '/imgup'] }));
});

server.listen(PORT, () => {
  console.log(`\n  🌸 Ori Local Proxy running on http://localhost:${PORT}`);
  console.log(`  /proxy  → forwards API calls (Replicate, Claude, Instagram)`);
  console.log(`  /imgup  → re-hosts images publicly for Instagram upload\n`);
});
