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

import { MultiAgentToolContext, MultiAgentToolResult, ToolParsingResult } from '../../momoa_core/types.js';
import { addDynamicallyRelevantFile, getFileAnalysis, removeFileEntry, updateFileEntry } from '../../utils/fileAnalysis.js';
import { getAllFileKeys } from '../../utils/fileMapUtils.js';
import { MultiAgentTool } from "../multiAgentTool.js";

/**
 * Simulates renaming a directory by modifying a file map in place.
 * It marks all files in the source path for deletion (by setting their content to an empty string)
 * and creates new entries for those files at the destination path with their original content.
 */
export const moveFolderTool: MultiAgentTool = {
  displayName: "Move File or Folder",
  name: 'MOVE_FILE_OR_FOLDER{SOURCE: ',
  endToken: '}',

  /**
   * Executes the file reader tool.
   * @param params The parameters for the tool's execution, expecting a 'filename' property.
   * @param context The ToolContext object containing necessary runtime information.
   * @returns A promise that resolves to the file's content or an error message.
   */
  async execute(params: Record<string, string>, context: MultiAgentToolContext): Promise<MultiAgentToolResult> {
    const source = params.source;
    const destination = params.destination; 

    addDynamicallyRelevantFile(source);
    addDynamicallyRelevantFile(destination);

    let sourceExists = false;
    const allFileKeys = getAllFileKeys(context.fileMap, context.binaryFileMap);

    // Check if the source path exists as a direct file entry
    if (context.fileMap.has(source) || context.binaryFileMap.has(source)) {
      sourceExists = true;
    } else {
      // If not a file, check if it exists as a folder by looking for any file paths that start with it
      const normalizedSourcePrefix = source.endsWith('/') ? source : source + '/';
      for (const key of allFileKeys) {
        if (key.startsWith(normalizedSourcePrefix)) {
          sourceExists = true;
          break;
        }
      }
    }

    if (!sourceExists) {
      const errorMessage = `No file or folder '${source}' exists, so it can't be moved or renamed. Please check the file or folder name carefully before retrying.`;
      return { result: errorMessage };
    }

    let resultString;
    // Case 1: Renaming a single file.
    if (context.fileMap.has(source) || context.binaryFileMap.has(source)) {
      // Check if destination is already taken by a file.
      if (context.fileMap.has(destination) || context.binaryFileMap.has(destination)) {
        return { result: `Couldn't rename ${source} because '${destination}' already exists.` };
      }

      const normalizedDestPrefix = destination.endsWith('/') ? destination : destination + '/';
      for (const key of allFileKeys) {
        if (key.startsWith(normalizedDestPrefix)) {
          return { result: `Invalid destination -- a folder named '${destination}' already exists.` };
        }
      }

      await updateFileInMetadata(source, destination, context);
      resultString = `Renamed file '${source}' to '${destination}'`;
    } else {
      // Case 2: Moving a folder
      if (destination.startsWith(source + '/')) {
        return { result: `Error: Cannot move a directory ('${source}') into a subdirectory of itself.` };
      }

      // Check if destination path is blocked by an existing file or folder.
      if (context.fileMap.has(destination) || context.binaryFileMap.has(destination)) {
        return { result: `Invalid destination folder name -- a file already exists with that name.` };
      }
      for (const filePath of allFileKeys) {
        if (filePath.startsWith(destination + '/')) {
          return { result: `Folder move failed. The directory '${destination}' already exists and is not empty. The destination directory must not exist or be empty.` };
        }
      }
      
      const eachMove = new Set<{ sourceFilePath: string, destinationFilePath: string }>();
      const normalizedSourcePrefix = source.endsWith('/') ? source : source + '/';
      
      for (const sourceFilePath of allFileKeys) {
        if (sourceFilePath.startsWith(normalizedSourcePrefix)) {
          const destinationFilePath = sourceFilePath.replace(source, destination);
          eachMove.add({ sourceFilePath, destinationFilePath });
        }
      }

      if (eachMove.size === 0) {
        return { result: `Source '${source}' appears to be an empty or non-existent folder. No files were moved.` };
      }

      resultString = `Renamed directory '${source}' to '${destination}':`;
      for (const { sourceFilePath, destinationFilePath } of eachMove) {
        await updateFileInMetadata(sourceFilePath, destinationFilePath, context);
        resultString += `\n* Moved ${sourceFilePath} to ${destinationFilePath}`;
      }
    }

    return { result: resultString };
  },

  /**
   * Extract parameters from the tool invocation string.
   * @param invocation The string used to invoke the tool.
   * @returns The parameter names and corresponding values.
   */
  async extractParameters(invocation: string, _context: MultiAgentToolContext): Promise<ToolParsingResult> {
    const pattern = /^(.*?)\s*DESTINATION:\s*(.*)/;
    const match = invocation.match(pattern);

    if (match && match[1] && match[2]) {
        const source = match[1].trim();
        const destination = match[2].trim().replace(/}$/, '').trim();

        if (source && destination) {
            return {
                success: true,
                params: { source, destination }
            };
        }
    }

    return {
        success: false,
        error: `Invalid syntax for the ${this.displayName} Tool. Expected format: MOVE_FILE_OR_FOLDER{SOURCE: <source_path> DESTINATION: <destination_path>}`
    };
  }
};

async function updateFileInMetadata(source: string, destination: string, context: MultiAgentToolContext) {
  context.editedFilesSet.add(source);
  context.editedFilesSet.add(destination);

  if (context.binaryFileMap.has(source)) {
    const sourceContent = context.binaryFileMap.get(source);
    context.binaryFileMap.set(destination, sourceContent ?? '');
    context.binaryFileMap.delete(source);
  } else {
    const sourceContent = context.fileMap.get(source);
    const sourceAnalysis = getFileAnalysis(source);
    if (sourceAnalysis) {
      sourceAnalysis.filename = destination;
      sourceAnalysis.relatedFiles = '';
      sourceAnalysis.description = `[Moved from ${source} to ${destination}] ${sourceAnalysis.description}`;
    }

    context.fileMap.set(destination, sourceContent ?? '');
    await updateFileEntry(destination, context.fileMap, undefined, sourceAnalysis);

    context.fileMap.delete(source);
    removeFileEntry(source);
  }
}