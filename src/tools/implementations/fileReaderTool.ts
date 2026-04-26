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
import { fileNameLookup } from '../../utils/fileNameLookup.js';
import { getCombinedFileMap } from '../../utils/fileMapUtils.js';
import { addDynamicallyRelevantFile, getFileAnalysis, updateFileEntry } from '../../utils/fileAnalysis.js';
import { MultiAgentToolContext, MultiAgentToolResult, ToolParsingResult } from '../../momoa_core/types.js';
import { getAssetString } from '../../services/promptManager.js';
import { isLockFile, getLockFileHiddenPlaceholder } from '../../utils/diffGenerator.js';

/**
 * Implements the File Reader Tool, providing functionality to read file content
 * from an in-memory collection of files (Map). This tool does NOT read from disk.
 */
export const fileReaderTool: MultiAgentTool = {
  displayName: "File Reader",
  name: 'DOC/READ{',
  endToken: '}',

  /**
   * Executes the file reader tool.
   * @param params The parameters for the tool's execution, expecting a 'filename' property.
   * @param context The ToolContext object containing necessary runtime information.
   * @returns A promise that resolves to the file's content or an error message.
   */
  async execute(params: Record<string, string>, context: MultiAgentToolContext): Promise<MultiAgentToolResult> {
    const providedFilename = params.filename;

    if (!providedFilename) {
      return {
        result: `Error: 'filename' parameter is missing for ${this.displayName} tool.`
      };
    }

    // Combine keys from both maps for a comprehensive lookup.
    const allFilesMap = getCombinedFileMap(context.fileMap, context.binaryFileMap);

    // const filename = await fileNameLookup(providedFilename, allFilesMap, context.multiAgentGeminiClient);
    let filename = providedFilename.trim();
    
    if (!allFilesMap.has(filename)) {
        // File not found. NOW, let's try to find a suggestion.
        const suggestion = await fileNameLookup(filename, allFilesMap, context.multiAgentGeminiClient);

        if (suggestion && suggestion !== filename && allFilesMap.has(suggestion)) {
            return {
                result: `File '${filename}' was not found. Did you mean '${suggestion}'?`
            };
        }

        return {
          result: `---File '${filename}' not found---`
        };
    }

    addDynamicallyRelevantFile(filename);

    context.sendMessage({
        type: 'PROGRESS_UPDATE',
        message: `Reading \`${filename}\``,
      }
    );

    const prefix = await getAssetString('file-content-prefix');
    const suffix = await getAssetString('file-content-suffix');
    const replacementString = await getAssetString('file-content-removed');

    // Handle binary files (Images, PDFs, Audio, Video)
    if (context.binaryFileMap.has(filename)) {
      const mimeType = getBinaryMimeType(filename);
      
      if (mimeType) {
        const base64Data = context.binaryFileMap.get(filename);
        if (base64Data) {
          // Determine the label based on the MIME type category
          if (mimeType.startsWith('text/')) {
            const trimmedContent = base64Data.slice(0, 10000);
            const explainString = `---File '${filename}' exists but is too large to be added to the chat history. Providing only the first 10,000 characters.---`;
            const fileString = `${prefix}\n${trimmedContent}\n[...Remaining file truncated to conserve context window space...]\n${suffix}`;
            return {
              result: `${explainString}\n${fileString}`,
              transcriptReplacementID: filename,
              transcriptReplacementString: `${explainString}\n${prefix}\n${replacementString}\n${suffix}`
            }
          }

          let fileTypeLabel = 'file';
          if (mimeType.startsWith('image/')) fileTypeLabel = 'image';
          else if (mimeType === 'application/pdf') fileTypeLabel = 'document';
          else if (mimeType.startsWith('audio/')) fileTypeLabel = 'audio file';
          else if (mimeType.startsWith('video/')) fileTypeLabel = 'video';

          if (context.transcriptsToUpdate) {
            const targets = context.transcriptsToUpdate.length > 1 
                ? context.transcriptsToUpdate.slice(1) 
                : context.transcriptsToUpdate;

              targets.forEach(transcript => {
                  transcript.addImage(
                      `This is the ${fileTypeLabel} \`${filename}\``,
                      base64Data,
                      mimeType
                  );
              });
          }
          
          return {
              result: `The ${fileTypeLabel} '${filename}' is the previous entry in the chat history.`,
              transcriptReplacementID: filename,
              transcriptReplacementString: `[${fileTypeLabel.charAt(0).toUpperCase() + fileTypeLabel.slice(1)} '${filename}' is out of date]`
          };
        }
      }

      return {
        result: `---File '${filename}' exists but the file may be too large, or it may be an unsupported binary file---`,
        transcriptReplacementID: filename,
        transcriptReplacementString: `---File '${filename}' exists but the file may be too large, or it may be an unsupported binary file---`
      };
    }

    // Handle "Secret Files"
    if (context.fileMap.has(filename) && filename.startsWith('SECRET__')) {
      const noSecrets = `---File '${filename}' exists but this tool can't share the contents of SECRET files---`;
      return {
        result: noSecrets,
        transcriptReplacementID: filename,
        transcriptReplacementString: noSecrets
      };
    }

    // Handle Lock Files
    if (isLockFile(filename)) {
         const placeholder = getLockFileHiddenPlaceholder(filename);
         return {
             result: placeholder,
             transcriptReplacementID: filename,
             transcriptReplacementString: placeholder
         };
    }

    const content = context.fileMap.get(filename);

    if (content === undefined)
      return {
        result: `---File '${filename}' is empty---`,
        transcriptReplacementID: filename,
        transcriptReplacementString: `${prefix}\n${replacementString}\n${suffix}`
      };

    try {
      const fileAnalysis = getFileAnalysis(filename);
      if (!fileAnalysis?.description)
        await updateFileEntry(filename, context.fileMap, context.multiAgentGeminiClient);
    } catch {}

    return {
      result: `${prefix}\n${content}\n${suffix}`,
      transcriptReplacementID: filename,
      transcriptReplacementString: `${prefix}\n${replacementString}\n${suffix}`
    }
  },

  /**
   * Extract parameters from the tool invocation string.
   * @param invocation The string used to invoke the tool.
   * @returns The parameter names and corresponding values.
   */
  async extractParameters(invocation: string, _context: MultiAgentToolContext): Promise<ToolParsingResult> {
    if (invocation.trim().endsWith("}")) {
      const filename = invocation.trim().slice(0, -1).trim();
      return {
        success: true, 
        params: {
          filename
        }
      };
    } else {
      return {
        success: false, 
        error: `Invalid syntax for the ${this.displayName} Tool. Make sure you include the curly brackets.`
      }
    }
  }
};

/**
 * Helper function to determine MIME type from filename extension for 
 * supported binary types: Images, PDFs, Audio, and Video.
 */
function getBinaryMimeType(filename: string): string | null {
    const ext = filename.split('.').pop()?.toLowerCase();
    switch (ext) {
        // Images
        case 'png': return 'image/png';
        case 'jpg':
        case 'jpeg': return 'image/jpeg';
        case 'webp': return 'image/webp';
        case 'heic': return 'image/heic';
        case 'heif': return 'image/heif';
        
        // Documents
        case 'pdf': return 'application/pdf';

        // Audio
        case 'wav': return 'audio/wav';
        case 'mp3': return 'audio/mp3';
        case 'aiff': return 'audio/aiff';
        case 'aac': return 'audio/aac';
        case 'ogg': return 'audio/ogg';
        case 'flac': return 'audio/flac';

        // Video
        case 'mp4': return 'video/mp4';
        case 'mpeg':
        case 'mpg': return 'video/mpeg';
        case 'mov': return 'video/mov';
        case 'avi': return 'video/avi';
        case 'flv': return 'video/x-flv';
        case 'webm': return 'video/webm';
        case 'wmv': return 'video/wmv';
        case '3gpp': return 'video/3gpp';

        // Text files
        case 'txt':
        case 'csv':
        case 'tsv':
        case 'log': return 'text/text';

        default: return null;
    }
}