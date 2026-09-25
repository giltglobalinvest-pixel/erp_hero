import { runUserCreateCli } from './commands.js';

process.exitCode = await runUserCreateCli(process.argv.slice(2), process.env, (line) => console.log(line));
