/**
 * Session Checker - Check if login session is still valid
 * 
 * This utility helps determine if a Chrome profile has a valid login session
 */

const fs = require('fs');
const path = require('path');
const { Builder } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const { By, until } = require('selenium-webdriver');

/**
 * Check if a profile has valid cookies by examining the Cookies file
 */
function hasValidCookies(profilePath) {
  try {
    const cookiesFile = path.join(profilePath, 'Default', 'Cookies');
    
    if (!fs.existsSync(cookiesFile)) {
      console.log('❌ No Cookies file found');
      return false;
    }

    const stats = fs.statSync(cookiesFile);
    const fileSize = stats.size;
    
    console.log(`📄 Cookies file size: ${fileSize} bytes`);
    
    // If Cookies file is very small (< 100 bytes), probably no session
    if (fileSize < 100) {
      console.log('❌ Cookies file too small, likely no session');
      return false;
    }

    console.log('✅ Cookies file exists and has content');
    return true;
  } catch (err) {
    console.log('❌ Error checking cookies:', err.message);
    return false;
  }
}

/**
 * Check if session is alive by opening browser and checking for logged-in elements
 */
async function checkSessionAlive(profilePath) {
  let driver = null;
  
  try {
    console.log(`\n🔍 Checking session in profile: ${profilePath}`);
    
    // Check cookies file first
    if (!hasValidCookies(profilePath)) {
      return { alive: false, reason: 'No valid cookies' };
    }
    
    // Open browser with profile
    const options = new chrome.Options();
    options.addArguments(`--user-data-dir=${profilePath}`);
    options.addArguments('--headless'); // Run in background
    options.addArguments('--disable-gpu');
    
    driver = await new Builder()
      .forBrowser('chrome')
      .setChromeOptions(options)
      .build();
    
    console.log('🌐 Opening browser with profile...');
    
    // Navigate to login page
    await driver.get('https://smartzone.reliancegeneral.co.in/Login/IMDLogin');
    await driver.sleep(3000);
    
    // Check if we're logged in by looking for Motors menu
    try {
      const motorsMenu = await driver.findElement(By.id('divMainMotors'));
      const isDisplayed = await motorsMenu.isDisplayed();
      
      if (isDisplayed) {
        console.log('✅ Session is ALIVE! Motors menu found.');
        return { alive: true, reason: 'Motors menu detected' };
      }
    } catch (e) {
      // Motors menu not found, check if we're on login page
      try {
        const loginForm = await driver.findElement(By.id('txtUserName'));
        console.log('❌ Session is DEAD! Login form visible.');
        return { alive: false, reason: 'Login form detected' };
      } catch (e2) {
        console.log('⚠️  Could not determine session status');
        return { alive: false, reason: 'Unknown state' };
      }
    }
    
  } catch (err) {
    console.error('❌ Error checking session:', err.message);
    return { alive: false, reason: err.message };
  } finally {
    if (driver) {
      await driver.quit();
    }
  }
}

/**
 * Check session in base profile
 */
async function checkBaseProfileSession() {
  const baseProfilePath = path.join(__dirname, 'chrome-profile');
  
  if (!fs.existsSync(baseProfilePath)) {
    console.log('❌ Base profile does not exist');
    return { alive: false, reason: 'Profile not found' };
  }
  
  return await checkSessionAlive(baseProfilePath);
}

/**
 * Get session info from cookies
 */
function getSessionInfo(profilePath) {
  try {
    const cookiesFile = path.join(profilePath, 'Default', 'Cookies');
    
    if (!fs.existsSync(cookiesFile)) {
      return { hasCookies: false, cookieCount: 0 };
    }
    
    const stats = fs.statSync(cookiesFile);
    const lastModified = stats.mtime;
    const ageInMinutes = Math.floor((Date.now() - lastModified.getTime()) / 60000);
    
    // Try to read cookies (they're in SQLite format, so we just check size)
    const fileSize = stats.size;
    
    return {
      hasCookies: true,
      cookieCount: Math.floor(fileSize / 100), // Rough estimate
      lastModified: lastModified.toISOString(),
      ageInMinutes: ageInMinutes,
      fileSize: fileSize
    };
  } catch (err) {
    return { hasCookies: false, error: err.message };
  }
}

/**
 * Print session status report
 */
function printSessionReport(profilePath) {
  console.log('\n' + '='.repeat(60));
  console.log('SESSION STATUS REPORT');
  console.log('='.repeat(60));
  
  const info = getSessionInfo(profilePath);
  
  console.log(`Profile: ${profilePath}`);
  console.log(`Has Cookies: ${info.hasCookies ? '✅ Yes' : '❌ No'}`);
  
  if (info.hasCookies) {
    console.log(`Cookie Count (approx): ${info.cookieCount}`);
    console.log(`Last Modified: ${info.lastModified}`);
    console.log(`Age: ${info.ageInMinutes} minutes ago`);
    console.log(`File Size: ${info.fileSize} bytes`);
    
    // Session typically expires after 30-60 minutes of inactivity
    if (info.ageInMinutes > 60) {
      console.log('⚠️  WARNING: Session likely expired (> 60 minutes old)');
    } else if (info.ageInMinutes > 30) {
      console.log('⚠️  WARNING: Session may expire soon (> 30 minutes old)');
    } else {
      console.log('✅ Session appears fresh');
    }
  }
  
  console.log('='.repeat(60) + '\n');
}

// CLI usage
if (require.main === module) {
  const profilePath = process.argv[2] || path.join(__dirname, 'chrome-profile');
  
  console.log('🔍 Session Checker');
  console.log(`Checking profile: ${profilePath}\n`);
  
  printSessionReport(profilePath);
  
  checkSessionAlive(profilePath).then(result => {
    console.log('\n📊 FINAL RESULT:');
    console.log(`Session Alive: ${result.alive ? '✅ YES' : '❌ NO'}`);
    console.log(`Reason: ${result.reason}`);
    process.exit(result.alive ? 0 : 1);
  });
}

module.exports = {
  hasValidCookies,
  checkSessionAlive,
  checkBaseProfileSession,
  getSessionInfo,
  printSessionReport
};






