#!/usr/bin/env node
import { runCli } from './cli.js';

/**
 * The `riosoma` command.  Everything it does is in `runCli`, which takes the words it was given and
 * the terminal it prints to, so the tool runs the same in a test as it does here.  The exit code is
 * set rather than forced, so a stream still writing has the chance to finish.
 */
runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // A fault the tool didn't expect is the one case where a stack is the useful answer.
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  },
);
