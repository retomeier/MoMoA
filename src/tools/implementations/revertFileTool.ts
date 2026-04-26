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
import { MultiAgentToolContext, MultiAgentToolResult, ToolParsingResult } from '../../momoa_core/types.js';
import { fileNameLookup } from '../../utils/fileNameLookup.js';
import { getCombinedFileMap } from '../../utils/fileMapUtils.js';
import { generateDiffString, isLockFile, getLockFileHiddenPlaceholder } from '../../utils/diffGenerator.js';
import { getAssetString } from '../../services/promptManager.js';
import { updateFileEntry } from '../../utils/fileAnalysis.js';

/**
 * Regenerates the project diff and updates the diff block in all
 * transcripts that are registered in the context.
 */
export async function updateDiffInAllTranscripts(context: MultiAgentToolContext) {
  const docId = PROJECT_DIFF_ID;

  if (!docId || !context.transcriptsToUpdate) {
    return;
  }

  const newDiffBlock = generateDiffString(context);

  context.transcriptsToUpdate.forEach(transcript => {
    transcript.replaceEntry(docId, newDiffBlock);
  });
  
  console.log(`Updated diff block '${docId}' in all registered transcripts.`);
}

export const PROJECT_DIFF_ID = "PROJECT_DIFF_ID";

export const revertFileTool: MultiAgentTool = {
  displayName: "Revert File",
  name: 'DOC/REVERT{',
  endToken: '}',

  async execute(params: Record<string, string>, context: MultiAgentToolContext): Promise<MultiAgentToolResult> {
    const providedFilename = params.filename;
    if (!providedFilename) {
      return { result: "Error: 'filename' parameter is missing." };
    }
    
    if (!context.originalFileMap || !context.originalBinaryFileMap) {
      return { result: "Error: Orchestrator did not provide original file maps to context." };
    }

    // Use fileNameLookup to find the precise file name
    const allFilesMap = getCombinedFileMap(context.fileMap, context.binaryFileMap);
    const filename = await fileNameLookup(providedFilename, allFilesMap, context.multiAgentGeminiClient);

    const originalExisted = context.originalFileMap.has(filename) || context.originalBinaryFileMap.has(filename);
    const currentExisted = context.fileMap.has(filename) || context.binaryFileMap.has(filename);
    
    let revertMessage = `---Error: Could not revert '${filename}'. It was not found in the current project state.---`;
    let revertSucceeded = false;
    let finalContent: string | null | undefined = undefined;
    let isBinary = false;

    // Case 1: Revert text file (it existed originally)
    if (context.originalFileMap.has(filename)) {
      const originalContent = context.originalFileMap.get(filename)!;
      context.fileMap.set(filename, originalContent);
      context.binaryFileMap.delete(filename); // Clean up just in case
      // We will remove from editedFilesSet *after* updating transcripts
      revertMessage = `---File '${filename}' has been successfully reverted to its original state.---`;
      revertSucceeded = true;
      finalContent = originalContent;
      isBinary = false;
    }
    // Case 2: Revert binary file (it existed originally)
    else if (context.originalBinaryFileMap.has(filename)) {
      const originalContent = context.originalBinaryFileMap.get(filename)!;
      context.binaryFileMap.set(filename, originalContent);
      context.fileMap.delete(filename); // Clean up just in case
      // We will remove from editedFilesSet *after* updating transcripts
      revertMessage = `---File '${filename}' has been successfully reverted to its original state.---`;
      revertSucceeded = true;
      finalContent = null;
      isBinary = true;
    }
    // Case 3: File was created (didn't exist originally), so "reverting" means deleting it.
    else if (!originalExisted && currentExisted) {
      context.fileMap.delete(filename);
      context.binaryFileMap.delete(filename);
      // We will remove from editedFilesSet *after* updating transcripts
      revertMessage = `---File '${filename}' was created during this run and has been successfully deleted (reverted).---`;
      revertSucceeded = true;
      finalContent = undefined; // Flag for deleted
      isBinary = false;
    }
    // Case 4: File doesn't exist now and didn't exist originally
    else if (!originalExisted && !currentExisted) {
      revertMessage = `---Error: Could not revert '${filename}'. It was not found in the current project or the original project state.---`;
    }

    // If a revert or deletion succeeded, update all transcripts
    if (revertSucceeded) {
      context.sendMessage({
          type: 'PROGRESS_UPDATE',
          message: `Undoing changes to \`${filename}\`, and reverting it to its original content.`,
      });

      // If the file was not deleted, force a re-analysis
      // to update its description and remove any "---DELETED---" markers.
      if (finalContent !== undefined) { // undefined means it was deleted
        try {
          if (!context.binaryFileMap.has(filename)) {
            await updateFileEntry(filename, context.fileMap, context.multiAgentGeminiClient);
          } else {
            await updateFileEntry(filename, context.fileMap, undefined, 
              { 
                filename: filename,
                description: "[Binary File]"
              }, 
              true);
          }
        } catch (e: any) {
          console.warn(`Failed to re-analyze reverted file ${filename}: ${e.message}`);
        }
      }

      // Immediately supersede this file's entry in all transcripts
      // (WorkPhase experts + Orchestrator) *before* removing from the set.
      context.transcriptsToUpdate?.forEach(transcript => {
        transcript.supersedeEntry(filename);
      });
      
      // Now that transcripts are updated, remove it from the set.
      context.editedFilesSet.delete(filename);
    }

    // Always update the diff block in all transcripts
    await updateDiffInAllTranscripts(context);

    // --- Format Return Value ---
    const prefix = await getAssetString('file-content-prefix');
    const suffix = await getAssetString('file-content-suffix');
    const replacementString = await getAssetString('file-content-removed');
    
    if (!revertSucceeded) {
      // Return the error message, but still provide the ID/replacement
      // so the WorkPhase supersedes any *previous* read of this file.
      return {
        result: revertMessage,
        transcriptReplacementID: filename,
        transcriptReplacementString: `${prefix}\n${replacementString}\n${suffix}`
      };
    }

    // Build the final result string
    let finalResultString = revertMessage;
    if (finalContent !== undefined) { // File exists post-revert
      if (isBinary) {
        finalResultString += `\nFile '${filename}' is a binary file.`;
      } else if (isLockFile(filename)) { 
        finalResultString += `\n${getLockFileHiddenPlaceholder(filename)}`;
      } else if (finalContent !== null) {
        finalResultString += `\n${prefix}\n${finalContent}\n${suffix}`;
      }
    }
    
    return {
      result: finalResultString,
      transcriptReplacementID: filename,
      transcriptReplacementString: `${prefix}\n${replacementString}\n${suffix}`
    };
  },

  async extractParameters(invocation: string, _context: MultiAgentToolContext): Promise<ToolParsingResult> {
    if (invocation.trim().endsWith("}")) {
      const filename = invocation.trim().slice(0, -1).trim();
      return {
        success: true,
        params: { filename }
      };
    } else {
      return {
        success: false,
        error: `Invalid syntax for ${this.displayName}. Expected DOC/REVERT{filename.txt}`
      };
    }
  }
};