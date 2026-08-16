const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const net = require('net');
const dns = require('dns');
const analysisWorker = require('./analysis-worker.js');
const apiRouter = require('./api-server.js');
const networkScanner = require('./network-scanner.js'); // New import
const { sanitizeHost, probeTarget } = require('./network-utils.js');
const app = express();
// Enable reverse proxy support (Crucial for Coolify / Traefik / Nginx)
app.set('trust proxy', true);

// In-memory store for advanced analysis history
const analysisHistory = [];

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Helper to extract clean WAN IP
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.headers['cf-connecting-ip'] || 
         req.headers['x-real-ip'] || 
         req.ip || 
         req.socket.remoteAddress || 
         'Unknown';
}

// Native CORS Middleware
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const isAllowedOrigin = origin && (
    origin === 'https://it.ai-daily.uk' || 
    /^https:\/\/[a-zA-Z0-9-]+\.ai-daily\.uk$/.test(origin)
  );

  // When 'Access-Control-Allow-Credentials' is true, the origin cannot be '*'.
  // We only set the header if the origin is in our allowlist.
  if (isAllowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Direct REST API route for IP retrieval
app.get('/api/ip', (req, res) => {
  res.json({ ip: getClientIp(req) });
});

// Serve static files
app.use(express.static(__dirname));

// Mount the new API router
app.use('/api/v1', apiRouter);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const tracerouteCache = {};

let speedCache = {
  downloadSpeed: 0,
  uploadSpeed: 0,
  isTesting: false,
  status: 'Idle'
};

// In-memory store for rate limiting per client IP
const clientRateLimits = new Map();

// Rate limiting configuration
// Note: These values are for demonstration. Adjust for production as needed.
const RATE_LIMIT_CONFIG = {
  PING: { windowMs: 2000, max: 1, message: 'Too many ping requests. Please wait.' }, // 1 ping per 2 seconds
  PORT_SCAN: { windowMs: 10000, max: 1, message: 'Too many port scan requests. Please wait.' }, // 1 scan per 10 seconds
  LOCAL_NETWORK_SCAN: { windowMs: 30000, max: 1, message: 'Too many local network scan requests. Please wait.' }, // 1 scan per 30 seconds
  ADVANCED_SCAN: { windowMs: 15000, max: 1, message: 'Too many advanced domain scan requests. Please wait.' }, // 1 scan per 15 seconds
};

// Generic rate limiter for WebSocket messages
function checkRateLimit(clientIp, actionType, broadcast) {
  const config = RATE_LIMIT_CONFIG[actionType];
  if (!config) return true; // No rate limit defined for this action

  const now = Date.now();
  let clientData = clientRateLimits.get(clientIp);

  if (!clientData) {
    clientData = {};
    clientRateLimits.set(clientIp, clientData);
  }

  const lastRequestTime = clientData[actionType] || 0;

  if (now - lastRequestTime < config.windowMs) {
    console.warn(`Rate limit exceeded for IP ${clientIp}, action ${actionType}.`);
    broadcast({ type: 'RATE_LIMIT_EXCEEDED', data: { message: config.message, action: actionType } });
    return false; // Rate limit exceeded
  }

  // Update last request time
  clientData[actionType] = now;
  // Clean up old client data periodically to prevent memory leak
  setTimeout(() => { if (clientRateLimits.get(clientIp) === clientData) delete clientData[actionType]; }, config.windowMs * 2);
  return true; // Request allowed
}

wss.on('connection', (ws, req) => {
  // Capture client's public WAN IP address on connection
  const clientWanIp = getClientIp(req);

  let targets = {
    rank1: 'google.com',
    rank2: 'bbc.co.uk'
  };

  Object.values(targets).forEach(runTraceroute);
  const localNetworkInfo = networkScanner.getLocalNetworkInfo(); // Use new function
  const dnsServers = dns.getServers();

  const broadcastCurrent = (msgObj) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msgObj));
    }
  };

  // Fetch IP details and send initial static data once on connection
  broadcastCurrent({
    publicIp: clientWanIp,
    serverGatewayIp: localNetworkInfo.ip.split('.').slice(0,3).join('.') + '.1', // Server's inferred gateway IP
    localIp: localNetworkInfo.ip, // New: Server's local IP
    localSubnet: localNetworkInfo.subnet, // New: Server's inferred local subnet
    wan: { isp: 'Detecting...', country: 'WAN' },
    dnsServer: dnsServers.length > 0 ? dnsServers[0] : null
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log(`Received WS message from ${clientWanIp}:`, data.type);

      // Apply rate limiting based on message type
      let actionType;
      switch (data.type) {
        case 'RUN_NETWORK_PING':
        case 'RUN_GATEWAY_PING':
          actionType = 'PING';
          break;
        case 'RUN_TCP_PORT_SCAN':
        case 'RUN_GATEWAY_PORT_SCAN':
          actionType = 'PORT_SCAN';
          break;
        case 'RUN_LOCAL_NETWORK_SCAN':
          actionType = 'LOCAL_NETWORK_SCAN';
          break;
        case 'RUN_ADVANCED_SCAN':
          actionType = 'ADVANCED_SCAN';
          break;
      }

      if (actionType && !checkRateLimit(clientWanIp, actionType, broadcastCurrent)) {
        console.log(`Request for ${data.type} from ${clientWanIp} blocked by rate limit.`);
        return; // Rate limit exceeded, do not process request
      }

      if (data.type === 'SET_TARGET_RANK2' && data.target) {
        const clean = sanitizeHost(data.target);
        targets.rank2 = clean;
        runTraceroute(clean);
      } else if (data.type === 'RUN_PORT_SCAN') {
        runPortScan(clientWanIp, broadcastCurrent, data.data?.range, 'PORT_SCAN_RESULT');
      } else if (data.type === 'RUN_NETWORK_PING') { // Remote Ping
        const target = sanitizeHost(data.target);
        probeTarget(target).then(result => {
          broadcastCurrent({ type: 'NETWORK_PING_RESULT', data: { ...result, target: target } });
        });
      } else if (data.type === 'RUN_GATEWAY_PING') { // Local Ping (to client-provided gateway)
        const target = sanitizeHost(data.target); // Use target provided by client
        probeTarget(target).then(result => {
          broadcastCurrent({ type: 'GATEWAY_PING_RESULT', data: { ...result, target: target } });
        });
      } else if (data.type === 'RUN_TCP_PORT_SCAN') { // Remote TCP Scan
        const target = sanitizeHost(data.target);
        const ports = data.ports;
        runPortScan(target, broadcastCurrent, ports, 'TCP_PORT_SCAN_RESULT_ADVANCED');
      } else if (data.type === 'RUN_GATEWAY_PORT_SCAN') { // Local TCP Scan (to client-provided gateway)
        const target = sanitizeHost(data.target); // Use target provided by client
        const ports = data.ports;
        runPortScan(target, broadcastCurrent, ports, 'GATEWAY_PORT_SCAN_RESULT');
      } else if (data.type === 'RUN_LOCAL_NETWORK_SCAN') { // New: Local Network Scan
        const subnet = data.subnet || localNetworkInfo.subnet;
        networkScanner.scanLocalNetwork(subnet, broadcastCurrent).then(devices => { // Pass broadcastCurrent
          broadcastCurrent({ type: 'LOCAL_NETWORK_SCAN_RESULT', data: { subnet: subnet, devices: devices } });
        }).catch(err => {
          console.error('Local network scan error:', err);
          // Ensure the client knows the scan failed and can re-enable buttons
          broadcastCurrent({ type: 'LOCAL_NETWORK_SCAN_RESULT', data: { error: err.message, subnet: subnet } });
        });
      } else if (data.type === 'GET_ANALYSIS_HISTORY') {
        broadcastCurrent({ type: 'ANALYSIS_HISTORY_DATA', data: analysisHistory });
      } else if (data.type === 'RUN_ADVANCED_SCAN' && data.domain) {
        const cleanDomain = sanitizeHost(data.domain);
        
        Promise.all([
          analysisWorker.runSubdomainSearch(cleanDomain),
          analysisWorker.runMxLookup(cleanDomain),
          analysisWorker.getSslInfo(cleanDomain)
        ]).then(([subdomainResult, mxResult, sslResult]) => {
          broadcastCurrent({ type: 'SUBDOMAIN_RESULT', data: subdomainResult });
          broadcastCurrent({ type: 'MX_RESULT', data: mxResult });
          broadcastCurrent({ type: 'SSL_RESULT', data: sslResult });

          // Store the simplified result in history
          if (!subdomainResult.error || !mxResult.error || !sslResult.error) {
              analysisHistory.push({
                timestamp: new Date().toISOString(),
                domain: cleanDomain,
                subdomain_count: subdomainResult.count || 0,
                subdomains: subdomainResult.subdomains?.join(', ') || 'N/A',
                mx_records: mxResult.records?.map(r => r.exchange).join(', ') || 'N/A',
                ssl_issuer: sslResult.issuer || 'N/A',
                ssl_expiry: sslResult.valid_to || 'N/A'
              });
            }
          })
          .catch(err => {
            broadcastCurrent({ type: 'ADVANCED_SCAN_ERROR', data: { error: err.message, domain: cleanDomain } });
          });
      }
    } catch (e) {
      console.error('Payload error:', e);
    }
  });

  const timer = setInterval(async () => {
    try {
      const wifiModes = [
        { type: '5G Wi-Fi', ping: (0.4 + Math.random() * 0.8).toFixed(1), state: 'green' },
        { type: '2.4G Wi-Fi', ping: (2.1 + Math.random() * 3.5).toFixed(1), state: 'green' },
        { type: 'LAN Cable', ping: (0.2 + Math.random() * 0.3).toFixed(1), state: 'green' },
      ];

      const mode1 = wifiModes[Math.floor(Math.random() * wifiModes.length)];
      const mode2 = wifiModes[Math.floor(Math.random() * wifiModes.length)];
      const routerProc = (0.1 + Math.random() * 0.3).toFixed(1);

      const p1_res = await probeTarget(targets.rank1);
      const p2_res = await probeTarget(targets.rank2);

      broadcastCurrent({
        bandwidth: speedCache,
        rank1: { 
          link1: mode1, 
          b2: routerProc, 
          b3: p1_res.success ? p1_res.latency : -1, 
          hops: tracerouteCache[targets.rank1] || 6, 
          target: targets.rank1,
        },
        rank2: { 
          link1: mode2, 
          b2: routerProc, 
          b3: p2_res.success ? p2_res.latency : -1, 
          hops: tracerouteCache[targets.rank2] || 8, 
          target: targets.rank2,
        }
      });
    } catch (err) {
      console.error('Probe error:', err);
    }
  }, 2500);

  ws.on('close', () => clearInterval(timer));
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`Traceroute server active at http://${HOST}:${PORT}`);
});
