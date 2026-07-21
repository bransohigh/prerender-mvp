import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../src/db/schema.js';
import { bootstrapOwner, BootstrapOwnerError } from '../../src/services/bootstrap-owner-service.js';

// Thin CLI wrapper: argv parsing + interactive password prompt only. All
// transactional/validation logic lives in
// src/services/bootstrap-owner-service.ts, which is unit-tested directly
// against a real Postgres transaction without going through a TTY.
//
// Password is deliberately never accepted as a CLI argument (would leak via
// shell history / process listing / CI logs) — it is read from an
// interactive, non-echoed stdin prompt.

const ASCII_CR = 13;
const ASCII_LF = 10;
const ASCII_CTRL_C = 3;
const ASCII_CTRL_D = 4;
const ASCII_BACKSPACE = 127;
const ASCII_BS = 8;

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

async function readHiddenLine(promptText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    if (!stdin.isTTY) {
      reject(new Error('bootstrap-owner requires an interactive TTY for password entry'));
      return;
    }
    stdout.write(promptText);
    let input = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const onData = (char: string) => {
      const code = char.charCodeAt(0);

      if (code === ASCII_CR || code === ASCII_LF || code === ASCII_CTRL_D) {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        stdout.write('\n');
        resolve(input);
        return;
      }
      if (code === ASCII_CTRL_C) {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        reject(new Error('Aborted'));
        return;
      }
      if (code === ASCII_BACKSPACE || code === ASCII_BS) {
        input = input.slice(0, -1);
        return;
      }
      input += char;
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('FATAL: DATABASE_URL is required');
    process.exit(1);
  }

  const email = readArg('email');
  const name = readArg('name');
  const orgName = readArg('org-name');
  const orgSlug = readArg('org-slug');

  if (!email || !name) {
    console.error(
      'Usage: auth:bootstrap-owner -- --email=<email> --name=<name> [--org-name=<name>] [--org-slug=<slug>]',
    );
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const db = drizzle(pool, { schema });

  try {
    const password = await readHiddenLine('Set owner password (min 12 chars): ');
    const confirm = await readHiddenLine('Confirm password: ');
    if (password !== confirm) {
      console.error('Passwords do not match.');
      process.exit(1);
    }

    const result = await bootstrapOwner(db, { email, name, password, orgName, orgSlug });
    console.log(`Owner bootstrap complete for ${result.email}.`);
    process.exit(0);
  } catch (err) {
    if (err instanceof BootstrapOwnerError) {
      console.error('Bootstrap failed:', err.message);
    } else {
      console.error('Bootstrap failed:', err instanceof Error ? err.message : err);
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

void main();
