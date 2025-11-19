#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const readline = require('readline');
const Database = require('./services/database');
const EventProcessor = require('./services/event-processor');

const STRFRY_PATH = path.join(__dirname, '..', 'strfry', 'strfry');
const STRFRY_CONFIG = path.join(__dirname, '..', 'strfry', 'strfry.conf');
const RELAY = 'wss://nip85.brainstorm.world';

const COMMITTEE_MEMBERS = [
  '3316e3696de74d39959127b9d842df57bddc5d1c7af8a04f1bc7aed80b445088', // justin
  'e5272de914bd301755c439b88e6959a43c9d2664831f093c51e9c799a16a102f', // straycat
  '2efaa715bbb46dd5be6b7da8d7700266d11674b913b8178addb5c2e63d987331'  // vinny
];

async function runBackfill() {
  console.log('🔄 Starting NymRank backfill...\n');
  
  // Check if strfry exists
  if (!fs.existsSync(STRFRY_PATH)) {
    console.error('❌ strfry not found at', STRFRY_PATH);
    console.error('Please clone https://github.com/hoytech/strfry.git to ~/strfry and build it');
    process.exit(1);
  }
  
  // Ensure strfry db directory exists
  const strfryDir = path.join(__dirname, '..', 'strfry', 'strfry-db');
  if (!fs.existsSync(strfryDir)) {
    console.log('Creating strfry database directory:', strfryDir);
    fs.mkdirSync(strfryDir, { recursive: true });
  }
  
  try {
    // Step 1: Sync delegations from committee members
    console.log('Step 1/4: Syncing delegations from committee members...');
    const delegationFilter = JSON.stringify({
      kinds: [10040],
      authors: COMMITTEE_MEMBERS
    });
    
    let syncCmd = `${STRFRY_PATH} --config=${STRFRY_CONFIG} sync ${RELAY} --filter '${delegationFilter}' --dir down`;
    execSync(syncCmd, { 
      stdio: 'inherit',
      cwd: path.join(__dirname, '..', 'strfry') 
    });
    
    console.log('✓ Delegations synced\n');
    
    // Step 2: Extract service keys from delegations and insert into PostgreSQL
    console.log('Step 2/4: Inserting delegations and extracting service keys...');
    
    const db = new Database();
    const silentLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (msg, err) => console.error('DB Error:', msg, err?.message || err)
    };
    const processor = new EventProcessor(db, silentLogger);
    await db.connect();
    
    // Get delegations from strfry to extract service keys
    const delegationExport = spawn(STRFRY_PATH, ['--config=' + STRFRY_CONFIG, 'export'], {
      cwd: path.join(__dirname, '..', 'strfry')
    });
    
    const serviceKeys = new Set();
    const delegationRl = readline.createInterface({
      input: delegationExport.stdout,
      crlfDelay: Infinity
    });
    
    // Extract service keys from delegations
    for await (const line of delegationRl) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.kind === 10040) {
          const delData = processor.parseDelegationEvent(event);
          if (delData.service_pubkey) {
            serviceKeys.add(delData.service_pubkey);
          }
          // Also insert delegation into PostgreSQL
          await processor.handleDelegationEvent(event);
        }
      } catch (err) {
        // Skip parse errors
      }
    }
    
    console.log(`✓ Found ${serviceKeys.size} service keys\n`);
    
    // Step 3: Negentropy sync attestations for the service keys
    console.log('Step 3/4: Syncing attestations via negentropy for service keys...');
    
    const attestationFilter = JSON.stringify({
      kinds: [30382],
      authors: Array.from(serviceKeys)
    });
    
    syncCmd = `${STRFRY_PATH} --config=${STRFRY_CONFIG} sync ${RELAY} --filter '${attestationFilter}' --dir down`;
    execSync(syncCmd, { 
      stdio: 'inherit',
      cwd: path.join(__dirname, '..', 'strfry') 
    });
    
    console.log('✓ Attestations synced\n');
    
    // Step 4: Export attestations and import to database
    console.log('Step 4/4: Exporting and importing attestations to PostgreSQL...');
    
    const exportProcess = spawn(STRFRY_PATH, ['--config=' + STRFRY_CONFIG, 'export'], {
      cwd: path.join(__dirname, '..', 'strfry'),
      stdio: ['pipe', 'pipe', 'inherit']
    });
    
    const rl = readline.createInterface({
      input: exportProcess.stdout,
      crlfDelay: Infinity
    });
    
    let attestations = 0;
    
    // Process attestations only
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.kind === 30382) {
          await processor.handleRankingEvent(event);
          attestations++;
          if (attestations % 10000 === 0) {
            console.log(`  Processed ${attestations} attestations`);
          }
        }
      } catch (err) {
        // Skip parse errors
      }
    }
    
    await db.close();
    
    console.log(`\n✓ Backfill complete!`);
    console.log(`  Attestations: ${attestations}`);
    console.log(`\nYou can now run: npm start`);
    
  } catch (error) {
    console.error('❌ Backfill failed:', error.message);
    process.exit(1);
  }
}

runBackfill();
