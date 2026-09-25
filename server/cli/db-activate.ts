import { runDbActivateCli } from './commands.js';

process.exitCode = await runDbActivateCli(process.argv.slice(2), process.env, (line) => console.log(line));
