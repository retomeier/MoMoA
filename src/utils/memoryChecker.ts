/**
 * Copyright 2026 Reto Meier
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as os from 'os';
import * as fs from 'fs';
import { execSync } from 'child_process';

// Helper to get true available memory across Linux and Mac
export function getAvailableMemoryBytes(): number {
  const platform = os.platform();

  if (platform === 'linux') {
    // Linux (Cloud Run) approach: Parse /proc/meminfo
    try {
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
      const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
      if (match) {
        return parseInt(match[1], 10) * 1024; // Convert kB to Bytes
      }
    } catch (e) {
      console.warn('Could not read /proc/meminfo. Falling back to os.freemem()');
    }
  } else if (platform === 'darwin') {
    // macOS (Local) approach: Parse vm_stat and hw.pagesize
    try {
      const vmStat = execSync('vm_stat', { encoding: 'utf8' });
      const pageSize = parseInt(execSync('sysctl -n hw.pagesize', { encoding: 'utf8' }).trim(), 10);

      // Extract page counts using regex
      const getPageCount = (key: string) => {
        const match = vmStat.match(new RegExp(`${key}:\\s+(\\d+)`));
        return match ? parseInt(match[1], 10) : 0;
      };

      const pagesFree = getPageCount('Pages free');
      const pagesInactive = getPageCount('Pages inactive');
      const pagesSpeculative = getPageCount('Pages speculative');

      // Available memory is free pages + reclaimable cached pages
      return (pagesFree + pagesInactive + pagesSpeculative) * pageSize;
    } catch (e) {
      console.warn('Could not execute vm_stat. Falling back to os.freemem()');
    }
  }

  // Fallback for Windows or if commands fail
  return os.freemem();
}

export function checkContainerMemory(): string {
  const toMB = (bytes: number) => Math.round((bytes / 1024 / 1024) * 100) / 100;
  const totalMem = os.totalmem();

  if (os.platform() != 'linux') {
   return `Managed memory environment: ${toMB(totalMem)} MB`;
  } else {
    const availableMem = getAvailableMemoryBytes();
    let memory = `Total Container  Memory    : ${toMB(totalMem)} MB\n\n`;
    memory +=    `Container Available Memory : ${toMB(availableMem)} MB`;
    return memory;
  }
}