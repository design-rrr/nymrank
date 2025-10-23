const Database = require('./services/database');

async function addColumn() {
  const database = new Database();
  await database.connect();

  await database.query(`
    ALTER TABLE profile_refresh_queue 
    ADD COLUMN IF NOT EXISTS last_activity_timestamp BIGINT
  `);

  console.log('Added last_activity_timestamp column');

  await database.close();
}

addColumn().catch(console.error);

