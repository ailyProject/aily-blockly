const fs = require('fs');
const path = require('path');

function exitWithFatalError(error) {
    const msg = (error instanceof Error) ? (error.stack || error.message) : String(error);
    console.error(`[ERROR] ${msg}`);
    process.exit(1);
}

process.on('uncaughtException', exitWithFatalError);
process.on('unhandledRejection', exitWithFatalError);

async function main() {
    const configPath = process.argv[2];
    if (!configPath) {
        console.error('Usage: node clear-cache.js <config-path>');
        process.exit(1);
    }

    let config;
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
        exitWithFatalError(`Failed to read config file: ${error.message}`);
    }

    const { buildPath, option, excludeDirs = [] } = config;

    if (!buildPath || !fs.existsSync(buildPath)) {
        console.log('No cache directory found, nothing to clear');
        process.exit(0);
    }

    let deletedCount = 0;
    const now = Date.now();
    const days = option === 'all' ? null : parseInt(option, 10);

    let entries;
    try {
        entries = fs.readdirSync(buildPath, { withFileTypes: true });
    } catch (error) {
        exitWithFatalError(`Failed to read build path: ${error.message}`);
    }

    const dirs = entries.filter(e => e.isDirectory());
    console.log(`Found ${dirs.length} cache directories`);

    for (const entry of dirs) {
        if (excludeDirs.includes(entry.name)) {
            console.log(`Skipped: ${entry.name} (current project)`);
            continue;
        }
        const dirPath = path.join(buildPath, entry.name);
        try {
            if (days === null) {
                fs.rmSync(dirPath, { recursive: true, force: true });
                console.log(`Removed: ${entry.name}`);
                deletedCount++;
            } else {
                const stat = fs.statSync(dirPath);
                const mtime = new Date(stat.mtime).getTime();
                const ageDays = (now - mtime) / (1000 * 60 * 60 * 24);
                if (ageDays >= days) {
                    fs.rmSync(dirPath, { recursive: true, force: true });
                    console.log(`Removed: ${entry.name} (${Math.floor(ageDays)} days old)`);
                    deletedCount++;
                }
            }
        } catch (error) {
            console.error(`[WARN] Failed to remove ${entry.name}: ${error.message}`);
        }
    }

    console.log(`Done. Removed ${deletedCount} of ${dirs.length} directories`);
    process.exit(0);
}

main();
