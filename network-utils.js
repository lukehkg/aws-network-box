const ping = require('ping');

function sanitizeHost(input) {
  if (!input) return 'bbc.co.uk';
  let clean = input.trim().toLowerCase();
  clean = clean.replace(/^https?:\/\//, '');
  clean = clean.split('/')[0];
  clean = clean.split('?')[0];
  clean = clean.split(':')[0];
  return clean || 'bbc.co.uk';
}

async function probeTarget(host) {
  const cleanHost = sanitizeHost(host);
  try {
    const res = await ping.promise.probe(cleanHost, { timeout: 15 }); // Increased timeout to 15 seconds
    if (res.alive && !isNaN(parseFloat(res.time))) {
      return { success: true, latency: parseFloat(res.time) };
    }
    return { success: false, error: 'Host unreachable or timeout.' };
  } catch (e) {
    return { success: false, error: `Ping failed: ${e.message}` };
  }
}

module.exports = { sanitizeHost, probeTarget };