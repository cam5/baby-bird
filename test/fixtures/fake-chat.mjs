#!/usr/bin/env node
// Stands in for an interactive chat CLI. Records argv, cwd, and the contents of any argv entry that
// is a readable file into FAKE_CHAT_CAPTURE (JSON), then exits with FAKE_CHAT_EXIT (default 0).
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const files = {};
for (const a of argv) {
  try {
    files[a] = readFileSync(a, 'utf8');
  } catch {
    // not a file
  }
}
if (process.env.FAKE_CHAT_CAPTURE) {
  writeFileSync(process.env.FAKE_CHAT_CAPTURE, JSON.stringify({ argv, cwd: process.cwd(), files, claudecode: process.env.CLAUDECODE ?? null }));
}
process.exit(Number(process.env.FAKE_CHAT_EXIT ?? 0));
