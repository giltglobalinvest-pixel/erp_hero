import { runImportCli } from './commands.js';

process.exitCode = await runImportCli(process.argv.slice(2), process.env, globalThis.fetch, (line) => console.log(line));
