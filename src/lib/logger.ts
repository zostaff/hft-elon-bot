/**
 * logger.ts — single pino instance.
 *
 * Use `logger.child({ mod: 'discovery' })` to scope per module.
 */

import { pino } from 'pino';
import { config } from '../config.js';

const transport = config.logPretty
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname',
        singleLine: false,
      },
    }
  : undefined;

export const logger = pino({
  level: config.logLevel,
  ...(transport ? { transport } : {}),
  base: { app: 'hft-elon-bot' },
});
