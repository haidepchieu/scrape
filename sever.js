const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');

puppeteer.use(StealthPlugin());

const app = express();
const port = 3000;

app.use(express.json());

// Hàm tự động cuộn trang để tải nội dung lazy-load
async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise(resolve => {
            let totalHeight = 0;
            const distance = 100;
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= scrollHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    });
}

// Hàm scrape website
async function scrapeWebsite(url, websiteId, chatbotId, req) {
    console.log(`[Puppeteer] Bắt đầu scrape ${url}...`);
    let browser, page;
    try {
        console.log('[Puppeteer] Khởi tạo trình duyệt Puppeteer...');
        browser = await puppeteer.launch({
            headless: 'new',
            executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            timeout: 0,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--no-zygote',
                '--single-process',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        });

        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        await page.setBypassCSP(true);

        // Bỏ qua tải hình ảnh, stylesheet, font để tăng tốc
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        console.log(`[Puppeteer] Truy cập URL: ${url}`);
        const maxRetries = 3;
        let attempt = 0;
        let response;
        while (attempt < maxRetries) {
            try {
                response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
                console.log(`[Puppeteer] Truy cập URL thành công, status: ${response.status()}`);
                if (!response.ok()) {
                    throw new Error(`HTTP ${response.status()}: ${response.statusText()}`);
                }
                break;
            } catch (error) {
                attempt++;
                console.warn(`[Puppeteer] Thử lại (${attempt}/${maxRetries}): ${error.message}`);
                if (attempt === maxRetries) throw error;
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        console.log('[Puppeteer] Cuộn trang để tải nội dung lazy...');
        await autoScroll(page);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Chờ thêm 2 giây để nội dung tải hết

        console.log('[Puppeteer] Đợi các phần tử sản phẩm/bài viết tải...');
        await page.waitForSelector('.product-small, .article, .post, .news', { timeout: 30000 })
            .catch(() => console.warn('[Puppeteer] Không tìm thấy phần tử, thử lấy dữ liệu từ API.'));

        console.log('[Puppeteer] Thu thập dữ liệu sản phẩm và bài viết...');
        const data = await page.evaluate(() => {
            const products = [];
            const articles = [];

            // Quét sản phẩm
            const productElements = document.querySelectorAll('.product-small');
            productElements.forEach(element => {
                const name = element.querySelector('.product-title')?.innerText?.trim() || '';
                const price = element.querySelector('.woocommerce-Price-amount')?.innerText?.trim() || '';
                const image = element.querySelector('img[src], img[data-src]')?.getAttribute('src') || element.querySelector('img')?.getAttribute('data-src') || '';
                const url = element.querySelector('a[href*="chi-tiet-sp"]')?.getAttribute('href') || '';

                if (name && price && url.includes('/chi-tiet-sp/')) {
                    products.push({
                        type: 'product',
                        name,
                        price,
                        image: image.startsWith('http') ? image : new URL(image, window.location.origin).href,
                        url: url.startsWith('http') ? url : new URL(url, window.location.origin).href
                    });
                }
            });

            // Quét bài viết
            const articleElements = document.querySelectorAll('.article, .post, .news, [class*="article"], [class*="post"], [class*="news"], [data-article]');
            articleElements.forEach(element => {
                const title = element.querySelector('h1, h2, h3, h4, .title, .post-title, [class*="title"], [data-title]')?.innerText?.trim() || '';
                const image = element.querySelector('img[src], img[data-src]')?.getAttribute('src') || element.querySelector('img')?.getAttribute('data-src') || '';
                const url = element.querySelector('a[href*="chi-tiet/"]')?.getAttribute('href') || '';

                if (title && url.includes('/chi-tiet/')) {
                    articles.push({
                        type: 'article',
                        title,
                        image: image.startsWith('http') ? image : new URL(image, window.location.origin).href,
                        url: url.startsWith('http') ? url : new URL(url, window.location.origin).href
                    });
                }
            });

            return { products, articles };
        });

        // Lấy dữ liệu từ API
        console.log('[Puppeteer] Thu thập yêu cầu API...');
        const apiData = await page.evaluate(async () => {
            const requests = [];
            window.fetch = async (...args) => {
                requests.push(args[0]);
                return await window.originalFetch(...args);
            };
            window.originalFetch = window.fetch;
            await new Promise(resolve => setTimeout(resolve, 2000));
            return requests.filter(req => req.includes('api') || req.includes('products') || req.includes('articles') || req.includes('posts'));
        });

        if (apiData.length > 0) {
            console.log('[Puppeteer] Phát hiện các yêu cầu API:', apiData);
            for (const apiUrl of apiData) {
                try {
                    const response = await axios.get(apiUrl);
                    const apiProducts = response.data.products || response.data.items || response.data;
                    const apiArticles = response.data.articles || response.data.posts || [];

                    if (Array.isArray(apiProducts)) {
                        apiProducts.forEach(product => {
                            if (product.name && product.price) {
                                data.products.push({
                                    type: 'product',
                                    name: product.name,
                                    price: product.price || product.priceText || '',
                                    image: product.image || product.thumbnail || '',
                                    url: product.url || product.link || ''
                                });
                            }
                        });
                    }

                    if (Array.isArray(apiArticles)) {
                        apiArticles.forEach(article => {
                            if (article.title) {
                                data.articles.push({
                                    type: 'article',
                                    title: article.title,
                                    image: article.image || article.thumbnail || '',
                                    url: article.url || article.link || ''
                                });
                            }
                        });
                    }
                } catch (error) {
                    console.warn('[Puppeteer] Lỗi khi lấy dữ liệu từ API:', error.message);
                }
            }
        }

        // Lọc trùng lặp và sắp xếp
        console.log('[Puppeteer] Lọc trùng lặp và sắp xếp dữ liệu...');
        const uniqueProducts = [];
        const productUrls = new Set();
        data.products.forEach(product => {
            if (!productUrls.has(product.url)) {
                productUrls.add(product.url);
                uniqueProducts.push(product);
            }
        });
        uniqueProducts.sort((a, b) => a.name.localeCompare(b.name));

        const uniqueArticles = [];
        const articleUrls = new Set();
        data.articles.forEach(article => {
            if (!articleUrls.has(article.url)) {
                articleUrls.add(article.url);
                uniqueArticles.push(article);
            }
        });
        uniqueArticles.sort((a, b) => a.title.localeCompare(b.title));

        data.products = uniqueProducts;
        data.articles = uniqueArticles;

        console.log(`[Puppeteer] ✅ Đã thu thập ${data.products.length} sản phẩm và ${data.articles.length} bài viết.`);

        // Chuẩn bị dữ liệu để gửi về backend
        const postData = {
            url,
            website_id: websiteId,
            chatbot_id: chatbotId,
            content: {
                products: data.products,
                articles: data.articles
            }
        };

        // Nếu không có sản phẩm hoặc bài viết, lấy innerHTML
        if (data.products.length === 0 && data.articles.length === 0) {
            console.log('[Puppeteer] Không quét được dữ liệu, lấy innerHTML...');
            const innerHTML = await page.evaluate(() => {
                const elementsToRemove = ['script', 'style', 'nav', 'footer', '[class*="ad"]', '[class*="banner"]'];
                elementsToRemove.forEach(selector => {
                    document.querySelectorAll(selector).forEach(el => el.remove());
                });
                return document.body.innerHTML.trim();
            });
            postData.content.innerHTML = innerHTML.slice(0, 100000); // Giới hạn kích thước
        }

        // Gửi dữ liệu về backend với retry logic
        console.log(`[Puppeteer] Gửi dữ liệu về backend với website_id: ${websiteId}, chatbot_id: ${chatbotId}`);
        const maxBackendRetries = 1;
        let backendAttempt = 0;
        let backendError = null;

        while (backendAttempt < maxBackendRetries) {
            try {
                const responseBackend = await axios.post('http://127.0.0.1:8000/api/process-scraped-content', postData, {
                    headers: { 
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    timeout: 120000 // Tăng timeout lên 120 giây
                });
                
                console.log('[Puppeteer] ✅ Gửi dữ liệu về backend thành công.');
                console.log('[Puppeteer] 🔁 Phản hồi từ backend:', responseBackend.data);
                
                const result = {
                    url,
                    website_id: websiteId,
                    chatbot_id: chatbotId,
                    products: data.products,
                    articles: data.articles,
                    innerHTML: postData.content.innerHTML || null,
                    backendResponse: responseBackend.data
                };
                
                return result;
            } catch (error) {
                backendAttempt++;
                backendError = error;
                console.warn(`[Puppeteer] Thử lại gửi backend (${backendAttempt}/${maxBackendRetries}): ${error.message}`);
                
                if (backendAttempt === maxBackendRetries) {
                    console.log('[Puppeteer] Không thể gửi dữ liệu về backend sau nhiều lần thử.');
                    return {
                        ...postData,
                        error: `Không thể gửi tới backend sau ${maxBackendRetries} lần thử: ${error.message}`
                    };
                }
                
                await new Promise(resolve => setTimeout(resolve, 2000 * backendAttempt));
            }
        }

    } catch (error) {
        console.error('[Puppeteer] ❌ Lỗi khi scrape:', error.message);
        console.error('[Puppeteer] Stack trace:', error.stack);
        return { error: error.message };
    } finally {
        if (browser) {
            await browser.close();
            console.log('[Puppeteer] 🔚 Đã đóng trình duyệt.');
        }
    }
}

// API endpoint để scrape
app.get('/scrape', async (req, res) => {
    const { url, websiteId, chatbotId } = req.query;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    const result = await scrapeWebsite(url, websiteId || 0, chatbotId || null, req);
    res.json(result);
});

// API endpoint để test Chrome
app.get('/test-chrome', async (req, res) => {
    let browser;
    try {
        console.log('[Test] Bắt đầu kiểm tra Chrome với Puppeteer...');
        browser = await puppeteer.launch({
            headless: 'new',
            executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            args: ['--no-sandbox', '--disable-extensions'],
            timeout: 180000,
        });
        console.log('[Test] Trình duyệt Chrome khởi tạo thành công!');

        const page = await browser.newPage();
        await page.goto('https://www.google.com', { waitUntil: 'networkidle2' });
        console.log('[Test] Truy cập google.com thành công.');
        const title = await page.title();
        console.log('[Test] Tiêu đề trang:', title);

        await browser.close();
        console.log('[Test] Đã đóng trình duyệt.');
        res.json({ status: 'success', title });
    } catch (error) {
        console.error('[Test] Lỗi:', error.message);
        if (browser) await browser.close();
        res.json({ status: 'error', error: error.message });
    }
});

// API endpoint để test URL
app.get('/test-url', async (req, res) => {
    const url = req.query.url || 'http://127.0.0.1:8082/';
    let browser;
    try {
        console.log(`[Test] Bắt đầu kiểm tra truy cập URL: ${url}`);
        browser = await puppeteer.launch({
            headless: 'new',
            executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            args: ['--no-sandbox', '--disable-extensions'],
            timeout: 180000,
        });
        console.log('[Test] Trình duyệt khởi tạo thành công.');

        const page = await browser.newPage();
        const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        console.log(`[Test] Truy cập thành công, status: ${response.status()}`);

        const title = await page.title();
        console.log('[Test] Tiêu đề trang:', title);

        await browser.close();
        console.log('[Test] Đã đóng trình duyệt.');
        res.json({ status: 'success', title, httpStatus: response.status() });
    } catch (error) {
        console.error('[Test] Lỗi:', error.message);
        if (browser) await browser.close();
        res.json({ status: 'error', error: error.message });
    }
});

// Chạy server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});