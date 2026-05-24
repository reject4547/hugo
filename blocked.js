const messageEl = document.getElementById('message');
const domainNameEl = document.getElementById('domain-name');
const mainHeaderDomainEl = document.getElementById('main-header-domain');
const bypassBtn = document.getElementById('bypass-btn');

document.addEventListener('DOMContentLoaded', async () => {
    const params = new URLSearchParams(window.location.search);
    const domain = params.get('domain');

    if (!domain) {
        messageEl.textContent = "Unknown domain blocked.";
        bypassBtn.style.display = 'none';
        return;
    }

    domainNameEl.textContent = domain;
    if (mainHeaderDomainEl) {
        mainHeaderDomainEl.textContent = domain;
    }

    // Fetch config to get the message
    try {
        const response = await fetch(chrome.runtime.getURL('config.json'));
        const config = await response.json();

        const reasonKey = config.domains[domain];
        const message = config.reasons[reasonKey] || "The reason for blocking this site is missing.";

        messageEl.textContent = message;
    } catch (e) {
        console.error("Failed to load config:", e);
        messageEl.textContent = "This site is blocked.";
    }

    // Extract original target URL from fragment if present
    let targetUrl = `https://${domain}`;
    const hash = window.location.hash;
    if (hash && hash.startsWith('#url=')) {
        const potentialUrl = hash.slice(5);
        if (potentialUrl.startsWith('http://') || potentialUrl.startsWith('https://')) {
            targetUrl = potentialUrl;
        }
    }

    // Handle temp bypass
    bypassBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: "temp_bypass", domain: domain }, (response) => {
            if (response && response.success) {
                // Redirect back to the original target
                window.location.replace(targetUrl);
            }
        });
    });

    // Handle perm bypass
    const permBypassBtn = document.getElementById('perm-bypass-btn');
    if (permBypassBtn) {
        permBypassBtn.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: "perm_bypass", domain: domain }, (response) => {
                if (response && response.success) {
                    window.location.replace(targetUrl);
                }
            });
        });
    }
});
