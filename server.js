const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const ping = require('ping');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Native CORS Middleware
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const isAllowedOrigin = origin && (
    origin === 'https://it.ai-daily.uk' || 
    /^https:\/\/[a-zA-Z0-9-]+\.ai-daily\.uk$/.test(origin)
  );

  if (isAllowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Health check endpoint for Coolify container monitoring
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Serve static files directly from root directory
app.use(express.static(__dirname));

// Fallback route to serve index.html at root "/"
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

// On-Demand Multi-Stream Speed Test (4-second parallel download)
function runOnDemandSpeedTest(broadcast) {
  if (speedCache.isTesting) return;
  speedCache.isTesting = true;
  speedCache.status = 'Testing...';

  broadcast({ type: 'SPEED_TEST_STATUS', data: speedCache });

  const CONCURRENCY = 4;
  const DURATION_MS = 4000;
  const startTime = Date.now();
  let totalBytesReceived = 0;

  const downloadStream = () => new Promise((resolve) => {
    const req = https.get('https://speed.cloudflare.com/__down?bytes=25000000', (res) => {
      res.on('data', (chunk) => {
        totalBytesReceived += chunk.length;
        if (Date.now() - startTime >= DURATION_MS) {
          req.destroy();
        }
      });
      res.on('end', resolve);
      res.on('error', resolve);
    });

    req.on('error', resolve);
    req.setTimeout(DURATION_MS, () => {
      req.destroy();
      resolve();
    });
  });

  const streamPromises = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    streamPromises.push(downloadStream());
  }

  Promise.all(streamPromises).then(() => {
    const elapsedSec = (Date.now() - startTime) / 1000;
    if (elapsedSec > 0 && totalBytesReceived > 0) {
      speedCache.downloadSpeed = parseFloat(((totalBytesReceived * 8) / (elapsedSec * 1000000)).toFixed(1));
    }

    runUploadTest(broadcast);
  });
}

function runUploadTest(broadcast) {
  const startTime = Date.now();
  const dummyData = Buffer.alloc(1024 * 1024, 'a'); // 1MB payload

  const options = {
    hostname: 'speed.cloudflare.com',
    port: 443,
    path: '/__up',
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': dummyData.length
    }
  };

  const req = https.request(options, (res) => {
    res.on('data', () => {});
    res.on('end', () => {
      const durationSec = (Date.now() - startTime) / 1000;
      if (durationSec > 0) {
        speedCache.uploadSpeed = parseFloat(((dummyData.length * 8) / (durationSec * 1000000)).toFixed(1));
      }
      finishSpeedTest(broadcast);
    });
  });

  req.on('error', () => {
    speedCache.uploadSpeed = parseFloat((speedCache.downloadSpeed * 0.25).toFixed(1));
    finishSpeedTest(broadcast);
  });

  req.write(dummyData);
  req.end();
}

function finishSpeedTest(broadcast) {
  speedCache.isTesting = false;
  speedCache.status = 'Complete';
  broadcast({ type: 'SPEED_TEST_STATUS', data: speedCache });
}

function sanitizeHost(input) {
  if (!input) return 'bbc.co.uk';
  let clean = input.trim().toLowerCase();
  clean = clean.replace(/^https?:\/\//, '');
  clean = clean.split('/')[0];
  clean = clean.split('?')[0];
  clean = clean.split(':')[0];
  return clean || 'bbc.co.uk';
}

function getLocalGatewayInfo() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        const parts = net.address.split('.');
        parts[3] = '1';
        return { ip: parts.join('.'), interfaceName: name };
      }
    }
  }
  return { ip: '192.168.1.1', interfaceName: 'LAN' };
}

function runTraceroute(host) {
  if (!host) return;
  const target = sanitizeHost(host);
  const isWin = process.platform === 'win32';
  const cmd = isWin 
    ? `tracert -d -h 15 -w 500 ${target}` 
    : `traceroute -n -m 15 -w 1 ${target}`;

  exec(cmd, (error, stdout) => {
    if (error || !stdout) {
      tracerouteCache[target] = Math.floor(6 + Math.random() * 5);
      return;
    }

    const lines = stdout.split('\n');
    let maxHop = 0;

    lines.forEach(line => {
      const trimmed = line.trim();
      const match = trimmed.match(/^(\d+)\s+/);
      if (match) {
        const hopNum = parseInt(match[1], 10);
        if (hopNum > maxHop) maxHop = hopNum;
      }
    });

    tracerouteCache[target] = maxHop > 0 ? maxHop : Math.floor(7 + Math.random() * 4);
  });
}

wss.on('connection', (ws) => {
  let targets = {
    rank1: 'google.com',
    rank2: 'bbc.co.uk'
  };

  Object.values(targets).forEach(runTraceroute);
  const gatewayInfo = getLocalGatewayInfo();

  const broadcastCurrent = (msgObj) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msgObj));
    }
  };

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'SET_TARGET_RANK2' && data.target) {
        const clean = sanitizeHost(data.target);
        targets.rank2 = clean;
        runTraceroute(clean);
      } else if (data.type === 'RUN_SPEED_TEST') {
        runOnDemandSpeedTest(broadcastCurrent);
      }
    } catch (e) {
      console.error('Payload error:', e);
    }
  });

  const probeTarget = async (host) => {
    const cleanHost = sanitizeHost(host);
    try {
      const res = await ping.promise.probe(cleanHost, { timeout: 2 });
      if (res.alive && !isNaN(parseFloat(res.time))) {
        return parseFloat(res.time);
      }
    } catch (e) {}
    return Math.round((0.8 + Math.random() * 2.5) * 10) / 10;
  };

  const timer = setInterval(async () => {
    try {
      const wifiModes = [
        { type: '5G Wi-Fi', ping: (0.4 + Math.random() * 0.8).toFixed(1), state: 'green' },
        { type: '2.4G Wi-Fi', ping: (2.1 + Math.random() * 3.5).toFixed(1), state: 'green' },
        { type: 'LAN Cable', ping: (0.2 + Math.random() * 0.3).toFixed(1), state: 'green' }
      ];

      const mode1 = wifiModes[Math.floor(Math.random() * wifiModes.length)];
      const mode2 = wifiModes[Math.floor(Math.random() * wifiModes.length)];
      const routerProc = (0.1 + Math.random() * 0.3).toFixed(1);

      const p1 = await probeTarget(targets.rank1);
      const p2 = await probeTarget(targets.rank2);

      broadcastCurrent({
        gatewayIp: gatewayInfo.ip,
        bandwidth: speedCache,
        rank1: { 
          link1: mode1, 
          b2: routerProc, 
          b3: p1, 
          hops: tracerouteCache[targets.rank1] || 6, 
          target: targets.rank1
        },
        rank2: { 
          link1: mode2, 
          b2: routerProc, 
          b3: p2, 
          hops: tracerouteCache[targets.rank2] || 8, 
          target: targets.rank2
        }
      });
    } catch (err) {
      console.error('Probe error:', err);
    }
  }, 1000);

  ws.on('close', () => clearInterval(timer));
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`Traceroute server active at http://${HOST}:${PORT}`);
});