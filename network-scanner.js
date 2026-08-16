const { probeTarget } = require('./network-utils.js');
const net = require('net');
const os = require('os');

// Common ports for basic OS detection heuristics and general interest
const COMMON_OS_PORTS = {
  SSH: 22,
  HTTP: 80,
  HTTPS: 443,
  RDP: 3389, // Windows Remote Desktop
  SMB: 445,  // Windows File Sharing
  FTP: 21,
  Telnet: 23,
  DNS: 53,
  MySQL: 3306,
  // Add more as needed for better heuristics
};

// Maximum allowed CIDR mask for local network scans (e.g., 23 for /23, which is 510 hosts)
const MAX_ALLOWED_CIDR_MASK = 23;

// Function to get the server's local IP and infer a default /24 subnet
function getLocalNetworkInfo() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const netInterface of interfaces[name]) {
      // Skip over internal (i.e. 127.0.0.1) and non-IPv4 addresses
      if (netInterface.family === 'IPv4' && !netInterface.internal) {
        const parts = netInterface.address.split('.');
        // Infer a /24 subnet (e.g., 192.168.1.100 -> 192.168.1.0/24)
        const subnet = `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
        return { ip: netInterface.address, subnet: subnet, interfaceName: name };
      }
    }
  }
  // Fallback if no suitable interface is found
  return { ip: '127.0.0.1', subnet: '127.0.0.0/24', interfaceName: 'localhost' };
}

// Function to parse a CIDR subnet (e.g., 192.168.1.0/24) into an array of IPs
function parseCidr(cidr) {
  const [ipStr, maskStr] = cidr.split('/');
  const ipParts = ipStr.split('.').map(Number);
  const maskNum = parseInt(maskStr, 10);

  if (isNaN(maskNum) || maskNum < 0 || maskNum > 32) {
    throw new Error('Invalid CIDR mask. Must be between 0 and 32.');
  }

  // Enforce maximum allowed subnet size
  if (maskNum < MAX_ALLOWED_CIDR_MASK) {
    throw new Error(`Subnet mask must be /${MAX_ALLOWED_CIDR_MASK} or smaller (e.g., /24, /25). Scanning larger subnets is not allowed.`);
  }

  const networkAddress = (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
  const subnetMask = -1 << (32 - maskNum);
  const startIp = networkAddress & subnetMask;
  const endIp = startIp | (~subnetMask);

  const ips = [];
  // Exclude network address and broadcast address for /24 and smaller, but include for /30, /31, /32
  const firstHost = maskNum < 31 ? startIp + 1 : startIp;
  const lastHost = maskNum < 31 ? endIp - 1 : endIp;

  for (let i = firstHost; i <= lastHost; i++) {
    ips.push(`${(i >>> 24) & 0xFF}.${(i >>> 16) & 0xFF}.${(i >>> 8) & 0xFF}.${i & 0xFF}`);
  }
  return ips;
}

// Function to perform a port scan on a single host for specific ports
async function scanPortsOnHost(host, ports) {
  const openPorts = [];
  const promises = ports.map(port => new Promise(resolve => {
    const socket = new net.Socket();
    let hadError = false;

    socket.setTimeout(1000); // 1 second timeout per port

    socket.on('connect', () => {
      openPorts.push(port);
      socket.destroy();
      resolve();
    });

    socket.on('timeout', () => {
      hadError = true;
      socket.destroy();
      resolve();
    });

    socket.on('error', () => {
      hadError = true;
      socket.destroy();
      resolve();
    });

    socket.on('close', () => {
      resolve(); // Ensure promise resolves even if no connect/error
    });
    socket.connect(port, host);
  }));
  await Promise.all(promises);
  return openPorts;
}

// Heuristic OS detection based on common open ports
function detectOsHeuristic(openPorts) {
  if (openPorts.includes(COMMON_OS_PORTS.RDP) || openPorts.includes(COMMON_OS_PORTS.SMB)) {
    return 'Windows (Heuristic)';
  }
  if (openPorts.includes(COMMON_OS_PORTS.SSH)) {
    return 'Linux/macOS (Heuristic)';
  }
  if (openPorts.includes(COMMON_OS_PORTS.HTTP) || openPorts.includes(COMMON_OS_PORTS.HTTPS)) {
    return 'Web Server (Heuristic)';
  }
  return 'Unknown (Heuristic)';
}

// Main function to scan the local network
async function scanLocalNetwork(subnet, broadcast) {
  const ipsToScan = parseCidr(subnet);
  const discoveredDevices = [];
  const totalIps = ipsToScan.length;

  broadcast({ type: 'LOCAL_NETWORK_SCAN_PROGRESS', data: { status: `Pinging ${totalIps} hosts...`, stage: 'ping', total: totalIps, current: 0 } });

  let completedPings = 0;
  const pingPromises = ipsToScan.map(ip =>
    probeTarget(ip).then(result => {
      completedPings++;
      // Send progress update, e.g., every 10% or every 10 IPs
      if (completedPings % Math.max(1, Math.floor(totalIps / 10)) === 0 || completedPings === totalIps) {
        broadcast({ type: 'LOCAL_NETWORK_SCAN_PROGRESS', data: { status: `Pinging hosts... ${completedPings}/${totalIps}`, stage: 'ping', total: totalIps, current: completedPings } });
      }
      return { ip, alive: result.success, latency: result.latency };
    })
  );
  const pingResults = await Promise.all(pingPromises);

  const aliveHosts = pingResults.filter(res => res.alive);
  const totalAliveHosts = aliveHosts.length;

  if (totalAliveHosts > 0) {
    broadcast({ type: 'LOCAL_NETWORK_SCAN_PROGRESS', data: { status: `Scanning ports on ${totalAliveHosts} alive hosts...`, stage: 'portscan', total: totalAliveHosts, current: 0 } });
  } else {
    // If no alive hosts, send a final progress update and return
    broadcast({ type: 'LOCAL_NETWORK_SCAN_PROGRESS', data: { status: `No alive hosts found.`, stage: 'complete', total: 0, current: 0 } });
    return discoveredDevices;
  }

  let completedPortScans = 0;
  const commonPorts = Object.values(COMMON_OS_PORTS);

  const deviceScanPromises = aliveHosts.map(async (host) => {
    const openPorts = await scanPortsOnHost(host.ip, commonPorts);
    const osGuess = detectOsHeuristic(openPorts);
    completedPortScans++;
    broadcast({ type: 'LOCAL_NETWORK_SCAN_PROGRESS', data: { status: `Scanning ports... ${completedPortScans}/${totalAliveHosts} hosts`, stage: 'portscan', total: totalAliveHosts, current: completedPortScans } });
    return {
      ip: host.ip,
      latency: host.latency,
      os: osGuess,
      openPorts: openPorts,
    };
  });
  const scannedDevices = await Promise.all(deviceScanPromises);
  discoveredDevices.push(...scannedDevices);
  return discoveredDevices;
}

module.exports = {
  getLocalNetworkInfo,
  scanLocalNetwork,
};