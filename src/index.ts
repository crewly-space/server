import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { JobRunner } from './jobs/runner.js';
import { crewlyServiceCredential } from './crewly/connection.js';
import { pullInboundMail } from './mail/inbound.js';
import { sendDueDigests } from './notifications/digest.js';
import { SUMMARIZE_CONVERSATION_JOB_TYPE, updateConversationSummary } from './memory/summary.js';
import { countUsers } from './users/repository.js';
import { prepareSetupClaim } from './auth/setup-claim.js';
import { pruneOperationalData } from './maintenance.js';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = '0.1.2';

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`Crewly server ${VERSION}

Usage: crewly-server [options]

  --port <number>       Listen port (default: 8787)
  --host <address>      Bind address (default: 127.0.0.1)
  --data-dir <path>     SQLite and configuration directory
  --web-dir <path>      Built Crewly app directory (omit for API only)
  --attachments-dir <path> Private attachment storage (default: <data-dir>/attachments)
  --log-level <level>   fatal|error|warn|info|debug|trace|silent
  --trust-proxy [bool]  Trust reverse-proxy forwarding headers`);
    return;
  }
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    console.log(`crewly-server ${VERSION}`);
    return;
  }
  const config = loadConfig();
  if (config.webDir && !fs.existsSync(path.join(config.webDir, 'index.html'))) {
    throw new Error(`Crewly app is missing: ${path.join(config.webDir, 'index.html')}`);
  }
  if (!config.webDir) {
    console.warn('Crewly app is disabled (no --web-dir); serving the API only');
  }
  const db = openDatabase(config.dataDir, { managedSecretsKey: config.managedSecretsKey });
  runMigrations(db);
  const setupClaim = prepareSetupClaim(config.dataDir, countUsers(db) > 0);
  if (setupClaim.token) {
    console.warn(`First-run claim token: ${setupClaim.token}`);
    console.warn(`It is also stored in ${setupClaim.file} until the owner account is created.`);
  }
  const app = await buildApp({
    db,
    webDir: config.webDir,
    logger: { level: config.logLevel },
    trustProxy: config.trustProxy,
    setupClaimToken: setupClaim.token,
    onSetupComplete: setupClaim.consume,
    version: VERSION,
    cloudHandoff: config.cloudHandoff,
    trustedAppOrigins: config.trustedAppOrigins,
    maxDelegationDepth: config.maxDelegationDepth,
    allowMcpStdio: config.allowMcpStdio,
    crewlyCloudUrl: config.crewlyCloudUrl,
    publicUrl: config.publicUrl,
    attachmentDir: config.attachmentsDir,
    attachmentMaxBytes: config.attachmentMaxBytes,
  });

  const jobRunner = new JobRunner(db, {
    [SUMMARIZE_CONVERSATION_JOB_TYPE]: async (jobDb, payload) => {
      const { conversationId } = payload as { conversationId: string };
      await updateConversationSummary(jobDb, conversationId);
    },
  });
  jobRunner.start();
  pruneOperationalData(db);
  const maintenanceTimer = setInterval(() => pruneOperationalData(db), 6 * 60 * 60 * 1000);
  maintenanceTimer.unref?.();
  // Mail that failed in a way worth retrying is tried again on its schedule.
  const mailRetryTimer = setInterval(() => {
    app.mail.retryDue()
      .then(() => sendDueDigests(db, app.notifications, app.mail))
      .then(() => app.notifications.retryDue())
      .catch((error) => app.log.error(error));
  }, 30_000);
  mailRetryTimer.unref?.();
  // Email replies wait in Crewly until this server takes them; it asks when it can receive.
  const inboundTimer = setInterval(() => {
    if (!crewlyServiceCredential(db, 'mail:receive')) return;
    pullInboundMail(db, globalThis.fetch.bind(globalThis), app.hub).catch((error) => app.log.warn({ err: error }, 'inbound mail pull failed'));
  }, 30_000);
  inboundTimer.unref?.();

  let closing = false;
  const close = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    jobRunner.stop();
    clearInterval(maintenanceTimer);
    clearInterval(mailRetryTimer);
    clearInterval(inboundTimer);
    await app.close();
    db.close();
  };
  process.once('SIGTERM', () => void close('SIGTERM'));
  process.once('SIGINT', () => void close('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
  app.log.info({ host: config.host, port: config.port }, 'Crewly server listening');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
