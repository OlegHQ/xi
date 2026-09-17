#!/usr/bin/env bun
// Keeps .claude/skills a symlink to .agents/skills so both trees can never drift.
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";

const target = ".agents/skills";
const link = ".claude/skills";

if (!existsSync(target)) {
  throw new Error(`${target} does not exist`);
}

mkdirSync(".claude", { recursive: true });

if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) {
  const stat = lstatSync(link);
  if (stat.isSymbolicLink() && readlinkSync(link) === target) {
    console.log(`${link} already links to ${target}`);
    process.exit(0);
  }
  rmSync(link, { recursive: true, force: true });
}

symlinkSync(target, link);
console.log(`Linked ${link} -> ${target}`);
