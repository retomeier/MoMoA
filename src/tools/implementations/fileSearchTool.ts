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

import { MultiAgentTool } from '../multiAgentTool.js';
import { findInFiles } from '../../utils/fileAnalysis.js';
import { MultiAgentToolContext, MultiAgentToolResult, ToolParsingResult } from '../../momoa_core/types.js';
import { getAllFileKeys } from '../../utils/fileMapUtils.js';

/**
 * Implements the File Reader Tool, providing functionality to read file content
 * from an in-memory collection of files (Map). This tool does NOT read from disk.
 */
export const fileSearchTool: MultiAgentTool = {
  displayName: "File Search",
  name: 'FILESEARCH{query: "',

  /**
   * Executes the file reader tool.
   * @param params The parameters for the tool's execution, expecting a 'filename' property.
   * @param context The ToolContext object containing necessary runtime information.
   * @returns A promise that resolves to the file's content or an error message.
   */
  async execute(params: Record<string, string>, context: MultiAgentToolContext): Promise<MultiAgentToolResult> {

    const query = params.query;

    context.sendMessage({
      type: 'PROGRESS_UPDATE',
      message: `Searching for \`${query}\``,
    });

    // 1. Search text file content.
    const contentMatches = findInFiles(query, context.fileMap) || [];
    
    // Use a Set to store unique results to avoid duplicates.
    const searchResults = new Set<string>(contentMatches);

    // 2. Search all filenames (both text and binary).
    const allFilenames = getAllFileKeys(context.fileMap, context.binaryFileMap);
    for (const filename of allFilenames) {
        if (filename.includes(query)) {
            if (context.binaryFileMap.has(filename)) {
                searchResults.add(`Binary file found: ${filename}`);
            } else {
                // If found by content search, it's already in the set as just the filename.
                // This logic ensures we don't add it twice.
                searchResults.add(filename);
            }
        }
    }

    const finalResultArray = Array.from(searchResults);
    const replacementString = `---FILE SEARCH RESULTS INTENTIONALLY REMOVED---`;

    const result = finalResultArray.length > 0 ? finalResultArray.join('\n') : `No matches found for your query.`;

    context.sendMessage({
      type: 'PROGRESS_UPDATE',
      message: `\`\`\`\n${result.trim()}\n\`\`\``,
    });

    return {
      result: result,
      transcriptReplacementID: query,
      transcriptReplacementString: replacementString
    };
  },

  /**
   * Extract parameters from the tool invocation string.
   * @param invocation The string used to invoke the tool.
   * @returns The parameter names and corresponding values.
   */
  async extractParameters(invocation: string, _context: MultiAgentToolContext): Promise<ToolParsingResult> {

    const toolCallEndMarker = '" END_QUERY}';
    const endQueryMarkerIndex = invocation.indexOf(toolCallEndMarker);

    if (endQueryMarkerIndex === -1) {
      return { 
        success: false,
        error: `Unable to search the files because you provided invalid syntax. Please pay close attention to the required syntax before trying again.`
      }
    }

    const extractedQuery = invocation.substring(0, endQueryMarkerIndex);
    if (!extractedQuery.trim()) {
      return { 
        success: false,
        error: `Unable to search the files because the provided query string was empty, which is invalid. Please pay close attention to the required syntax before trying again.`
      }
    }

    return {
      success: true,
      params: {
        query: extractedQuery.trim()
      }
    }
  }
};