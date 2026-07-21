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
//
// Non-interactive fallback (Docker/CI smoke automation ONLY): when stdin is
// not a TTY, the password is read from the BOOTSTRAP_OWNER_PASSWORD
// environment variable instead of prompting. This is documented and
// intentionally narrow — env vars don't appear in shell history or `ps`
// output the way a CLI argument would, but this path should only be used
// by automated smoke/CI flows that generate a random password per run,
// never for a real production bootstrap (use the interactive prompt there).

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
    let password: string;
    if (process.stdin.isTTY) {
      const confirm = await readHiddenLine('Set owner password (min 12 chars): ').then(async (p) => {
        const c = await readHiddenLine('Confirm password: ');
        if (p !== c) {
          console.error('Passwords do not match.');
          process.exit(1);
        }
        return p;
      });
      password = confirm;
    } else {
      const envPassword = process.env['BOOTSTRAP_OWNER_PASSWORD'];
      if (!envPassword) {
        console.error('FATAL: not running in a TTY and BOOTSTRAP_OWNER_PASSWORD is not set. See file header comment.');
        process.exit(1);
      }
      password = envPassword;
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
