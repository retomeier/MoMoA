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

import { applyPatch, createTwoFilesPatch, parsePatch } from 'diff';
import { MultiAgentToolContext } from '../momoa_core/types.js';
import { Buffer } from 'node:buffer';
import { getCombinedFileMap } from './fileMapUtils.js';
import * as zlib from 'node:zlib';

const LOCK_FILE_NAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Gemfile.lock',
  'Pipfile.lock',
  'poetry.lock',
  'composer.lock',
  'mix.lock',
  'pubspec.lock',
  'go.sum',
  'Cargo.lock',
  'npm-shrinkwrap.json'
]);

export function isLockFile(filename: string): boolean {
  // Check standard exact matches
  if (LOCK_FILE_NAMES.has(filename)) return true;
  // Check if it's a lock file in a subfolder (e.g., backend/go.sum)
  const baseName = filename.split(/[/\\]/).pop();
  return baseName ? LOCK_FILE_NAMES.has(baseName) : false;
}

export function getLockFileHiddenPlaceholder(filename: string): string {
    return `--- Content of machine-generated lock file '${filename}' hidden to save context ---`;
}

export function getLockFileFileDescription(): string {
  return 'Machine-generated lock file.'
}

/**
 * Describes the changes applied by applyDiff.
 */
export interface ApplyDiffChanges {
  created: string[];
  deleted: string[];
  modified: string[];
  renamed: { from: string; to: string }[];
}

/**
 * Generates a unified diff string for all created, deleted, or modified files.
 * @param originalFileMap The map of filenames to their original content.
 * @param finalFileMap The map of filenames to their final content.
 * @param editedFilesSet The set of filenames that have been touched.
 * @param binaryFiles Set of all binary files (original and final).
 * @param redactFiles If true, replaces lock and binary file diff bodies with placeholders.
 * @returns A string in the unified diff format.
 */
export function generateDiff(
  originalFileMap: Map<string, string>,
  finalFileMap: Map<string, string>,
  editedFilesSet: Set<string>,
  binaryFiles: Set<string>,
  redactFiles: boolean = false
): string {
  let fullDiff = '';

  // Sort filenames for deterministic diff output
  const sortedFiles = Array.from(editedFilesSet).sort();

  for (const filename of sortedFiles) {
    const originalExists = originalFileMap.has(filename);
    const finalExists = finalFileMap.has(filename);

    const originalContent = originalFileMap.get(filename) ?? '';
    const finalContent = finalFileMap.get(filename) ?? '';

    if (originalContent === finalContent && originalExists === finalExists) {
      continue;
    }

    const isDeleted = originalExists && !finalExists;
    const isCreation = !originalExists && finalExists;
    const isBinary = binaryFiles.has(filename);
    const isLock = isLockFile(filename);

    // --- Standard Git Header ---
    fullDiff += `diff --git a/${filename} b/${filename}\n`;

    if (isCreation) {
        fullDiff += `new file mode 100644\n`;
    }
    if (isDeleted) {
        fullDiff += `deleted file mode 100644\n`;
    }

    // --- Binary File Handling ---
    if (isBinary && !isDeleted) {
        if (redactFiles) {
             // Redacted mode: fake a regular patch with a placeholder message
             fullDiff += isCreation ? `--- /dev/null\n` : `--- a/${filename}\n`;
             fullDiff += `+++ b/${filename}\n`;
             fullDiff += `@@ -0,0 +1 @@\n+ [Binary file changes hidden to save context]\n`;
        } else {
            // Full mode: standard git binary message
            // Note: standard git output for binary often omits ---/+++ unless --text is forced,
            // but usually just says "Binary files ... differ"
            fullDiff += `Binary files a/${filename} and b/${filename} differ\n`;
        }
        continue;
    }

    // --- Lock File Redaction ---
    if (redactFiles && isLock) {
       if (isDeleted) {
           fullDiff += `--- a/${filename}\n+++ /dev/null\n`;
           fullDiff += `@@ -1 +0,0 @@\n- [Machine-generated lock file deleted]\n`;
       } else {
           fullDiff += isCreation ? `--- /dev/null\n` : `--- a/${filename}\n`;
           fullDiff += `+++ b/${filename}\n`;
           fullDiff += `@@ -0,0 +1 @@\n+ [Machine-generated lock file changes hidden to save context]\n`;
       }
       continue;
    }

    // --- Standard Text File Diffing ---
    const patch = createTwoFilesPatch(
      isCreation ? '/dev/null' : `a/${filename}`,
      isDeleted ? '/dev/null' : `b/${filename}`,
      originalContent,
      finalContent,
      '',
      '',
      { context: 3 }
    );

    const cleanPatch = patch
        .split('\n')
        .filter(line => !line.startsWith('==================================================================='))
        .join('\n');

    // If the file is a deleted binary (that wasn't caught above because isBinary && !isDeleted was false),
    // we might get a weird patch if we aren't careful, but usually binaryFiles check handles it.
    // Assuming standard text flow here:
    fullDiff += cleanPatch
  }

  return fullDiff;
}

/**
 * Applies a unified diff string to an in-memory file map and updates the set of edited files.
 * @param fileMap The map of filenames to content that the diff will be applied to.
 * @param editedFilesSet The set of edited filenames to update.
 * @param diffString The unified diff string containing patches for one or more files.
 * @returns An object indicating success, a list of changed files, and an optional error message.
 */
export function applyDiff(
  fileMap: Map<string, string>,
  diffString: string
): { success: boolean; changes?: ApplyDiffChanges; error?: string } {
  try {
    // parsePatch is generally resilient to extra git headers we added above.
    const patches = parsePatch(diffString);
    const changes: ApplyDiffChanges = {
      created: [],
      deleted: [],
      modified: [],
      renamed: [],
    };

    for (const patch of patches) {
      const isDeletion = patch.newFileName === '/dev/null';
      const isCreation = patch.oldFileName === '/dev/null';

      // For deletions, the relevant filename is the old one.
      // For creations/modifications/renames, it's the new one.
      const filename = (isDeletion
        ? patch.oldFileName?.replace(/^a\//, '')
        : patch.newFileName?.replace(/^b\//, '')) as string;

      if (!filename) {
        return { success: false, error: 'Could not determine filename from a patch.' };
      }

      // Handle file deletions
      if (isDeletion) {
        if (fileMap.has(filename)) {
          fileMap.delete(filename);
          changes.deleted.push(filename);
        }
        continue;
      }

      // Handle file creations
      if (isCreation) {
        const newContent = applyPatch('', patch, { fuzzFactor: 4 });
        if (newContent === false) {
          return {
            success: false,
            error: `Failed to apply creation patch to '${filename}'.`,
          };
        }
        fileMap.set(filename, newContent);
        changes.created.push(filename);
        continue;
      }

      // Handle file modification OR rename
      const oldFilename = patch.oldFileName?.replace(/^a\//, '');
      if (!oldFilename) {
        return { success: false, error: 'Could not determine old filename from modification patch.' };
      }

      let originalContent = fileMap.get(oldFilename);
      let isImplicitCreation = false;

      if (originalContent === undefined) {
        // Fallback if we don't have the original file in memory but a patch references it.
        // This might happen in partial context scenarios.
        originalContent = '';
        isImplicitCreation = true;
      }

      const newContent = applyPatch(originalContent, patch, { fuzzFactor: 4 });

      if (newContent === false) {
        const errorContext = isImplicitCreation ? 'implicit creation' : 'patch';
        return {
          success: false,
          error: `Failed to apply ${errorContext} to '${oldFilename}'.`,
        };
      }

      // Set the new content under the new filename
      fileMap.set(filename, newContent);

      if (oldFilename !== filename) {
        // This was a rename
        fileMap.delete(oldFilename);
        changes.renamed.push({ from: oldFilename, to: filename });
      } else {
        // This was a simple modification
        changes.modified.push(filename);
      }
    }

    return { success: true, changes: changes };

  } catch (error) {
    const message = error instanceof Error ? error.message : 'An unknown error occurred while applying the diff.';
    return { success: false, error: message };
  }
}

export function generateDiffString(context: MultiAgentToolContext, redactFiles: boolean = false): string {
  const binaryPlaceholder = "[binary file content]";
  const combinedOriginalFileMap = getCombinedFileMap(
      context.originalFileMap || new Map(),
      context.originalBinaryFileMap || new Map(),
      binaryPlaceholder
  );
  const combinedFinalFileMap = getCombinedFileMap(context.fileMap, context.binaryFileMap, binaryPlaceholder);
  
  const allBinaryFiles = new Set([
      ...(context.originalBinaryFileMap?.keys() || []),
      ...context.binaryFileMap.keys()
  ]);

  let newDiffString = generateDiff(
      combinedOriginalFileMap,
      combinedFinalFileMap,
      context.editedFilesSet,
      allBinaryFiles,
      redactFiles
  );

  if (!newDiffString) {
    newDiffString = "---No changes detected. All files are in their original state.---";
  }

  let header = `#Unified Diff for Project\nThe following diff is a live source of truth for the changes made to the project's files up to this point.`;
  if (redactFiles) {
      header += `\nNote: Machine-generated lock files and binary files may be redacted to save context window space.`;
  }

  const newDiffBlock = `${header}\n---Start of Unified Diff---\n${newDiffString}\n---End of Unified Diff---`;
  return newDiffBlock;
}

/**
 * Decodes a Git binary patch string into a raw Buffer.
 * Handles the Git-specific Base85 encoding and zlib inflation.
 */
export function decodeGitBinaryPatch(patchText: string): Buffer | null {
  // 1. Extract the literal block. 
  // Git binary patches usually contain two 'literal' blocks (new vs old).
  // We generally want the first one (the new content).
  const lines = patchText.split('\n');
  const dataLines: string[] = [];
  let inLiteral = false;

  for (let line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('literal')) {
        // If we already found a block and hit a new literal, we stop (we only want the first one)
        if (inLiteral && dataLines.length > 0) break;
        inLiteral = true;
        continue;
    }
    // If we hit an empty line while reading a block, that block is done.
    if (inLiteral && !trimmed) break; 
    
    if (inLiteral) dataLines.push(trimmed);
  }

  if (dataLines.length === 0) return null;

  // 2. Git Base85 Alphabet for DATA
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";
  const charMap: Record<string, number> = {};
  for (let i = 0; i < alphabet.length; i++) charMap[alphabet[i]] = i;

  const buffers: Buffer[] = [];

  for (const line of dataLines) {
    if (line.length === 0) continue;

    // 3. Decode Line Length (Strict Git format: A-Z=1-26, a-z=27-52)
    const firstChar = line[0];
    let bytesInLine = 0;
    const charCode = firstChar.charCodeAt(0);

    if (charCode >= 65 && charCode <= 90) { // A-Z
        bytesInLine = charCode - 65 + 1;
    } else if (charCode >= 97 && charCode <= 122) { // a-z
        bytesInLine = charCode - 97 + 27;
    } else {
        // Invalid or empty line length prefix, skip
        continue;
    }

    const encodedData = line.substring(1);
    const lineBuffer = Buffer.alloc(bytesInLine);
    let outIdx = 0;

    // Process in groups of 5 chars to produce 4 bytes
    for (let i = 0; i < encodedData.length && outIdx < bytesInLine; i += 5) {
      let accumulator = 0;
      for (let j = 0; j < 5; j++) {
        // If we run out of chars, standard git behavior is implicit padding, 
        // though usually the length check handles this.
        const char = encodedData[i + j] || '}'; 
        accumulator = accumulator * 85 + (charMap[char] ?? 0);
      }

      // Git stores these as Big Endian 32-bit ints
      for (let shift = 24; shift >= 0 && outIdx < bytesInLine; shift -= 8) {
        lineBuffer[outIdx++] = (accumulator >> shift) & 0xff;
      }
    }
    buffers.push(lineBuffer);
  }

  const compressedBuffer = Buffer.concat(buffers);

  try {
    // 4. Inflate the concatenated data
    return zlib.inflateSync(compressedBuffer);
  } catch (e) {
    console.error("Failed to inflate git binary patch:", e);
    return null;
  }
}