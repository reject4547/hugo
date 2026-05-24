// Elements
const statusContainer = document.getElementById('status-container');
const statusText = document.getElementById('status-text');
const timerDisplay = document.getElementById('timer-display');
const timeRemainingSpan = document.getElementById('time-remaining');
const resumeBtn = document.getElementById('resume-btn');
const pauseControls = document.getElementById('pause-controls');
const bypassInput = document.getElementById('bypass-input');
const addBypassBtn = document.getElementById('add-bypass');
const bypassListEl = document.getElementById('bypass-list');
const tempBypassContainer = document.getElementById('temp-bypass-container');
const tempBypassListEl = document.getElementById('temp-bypass-list');
let tempBypassInterval = null;

// Initialize
document.addEventListener('DOMContentLoaded', loadState);

// Event Listeners
document.getElementById('pause-15m').addEventListener('click', () => pause(15));
document.getElementById('pause-1h').addEventListener('click', () => pause(60));
document.getElementById('pause-24h').addEventListener('click', () => pause(24 * 60));
resumeBtn.addEventListener('click', resume);
addBypassBtn.addEventListener('click', addBypass);

async function loadState() {
    const { isPaused, pauseUntil, userBypassList } = await chrome.storage.local.get(['isPaused', 'pauseUntil', 'userBypassList']);

    updateStatus(isPaused, pauseUntil);
    renderBypassList(userBypassList || []);
    
    const alarms = await chrome.alarms.getAll();
    const bypassAlarms = alarms.filter(a => a.name.startsWith('bypass_'));
    renderTempBypassList(bypassAlarms);
}

function updateStatus(isPaused, pauseUntil) {
    if (isPaused) {
        statusContainer.className = 'status-indicator status-paused';
        statusText.textContent = 'Paused';
        resumeBtn.style.display = 'block';
        pauseControls.style.display = 'none';

        if (pauseUntil) {
            timerDisplay.style.display = 'block';
            const date = new Date(pauseUntil);
            timeRemainingSpan.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
    } else {
        statusContainer.className = 'status-indicator status-active';
        statusText.textContent = 'Active';
        resumeBtn.style.display = 'none';
        pauseControls.style.display = 'block';
        timerDisplay.style.display = 'none';
    }
}

async function pause(minutes) {
    const durationMs = minutes * 60 * 1000;
    const pauseUntil = Date.now() + durationMs;

    await chrome.storage.local.set({
        isPaused: true,
        pauseUntil: pauseUntil
    });

    // Set alarm in background by creating it here? 
    // Alarms created in popup persist in background? Yes, alarms are per-extension.
    chrome.alarms.create("pause_timer", { delayInMinutes: minutes });

    loadState();
}

async function resume() {
    await chrome.storage.local.set({ isPaused: false, pauseUntil: null });
    chrome.alarms.clear("pause_timer");
    loadState();
}

async function addBypass() {
    const domain = bypassInput.value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''); // Simple cleanup
    if (!domain) return;

    const { userBypassList } = await chrome.storage.local.get('userBypassList');
    const newList = userBypassList ? [...userBypassList] : [];

    if (!newList.includes(domain)) {
        newList.push(domain);
        await chrome.storage.local.set({ userBypassList: newList });
        renderBypassList(newList);
        bypassInput.value = '';
    }
}

async function removeBypass(domain) {
    const { userBypassList } = await chrome.storage.local.get('userBypassList');
    if (!userBypassList) return;

    const newList = userBypassList.filter(d => d !== domain);
    await chrome.storage.local.set({ userBypassList: newList });
    renderBypassList(newList);
}

function renderBypassList(list) {
    bypassListEl.innerHTML = '';
    list.forEach(domain => {
        const li = document.createElement('li');
        li.className = 'bypass-item';
        li.innerHTML = `
      <span>${domain}</span>
      <button class="remove-btn" aria-label="Remove">&times;</button>
    `;
        li.querySelector('.remove-btn').addEventListener('click', () => removeBypass(domain));
        bypassListEl.appendChild(li);
    });
}

function formatTimeDiff(ms) {
    if (ms <= 0) return "Expired";
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function renderTempBypassList(alarms) {
    if (tempBypassInterval) {
        clearInterval(tempBypassInterval);
    }
    
    if (alarms.length === 0) {
        if (tempBypassContainer) tempBypassContainer.style.display = 'none';
        return;
    }
    
    if (tempBypassContainer) tempBypassContainer.style.display = 'block';
    if (tempBypassListEl) tempBypassListEl.innerHTML = '';
    
    alarms.forEach(alarm => {
        const domain = alarm.name.slice('bypass_'.length);
        const li = document.createElement('li');
        li.className = 'bypass-item';
        li.innerHTML = `
      <div style="display: flex; flex-direction: column; flex-grow: 1;">
        <span>${domain}</span>
        <span class="time-remaining-timer" data-time="${alarm.scheduledTime}" style="font-size: 11px; color: #666;"></span>
      </div>
      <div style="display: flex; gap: 4px;">
        <button class="extend-btn" aria-label="Extend" style="font-size: 11px; padding: 2px 4px; border-radius: 4px; border: 1px solid #ccc; background: #fff; cursor: pointer;">+24h</button>
        <button class="remove-btn" aria-label="Cancel">&times;</button>
      </div>
    `;
        li.querySelector('.extend-btn').addEventListener('click', () => extendTempBypass(domain));
        li.querySelector('.remove-btn').addEventListener('click', () => cancelTempBypass(domain));
        tempBypassListEl.appendChild(li);
    });
    
    updateTimers();
    tempBypassInterval = setInterval(updateTimers, 1000);
}

function updateTimers() {
    const timers = document.querySelectorAll('.time-remaining-timer');
    let needsRefresh = false;
    timers.forEach(timer => {
        const targetTime = parseInt(timer.getAttribute('data-time'), 10);
        const diff = targetTime - Date.now();
        timer.textContent = formatTimeDiff(diff);
        if (diff <= 0) {
            needsRefresh = true;
        }
    });
    if (needsRefresh) {
        loadState();
    }
}

function cancelTempBypass(domain) {
    chrome.runtime.sendMessage({ action: "cancel_temp_bypass", domain: domain }, (response) => {
        loadState();
    });
}

function extendTempBypass(domain) {
    chrome.runtime.sendMessage({ action: "extend_temp_bypass", domain: domain }, (response) => {
        loadState();
    });
}
