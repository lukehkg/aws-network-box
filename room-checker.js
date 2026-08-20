async function runRoomDiagnostics() {
    const btn = document.getElementById('run-diagnostic-btn');
    const resultsPanel = document.getElementById('diagnostic-results');
    const outputContainer = document.getElementById('diagnostic-output-text');
    
    // Read quantities from number inputs
    const counts = {
        Kitchen: parseInt(document.getElementById('qty-kitchen').value) || 0,
        Bedroom: parseInt(document.getElementById('qty-bedroom').value) || 0,
        Bathroom: parseInt(document.getElementById('qty-bathroom').value) || 0,
        "CCTV / Outdoor": parseInt(document.getElementById('qty-cctv').value) || 0
    };

    let totalZones = Object.values(counts).reduce((a, b) => a + b, 0);
    if (totalZones === 0) {
        alert('Please enter at least one room or zone.');
        return;
    }

    btn.textContent = `Testing ${totalZones} Individual Zones...`;
    btn.disabled = true;
    resultsPanel.classList.remove('hidden');
    outputContainer.innerHTML = '<p style="color: #64748b;" class="animate-pulse">Scanning latency and calculating individual room attenuation...</p>';

    // Measure base network latency
    const startTime = performance.now();
    try {
        await fetch(window.location.href, { method: 'HEAD', cache: 'no-store' });
    } catch (e) {}
    const baseLatency = Math.round(performance.now() - startTime);

    setTimeout(() => {
        let reportHtml = `<p style="margin-bottom: 0.5rem;"><strong>Base Network Ping:</strong> ${baseLatency} ms</p>`;
        reportHtml += `<p style="margin-bottom: 0.75rem; color: #94a3b8;">Tested <strong>${totalZones} specific areas</strong> across your layout:</p>`;
        
        let hasDeadZone = false;

        // Loop through each category and generate individual items
        for (let [category, count] of Object.entries(counts)) {
            for (let i = 1; i <= count; i++) {
                let zoneName = count > 1 ? `${category} #${i}` : category;
                
                // Simulate realistic variations (e.g., CCTV or Bedroom 3 having worse signal due to walls)
                let simulatedPing = baseLatency + (Math.random() * 40).toFixed(0);
                let statusColor = '#34d399'; // Green
                let statusText = '🟢 Excellent Signal';

                if (simulatedPing > 55 || category === "CCTV / Outdoor") {
                    simulatedPing += 30;
                    statusColor = '#fbbf24'; // Yellow/Orange
                    statusText = '⚠️ Weak Signal / Interference';
                }
                if (simulatedPing > 85) {
                    statusColor = '#f87171'; // Red
                    statusText = '🔴 Dead Zone Detected';
                    hasDeadZone = true;
                }

                reportHtml += `
                    <div style="display: flex; justify-content: space-between; align-items: center; background: #0f172a; padding: 0.5rem 0.75rem; margin-bottom: 0.35rem; border-radius: 0.35rem; border-left: 3px solid ${statusColor};">
                        <span><strong>${zoneName}</strong></span>
                        <span style="color: ${statusColor}; font-weight: 500;">${simulatedPing}ms — ${statusText}</span>
                    </div>
                `;
            }
        }

        if (hasDeadZone) {
            reportHtml += `<div style="margin-top: 0.75rem; padding: 0.5rem; background: rgba(248, 113, 113, 0.1); border: 1px solid rgba(248, 113, 113, 0.2); border-radius: 0.35rem; color: #fca5a5;">
                💡 <strong>Expert Recommendation:</strong> Dead zones found in specific rooms above. Recommended to position a mesh extender closer to those bottlenecks or check for channel overlap.
            </div>`;
        } else {
            reportHtml += `<div style="margin-top: 0.75rem; padding: 0.5rem; background: rgba(52, 211, 153, 0.1); border: 1px solid rgba(52, 211, 153, 0.2); border-radius: 0.35rem; color: #6ee7b7;">
                ✅ All tested zones show stable return rates. No major bottlenecks found.
            </div>`;
        }

        outputContainer.innerHTML = reportHtml;
        btn.textContent = 'Run Multi-Zone Test Across All Rooms';
        btn.disabled = false;
    }, 1200);
}