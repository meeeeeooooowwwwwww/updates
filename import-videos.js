const fs = require('fs').promises;
const path = require('path');

const INPUT_JSON_FILE = 'scraped_videos.json'; // Use the correct, newly generated file name
const OUTPUT_SQL_PREFIX = 'import_batch_'; // Prefix for output files
const OUTPUT_SQL_SUFFIX = '.sql';
const BATCH_SIZE = 500; // Number of INSERT statements per file
const TABLE_NAME = 'videos';

// Function to escape single quotes for SQL
function escapeSqlString(value) {
    if (value === null || value === undefined) {
        return 'NULL';
    }
    // Replace single quotes with two single quotes
    const escaped = String(value).replace(/'/g, "''");
    return `'${escaped}'`; // Enclose in single quotes for SQL
}

async function generateImportSqlBatches() {
    console.log(`Reading JSON data from ${INPUT_JSON_FILE}...`);
    let videos = [];
    try {
        const jsonData = await fs.readFile(INPUT_JSON_FILE, 'utf-8');
        videos = JSON.parse(jsonData);
        console.log(`Successfully read and parsed ${videos.length} video records.`);
    } catch (error) {
        console.error(`Error reading or parsing ${INPUT_JSON_FILE}:`, error);
        return; // Stop if file reading/parsing fails
    }

    if (videos.length === 0) {
        console.log('No video records found in the JSON file. No SQL generated.');
        return;
    }

    console.log(`Generating SQL INSERT statements in batches of ${BATCH_SIZE}...`);
    
    let fileCounter = 1;
    let statementsInCurrentBatch = [];
    const executionCommands = [];

    for (let i = 0; i < videos.length; i++) {
        const video = videos[i];
        
        const id = escapeSqlString(video.id);
        const title = escapeSqlString(video.title);
        const link = escapeSqlString(video.link);
        const thumbnail = escapeSqlString(video.thumbnail);
        const publish_date = escapeSqlString(video.publish_date);
        const platform = escapeSqlString(video.platform);
        const platform_id = escapeSqlString(video.platform_id);
        const source_type = escapeSqlString(video.source_type);
        // Ensure sort_order is treated as a number (no quotes)
        const sort_order = video.sort_order === null || video.sort_order === undefined ? 'NULL' : video.sort_order; 

        const insertStatement = `INSERT INTO ${TABLE_NAME} (id, title, link, thumbnail, publish_date, platform, platform_id, source_type, sort_order) VALUES (${id}, ${title}, ${link}, ${thumbnail}, ${publish_date}, ${platform}, ${platform_id}, ${source_type}, ${sort_order});`;
        statementsInCurrentBatch.push(insertStatement);

        // Check if the batch is full or if it's the last video
        if (statementsInCurrentBatch.length === BATCH_SIZE || i === videos.length - 1) {
            const batchFileName = `${OUTPUT_SQL_PREFIX}${fileCounter}${OUTPUT_SQL_SUFFIX}`;
            const sqlContent = statementsInCurrentBatch.join('\n');
            
            console.log(`Writing batch ${fileCounter} (${statementsInCurrentBatch.length} statements) to ${batchFileName}...`);
            try {
                await fs.writeFile(batchFileName, sqlContent);
                console.log(`Successfully wrote ${batchFileName}`);
                executionCommands.push(`wrangler d1 execute nataliewinters-db --file=${batchFileName}`);
                // Reset for next batch
                statementsInCurrentBatch = [];
                fileCounter++;
            } catch (error) {
                console.error(`Error writing SQL file ${batchFileName}:`, error);
                // Optionally stop here or continue with other batches?
                // For now, we'll log the error and continue trying to generate other batches.
            }
        }
    }

    console.log("\nFinished generating SQL batch files.");
    console.log("\nTo execute the batches, run the following commands one by one in your terminal:");
    executionCommands.forEach(cmd => console.log(cmd));
}

generateImportSqlBatches();