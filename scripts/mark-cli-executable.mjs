#!/usr/bin/env node
import { chmod } from "node:fs/promises";
import { resolve } from "node:path";

await chmod(resolve("dist/src/cli.js"), 0o755);
