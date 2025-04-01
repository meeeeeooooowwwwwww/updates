const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

// Constants
const TARGET_URL_BASE = 'https://rumble.com/c/BannonsWarRoom'; // Base URL without /videos
const OUTPUT_FILE = 'scraped_videos.json';
// const SCROLL_PAUSE_TIME = 2500; // No longer needed
const PAGE_LOAD_DELAY = 2000; // Delay between loading pages (ms)
const TIME_CONTAINER_SELECTOR = 'div.media-description-info-stream-time'; // Selector for the container
const TIME_TITLE_SELECTOR = 'div[title]'; // Selector for the specific div with title attr inside the container
const SAVE_INTERVAL = 100; // Save progress every 100 unique videos
// const MAX_NO_CHANGE_RETRIES = 3; // No longer needed
const VIDEO_LIST_ITEM_SELECTOR = 'ol.thumbnail__grid div.thumbnail__thumb';
const PAGE_NAV_TIMEOUT = 90000; // Timeout for page navigation
const SELECTOR_WAIT_TIMEOUT = 30000; // Timeout for waiting for selectors
const OVERALL_VIDEO_ENTRY_SELECTOR_PRIMARY = 'li'; // Primary guess for the ancestor wrapper
const OVERALL_VIDEO_ENTRY_SELECTOR_FALLBACK = 'div.video-listing-entry'; // Fallback guess
const TIME_VIEWS_CONTAINER_SELECTOR = 'div.media-description-time-views-container'; // Intermediate container for time/views

// --- Helper Function to Parse Date String from Title Attribute ---
function parseDateFromTitle(dateStr) {
    if (!dateStr) return null;
    // Expected format: "Month Day, Year" (e.g., "March 31, 2025")
    try {
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) {
            // console.warn(`Could not parse exact date string: "${dateStr}".`);
            return null;
        }
        date.setUTCHours(12, 0, 0, 0); // Normalize to noon UTC
        return date;
    } catch (e) {
        // console.warn(`Error parsing exact date string: "${dateStr}".`, e);
        return null;
    }
}

// --- Helper Function to Parse Relative Time String ---
function parseRelativeTime(timeStr) {
    if (!timeStr) return null;
    const now = new Date(); // Use local time zone initially, convert to UTC later
    timeStr = timeStr.toLowerCase().trim();
    const match = timeStr.match(/(\d+)\s+(minute|hour|day|week|month|year)s?/);

    if (!match) {
        // console.warn(`Could not parse relative time string: "${timeStr}".`);
        return null; // Could not parse
    }

    const quantity = parseInt(match[1], 10);
    const unit = match[2];
    let date = new Date(now);

    try {
        switch (unit) {
            case 'minute':
                date.setMinutes(date.getMinutes() - quantity);
                break;
            case 'hour':
                date.setHours(date.getHours() - quantity);
                break;
            case 'day':
                date.setDate(date.getDate() - quantity);
                break;
            case 'week':
                date.setDate(date.getDate() - quantity * 7);
                break;
            case 'month':
                date.setMonth(date.getMonth() - quantity);
                break;
            case 'year':
                date.setFullYear(date.getFullYear() - quantity);
                break;
            default:
                return null; // Unknown unit
        }
        // Convert the calculated date to UTC for consistency before returning
        return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(),
                               date.getHours(), date.getMinutes(), date.getSeconds()));
    } catch (e) {
        console.warn(`Error calculating date from relative time: "${timeStr}".`, e);
        return null;
    }
}

// --- Helper Function to Process and Save Data ---
async function processAndSaveData(allScrapedVideos, isFinalSave = false) {
    if (!allScrapedVideos || allScrapedVideos.length === 0) {
        console.log("No videos to process or save.");
        return 0;
    }

    const videoCount = allScrapedVideos.length;
    console.log(`Processing ${videoCount} total videos for ${isFinalSave ? 'final' : 'incremental'} save...`);

    // 3. Assign final publish_date and sort_order based purely on scrape order
    console.log("Assigning timestamps and sort order based on scrape order...");
    const baseTime = new Date('2050-01-01T00:00:00Z'); // Fixed future base time
    
    for (let i = 0; i < allScrapedVideos.length; i++) {
        const video = allScrapedVideos[i];
        // Assign sort_order (1-based index reflecting scrape order)
        video.sort_order = i + 1; 
        
        // Assign fake publish_date (earlier index = later date)
        const fakeTimestamp = new Date(baseTime.getTime() - (i * 1000));
        video.publish_date = fakeTimestamp.toISOString();
    }
    // --- End Timestamp/Sort Order Assignment ---

    // 4. Prepare Final Output Format
    const processedOutput = allScrapedVideos.map(video => {
        const rumbleIdMatch = video.link.match(/\/([a-z0-9]+)-/);
        const rumbleId = rumbleIdMatch ? rumbleIdMatch[1] : video.link.split('/').pop().split('.')[0];
        const publish_date = video.publish_date || new Date(0).toISOString(); 
        const sort_order = video.sort_order || 999999; // Fallback sort order if missing
        return {
            id: `rumble:${rumbleId}`,
            title: video.title,
            link: video.link,
            thumbnail: video.thumbnail,
            publish_date: publish_date, // Use the fake timestamp
            sort_order: sort_order, // Add the sort order field
            platform: 'rumble',
            platform_id: rumbleId,
            source_type: 'warroom'
        };
    });

    // 5. Write to JSON file
    try {
        await fs.writeFile(OUTPUT_FILE, JSON.stringify(processedOutput, null, 2));
        console.log(`Successfully wrote ${processedOutput.length} videos to ${OUTPUT_FILE}`);
        return processedOutput.length;
    } catch (error) {
        console.error(`Error writing to file ${OUTPUT_FILE}:`, error);
        return -1;
    }
}

// --- Main Scraping Function ---
async function scrapeWarRoomVideos() {
    console.log('Launching browser...');
    // Keep dumpio: true if helpful, otherwise remove
    const browser = await puppeteer.launch({ headless: true, dumpio: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    let scrapedVideos = []; // Holds all unique raw video data
    const existingLinks = new Set();
    let lastSaveCount = 0;
    let pageNumber = 1; // Start with page 1

    console.log('Starting scrape using pagination...');

    try {
        // Loop through pages
        while (true) {
            const currentPageUrl = pageNumber === 1
                ? `${TARGET_URL_BASE}/videos` // Page 1 URL structure
                : `${TARGET_URL_BASE}?page=${pageNumber}`; // Page 2+ URL structure

            console.log(`--- Navigating to page ${pageNumber}: ${currentPageUrl} ---`);

            try {
                await page.goto(currentPageUrl, { waitUntil: 'networkidle2', timeout: PAGE_NAV_TIMEOUT });
                console.log(`Page ${pageNumber} loaded.`);
            } catch (error) {
                console.log(`Failed to load page ${pageNumber} (URL: ${currentPageUrl}). Assuming end of pagination or error.`);
                console.error(error);
                break; // Exit loop if page navigation fails
            }

            // Wait for video list items to be present on the page
            try {
                 await page.waitForSelector(VIDEO_LIST_ITEM_SELECTOR, { timeout: SELECTOR_WAIT_TIMEOUT });
                 console.log("Video list items found on page.");
            } catch (timeoutError) {
                 console.log(`No video list items (${VIDEO_LIST_ITEM_SELECTOR}) found on page ${pageNumber} within timeout. Assuming end of pagination.`);
                 break; // Exit loop if no videos found after waiting
            }

            // Scrape videos from the current page - simplified extraction
            const videosOnPage = await page.$$eval(
                VIDEO_LIST_ITEM_SELECTOR, // Selects div.thumbnail__thumb elements
                (items) => { // Remove date/time related selectors/args
                    return items.map(item => {
                        // 'item' is div.thumbnail__thumb
                        const img = item.querySelector('img.thumbnail__image');
                        const link = item.querySelector('a.videostream__link.link');
                        const title = img ? img.getAttribute('alt') : null;
                        const thumbnail = img ? img.getAttribute('src') : null;
                        const videoPath = link ? link.getAttribute('href') : null;
            
                        if (title && videoPath && link) {
                            return { // Return only essential fields
                                title: title.trim(),
                                link: `https://rumble.com${videoPath}`,
                                thumbnail: thumbnail,
                            };
                        }
                        return null;
                    }).filter(video => video !== null);
                }
                // Remove selector arguments related to date/time
            );

            console.log(`Found ${videosOnPage.length} potential video elements on page ${pageNumber}.`);
            
            // Termination condition: If no videos are found on the page, break.
            if (videosOnPage.length === 0) {
                console.log(`No videos extracted from page ${pageNumber}. Stopping scrape.`);
                break;
            }

            // Process and add unique videos (now without date info)
            let newVideosFoundInPass = 0;
            videosOnPage.forEach(video => {
                if (video.link && !existingLinks.has(video.link)) {
                    scrapedVideos.push(video); // Just push the object with title, link, thumb
                    existingLinks.add(video.link);
                    newVideosFoundInPass++;
                }
            });
            console.log(`Added ${newVideosFoundInPass} unique videos this pass. Total unique: ${scrapedVideos.length}`);

            // Incremental save
            if (scrapedVideos.length >= lastSaveCount + SAVE_INTERVAL) {
                const savedCount = await processAndSaveData(scrapedVideos);
                if (savedCount > 0) {
                    lastSaveCount = savedCount;
                }
            }

            // Go to the next page
            pageNumber++;
            console.log(`Waiting ${PAGE_LOAD_DELAY}ms before loading next page...`);
            await new Promise(resolve => setTimeout(resolve, PAGE_LOAD_DELAY));

        } // End of while loop

    } catch (error) {
        console.error('Unhandled error during scraping process:', error);
    } finally {
        console.log('\nPagination loop finished.');
         // Final save
         if (scrapedVideos.length > lastSaveCount) {
             console.log('Performing final save...');
             await processAndSaveData(scrapedVideos, true);
         }
         await browser.close();
         console.log('Browser closed.');
    }

    console.log(`\n--- Scrape Complete ---`);
    // Final count reporting
    const finalCount = await fs.readFile(OUTPUT_FILE, 'utf-8').then(data => JSON.parse(data).length).catch(() => scrapedVideos.length);
    console.log(`Total unique videos found and saved: ${finalCount}`);
}

// Run the scraper
scrapeWarRoomVideos(); 