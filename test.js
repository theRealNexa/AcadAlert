const puppeteer = require('puppeteer-core');

(async () => {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Users\\User\\.cache\\puppeteer\\chrome\\win64-146.0.7680.31\\chrome-win64\\chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  console.log('Browser launched successfully.');
  const page = await browser.newPage();
  await page.goto('https://example.com');
  console.log('Page loaded successfully.');
  await browser.close();
  console.log('Done.');
})();
