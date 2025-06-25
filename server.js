const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const jsdom = require('jsdom');
const xml2js = require('xml2js');
const { JSDOM } = jsdom;
const fs = require('fs');
const { Cluster } = require('puppeteer-cluster');

puppeteer.use(StealthPlugin());

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

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

function extractProductsAndArticlesByRule(innerHTML, baseUrl) {
    const dom = new JSDOM(innerHTML);
    const document = dom.window.document;

    const toAbsoluteUrl = (url) => {
        if (!url) return '';
        if (url.startsWith('http')) return url;
        if (url.startsWith('//')) return `https:${url}`;
        if (url.startsWith('/')) return new URL(url, baseUrl).href;
        return new URL(url, baseUrl).href;
    };

    const productNodes = document.querySelectorAll('div[class*="product"], li[class*="product"]');
    const products = [];
    productNodes.forEach(node => {
        let name = node.querySelector('h2, h3, .product-title, .title')?.textContent?.trim() || '';
        let price = '';
        const priceNodes = node.querySelectorAll('.price, .product-price, [class*="price"]');
        for (let el of priceNodes) {
            // Loại bỏ giá bị gạch ngang (giá gốc)
            const style = el.getAttribute('style') || '';
            const className = el.className || '';
            if (
                !style.includes('line-through') &&
                !className.match(/old|original|strike|gach/i)
            ) {
                price = el.textContent.replace(/[\n\r]+/g, ' ').trim();
                if (price) break; // Lấy giá đầu tiên hợp lệ
            }
        }
        let img = toAbsoluteUrl(node.querySelector('img')?.getAttribute('src') || '');
        let url = toAbsoluteUrl(node.querySelector('a')?.getAttribute('href') || '');
        if (name) {
            products.push({ name, price, image: img, url });
        }
    });

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

async function scrapeWebsite(url) {
    console.log(`\n[Puppeteer] === Bắt đầu scrape ${url} ===`);
    const os = require('os');
    console.log(`[Puppeteer] RAM: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`);
    console.log(`[Puppeteer] CPU: ${os.loadavg()[0].toFixed(2)}`);

    const cluster = await Cluster.launch({
        concurrency: Cluster.CONCURRENCY_PAGE,
        maxConcurrency: 1, // Chỉ 1 trang
        puppeteerOptions: {
            headless: true,
            protocolTimeout: 300000,
            timeout: 0,
            executablePath: '/usr/bin/google-chrome', // Dùng Chrome có sẵn
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=1280,720',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows'
            ]
        }
    });

    let result = null;
    try {
        await cluster.task(async ({ page, data: url }) => {
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
            await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
            await page.setBypassCSP(true);
            await page.setViewport({ width: 1280, height: 720 });

            console.log(`[Puppeteer] Truy cập URL: ${url}`);
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

            const isCaptcha = await page.evaluate(() => {
                return !!document.querySelector('input[name="cf-turnstile-response"]') ||
                       !!document.querySelector('#recaptcha') ||
                       !!document.querySelector('.g-recaptcha');
            });
            if (isCaptcha) {
                console.log('[Puppeteer] Phát hiện CAPTCHA, bỏ qua');
                result = { error: 'CAPTCHA detected' };
                return;
            }

            console.log('[Puppeteer] Cuộn trang...');
            await autoScroll(page);
            await new Promise(resolve => setTimeout(resolve, 5000));

            const innerHTML = await page.evaluate(() => {
                const elements = ['script', 'style', 'footer', 'header'];
                elements.forEach(sel => document.querySelectorAll(sel).forEach(el => el.remove()));
                return document.body.innerHTML.trim();
            });

            const { products, articles } = extractProductsAndArticlesByRule(innerHTML, url);
            const uniqueByUrl = arr => {
                const seen = new Set();
                return arr.filter(item => {
                    if (!item.url || seen.has(item.url)) return false;
                    seen.add(item.url);
                    return true;
                });
            };
            result = { url, products: uniqueByUrl(products), articles: uniqueByUrl(articles) };
        });

        await cluster.queue(url);
        await cluster.idle();
    } catch (error) {
        console.error(`[Puppeteer] Lỗi: ${error.message}`);
        result = { error: error.message };
    } finally {
        await cluster.close();
        console.log('[Puppeteer] Đã đóng cluster.');
    }
    return result || { error: 'No data scraped' };
}

async function parseSitemapXml(sitemapUrl) {
    console.log(`\n[Sitemap] === Đang tải sitemap: ${sitemapUrl}`);
    try {
        const response = await axios.get(sitemapUrl);
        const xml = response.data;
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(xml);

        let urls = [];

        if (result.urlset && result.urlset.url) {
            urls = result.urlset.url.map(u => u.loc[0]);
        } else if (result.sitemapindex && result.sitemapindex.sitemap) {
            const sitemapUrls = result.sitemapindex.sitemap.map(s => s.loc[0]);
            console.log(`[Sitemap] Sitemap index - phát hiện ${sitemapUrls.length} sitemap con`);
            for (const subSitemapUrl of sitemapUrls) {
                const subUrls = await parseSitemapXml(subSitemapUrl);
                urls = urls.concat(subUrls);
            }
        }

        console.log(`[Sitemap] Tổng cộng ${urls.length} URL lấy được từ ${sitemapUrl}`);
        return urls;

    } catch (error) {
        console.error(`[Sitemap] ❌ Lỗi tải sitemap: ${error.message}`);
        return [];
    }
}

async function tryGetSitemapUrl(baseUrl) {
    const sitemapUrl = baseUrl.endsWith('/') ? `${baseUrl}sitemap.xml` : `${baseUrl}/sitemap.xml`;
    console.log(`\n[Detect] Thử tìm sitemap tại: ${sitemapUrl}`);
    try {
        const response = await axios.get(sitemapUrl);
        if (response.status === 200 && response.data.includes('<?xml')) {
            console.log('[Detect] ✅ Tìm thấy sitemap.xml');
            return sitemapUrl;
        }
    } catch (err) {
        console.log('[Detect] ❌ Không tìm thấy sitemap.xml');
    }
    return null;
}

async function crawlAllUrlsFromSitemap(sitemapUrl, baseUrl, websiteId, chatbotId) {
    let urls = await parseSitemapXml(sitemapUrl);

    // GIỚI HẠN 50 URL
    const maxUrls = 10;
    urls = urls.slice(0, maxUrls);
    console.log(`\n[Crawler] ⚠️ Đang crawl tối đa ${urls.length} URL đầu tiên.`);

    const globalProductsMap = new Map();
    const globalArticlesMap = new Map();

    for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        console.log(`\n[Crawler] (${i + 1}/${urls.length}) Đang quét URL: ${url}`);

        try {
            const result = await scrapeWebsite(url);

                let newProductsCount = 0;

                if (Array.isArray(result.products)) {
                    result.products.forEach(product => {
                        const key = `${product.name}|${product.url}`.toLowerCase();
                        if (!globalProductsMap.has(key)) {
                            globalProductsMap.set(key, product);
                            newProductsCount++;
                        } else {
                            console.log(`[Crawler] 🔁 Trùng sản phẩm: ${product.name} (${product.url})`);
                        }
                    });
                }

                if (Array.isArray(result.articles)) {
                    result.articles.forEach(article => {
                        const key = `${article.title}|${article.url}`.toLowerCase();
                        if (!globalArticlesMap.has(key)) {
                            globalArticlesMap.set(key, article);
                        }
                    });
                }

                console.log(`[Crawler] ✅ Xong URL: ${url} → Sản phẩm mới: ${newProductsCount}, Bài viết: ${result.articles?.length || 0}`);
                await new Promise(resolve => setTimeout(resolve, 1500));
            } catch (error) {
                console.error(`[Crawler] ❌ Lỗi khi quét URL: ${url}`, error.message);
            }
    }

    console.log(`\n[Crawler] 🎉 Hoàn thành crawl ${urls.length} URL. Tổng sản phẩm KHÔNG TRÙNG: ${globalProductsMap.size}, Tổng bài viết KHÔNG TRÙNG: ${globalArticlesMap.size}`);

    const allProducts = Array.from(globalProductsMap.values());
    const allArticles = Array.from(globalArticlesMap.values());
    return { products: allProducts, articles: allArticles };
}

app.get('/scrape', async (req, res) => {
    const { url, website_id, chatbot_id } = req.query;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    console.log(`\n[Main] === Bắt đầu SCRAPE cho: ${url}`);

    const sitemapUrl = await tryGetSitemapUrl(url);

    if (sitemapUrl) {
        console.log('\n[Main] Phát hiện sitemap → Tiến hành crawl toàn site');
        const result = await crawlAllUrlsFromSitemap(sitemapUrl, url, website_id, chatbot_id);
        res.json({ status: 'done (full site)', sitemapUrl, ...result });
    } else {
        console.log('\n[Main] Không có sitemap → Chỉ scrape URL truyền vào');
        const result = await scrapeWebsite(url);
        res.json(result);
    }
});

app.listen(port, () => {
    console.log(`\n🚀 Server running on port ${port}`);
});