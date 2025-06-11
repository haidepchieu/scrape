const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;

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

// Hàm chia nhỏ chuỗi thành các đoạn nhỏ
function splitStringByLength(str, maxLength) {
    const result = [];
    let i = 0;
    while (i < str.length) {
        result.push(str.slice(i, i + maxLength));
        i += maxLength;
    }
    return result;
}

// Hàm tách sản phẩm bằng rule code (jsdom) - ĐÃ SỬA
function extractProductsAndArticlesByRule(innerHTML, baseUrl) {
    const dom = new JSDOM(innerHTML);
    const document = dom.window.document;

    // Hàm helper để chuyển relative URL thành absolute URL
    const toAbsoluteUrl = (url) => {
        if (!url) return '';
        if (url.startsWith('http')) return url;
        if (url.startsWith('//')) return `https:${url}`;
        if (url.startsWith('/')) return new URL(url, baseUrl).href;
        return new URL(url, baseUrl).href;
    };

    // Sản phẩm
    const productNodes = document.querySelectorAll('div[class*="product"], li[class*="product"]');
    const products = [];
    productNodes.forEach(node => {
        let name = node.querySelector('h2, h3, .product-title, .title')?.textContent?.trim() || '';
        let price = node.querySelector('.price, .product-price, [class*="price"]')?.textContent?.trim() || '';
        let img = toAbsoluteUrl(node.querySelector('img')?.getAttribute('src') || '');
        let url = toAbsoluteUrl(node.querySelector('a')?.getAttribute('href') || '');
        if (name) {
            products.push({ name, price, image: img, url });
        }
    });

    // Bài viết
    const articleNodes = document.querySelectorAll('div[class*="article"], li[class*="article"], div[class*="post"], li[class*="post"], article');
    const articles = [];
    articleNodes.forEach(node => {
        let title = node.querySelector('h2, h3, .article-title, .post-title, .title')?.textContent?.trim() || '';
        let url = toAbsoluteUrl(node.querySelector('a')?.getAttribute('href') || '');
        let img = toAbsoluteUrl(node.querySelector('img')?.getAttribute('src') || '');
        if (title) {
            articles.push({ title, url, image: img });
        }
    });

    return { products, articles };
}

// Hàm scrape website
async function scrapeWebsite(url, websiteId, chatbotId, req) {
    console.log(`[Puppeteer] Bắt đầu scrape ${url}...`);
    let browser, page;
    try {
        console.log('[Puppeteer] Khởi tạo trình duyệt Puppeteer...');
        browser = await puppeteer.launch({
            headless: 'new',
            
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
        await new Promise(resolve => setTimeout(resolve, 10000)); // Chờ thêm để nội dung tải hết

        // Lấy innerHTML đã loại bỏ các thẻ không cần thiết
        console.log('[Puppeteer] Lấy innerHTML đã loại bỏ các thẻ không cần thiết...');
        const innerHTML = await page.evaluate(() => {
            const elementsToRemove = [
                'script', 'style', 'footer', 'header',
            ];
            elementsToRemove.forEach(selector => {
                document.querySelectorAll(selector).forEach(el => el.remove());
            });
            return document.body.innerHTML.trim();
        });

        // Áp dụng rule code trước
         const { products: productsByRule, articles: articlesByRule } = extractProductsAndArticlesByRule(innerHTML, url);

        let allProducts = [];
        let allArticles = [];
        let backendResponses = [];

        if (productsByRule.length >= 3 || articlesByRule.length >= 1) { // Nếu tách được đủ sản phẩm hoặc có bài viết
            console.log(`[Puppeteer] ✅ Đã tách được ${productsByRule.length} sản phẩm và ${articlesByRule.length} bài viết bằng rule code, KHÔNG gửi lên OpenAI.`);
            allProducts = productsByRule;
            allArticles = articlesByRule;
        } else {
            // Nếu không tách được hoặc quá ít, mới gửi lên OpenAI như cũ
            const MAX_LENGTH = 80000;
            const htmlParts = splitStringByLength(innerHTML, MAX_LENGTH);

            for (let idx = 0; idx < htmlParts.length; idx++) {
                const part = htmlParts[idx];
                const postData = {
                    url,
                    website_id: websiteId,
                    chatbot_id: chatbotId,
                    content: {
                        innerHTML: part
                    }
                };
                console.log(`[Puppeteer] Gửi đoạn ${idx + 1}/${htmlParts.length} về backend...`);
                try {
                    const responseBackend = await axios.post('https://chatbot.newwaytech.vn/api/process-scraped-content', postData, {
                        headers: { 
                            'Content-Type': 'application/json',
                            'Accept': 'application/json'
                        },
                        timeout: 120000
                    });
                    const data = responseBackend.data;
                    backendResponses.push(data);
                    if (Array.isArray(data.products)) allProducts = allProducts.concat(data.products);
                    if (Array.isArray(data.articles)) allArticles = allArticles.concat(data.articles);
                    console.log(`[Puppeteer] ✅ Đoạn ${idx + 1} gửi thành công.`);
                } catch (error) {
                    console.warn(`[Puppeteer] ❌ Lỗi gửi đoạn ${idx + 1}: ${error.message}`);
                }
            }
        }

        // Loại trùng sản phẩm/bài viết nếu cần (theo url)
        const uniqueByUrl = (arr) => {
            const seen = new Set();
            return arr.filter(item => {
                if (!item.url || seen.has(item.url)) return false;
                seen.add(item.url);
                return true;
            });
        };

        allProducts = uniqueByUrl(allProducts);
        allArticles = uniqueByUrl(allArticles);

        // Gửi kết quả tổng hợp về backend để lưu
        const finalPostData = {
            url,
            website_id: websiteId,
            chatbot_id: chatbotId,
            content: {
                products: allProducts,
                articles: allArticles
            }
        };
        try {
            const saveResponse = await axios.post('https://chatbot.newwaytech.vn/api/save-scraped-result', finalPostData, {
                headers: { 
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                timeout: 120000
            });
            console.log('[Puppeteer] ✅ Đã gửi kết quả tổng hợp về backend để lưu:', saveResponse.data);
        } catch (error) {
            console.warn('[Puppeteer] ❌ Lỗi khi gửi kết quả tổng hợp:', error.message);
        }
        return {
            url,
            website_id: websiteId,
            chatbot_id: chatbotId,
            products: allProducts,
            articles: allArticles
        };

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