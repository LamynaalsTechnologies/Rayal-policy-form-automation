const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const path = require("path");
const fs = require("fs");

let singletonDriver = null;

async function getDriver() {
    if (singletonDriver) return singletonDriver;

    const options = new chrome.Options();
    options.addArguments("--start-maximized");
    const userDataDir = path.join(__dirname, "chrome-profile");
    try {
        if (!fs.existsSync(userDataDir)) {
            fs.mkdirSync(userDataDir, { recursive: true });
        }
    } catch {}
    options.addArguments(`--user-data-dir=${userDataDir}`);

    // Try to use system Chrome binary if found
    const candidateChromeBins = [
        process.env.CHROME_PATH,
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
    ].filter(Boolean);
    for (const bin of candidateChromeBins) {
        try { if (fs.existsSync(bin)) { options.setChromeBinaryPath(bin); console.log(`[selenium] Using Chrome binary: ${bin}`); break; } } catch {}
    }

    // Prefer a local chromedriver if present
    let serviceBuilder = null;
    const candidateDrivers = [
        process.env.CHROMEDRIVER_PATH,
        path.join(__dirname, "../chromedriver-linux64/chromedriver"),
        path.join(__dirname, "../../chromedriver-linux64/chromedriver"),
        path.join(__dirname, "chromedriver"),
        "/usr/bin/chromedriver",
        "/usr/local/bin/chromedriver",
        "/snap/bin/chromium.chromedriver",
    ].filter(Boolean);
    console.log(`[selenium] Candidate chromedrivers: ${candidateDrivers.join(', ')}`);
    for (const drv of candidateDrivers) {
        try {
            if (fs.existsSync(drv)) {
                try { fs.chmodSync(drv, 0o755); } catch {}
                serviceBuilder = new chrome.ServiceBuilder(drv);
                console.log(`[selenium] Using chromedriver: ${drv}`);
                break;
            }
        } catch {}
    }

    try {
        const builder = new Builder().forBrowser("chrome").setChromeOptions(options);
        if (serviceBuilder) builder.setChromeService(serviceBuilder);
        singletonDriver = await builder.build();
    } catch (e) {
        const triedDriver = serviceBuilder ? "custom chromedriver (see log above)" : "selenium-manager auto";
        const msg = [
            "Failed to start Chrome driver.",
            `Chrome binary: ${(options.options_ && options.options_.binary) || "auto"}`,
            `Tried driver: ${triedDriver}`,
            "Tips: Install google-chrome-stable and ensure chromedriver matches your Chrome version.",
            "You can set CHROME_PATH and CHROMEDRIVER_PATH environment variables.",
        ].join("\n");
        console.error(msg);
        throw e;
    }

    await singletonDriver.manage().setTimeouts({ implicit: 20000, pageLoad: 40000, script: 30000 });
    return singletonDriver;
}

async function openNewTab(driver, url) {
    // Get current handles before creating new tab
    const handlesBefore = await driver.getAllWindowHandles();
    console.log(`[tabs] Handles before: ${handlesBefore.length}`, handlesBefore);
    
    let newHandle = null;
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts && !newHandle) {
        attempts++;
        console.log(`[tabs] Attempt ${attempts} to create new tab`);
        
        try {
            // Method 1: Try the standard newWindow method
            await driver.switchTo().newWindow('tab');
            console.log('[tabs] Successfully created new tab using newWindow()');
            
            // Verify new tab was created
            const handlesAfter = await driver.getAllWindowHandles();
            newHandle = handlesAfter.find(h => !handlesBefore.includes(h));
            
            if (newHandle) {
                console.log('[tabs] Verified new tab created with handle:', newHandle);
                break;
            } else {
                console.warn('[tabs] newWindow() did not create new tab, trying fallback');
            }
        } catch (e) {
            console.warn('[tabs] newWindow failed:', e && e.message || e);
        }
        
        // Method 2: Fallback using JavaScript with direct URL
        try {
            console.log('[tabs] Trying JavaScript window.open fallback with direct URL');
            if (url) {
                await driver.executeScript(`window.open('${url}','_blank');`);
            } else {
                await driver.executeScript("window.open('about:blank','_blank');");
            }
            
            // Wait for the new tab to be created
            await driver.sleep(1000);
            
            // Get handles after creating new tab
            const handlesAfter = await driver.getAllWindowHandles();
            console.log(`[tabs] Handles after JS open: ${handlesAfter.length}`, handlesAfter);
            
            // Find the new handle
            newHandle = handlesAfter.find(h => !handlesBefore.includes(h));
            if (newHandle) {
                console.log('[tabs] Found new handle via JS, switching to it:', newHandle);
                await driver.switchTo().window(newHandle);
                // If we didn't navigate directly, navigate now
                if (url && !url.includes('about:blank')) {
                    try {
                        await driver.get(url);
                    } catch (e) {
                        console.warn('[tabs] Navigation after JS open failed:', e.message);
                    }
                }
                break;
            }
        } catch (e) {
            console.warn('[tabs] JavaScript fallback failed:', e && e.message || e);
        }
        
        // Method 3: Force new window if tab creation fails
        if (!newHandle && attempts === maxAttempts) {
            console.log('[tabs] All methods failed, trying to create new window');
            try {
                await driver.switchTo().newWindow('window');
                const handlesAfter = await driver.getAllWindowHandles();
                newHandle = handlesAfter.find(h => !handlesBefore.includes(h));
                if (newHandle) {
                    console.log('[tabs] Created new window as fallback:', newHandle);
                    break;
                }
            } catch (e) {
                console.error('[tabs] Even new window creation failed:', e && e.message || e);
            }
        }
    }
    
    if (!newHandle) {
        console.error('[tabs] CRITICAL: Could not create new tab/window after all attempts');
        // As absolute last resort, use the last available handle
        const allHandles = await driver.getAllWindowHandles();
        if (allHandles.length > 0) {
            newHandle = allHandles[allHandles.length - 1];
            await driver.switchTo().window(newHandle);
            console.log('[tabs] Using last available handle as fallback:', newHandle);
        } else {
            throw new Error('No browser handles available');
        }
    }
    
    // Navigate to URL if provided
    if (url) {
        console.log(`[tabs] Navigating to: ${url}`);
        try {
            await driver.get(url);
        } catch (e) {
            console.warn('[tabs] Navigation failed:', e && e.message || e);
        }
    }
    
    // Wait for DOM readiness
    try {
        await driver.executeScript('return document.readyState');
        await driver.sleep(500); // Additional wait for page stability
    } catch (e) {
        console.warn('[tabs] DOM readiness check failed:', e && e.message || e);
    }
    
    const currentHandle = await driver.getWindowHandle();
    console.log(`[tabs] Final tab handle: ${currentHandle}`);
    return currentHandle;
}

async function ensureLoggedIn(driver, waitMsIfNeeded = 20000) {
    const homeUrl = "https://www.uiic.in/GCWebPortal/login/HomeAction.do";
    const loginUrl = "https://www.uiic.in/GCWebPortal/login/LoginAction.do?p=login";
    const loginUrlPart = "LoginAction.do";

    // Helper: detect public site (non-portal)
    const onPublicUiicRoot = (url) => (
        (url.startsWith("https://uiic.co.in") || url.startsWith("https://www.uiic.co.in")) &&
        !url.includes("/GCWebPortal/")
    );

    // Step 1: Try portal home first to reuse existing session
    await driver.get(homeUrl);
    let currentUrl = await driver.getCurrentUrl();

    // If redirected to public uiic.co.in, force to portal login
    if (onPublicUiicRoot(currentUrl)) {
        console.log("Redirected to public uiic.co.in → forcing portal login page...");
        await driver.get(loginUrl);
        currentUrl = await driver.getCurrentUrl();
    }

    // --- Case 2: On login page ---
    if (currentUrl.includes(loginUrlPart)) {
        console.log(`Session not available. Please login manually. Waiting ${Math.floor(waitMsIfNeeded / 1000)} seconds...`);
        await driver.sleep(waitMsIfNeeded);

        // Poll for successful login
        let retries = Math.floor(waitMsIfNeeded / 1000);
        while (retries-- > 0) {
            currentUrl = await driver.getCurrentUrl();

            // Exit if we're no longer on login or either uiic domain
            if (
                !currentUrl.includes(loginUrlPart) &&
                !currentUrl.startsWith("https://uiic.co.in") &&
                !currentUrl.startsWith("https://www.uiic.co.in")
            ) {
                break;
            }
            await driver.sleep(1000);
        }
    }

    // After login or if already authenticated, ensure we are on portal home
    try { currentUrl = await driver.getCurrentUrl(); } catch {}
    if (onPublicUiicRoot(currentUrl) || !currentUrl.includes("/GCWebPortal/")) {
        try { await driver.get(homeUrl); } catch {}
    } else if (!currentUrl.includes("HomeAction.do")) {
        try { await driver.get(homeUrl); } catch {}
    }

    // --- Case 3: Already logged in (sanity check) ---
    try {
        await driver.wait(until.elementLocated(By.xpath("//a[contains(@class, 'menuColor')]")), 5000);
        console.log("Login verified.");
    } catch {
        console.log("Could not verify login. You may still need to log in manually.");
    }
}



async function closeCurrentTab(driver) {
    const all = await driver.getAllWindowHandles();
    console.log(`[tabs] Closing current tab. Total tabs: ${all.length}`);
    
    if (all.length <= 1) {
        console.log('[tabs] Only one tab remaining, keeping it open');
        return; // keep at least one tab open
    }
    
    const current = await driver.getWindowHandle();
    console.log(`[tabs] Closing tab with handle: ${current}`);
    
    await driver.close();
    
    // Wait a moment for the tab to close
    await driver.sleep(200);
    
    const remaining = await driver.getAllWindowHandles();
    console.log(`[tabs] Remaining tabs after close: ${remaining.length}`);
    
    if (remaining.length > 0) {
        const target = remaining[0];
        console.log(`[tabs] Switching to remaining tab: ${target}`);
        await driver.switchTo().window(target);
    }
}

async function ensureCleanState(driver) {
    // No cleanup anymore; preserve all tabs
    try {
        const handles = await driver.getAllWindowHandles();
        console.log(`[cleanup] Skipped. Tabs open: ${handles.length}`);
    } catch {}
}

async function createFreshDriver() {
    console.log('[driver] Creating fresh driver instance');
    
    const options = new chrome.Options();
    options.addArguments("--start-maximized");
    
    // Use the same profile directory but add additional options to handle conflicts
    const userDataDir = path.join(__dirname, "chrome-profile");
    try {
        if (!fs.existsSync(userDataDir)) {
            fs.mkdirSync(userDataDir, { recursive: true });
        }
    } catch {}
    
    // Add options to handle profile conflicts
    options.addArguments(`--user-data-dir=${userDataDir}`);
    options.addArguments("--no-first-run");
    options.addArguments("--no-default-browser-check");
    options.addArguments("--disable-extensions");
    options.addArguments("--disable-plugins");
    options.addArguments("--disable-background-timer-throttling");
    options.addArguments("--disable-backgrounding-occluded-windows");
    options.addArguments("--disable-renderer-backgrounding");
    
    console.log(`[driver] Using profile directory: ${userDataDir}`);

    // Try to use system Chrome binary if found
    const candidateChromeBins = [
        process.env.CHROME_PATH,
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
    ].filter(Boolean);
    for (const bin of candidateChromeBins) {
        try { if (fs.existsSync(bin)) { options.setChromeBinaryPath(bin); console.log(`[selenium] Using Chrome binary: ${bin}`); break; } } catch {}
    }

    // Prefer a local chromedriver if present
    let serviceBuilder = null;
    const candidateDrivers = [
        process.env.CHROMEDRIVER_PATH,
        path.join(__dirname, "../chromedriver-linux64/chromedriver"),
        path.join(__dirname, "../../chromedriver-linux64/chromedriver"),
        path.join(__dirname, "chromedriver"),
        "/usr/bin/chromedriver",
        "/usr/local/bin/chromedriver",
        "/snap/bin/chromium.chromedriver",
    ].filter(Boolean);
    console.log(`[selenium] Candidate chromedrivers: ${candidateDrivers.join(', ')}`);
    for (const drv of candidateDrivers) {
        try {
            if (fs.existsSync(drv)) {
                try { fs.chmodSync(drv, 0o755); } catch {}
                serviceBuilder = new chrome.ServiceBuilder(drv);
                console.log(`[selenium] Using chromedriver: ${drv}`);
                break;
            }
        } catch {}
    }

    try {
        const builder = new Builder().forBrowser("chrome").setChromeOptions(options);
        if (serviceBuilder) builder.setChromeService(serviceBuilder);
        const driver = await builder.build();
        await driver.manage().setTimeouts({ implicit: 20000, pageLoad: 40000, script: 30000 });
        console.log('[driver] Fresh driver created successfully');
        return driver;
    } catch (e) {
        const triedDriver = serviceBuilder ? "custom chromedriver (see log above)" : "selenium-manager auto";
        const msg = [
            "Failed to start Chrome driver.",
            `Chrome binary: ${(options.options_ && options.options_.binary) || "auto"}`,
            `Tried driver: ${triedDriver}`,
            "Tips: Install google-chrome-stable and ensure chromedriver matches your Chrome version.",
            "You can set CHROME_PATH and CHROMEDRIVER_PATH environment variables.",
        ].join("\n");
        console.error(msg);
        throw e;
    }
}

// Create fresh driver by cloning the base profile, allowing parallel Chrome instances with session reuse
// Returns { driver, profileDir }
async function createFreshDriverFromBaseProfile(baseProfileDir) {
    console.log('[driver] Creating fresh driver from base profile:', baseProfileDir);

    // Prepare a unique temp profile directory
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).slice(2);
    const tempProfileDir = path.join(__dirname, `chrome-profile-job-${timestamp}-${randomId}`);

    // Best-effort clone of the base profile
    try {
        cloneDirectoryRecursive(baseProfileDir, tempProfileDir);
        console.log('[driver] Cloned base profile to:', tempProfileDir);
    } catch (e) {
        console.warn('[driver] Failed to clone base profile, proceeding with empty profile:', e && e.message || e);
        try { fs.mkdirSync(tempProfileDir, { recursive: true }); } catch {}
    }

    const options = new chrome.Options();
    options.addArguments("--start-maximized");
    options.addArguments(`--user-data-dir=${tempProfileDir}`);
    options.addArguments("--no-first-run");
    options.addArguments("--no-default-browser-check");
    options.addArguments("--disable-extensions");

    // Use system Chrome binary if present
    const candidateChromeBins = [
        process.env.CHROME_PATH,
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
    ].filter(Boolean);
    for (const bin of candidateChromeBins) {
        try { if (fs.existsSync(bin)) { options.setChromeBinaryPath(bin); console.log(`[selenium] Using Chrome binary: ${bin}`); break; } } catch {}
    }

    // Prefer a local chromedriver if present
    let serviceBuilder = null;
    const candidateDrivers = [
        process.env.CHROMEDRIVER_PATH,
        path.join(__dirname, "../chromedriver-linux64/chromedriver"),
        path.join(__dirname, "../../chromedriver-linux64/chromedriver"),
        path.join(__dirname, "chromedriver"),
        "/usr/bin/chromedriver",
        "/usr/local/bin/chromedriver",
        "/snap/bin/chromium.chromedriver",
    ].filter(Boolean);
    console.log(`[selenium] Candidate chromedrivers: ${candidateDrivers.join(', ')}`);
    for (const drv of candidateDrivers) {
        try {
            if (fs.existsSync(drv)) {
                try { fs.chmodSync(drv, 0o755); } catch {}
                serviceBuilder = new chrome.ServiceBuilder(drv);
                console.log(`[selenium] Using chromedriver: ${drv}`);
                break;
            }
        } catch {}
    }

    try {
        const builder = new Builder().forBrowser("chrome").setChromeOptions(options);
        if (serviceBuilder) builder.setChromeService(serviceBuilder);
        const driver = await builder.build();
        await driver.manage().setTimeouts({ implicit: 20000, pageLoad: 40000, script: 30000 });
        console.log('[driver] Fresh driver (cloned profile) created successfully');
        return { driver, profileDir: tempProfileDir };
    } catch (e) {
        console.error('Failed creating driver with cloned profile:', e && e.message || e);
        throw e;
    }
}

// Utilities
function cloneDirectoryRecursive(srcDir, destDir) {
    try { fs.mkdirSync(destDir, { recursive: true }); } catch {}
    if (!fs.existsSync(srcDir)) return;
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);
        try {
            if (entry.isDirectory()) {
                // Skip lock folders/files
                if (entry.name.toLowerCase().includes('lock')) continue;
                cloneDirectoryRecursive(srcPath, destPath);
            } else if (entry.isFile()) {
                // Skip very large cache files
                const stat = fs.statSync(srcPath);
                if (stat.size > 25 * 1024 * 1024) continue;
                fs.copyFileSync(srcPath, destPath);
            }
        } catch {}
    }
}

module.exports = {
    getDriver,
    openNewTab,
    ensureLoggedIn,
    closeCurrentTab,
    ensureCleanState,
    createFreshDriver,
    createFreshDriverFromBaseProfile,
};


