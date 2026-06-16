#!/usr/bin/env node
import { createProgram } from '../dist/index.js';

createProgram()
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
