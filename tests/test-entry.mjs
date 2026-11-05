#!/usr/bin/env node
import { execSync } from 'child_process';

// Just run vitest directly, the config already handles include/exclude
execSync(`vitest run`, { stdio: 'inherit' });