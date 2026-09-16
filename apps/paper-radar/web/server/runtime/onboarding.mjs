import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Onboarding {
  constructor(database, personaSettings) {
    this.database = database;
    this.personaSettings = personaSettings;
    this.path = join(database.directory, 'onboarding.json');
  }
  status() {
    const db = this.database.db;
    const has = (table) => !!db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
    const hasContent =
      has('subscriptions') ||
      has('jobs') ||
      has('daily_runs') ||
      has('results');
    let completed = false;
    try {
      completed =
        JSON.parse(readFileSync(this.path, 'utf8')).completed === true;
    } catch {
      /* Infer from real data. */
    }
    // Remember an existing workspace so deleting the last subscription does not restart setup.
    if (hasContent && !completed) {
      const temporary = this.path + '.' + randomUUID() + '.tmp';
      writeFileSync(
        temporary,
        JSON.stringify({
          schema: 'paper-radar.onboarding/v1',
          completed: true,
        }) + '\n',
        { mode: 0o600 },
      );
      renameSync(temporary, this.path);
      completed = true;
    }
    const persona = this.personaSettings?.settings();
    return {
      needs_setup: !completed && !hasContent,
      persona_configured: !!persona?.configured,
      persona_connected: !!persona?.connected,
      data_available: existsSync(join(this.database.directory, 'radar.sqlite')),
    };
  }
}
