/**
 * setup-creds.ts — one-time setup wizard for live trading.
 *
 * What it does:
 *   1. Reads WALLET_PRIVATE_KEY from .env
 *   2. Connects to Polymarket CLOB V2 with L1 (wallet) auth
 *   3. Calls createOrDeriveApiKey() — derives or retrieves the deterministic
 *      API key tied to your wallet
 *   4. Prints the three env vars to copy into .env:
 *        CLOB_API_KEY=...
 *        CLOB_SECRET=...
 *        CLOB_PASS_PHRASE=...
 *   5. Prints your EOA address — copy your Polymarket proxy/Safe address
 *      into POLYMARKET_PROXY_ADDRESS manually (visible in Polymarket UI →
 *      Settings → Wallets)
 *
 * Usage:
 *   1. Set WALLET_PRIVATE_KEY in .env
 *   2. npm run setup-creds
 *   3. Paste the 3 lines into .env
 *   4. Set POLYMARKET_PROXY_ADDRESS from Polymarket UI
 *   5. Verify with: npm run check-live
 */

import { config } from '../src/config.js';
import { logger } from '../src/lib/logger.js';
import { getL1Client } from '../src/lib/clob.js';

const log = logger.child({ mod: 'setup-creds' });

async function main(): Promise<void> {
  if (!config.credentials.walletPrivateKey) {
    log.fatal(
      'WALLET_PRIVATE_KEY is not set in .env. ' +
        'Fill it in first (the EOA private key — NOT the proxy address).'
    );
    process.exit(1);
  }

  log.info('connecting with L1 (wallet) auth...');
  const { client, walletAddress } = await getL1Client();

  log.info({ wallet: walletAddress }, 'wallet ready, deriving API key...');
  const c = client as unknown as Record<string, unknown>;
  const fn =
    (c.createOrDeriveApiKey as unknown) ?? (c.deriveApiKey as unknown);
  if (typeof fn !== 'function') {
    log.fatal('SDK has neither createOrDeriveApiKey nor deriveApiKey');
    process.exit(2);
  }
  const creds = (await (fn as () => Promise<{
    key: string;
    secret: string;
    passphrase: string;
  }>)()) as { key: string; secret: string; passphrase: string };

  log.info('✅ API key derived. Paste these into .env:');
  // Use plain console.log so the strings aren't munged by pino-pretty
  // eslint-disable-next-line no-console
  console.log('\n──────────────────────────────────────────────────────');
  // eslint-disable-next-line no-console
  console.log(`CLOB_API_KEY=${creds.key}`);
  // eslint-disable-next-line no-console
  console.log(`CLOB_SECRET=${creds.secret}`);
  // eslint-disable-next-line no-console
  console.log(`CLOB_PASS_PHRASE=${creds.passphrase}`);
  // eslint-disable-next-line no-console
  console.log('──────────────────────────────────────────────────────\n');
  log.info(
    { wallet: walletAddress },
    'next: open Polymarket → Settings → Wallets, copy your Proxy/Safe address into POLYMARKET_PROXY_ADDRESS, then run `npm run check-live`'
  );
}

main().catch((err) => {
  log.fatal({ err: (err as Error).message }, 'setup-creds failed');
  process.exit(1);
});
