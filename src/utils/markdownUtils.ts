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

import { MultiAgentToolContext } from "../momoa_core/types.js";
import { getAssetString } from "../services/promptManager.js";
import { getFileAnalysis } from "./fileAnalysis.js";
import { fileNameLookup } from "./fileNameLookup.js";
import { getCombinedFileMap } from "./fileMapUtils.js";

/**
 * Removes triple backtick fences from a string if they exist at the start and end.
 *
 * The function checks if the input string, when trimmed, starts with '```' on its
 * first line and ends with '```' on its last line. It also removes single '`' from
 * the beginning and end of a string on the same line. If these conditions are met,
 * it returns the content between the fences, also trimmed of any leading/trailing
 * whitespace that might be introduced by the removal. Otherwise, the original
 * untrimmed input string is returned.
 *
 * @param text The input string to process.
 * @returns The content within the backtick fences if found, or the original string.
 */
export function removeBacktickFences(text: string): string {
  const trimmedText = text.trim();
  const lines = trimmedText.split('\n');

  // Check if there are at least two lines (for opening and closing fences)
  // and if the first line starts with '```' and the last line (when trimmed) is
  //  exactly '```'.
  if (
    lines.length >= 2 &&
    lines[0].trim().startsWith('```') &&
    lines[lines.length - 1].trim() === '```'
  ) {
    // Extract the content between the fences
    const contentLines = lines.slice(1, lines.length - 1);
    const content = contentLines.join('\n');
    return content;
  } else if (
    lines.length === 1 &&
    lines[0].trim().startsWith('`') &&
    lines[0].trim().endsWith('`')) {
    const content = lines[0].slice(1, -1);
    return content;
  }

  // If conditions are not met, return the original untrimmed string
  return text;
}

export function toKebabCase(str: string | undefined): string {
  if (!str) return '';

  return str
    // Find transitions from a lowercase/number to an uppercase letter
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    // Replace spaces and underscores with a hyphen
    .replace(/[\s_]+/g, '-')
    // Convert the entire string to lowercase
    .toLowerCase();
}

export const aOrAn = (word: string): string => 'aeiou'.includes(word[0]?.toLowerCase()) ? 'an' : 'a';

const numberToWord: Record<number, string> = {
  2: 'two',
  3: 'three',
  4: 'four',
  5: 'five',
  6: 'six',
  7: 'seven',
  8: 'eight',
  9: 'nine',
};

export function formatExpertList(experts: string[]): string {
  const counts = new Map<string, number>();
  for (const expert of experts) {
    counts.set(expert, (counts.get(expert) || 0) + 1);
  }

  const sorted = Array.from(counts.entries()).sort(
    ([, countA], [, countB]) => countB - countA
  );

  const sortedUsingWords = sorted.map(([item, count]) => {
    if (count === 1) {
      return `${aOrAn(item)} ${item}`;
    }
    
    const word = numberToWord[count] || count.toString();
    const countPrefix = word; //word.charAt(0).toUpperCase() + word.slice(1);
    
    return `${countPrefix} ${item}s`;
  });

  const formatter = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });
  const allExpertNames = formatter.format(sortedUsingWords);
  return allExpertNames;
}

/**
 * Repairs a potentially truncated JSON array string by trimming it from the end
 * and appending a ']' to make it a valid JSON array.
 *
 * @param jsonString The potentially truncated JSON array string.
 * @returns A valid JSON array string (or `undefined` if it cannot be repaired.
 */
export const repairTruncatedJsonArray = (jsonString: string): string | undefined => {
  const trimmedString = jsonString.trim();

  if (!trimmedString.startsWith('['))
    return undefined;

  try {
    if (Array.isArray(JSON.parse(trimmedString))) 
      return trimmedString;
  } catch {}

  const tryAppendingBrace = (stringToTry: string):string | undefined => {
    try {
      const appendCloseBracket = `${stringToTry.trimEnd()}]`;
      const parsedAppendCloseBracket = JSON.parse(appendCloseBracket);
      if (Array.isArray(parsedAppendCloseBracket))
        return appendCloseBracket;
    } catch {
      return undefined;
    }
  }
  
  const appendBraceResult = tryAppendingBrace(trimmedString); 
  if (appendBraceResult)
    return appendBraceResult;

  for (let i = trimmedString.length; i > 0; i--) {
    let chunk = trimmedString.substring(0, i).trimEnd();

    if (chunk.endsWith(','))
      chunk = chunk.slice(0, -1);
    
    if (chunk === '[')
      return '[]';
    if (!chunk)
      return undefined;

    const tryThisChunk = tryAppendingBrace(chunk);
    if (tryThisChunk)
      return tryThisChunk;
  }

  return undefined;
};

/**
 * Replaces the content between two marker strings (and the markers
 * themselves) with a new string.
 *
 * @param originalString The string to modify.
 * @param prefix The starting marker string.
 * @param suffix The ending marker string.
 * @param replacementString The string to insert.
 * @returns The modified string, or the original string if conditions aren't met.
 */
export const replaceContentBetweenMarkers = (
  originalString: string,
  prefix: string,
  suffix: string,
  replacementString: string
): string => {
  // 1. Find the starting position of the prefix
  const prefixIndex = originalString.indexOf(prefix);

  // 2. Find the starting position of the suffix, searching *after* the prefix
  const suffixIndex = originalString.indexOf(suffix, prefixIndex);

  // 3. Check conditions:
  //    - Both markers must be found (index !== -1)
  if (prefixIndex === -1 || suffixIndex === -1) {
    // If conditions aren't met, return the original string untouched
    return originalString;
  }

  // 4. If conditions are met, build the new string:
  //    - Get the part *before* the prefix
  const partBefore = originalString.slice(0, prefixIndex);

  //    - Get the part *after* the suffix
  const partAfter = originalString.slice(suffixIndex + suffix.length);

  // 5. Concatenate them with the replacement string in the middle
  // 
  return partBefore + replacementString + partAfter;
};

export async function getFilesAndContent(requestedFiles: {FILENAME: string, DESCRIPTION: string}[], context: MultiAgentToolContext): Promise<string> {
  const fileContentPrefix = await getAssetString('file-content-prefix');
  const fileContentSuffix = await getAssetString('file-content-suffix');

  let result = '--No Files--';
  if (requestedFiles && requestedFiles.length > 0 && (context.fileMap || context.binaryFileMap)) {
    // Combine text and binary file maps for a comprehensive file lookup.
    const allFilesMap = getCombinedFileMap(context.fileMap, context.binaryFileMap);

    const fileResults: string[] = [];

    for (const fileObject of requestedFiles) {
      if (fileObject && fileObject.FILENAME) {
        let filename = fileObject.FILENAME;
        let description = fileObject?.DESCRIPTION || undefined;

        filename = await fileNameLookup(filename, allFilesMap, context.multiAgentGeminiClient);

        let fileBlock = `Filename: ${filename}\n`;
        if (description)
          fileBlock += `File Description: ${description}`;
        
        const fileSummary = getFileAnalysis(filename);
        if (fileSummary)
          fileBlock += ` ${fileSummary}`;

        if (description || fileSummary)
          fileBlock += `\n`;
        
        // Check both maps to retrieve content or identify the file type.
        if (context.fileMap.has(filename)) {
          const fileContent = context.fileMap.get(filename);
          fileBlock += `${fileContentPrefix}\n${fileContent}\n${fileContentSuffix}\n`;
        } else if (context.binaryFileMap.has(filename)) {
          fileBlock += `[Binary file: Content not viewable]\n`;
        } else {
          fileBlock += `[File Doesn't Exist Yet]\n`;
        }
        fileResults.push(fileBlock);
      }
    }
    
    if (fileResults.length > 0) {
      // Join the content for each file and trim any final whitespace.
      result = fileResults.join('').trim();
    }
  }
  return result;
}