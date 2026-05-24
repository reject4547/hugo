const RULE_ID_BLOCK_BASE = 1;
const RULE_ID_ALLOW_BASE = 10000;
const PAUSE_ALARM = "pause_timer";
const BYPASS_ALARM_PREFIX = "bypass_";

// Initialize on install or startup
chrome.runtime.onInstalled.addListener(initialize);
chrome.runtime.onStartup.addListener(initialize);

async function initialize() {
  console.log("Hugo: Initializing...");
  await updateRules();
}

// Listen for storage changes to update rules immediately
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' || area === 'sync') {
    updateRules();
  }
});

// Listen for alarms (Pause timer, Temp bypass)
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === PAUSE_ALARM) {
    console.log("Hugo: Pause timer expired.");
    await chrome.storage.local.set({ isPaused: false, pauseUntil: null }); // This triggers storage.onChanged -> updateRules
  } else if (alarm.name.startsWith(BYPASS_ALARM_PREFIX)) {
    const domain = alarm.name.slice(BYPASS_ALARM_PREFIX.length);
    console.log(`Hugo: Temp bypass expired for ${domain}`);
    await removeTempBypass(domain);
  }
});

// Listen for messages from blocked page or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "temp_bypass") {
    handleTempBypass(message.domain).then(sendResponse);
    return true; // Keep channel open for async response
  } else if (message.action === "perm_bypass") {
    handlePermBypass(message.domain).then(sendResponse);
    return true;
  } else if (message.action === "cancel_temp_bypass") {
    handleCancelTempBypass(message.domain).then(sendResponse);
    return true;
  } else if (message.action === "extend_temp_bypass") {
    handleExtendTempBypass(message.domain).then(sendResponse);
    return true;
  }
});

async function handleTempBypass(domain) {
  // Add to temp bypass list in storage or just add a rule and alarm
  // We'll use a dynamic rule for the specific domain
  const ruleId = await getHashId(domain) + RULE_ID_ALLOW_BASE + 50000; // Offset to avoid collision
  
  // Add allow rule
  const rule = {
    id: ruleId,
    priority: 100,
    action: { type: "allow" },
    condition: { 
      urlFilter: `||${domain}`, 
      resourceTypes: ["main_frame"] 
    }
  };

  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [rule],
    removeRuleIds: [ruleId]
  });

  // Set alarm for 24 hours
  chrome.alarms.create(BYPASS_ALARM_PREFIX + domain, { delayInMinutes: 24 * 60 });
  
  return { success: true };
}

async function removeTempBypass(domain) {
    const ruleId = await getHashId(domain) + RULE_ID_ALLOW_BASE + 50000;
    await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [ruleId]
    });
}

async function handlePermBypass(domain) {
  const { userBypassList } = await chrome.storage.local.get('userBypassList');
  const newList = userBypassList ? [...userBypassList] : [];
  if (!newList.includes(domain)) {
      newList.push(domain);
      await chrome.storage.local.set({ userBypassList: newList });
      await updateRules();
  }
  return { success: true };
}

async function handleCancelTempBypass(domain) {
  await removeTempBypass(domain);
  await chrome.alarms.clear(BYPASS_ALARM_PREFIX + domain);
  return { success: true };
}

async function handleExtendTempBypass(domain) {
  const alarmName = BYPASS_ALARM_PREFIX + domain;
  const existingAlarm = await chrome.alarms.get(alarmName);
  
  if (existingAlarm) {
    const newTime = existingAlarm.scheduledTime + (24 * 60 * 60 * 1000);
    chrome.alarms.create(alarmName, { when: newTime });
  } else {
    // Fallback if it just expired: recreate it for 24 hours from now
    await handleTempBypass(domain);
  }
  return { success: true };
}

// Core function to reconcile state and rules
async function updateRules() {
  const [config, storage] = await Promise.all([
    fetch(chrome.runtime.getURL('config.json')).then(r => r.json()),
    chrome.storage.local.get(['isPaused', 'userBypassList'])
  ]);

  const paused = storage.isPaused || false;
  const userBypass = storage.userBypassList || [];

  // If paused, we basically want to remove all blocking rules.
  // Or simpler: we clear all our "managed" rules and re-add them if not paused.
  
  // Get all current dynamic rules to identify ones we manage
  const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
  const currentRuleIds = currentRules.map(r => r.id);

  if (paused) {
    // Remove all rules we might have set (except maybe temp bypasses? User asked for "pause blocking on ALL sites")
    // If we pause, we should probably allow everything.
    // Easiest way is to remove all blocking rules.
    // We will keep the temp bypass rules (higher priority allow) just in case, but they are redundant if blocks are gone.
    // However, to be clean, let's just wipe the blocking rules (Priority 10).
    // We need to know which IDs are blocking rules. 
    // We'll deterministically generate IDs based on domains.
    
    // Actually, simpler approach: Remove ALL dynamic rules if we want a clean slate? 
    // No, we might want to preserve temp bypasses so they resume if we unpause? 
    // If we unpause, we regenerate blocking rules.
    // Let's filter IDs.
    
    // For now, let's just clear ALL blocking rules (ID < RULE_ID_ALLOW_BASE).
    const blockRuleIds = currentRules.filter(r => r.id < RULE_ID_ALLOW_BASE).map(r => r.id);
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: blockRuleIds
    });
    console.log("Hugo: Paused. Rules cleared.");
    return;
  }

  // If NOT paused, generate rules
  const newRules = [];
  
  // 1. Block rules from config
  const domains = Object.keys(config.domains);
  for (let i = 0; i < domains.length; i++) {
    const domain = domains[i];
    
    // Skip if in user bypass list
    if (userBypass.includes(domain)) continue;

    const ruleId = await getHashId(domain);
    const escapedDomain = domain.replace(/\./g, '\\.');
    newRules.push({
      id: ruleId,
      priority: 10,
      action: { 
        type: "redirect", 
        redirect: { 
          regexSubstitution: chrome.runtime.getURL(`blocked.html?domain=${domain}#url=\\0`)
        } 
      },
      condition: { 
        regexFilter: `^https?://([^/:]*\\.)?${escapedDomain}([:/].*)?$`,
        resourceTypes: ["main_frame"] 
      }
    });
  }

  // We don't strictly need to add "Allow" rules for userBypassList because we just skipped adding the block rule above!
  // BUT, if there was an existing block rule from a previous run (and we just removed it from the list logic), we need to make sure the old rule is removed.
  // The `updateDynamicRules` call takes `addRules` and `removeRuleIds`.
  // To be safe and clean, we should calculate the IDs of ALL rules that SHOULD exist, and remove any that shouldn't.
  
  // 1. Calculate all Desired Rule IDs.
  // 2. Remove all existing Block Rules (so we can safely add the Desired Rules without ID collisions).
  // 3. Add the Desired Rules.
  
  const rulesToRemove = currentRules
    .filter(r => r.id < RULE_ID_ALLOW_BASE)
    .map(r => r.id);

  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: newRules,
    removeRuleIds: rulesToRemove
  });
  
  console.log(`Hugo: Rules updated. Active blocks: ${newRules.length}`);
}

// Helper to generate a stable number ID from a string
async function getHashId(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash) % 10000 + 1; // Range 1-10000
}
