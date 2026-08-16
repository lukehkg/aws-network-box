const https = require('https');
const dns = require('dns').promises;

/**
 * Finds subdomains using the HackerTarget.com public API.
 * This is a stable, free API designed for this purpose.
 * @param {string} domain The domain to search for.
 * @returns {Promise<object>} A promise that resolves with the search results.
 */
async function runSubdomainSearch(domain) {
  const url = `https://api.hackertarget.com/hostsearch/?q=${domain}`;

  return new Promise(resolve => {
    try {
      const req = https.get(url, { timeout: 8000 }, res => {
        if (res.statusCode !== 200) {
          return resolve({ error: `API returned status ${res.statusCode}` });
        }
        let body = '';
        res.on('data', chunk => (body += chunk));
        res.on('end', () => {
          const lines = body.split('\n').filter(line => line.trim() !== '' && line.includes('.'));
          const subdomains = lines.map(line => line.split(',')[0].trim());
          resolve({ count: subdomains.length, subdomains: subdomains, domain: domain });
        });
      });

      req.on('timeout', () => { req.destroy(); resolve({ error: 'API request timed out.' }); });
      req.on('error', e => resolve({ error: `API request failed: ${e.message}` }));
    } catch (e) {
      resolve({ error: `Request setup failed: ${e.message}` });
    }
  });
}
async function runMxLookup(domain) {
  try {
    const records = await dns.resolveMx(domain);
    records.sort((a, b) => a.priority - b.priority);
    return { records: records, domain: domain };
  } catch (e) {
    // Provide a more user-friendly error message for common cases
    if (e.code === 'ENODATA' || e.code === 'ENOTFOUND') {
      return { error: 'No MX records found for this domain.' };
    }
    return { error: e.message || 'An unknown error occurred.' };
  }
}

/**
 * Checks for an SSL certificate on the main domain and its 'www' subdomain.
 * @param {string} domain The domain to look up.
 * @returns {Promise<object>} A promise that resolves with the SSL info.
 */
async function getSslInfo(domain) {
  const hostsToCheck = [domain, `www.${domain}`];
  for (const host of hostsToCheck) {
    try {
      // This inner try/catch ensures that if one host fails (e.g., timeout),
      // we can still attempt the next one in the list.
      const cert = await new Promise((resolve, reject) => {
        const options = {
          host: host,
          port: 443,
          method: 'GET',
          rejectUnauthorized: false, // We want the cert even if it's invalid
          timeout: 3000,
        };
        const req = https.request(options, (res) => {
          const certificate = res.socket.getPeerCertificate();
          resolve(certificate);
          req.destroy(); // End the request as soon as we have the cert
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.end();
      });

      if (cert && Object.keys(cert).length > 0) {
        return {
          found: true,
          issuer: cert.issuer.O || 'Unknown Issuer',
          valid_from: cert.valid_from,
          valid_to: cert.valid_to,
        };
      }
    } catch (e) {
      // Log the error for debugging, then continue to the next host.
      console.error(`SSL check for ${host} failed:`, e.message);
    }
  }
  return { found: false, error: 'No SSL certificate found on common hosts.' };
}

module.exports = {
  runSubdomainSearch,
  runMxLookup,
  getSslInfo,
};