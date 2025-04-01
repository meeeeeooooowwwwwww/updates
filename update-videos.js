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

async function scrapeLatestVideos(latestKnownPlatformId) {
    console.log('[SCRAPER] Launching browser for scraping...');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'] // Necessary for running in GitHub Actions/Linux
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    const videosToInsert = [];
    const page1Url = `${TARGET_URL_BASE}/videos`; // Always start checking from page 1

    try {
        console.log(`[SCRAPER] Navigating to ${page1Url}...`);
        await page.goto(page1Url, { waitUntil: 'networkidle2', timeout: PAGE_NAV_TIMEOUT });
        console.log("[SCRAPER] Page loaded. Waiting for videos...");
        await page.waitForSelector(VIDEO_LIST_ITEM_SELECTOR, { timeout: SELECTOR_WAIT_TIMEOUT });
        console.log("[SCRAPER] Videos found.");

        const videosOnPage = await page.$$eval(
            VIDEO_LIST_ITEM_SELECTOR,
             (items, primaryAncestorSel, fallbackAncestorSel, timeViewsSel, timeContainerSel, timeTitleSel) => {
                // This $$eval function extracts data but *doesn't* have access to latestKnownPlatformId
                // It just returns all data from page 1
                return items.map(item => {
                    const img = item.querySelector('img.thumbnail__image');
                    const linkElement = item.querySelector('a.videostream__link.link'); // Rename to avoid conflict
                    const title = img ? img.getAttribute('alt') : null;
                    const thumbnail = img ? img.getAttribute('src') : null;
                    const videoPath = linkElement ? linkElement.getAttribute('href') : null; // Use renamed variable
                    const link = videoPath ? `https://rumble.com${videoPath}` : null; // Construct full link early

                    // Extract platform_id here for comparison later
                    const platformIdMatch = link ? link.match(/rumble\.com\/([a-z0-9]+)-/) : null;
                    const platform_id = platformIdMatch ? platformIdMatch[1] : (link ? link.split('/').pop().split('.')[0] : null);


                    // We don't need date extraction here as we use fake dates for inserts
                    // based on order relative to the known latest video.

                    if (title && link && platform_id) {
                        return {
                            title: title.trim(),
                            link: link,
                            thumbnail: thumbnail,
                            platform: 'rumble', // Hardcoded
                            platform_id: platform_id,
                            source_type: 'warroom' // Hardcoded
                        };
                    }
                    return null;
                }).filter(video => video !== null);
            },
            OVERALL_VIDEO_ENTRY_SELECTOR_PRIMARY,
            OVERALL_VIDEO_ENTRY_SELECTOR_FALLBACK,
            TIME_VIEWS_CONTAINER_SELECTOR,
            TIME_CONTAINER_SELECTOR,
            TIME_TITLE_SELECTOR
        );

        console.log(`[SCRAPER] Found ${videosOnPage.length} videos on page 1.`);

        // Process scraped videos to find new ones
        let newVideosCount = 0;
        for (const video of videosOnPage) {
            if (video.platform_id === latestKnownPlatformId) {
                console.log(`[SCRAPER] Found latest known video (ID: ${latestKnownPlatformId}). Stopping.`);
                break; // Stop adding videos once we hit one we already have
            }
            console.log(`[SCRAPER] Adding new video: ${video.title} (ID: ${video.platform_id})`);
            videosToInsert.push(video);
            newVideosCount++;
        }

        console.log(`[SCRAPER] Total new videos found: ${newVideosCount}`);

        // If we went through all videos on page 1 and didn't find the latest known one,
        // it means there are >1 page of new videos OR the latest known video expired.
        // For simplicity, we are currently only processing Page 1.
        // Add logic here later to navigate to page 2 if needed.
        if (videosToInsert.length === videosOnPage.length && latestKnownPlatformId !== null) {
             console.warn("[SCRAPER] Processed all videos on page 1 without finding the latest known video. Either >1 page of new videos or latest known video is very old.");
        }


    } catch (error) {
        console.error("[SCRAPER] Error during scraping:", error);
        // Decide if we should stop or continue without new videos
    } finally {
        await browser.close();
        console.log("[SCRAPER] Browser closed.");
    }

    return videosToInsert; // Return only the new videos found
}

async function insertNewVideos(newVideos) {
    if (!newVideos || newVideos.length === 0) {
        console.log("[DB] No new videos to insert.");
        return;
    }

    console.log(`[DB] Preparing to insert ${newVideos.length} new videos...`);

    const maxSortOrder = await fetchMaxSortOrder();
    const baseTime = new Date(); // Use current time as base for fake dates
    const sqlStatements = [];

    // Reverse the array so the oldest of the *new* videos is processed first
    newVideos.reverse();

    newVideos.forEach((video, index) => {
        const sort_order = maxSortOrder + index + 1;
        const fakeTimestamp = new Date(baseTime.getTime() - (index * 1000)); // Oldest new video gets latest fake time
        const publish_date = fakeTimestamp.toISOString();

        const id = escapeSqlString(`rumble:${video.platform_id}`); // Construct full ID
        const title = escapeSqlString(video.title);
        const link = escapeSqlString(video.link);
        const thumbnail = escapeSqlString(video.thumbnail);
        const platform = escapeSqlString(video.platform);
        const platform_id = escapeSqlString(video.platform_id);
        const source_type = escapeSqlString(video.source_type);

        sqlStatements.push(
            `INSERT INTO ${TABLE_NAME} (id, title, link, thumbnail, publish_date, platform, platform_id, source_type, sort_order) VALUES (${id}, ${title}, ${link}, ${thumbnail}, '${publish_date}', ${platform}, ${platform_id}, ${source_type}, ${sort_order});`
        );
    });

    console.log(`[DB] Generated ${sqlStatements.length} INSERT statements.`);

    try {
        await fs.writeFile(TEMP_SQL_FILE, sqlStatements.join('\n'));
        console.log(`[DB] Wrote INSERT statements to ${TEMP_SQL_FILE}.`);

        // Execute the SQL file using Wrangler
        runWrangler(`d1 execute ${DB_NAME} --remote --file=${TEMP_SQL_FILE}`);
        console.log(`[DB] Successfully executed ${TEMP_SQL_FILE}.`);

        // Clean up the temporary SQL file
        await fs.unlink(TEMP_SQL_FILE);
        console.log(`[DB] Deleted ${TEMP_SQL_FILE}.`);

    } catch (error) {
        console.error("[DB] Error writing SQL file or executing inserts:", error);
        // Keep the SQL file for debugging if execution failed?
    }
}


// --- Main Execution ---
(async () => {
    console.log("[START] Beginning video update process...");
    try {
        const latestKnownId = await fetchLatestPlatformId();
        console.log(`[START] Latest known video ID: ${latestKnownId || 'None'}`);
        
        const newVideos = await scrapeLatestVideos(latestKnownId);
        console.log(`[START] Found ${newVideos.length} new videos to insert`);
        
        await insertNewVideos(newVideos);
        console.log("[START] Update process finished successfully.");
    } catch (error) {
        console.error("[ERROR] Script failed:", error);
        process.exit(1); // Exit with error code
    }
})();