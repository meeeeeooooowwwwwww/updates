const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process'); // To run wrangler commands

// --- Configuration ---
const TARGET_URL_BASE = 'https://rumble.com/c/BannonsWarRoom';
const DB_NAME = 'nataliewinters-db'; // Your D1 Database name
const TABLE_NAME = 'videos';
const TEMP_SQL_FILE = 'new_videos.sql';
const PAGE_NAV_TIMEOUT = 90000;
const SELECTOR_WAIT_TIMEOUT = 30000;

// --- Selectors (Keep consistent with mine-videos.js) ---
const VIDEO_LIST_ITEM_SELECTOR = 'ol.thumbnail__grid div.thumbnail__thumb';
const OVERALL_VIDEO_ENTRY_SELECTOR_PRIMARY = 'li';
const OVERALL_VIDEO_ENTRY_SELECTOR_FALLBACK = 'div.video-listing-entry';
const TIME_VIEWS_CONTAINER_SELECTOR = 'div.media-description-time-views-container';
const TIME_CONTAINER_SELECTOR = 'div.media-description-info-stream-time';
const TIME_TITLE_SELECTOR = 'div[title]';

// Function to escape single quotes for SQL
function escapeSqlString(value) {
    if (value === null || value === undefined) return 'NULL';
    const escaped = String(value).replace(/'/g, "''");
    return `'${escaped}'`;
}

// Function to run Wrangler commands with logging
function runWrangler(command) {
    console.log(`[WRANGLER] Executing: wrangler ${command}`);
    try {
        // Ensure environment variables for auth are available if needed by wrangler
        // Inherited from GitHub Actions environment
        const output = execSync(`wrangler ${command}`, { encoding: 'utf-8' });
        console.log("[WRANGLER] Command executed successfully");
        return output;
    } catch (error) {
        console.error("[WRANGLER] Error executing command:", error.stderr || error.stdout || error);
        throw error; // Re-throw to stop the script
    }
}

async function fetchLatestPlatformId() {
    console.log("[DB] Fetching latest platform_id from database...");
    try {
        const command = `d1 execute ${DB_NAME} --remote --command "SELECT platform_id FROM ${TABLE_NAME} ORDER BY sort_order DESC LIMIT 1;" --json`;
        const output = runWrangler(command);
        const results = JSON.parse(output);
        if (results && results.length > 0 && results[0].results && results[0].results.length > 0) {
            const latestId = results[0].results[0].platform_id;
            console.log(`[DB] Latest platform_id found: ${latestId}`);
            return latestId;
        }
        console.log("[DB] No existing videos found or platform_id is null.");
        return null;
    } catch (error) {
        console.error("[DB] Failed to fetch latest platform_id:", error);
        return null; // Proceed as if DB is empty on error
    }
}

async function fetchMaxSortOrder() {
    console.log("[DB] Fetching max sort_order from database...");
    try {
        const command = `d1 execute ${DB_NAME} --remote --command "SELECT MAX(sort_order) as max_order FROM ${TABLE_NAME};" --json`;
        const output = runWrangler(command);
        const results = JSON.parse(output);
        if (results && results.length > 0 && results[0].results && results[0].results.length > 0 && results[0].results[0].max_order !== null) {
            const maxOrder = parseInt(results[0].results[0].max_order, 10);
            console.log(`[DB] Max sort_order found: ${maxOrder}`);
            return maxOrder;
        }
        console.log("[DB] No existing videos found or max_order is null.");
        return 0; // Start from 0 if table is empty or max is null
    } catch (error) {
        console.error("[DB] Failed to fetch max sort_order:", error);
        return 0; // Default to 0 on error
    }
}

async function getLatestVideoId() {
    console.log('[DB] Fetching latest video ID from database...');
    try {
        const result = await runWrangler('d1 execute nataliewinters-db --remote --command "SELECT id FROM videos ORDER BY sort_order DESC LIMIT 1;" --json');
        const data = JSON.parse(result);
        if (data && data.length > 0 && data[0].id) {
            console.log('[DB] Latest video ID found:', data[0].id);
            return data[0].id;
        }
        console.log('[DB] No videos found in database');
        return null;
    } catch (error) {
        console.error('[DB] Error fetching latest video ID:', error);
        return null;
    }
}

async function checkVideoExists(videoId) {
    try {
        const result = await runWrangler(`d1 execute nataliewinters-db --remote --command "SELECT COUNT(*) as count FROM videos WHERE id = '${videoId}';" --json`);
        const data = JSON.parse(result);
        return data && data.length > 0 && data[0].count > 0;
    } catch (error) {
        console.error('[DB] Error checking video existence:', error);
        return false;
    }
}

async function scrapeVideos() {
    console.log('[START] Beginning video update process...');
    
    // Get the latest video ID from the database
    const latestVideoId = await getLatestVideoId();
    console.log('[START] Latest known video ID:', latestVideoId);

    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();
        console.log('[SCRAPER] Launching browser for scraping...');

        // Navigate to the page
        console.log('[SCRAPER] Navigating to', TARGET_URL_BASE);
        await page.goto(TARGET_URL_BASE, { waitUntil: 'networkidle0' });
        console.log('[SCRAPER] Page loaded. Waiting for videos...');

        // Wait for videos to load
        await page.waitForSelector('ol.thumbnail__grid', { timeout: 30000 });
        console.log('[SCRAPER] Videos found.');

        // Get all video elements
        const videoElements = await page.$$('ol.thumbnail__grid div.thumbnail__thumb');
        console.log(`[SCRAPER] Found ${videoElements.length} videos on page 1.`);

        const newVideos = [];
        let foundLatestVideo = false;

        // Process each video
        for (const video of videoElements) {
            try {
                const linkElement = await video.$('a.videostream__link.link');
                if (!linkElement) continue;

                const link = await linkElement.evaluate(el => el.href);
                const title = await linkElement.evaluate(el => el.textContent.trim());
                
                // Extract video ID from URL - more robust extraction
                const videoId = link.split('/').pop().split('.')[0].split('-')[0];
                
                // Skip if we've found the latest video
                if (foundLatestVideo) continue;
                
                // If we've found the latest video we've already scraped, stop
                if (latestVideoId && videoId === latestVideoId) {
                    console.log(`[SCRAPER] Found latest known video: ${title} (ID: ${videoId})`);
                    foundLatestVideo = true;
                    continue;
                }

                // Check if video already exists in database
                const exists = await checkVideoExists(videoId);
                if (exists) {
                    console.log(`[SCRAPER] Video already exists in database: ${title} (ID: ${videoId})`);
                    continue;
                }

                // Add new video to our list
                newVideos.push({
                    id: videoId,
                    title: title,
                    link: link,
                    publish_date: new Date().toISOString().split('T')[0],
                    platform_id: 'warroom'
                });
                console.log(`[SCRAPER] Adding new video: ${title} (ID: ${videoId})`);
            } catch (error) {
                console.error('[SCRAPER] Error processing video:', error);
                continue;
            }
        }

        if (!foundLatestVideo && latestVideoId) {
            console.log('[SCRAPER] Processed all videos on page 1 without finding the latest known video. Either >1 page of new videos or latest known video is very old.');
        }

        await browser.close();
        console.log('[SCRAPER] Browser closed.');

        return newVideos;
    } catch (error) {
        console.error('[SCRAPER] Error during scraping:', error);
        await browser.close();
        throw error;
    }
}

async function insertNewVideos(videos) {
    if (!videos || videos.length === 0) {
        console.log('[DB] No new videos to insert');
        return;
    }

    console.log('[DB] Preparing to insert', videos.length, 'new videos...');
    
    try {
        // Get the current max sort_order
        const result = await runWrangler('d1 execute nataliewinters-db --remote --command "SELECT MAX(sort_order) as max_order FROM videos;" --json');
        const data = JSON.parse(result);
        const maxOrder = data && data.length > 0 ? data[0].max_order : 0;
        console.log('[DB] Max sort_order found:', maxOrder);

        // Generate INSERT statements
        const insertStatements = videos.map((video, index) => {
            const sortOrder = maxOrder + videos.length - index;
            return `INSERT INTO videos (id, title, link, publish_date, platform_id, sort_order) VALUES ('${video.id}', '${video.title.replace(/'/g, "''")}', '${video.link.replace(/'/g, "''")}', '${video.publish_date}', '${video.platform_id}', ${sortOrder});`;
        });

        // Write to SQL file
        fs.writeFileSync('new_videos.sql', insertStatements.join('\n'));
        console.log('[DB] Generated', insertStatements.length, 'INSERT statements.');
        console.log('[DB] Wrote INSERT statements to new_videos.sql');

        // Execute the SQL file
        await runWrangler('d1 execute nataliewinters-db --remote --file=new_videos.sql');
        console.log('[DB] Successfully inserted', videos.length, 'new videos');
    } catch (error) {
        console.error('[DB] Error writing SQL file or executing inserts:', error);
        throw error;
    }
}


// --- Main Execution ---
(async () => {
    console.log("[START] Beginning video update process...");
    try {
        const latestKnownId = await fetchLatestPlatformId();
        console.log(`[START] Latest known video ID: ${latestKnownId || 'None'}`);
        
        const newVideos = await scrapeVideos();
        console.log(`[START] Found ${newVideos.length} new videos to insert`);
        
        await insertNewVideos(newVideos);
        console.log("[START] Update process finished successfully.");
    } catch (error) {
        console.error("[ERROR] Script failed:", error);
        process.exit(1); // Exit with error code
    }
})();