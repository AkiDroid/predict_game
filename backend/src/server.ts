import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const app = await buildApp(config);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info(`shutting down (${signal})`);
  await app.close();
}

process.once('SIGINT', () => {
  void shutdown('SIGINT').then(() => process.exit(0));
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM').then(() => process.exit(0));
});

await app.listen({ port: config.port, host: config.host });
const origin = `http://${config.host}:${config.port}`;
if (config.serveStatic) {
  app.log.info(`UI ${origin}`);
} else {
  app.log.info(`API ${origin}`);
}
