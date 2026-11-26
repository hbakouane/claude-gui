import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, rmdir, stat, utimes } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

// Files still being written are left for the next run, so a copy is never taken mid-turn.
export const SETTLE_MS = 10 * 60 * 1000;
export const SYNC_INTERVAL_MS = 30 * 60 * 1000;
export const MAX_KEEP_DAYS = 36500;
const DAY_MS = 24 * 60 * 60 * 1000;

export function archivePath(env = process.env) {
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'claude-gui', 'archive');
}

export const isValidKeepDays = (days) => Number.isInteger(days) && days >= 1 && days <= MAX_KEEP_DAYS;

// Copies every settled transcript in `root` to `archive` as <project>/<session>.jsonl.gz, skipping copies that are
// already up to date. With `keepDays`, sessions inactive for longer are neither copied nor kept.
// Transcripts hold secrets, so the archive is readable only by its owner.
export async function syncArchive(root, archive, { now = Date.now(), settleMs = SETTLE_MS, keepDays = null } = {}) {
  const expired = (mtimeMs) => keepDays !== null && now - mtimeMs > keepDays * DAY_MS;
  let copied = 0;
  const projects = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const project of projects.filter((entry) => entry.isDirectory())) {
    const names = await readdir(join(root, project.name)).catch(() => []);
    for (const name of names.filter((n) => n.endsWith('.jsonl'))) {
      const source = join(root, project.name, name);
      const info = await stat(source).catch(() => null);
      if (!info?.isFile() || now - info.mtimeMs < settleMs || expired(info.mtimeMs)) {
        continue;
      }
      const target = join(archive, project.name, `${name}.gz`);
      const existing = await stat(target).catch(() => null);
      if (existing && seconds(existing.mtimeMs) === seconds(info.mtimeMs)) {
        continue;
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const temp = `${target}.${process.pid}.tmp`;
      try {
        await pipeline(createReadStream(source), createGzip(), createWriteStream(temp, { mode: 0o600 }));
        await utimes(temp, info.atime, info.mtime);
        await rename(temp, target);
        copied++;
      } catch {
        await rm(temp, { force: true });
      }
    }
  }

  return { copied, removed: keepDays === null ? 0 : await pruneArchive(archive, expired) };
}

// A copy's modification time is its session's last activity, so expiry needs no reading or decompressing.
async function pruneArchive(archive, expired) {
  let removed = 0;
  const projects = await readdir(archive, { withFileTypes: true }).catch(() => []);
  for (const project of projects.filter((entry) => entry.isDirectory())) {
    const dir = join(archive, project.name);
    for (const name of (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.jsonl.gz'))) {
      const info = await stat(join(dir, name)).catch(() => null);
      if (info && expired(info.mtimeMs)) {
        await rm(join(dir, name), { force: true });
        removed++;
      }
    }
    await rmdir(dir).catch(() => {});
  }

  return removed;
}

// Puts an archived transcript back where Claude Code looks for it, so `claude --resume` can open it again.
// Never overwrites a transcript that already exists.
export async function restoreSession(archived, target) {
  if (await stat(target).catch(() => null)) {
    return false;
  }
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  try {
    await pipeline(createReadStream(archived), createGunzip(), createWriteStream(temp, { mode: 0o600 }));
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }

  return true;
}

const seconds = (ms) => Math.trunc(ms / 1000);
