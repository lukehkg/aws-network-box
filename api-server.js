const express = require('express');
const https = require('https');
const { sanitizeHost, probeTarget } = require('./network-utils.js');
const analysisWorker = require('./analysis-worker.js');

const router = express.Router();

// Middleware to parse JSON bodies
router.use(express.json());

/**
 * @api {post} /api/v1/latency Latency Check
 * @apiDescription Checks the ICMP latency to a given target.
 * @apiParam {String} target The domain or IP to ping.
 * @apiSuccess {Boolean} success True if the ping was successful.
 * @apiSuccess {Number} latency The latency in milliseconds.
 * @apiError {Boolean} success False if the ping failed.
 * @apiError {String} error The error message.
 */
router.post('/latency', async (req, res) => {
  const { target } = req.body;
  if (!target) {
    return res.status(400).json({ success: false, error: 'Missing "target" in request body.' });
  }
  const result = await probeTarget(target);
  res.json(result);
});

/**
 * @api {post} /api/v1/domain-query Domain Query
 * @apiDescription Performs a detailed analysis of a domain (subdomains, MX, SSL).
 * @apiParam {String} domain The domain to analyze.
 * @apiSuccess {Object} result A consolidated object with all analysis data.
 * @apiError {String} error The error message if the query fails.
 */
router.post('/domain-query', async (req, res) => {
  const { domain } = req.body;
  if (!domain) {
    return res.status(400).json({ success: false, error: 'Missing "domain" in request body.' });
  }

  try {
    const cleanDomain = sanitizeHost(domain);
    const [subdomainResult, mxResult, sslResult] = await Promise.all([
      analysisWorker.runSubdomainSearch(cleanDomain),
      analysisWorker.runMxLookup(cleanDomain),
      analysisWorker.getSslInfo(cleanDomain)
    ]);

    res.json({
      success: true,
      domain: cleanDomain,
      subdomains: subdomainResult,
      mx: mxResult,
      ssl: sslResult
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * @api {get} /api/v1/speedtest Speed Test
 * @apiDescription Performs a simple download speed test.
 * @apiSuccess {Number} downloadSpeedMbps The calculated download speed in Mbps.
 * @apiError {String} error The error message if the test fails.
 */
router.get('/speedtest', (req, res) => {
  const startTime = Date.now();
  let totalBytesReceived = 0;

  const speedTestReq = https.get('https://speed.cloudflare.com/__down?bytes=25000000', (speedRes) => {
    speedRes.on('data', (chunk) => {
      totalBytesReceived += chunk.length;
    });

    speedRes.on('end', () => {
      const durationSec = (Date.now() - startTime) / 1000;
      if (durationSec > 0 && totalBytesReceived > 0) {
        const downloadSpeedMbps = parseFloat(((totalBytesReceived * 8) / (durationSec * 1000000)).toFixed(2));
        res.json({ success: true, downloadSpeedMbps });
      } else {
        res.status(500).json({ success: false, error: 'Speed test failed to transfer data.' });
      }
    });
  });

  speedTestReq.on('error', (e) => {
    res.status(500).json({ success: false, error: `Speed test request failed: ${e.message}` });
  });

  speedTestReq.setTimeout(10000, () => {
    speedTestReq.destroy();
    res.status(500).json({ success: false, error: 'Speed test timed out.' });
  });
});

module.exports = router;