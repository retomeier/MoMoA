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
import { fileReaderTool } from './fileReaderTool.js';
import { addDynamicallyRelevantFile, removeFileEntry, updateFileEntry } from '../../utils/fileAnalysis.js';
import { FileOperation, MultiAgentToolContext, MultiAgentToolResult, ToolParsingResult } from '../../momoa_core/types.js';
import { getAssetString, getToolPreamblePrompt, replaceRuntimePlaceholders } from '../../services/promptManager.js';
import { DEFAULT_GEMINI_FLASH_MODEL, DEFAULT_GEMINI_LITE_MODEL } from '../../config/models.js';
import { removeBacktickFences } from '../../utils/markdownUtils.js';
import { TranscriptManager } from '../../services/transcriptManager.js';
import { fuzzyReplace } from '../../utils/fuzzyStringReplacer.js';
import { updateDiffInAllTranscripts } from './revertFileTool.js';
import { isLockFile } from '../../utils/diffGenerator.js';
import { createTwoFilesPatch } from 'diff';
import { logFilename } from '../../config/config.js';

const filenameStart = `DOC/EDIT{`;
const filenameEnd = `}\nTO\u005fREPLACE`;
const fixInstructions = `Please review the tool instructions and follow the syntax rules carefully before trying again. The most common mistake is not surrounding the TO_REPLACE text or the NEW_TEXT in curly braces, make sure you're doing this.`;

/**
 * Implements the Smart File Editor Tool, providing functionality to edit file content
 * from an in-memory collection of files (Map). This tool does NOT write to disk.
 */
export const smartFileEditorTool: MultiAgentTool = {
  displayName: "File Editor",
  name: filenameStart,
  endToken: 'END\u005fEDIT',

  /**
   * Executes the smart file editor tool.
   * @param params The parameters for the tool's execution, expecting a 'filename' and 'editRequest' properties.
   * @param context The ToolContext object containing necessary runtime information.
   * @returns A promise that resolves to the file's edited content or an error message.
   */
  async execute(params: Record<string, string>, context: MultiAgentToolContext): Promise<MultiAgentToolResult> {

    // Define updateLog inside execute to ensure context is in scope
    const updateLog = async (message: string, updateOverseerLog: boolean = true) => {
      context.sendMessage(JSON.stringify({
        status: 'WORK_LOG',
        message: message,
      }));
    
      if (updateOverseerLog)
        context.overseer?.addLog(message);
    };

    const filename = params.filename;
    const originalEditRequest = params.editRequest;

    if (filename) {
      addDynamicallyRelevantFile(filename);
    }

    if (!filename || !originalEditRequest)
      return {result: `Invalid syntax for the ${this.displayName} Tool. ${fixInstructions}`};
    
    if (filename.toLowerCase() === logFilename.toLowerCase()) {
      return {result: `The Research Log \`${filename}\` cannot be manually edited. Use the 'Research Log Updater' Tool (or start a new Workphase to use this tool) to add new entries including corrections and clarifications.`};
    }

    const parameterExtractionResult = await extractEditRequestParameters(originalEditRequest);
    const syntaxIssues = (parameterExtractionResult).success ? "--No issues have yet been identified with the request--" : parameterExtractionResult.error;

    // Capture the original content at the beginning of the execute method
    const isBinary = context.binaryFileMap.has(filename);
    const originalFileContent = isBinary ? `[Binary File: ${filename}]` : (context.fileMap.get(filename) ?? null);
    context.editedFilesSet.add(filename);

    // History String
    const chatHistoryString = await (async () => {
      const historyString = context.transcriptForContext.getTranscriptAsString(true, context.experts);
      
      if (historyString) {
        const conversationSummarizerPreamble = await getAssetString('conversation-summarizer-preamble');
        const summarizerRequest = `${conversationSummarizerPreamble}\n${historyString}`;
  
        const llmSummarizedHistory = (await context.multiAgentGeminiClient.sendOneShotMessage(
          summarizerRequest,
          { model: DEFAULT_GEMINI_LITE_MODEL } 
        ))?.text?.trim() || "";
    
        // Clean the LLM's response.
        return removeBacktickFences(llmSummarizedHistory);
      }
      return '--No Chat History Available--';
    })();

    const smartEditorPreamble = await getToolPreamblePrompt('smart-editing-tool-monolog-preamble');
    const completedPreamble = await replaceRuntimePlaceholders(smartEditorPreamble,
      {
        ChatHistory: chatHistoryString,
        OriginalFile: originalFileContent ?? `[File Doesn't Exist Yet]`,
        SyntaxIssues: syntaxIssues,
        EditRequest: `\u0040DOC/EDIT{${filename}}\n${originalEditRequest}`
      }
    );

    let smartEditorResult;
    let done = false;
    let turn = 0;
    const maxAllowedTurns = 20;
    
    const transcriptManager = new TranscriptManager({ 
        context: context.infrastructureContext 
      });
    transcriptManager.addEntry('user', completedPreamble);

    await updateLog(`### Smart Editor editing '${filename}`);
    context.sendMessage({
      type: 'PROGRESS_UPDATE',
      message: `Editing \`${filename}\``,
    });

    // Attempt the edit directly first. The LLM loop is now a fallback.
    if (parameterExtractionResult.success) {
      // Attempt the edit directly. editFile() will log its own detailed results.
      const editResultString = editFile(
        filename,
        String(parameterExtractionResult.params.toReplaceString), // TODO: handling of string[]
        String(parameterExtractionResult.params.replacementString), // TODO: handling of string[]
        context
      );

      // Check if the edit failed (e.g., "not found", "multiple matches")
      // These keywords are from the error strings returned by editFile/fuzzyReplace
      const editFailed = editResultString.includes('failed') || 
                         editResultString.includes("doesn't exist") || 
                         editResultString.includes('potential matches');

      if (editFailed) {
        // The edit failed. The reason is in editResultString (and was logged by editFile).
        // Pass this error to the internal LLM loop so it can try to fix it.
        transcriptManager.addEntry('user', editResultString, { documentId: filename, replacementIfSuperseded: '---FILE CONTENT INTENTIONALLY REMOVED---'});
        await updateLog(`###Smart Editor: Initial edit failed. Handing over to internal LLM for correction.`);
        
      } else {
        // The edit SUCCEEDED. We skip the LLM loop.
        done = true;
        smartEditorResult = editResultString; 
      }

    } else {
      // Syntax was bad from the start, so we let the LLM loop handle it.
      // The original `smartEditorPreamble` already contains the syntax error.
      await updateLog(`###Smart Editor: Initial syntax check failed. Handing over to internal LLM for correction.`);
    }


    while (!done) {
      turn++;

      if (context.signal?.aborted) {
        await updateLog('Received abort signal. Cancelling edit.');

        // Perform any immediate cleanup here if necessary before breaking
        smartEditorResult = `${this.displayName} tool has been cancelled by the user.`;
        done = true;
        break; 
      }

      const feedback = context.overseer?.peekPendingFeedback();
      if (feedback) {
        if (feedback.action === 'RESTART') {
          await updateLog('The overseer has decided to restart the project.');
          smartEditorResult = `Cancelling the ${this.displayName} because the overseer has decided to restart the project.`;
        } else if (feedback.action === 'ABANDON') {
          await updateLog('The overseer has decided to abandon the project.');
          smartEditorResult = `Cancelling the ${this.displayName} because the overseer has decided to abandon the project.`;
        }
      }

      if (turn > maxAllowedTurns + 1) {
        transcriptManager.addEntry('user', `You have run out of turns and MUST return a result. You must now provide your best response to try and solve the task you were assigned.`);
        await updateLog(`Turn limit reached.`);
      } 
      if (turn > maxAllowedTurns + 1) {
        done = true;
        await updateLog(`Hard turn limit reached. Aborting edit.`);
      }

      // Next LLM Turn
      const smartEditorResponse = await context.multiAgentGeminiClient.sendTranscriptMessage(
        transcriptManager,
        {
          model: DEFAULT_GEMINI_FLASH_MODEL,
          signal: context.signal
        }
      );
      let smartEditorResponseText = smartEditorResponse.text || '';
      smartEditorResponseText = await transcriptManager.cleanLLMResponse(smartEditorResponseText);

      await updateLog(`###Smart Editor response:\n${smartEditorResponseText}`);

      // 1. Check for empty response.
      if (!smartEditorResponseText) {
        await updateLog(`###Smart Editor: Empty Response.`);
        transcriptManager.addEntry('user', `I was unable to understand your last response. Please try again and respond only with text. (No files were edited).`);
        continue;
      }

      // 2. Check for Tool Invocations
      // 2.1 Edit Request
      if (/^\u0040DOC\/EDIT{/m.test(smartEditorResponseText)) {
        await updateLog(`###Smart Editor attempting an edit`);

        const regex = /^\u0040DOC\/EDIT{(.*)/sim;
        const matchResult = smartEditorResponseText.match(regex);
        const docEditRequest = matchResult ? matchResult[1].trim() : '';

        const parameters = await this.extractParameters(docEditRequest, context);
        if (!parameters.success) {
          transcriptManager.addEntry('user', parameters.error);
          await updateLog(`Basic parameter extraction Error: ${parameters.error}`);
          continue;
        } else {
          const detailedParameters = await extractEditRequestParameters(
            String(parameters.params.editRequest)
          ); 

          if (!detailedParameters.success) {
            transcriptManager.addEntry('user', detailedParameters.error);
            await updateLog(`Parameter extraction Error: ${detailedParameters.error}\n${parameters.params.editRequest}`);
            continue;  
          } else {
            const editResult = editFile(
              filename,
              String(detailedParameters.params.toReplaceString),
              String(detailedParameters.params.replacementString),
              context
            );
            transcriptManager.addEntry("user", editResult, {
              documentId: filename,
              replacementIfSuperseded:
                "---FILE CONTENT INTENTIONALLY REMOVED---",
            });
            await updateLog(`Edit Request Result:\n${editResult}`);
            continue;
          }
        }
      }

      // 2.2 Revert Edits
      if (/^\u0040REVERT_FILE/m.test(smartEditorResponseText)) {
        await updateLog(`Reverting edits...`);
        let revertedString = `You requested to revert the content of '${filename}' but there isn't an earlier version available.`;
        if (originalFileContent && !isBinary) {
          context.fileMap.set(filename, originalFileContent);
          revertedString = `The following is the content of '${filename}' after your request to revert it. Please read it carefully before attempting to make further edits:`
                          + "\n---START OF FILE CONTENT---\n"
                          + originalFileContent 
                          + "\n---END OF FILE CONTENT---";
        } else if (isBinary) {
            revertedString = `Cannot revert binary file '${filename}'. The file was not modified.`;
        }
        transcriptManager.addEntry('user', revertedString, { documentId: filename, replacementIfSuperseded: '\n---FILE CONTENT INTENTIONALLY REMOVED---'});
        await updateLog(`File '${filename}' has been reverted to its previous version.`);
        continue;
      }

      // 2.3 Read Files
      if (/^\u0040DOC\/READ{/m.test(smartEditorResponseText)) {

        const regex = /^\u0040DOC\/READ{(.*)/sim;
        const matchResult = smartEditorResponseText.match(regex);
        const docReadRequest = matchResult ? matchResult[1].trim() : '';

        const fileReaderToolParameters = await fileReaderTool.extractParameters(docReadRequest, context);
        if (fileReaderToolParameters.success) {
          const fileReaderToolResult = await fileReaderTool.execute(fileReaderToolParameters.params, context);
          transcriptManager.addEntry('user', fileReaderToolResult.result, { documentId: fileReaderToolResult.transcriptReplacementID, replacementIfSuperseded: fileReaderToolResult.transcriptReplacementString});
          await updateLog(`Reading '${fileReaderToolParameters.params.filename}'`);
        } else {
          transcriptManager.addEntry('user', fileReaderToolParameters.error);
          await updateLog(`File Read Error: ${fileReaderToolParameters.error}`);
        }
      }

      // 3. Check for \u0040RETURN
      if (/^\u0040RETURN/m.test(smartEditorResponseText)) {
        await updateLog(`Smart Editor Finished`);
        done = true;
        const parts = smartEditorResponseText.split(/^\u0040RETURN/im);
        const resultString =
          parts.length > 1 ? parts.pop()?.trim() ?? undefined : undefined;
        if (!resultString)
          smartEditorResult = `Editing of '${filename}' is complete.`;
        smartEditorResult = resultString;
        break;
      }

      // 4. Not a tool or result
      transcriptManager.addEntry('user', `Your response didn't use a tool or try to return a response. Please try again. No files were changed.`);
      await updateLog(`Smart Editor response didn't use a tool or try to return a response.`);
    }

    const prefix = await getAssetString('file-content-prefix');
    const suffix = await getAssetString('file-content-suffix');

    let fileOperation = FileOperation.Edit;
    if (!context.originalFilesSet.has(filename))
      fileOperation = FileOperation.Create;
    
    // Check if the file (of any type) was deleted
    if (context.originalFilesSet.has(filename) && !context.fileMap.has(filename) && !context.binaryFileMap.has(filename)) {
      deleteFile(filename, context);
      fileOperation = FileOperation.Delete;
    } else if (context.fileMap.has(filename)) {
      // Only run analysis on text files
      await updateFileEntry(filename, context.fileMap, context.multiAgentGeminiClient);
    }

    let operationVerb = "editing";
    if (fileOperation === FileOperation.Create) {
        operationVerb = "creation";
    }
    else if (fileOperation === FileOperation.Delete) {
        operationVerb = "deletion";
    }

    let finalSmartEditResult = smartEditorResult;
    if (context.fileMap.has(filename)) {
      const finalFileContent = context.fileMap.get(filename);
      finalSmartEditResult += `\nThis is the content of the file '${filename}' after ${operationVerb} with the ${this.displayName} Tool:\n`;
      finalSmartEditResult += `${prefix}\n${finalFileContent}\n${suffix}`;
    } else if (context.binaryFileMap.has(filename)) {
        finalSmartEditResult += `\nFile '${filename}' is a binary file and was not modified.`;
    }

    await updateLog(`Smart Editor has finished.`);

    const finalFileContent = context.fileMap.get(filename);
    const finalFileIsText = context.fileMap.has(filename);

    if (finalFileIsText && (!finalFileContent || finalFileContent !== originalFileContent)) {

      if (context.saveFiles) {        
        context.sendMessage(JSON.stringify({
          status: 'APPLY_FILE_CHANGE',
          data: {
            filename: filename,
            content: Buffer.from(finalFileContent ?? '').toString('base64'),
          }
        }));
      }
    }

    const orchestratorTranscript = context.transcriptsToUpdate?.[0];
    if (orchestratorTranscript) {
      orchestratorTranscript.supersedeEntry(filename);
    }

    try {
      await updateDiffInAllTranscripts(context);
    } catch (e: any) {
      await updateLog(`Warning: Failed to update diff after edit: ${e.message}`);
    }

    const replacementString = await getAssetString('file-content-removed');
    return {
      result: finalSmartEditResult ?? `The ${this.displayName} tool has finished.`,
      transcriptReplacementID: filename,
      transcriptReplacementString: `${smartEditorResult}\n${prefix}\n${replacementString}\n${suffix}`
    };
  },

  /**
   * Extract parameters from the tool invocation string.
   * @param invocation The string used to invoke the tool.
   * @returns The parameter names and corresponding values.
   */
  async extractParameters(invocation: string, context: MultiAgentToolContext): Promise<ToolParsingResult> {
    if (!invocation ||
        !invocation.includes("TO_REPLACE") || 
        !invocation.includes("NEW_TEXT")) {
      return {
        success: false, 
        error: `Invalid syntax for the ${this.displayName} Tool. ${fixInstructions}`
      }
    }; 

    if (!invocation.includes(filenameEnd)) {
      return {
        success: false,
        error: `The ${this.displayName} attempt failed because we were not able to determine a filename. Make sure the filename is surrounded by curly brackets.`,
      }
    }

    // Truncate the invocation string at the endToken to ignore trailing characters (like '}')
    // This ensures the strict validation check below passes even if the LLM adds closing braces after the token.
    const endTokenIndex = invocation.lastIndexOf("END\u005fEDIT");
    if (endTokenIndex !== -1) {
      invocation = invocation.substring(0, endTokenIndex + "END\u005fEDIT".length);
    }

    if (!invocation.split(/\r?\n/).some(line => line.trimEnd() === this.endToken))
      return {
        success: false,
        error: await getAssetString('edit-too-big-failure')
    }

    const editRequest = invocation.split(/\r?\n/).slice(1).join('\n').trim();
    const extractedFilename = invocation.split(filenameEnd, 1)[0].trim();

    let filename;
    let isUnambiguousCreate = false;

    // We need to do a lightweight parse to find the agent's intent
    const toReplaceStart = `TO\u005fREPLACE:{`;
    const toReplaceEnd = `}\nNEW\u005fTEXT`;
    const replacementTextStart = `\nNEW\u005fTEXT:{`;
    const replacementTextEnd = '}\nEND\u005fEDIT';

    const toReplaceStartIndex = editRequest.indexOf(toReplaceStart);
    const toReplaceEndIndex = editRequest.indexOf(toReplaceEnd);
    const newTextStartIndex = editRequest.indexOf(replacementTextStart);
    const newTextEndIndex = editRequest.lastIndexOf(replacementTextEnd);

    if (toReplaceStartIndex !== -1 && toReplaceEndIndex > toReplaceStartIndex &&
        newTextStartIndex > toReplaceEndIndex && newTextEndIndex > newTextStartIndex) {
        
        const toReplaceContent = editRequest.substring(toReplaceStartIndex + toReplaceStart.length, toReplaceEndIndex);
        if (toReplaceContent.trim() === 'OVERWRITE_ENTIRE_FILE') {
            isUnambiguousCreate = true;
        }
    }
    
    // Combine all file keys for a comprehensive lookup.
    const allFilesMap = getCombinedFileMap(context.fileMap, context.binaryFileMap);

    if (isUnambiguousCreate) {
        // This is a CREATE or OVERWRITE. The file does not need to exist.
        filename = extractedFilename;
    } else {
        // This is an EDIT or a DELETE/CREATE_EMPTY. We *must* check for typos.
        filename = await fileNameLookup(extractedFilename, allFilesMap, context.multiAgentGeminiClient);
    }

    return {
      success: true, 
      params: {
        filename,
        editRequest
      }
    };
  }
};

function deleteFile(filename: string, context: MultiAgentToolContext) {
  context.fileMap.delete(filename);
  context.binaryFileMap.delete(filename);
  removeFileEntry(filename);
}

async function extractEditRequestParameters(stringToParse: string): Promise<ToolParsingResult> {
  const toReplaceStart = `TO\u005fREPLACE:{`;
  const toReplaceEnd = `}\nNEW\u005fTEXT`;
  const replacementTextStart = `\nNEW\u005fTEXT:{`;
  const replacementTextEnd = '}\nEND\u005fEDIT';

  if (!stringToParse.startsWith(toReplaceStart) || !stringToParse.includes(toReplaceEnd))
    return {
      success: false,
      error: `The editing tool couldn't find the "TO\u005fREPLACE:{}" section that provides the string to replace. This is most commonly a syntax error caused by missing the surrounding curly braces ({}) or an additional colon (:). Please check your syntax carefully before trying again.`
    }

  if (!stringToParse.includes(replacementTextStart) || !stringToParse.includes(replacementTextEnd))
    return {
      success: false,
      error: `The editing tool couldn't find the "NEW\u005fTEXT:{}" section that provides the replacement string to use. This is most commonly a syntax error caused by missing the surrounding curly braces ({}) or an additional colon (:). Please check your syntax carefully before trying again.`
    }

  const endIndex = stringToParse.lastIndexOf(replacementTextEnd);
  const fromToString = stringToParse.slice(toReplaceStart.length, endIndex);

  const fromString = fromToString.split(toReplaceEnd, 2)[0];
  const toString = fromToString.split(replacementTextStart, 2)[1];
  
  return {
    success: true,
    params: {
      toReplaceString: fromString,
      replacementString: toString,
    }
  }
};

function editFile(filename: string, fromString: string, toString: string, context: MultiAgentToolContext): string {
  let result = '';
  let worklog = '';
  let progressUpdate = '';
  const isLock = isLockFile(filename);
  const isBinary = context.binaryFileMap.has(filename);
  const fileExists = context.fileMap.has(filename);

  const isOverwrite = fromString.trim() === 'OVERWRITE_ENTIRE_FILE';
  const isAppend = fromString.trim() === 'APPEND';
  const isEmptyReplace = fromString.trim() === '';

  // Handle binary file logic first
  if (isBinary) {
    if (isOverwrite && !toString) {
        context.binaryFileMap.delete(filename);
        result = `'${filename}' has been successfully deleted.`;
        progressUpdate = result;
    } else {
        result = `The attempted edit of '${filename}' failed because it is a binary file, which cannot be edited. You can only delete binary files by using TO_REPLACE:{OVERWRITE_ENTIRE_FILE} and an empty NEW_TEXT.`;
        progressUpdate = `The attempted edit of '${filename}' failed because it is a binary file.`;
    }
    worklog = result;
  } else if (isEmptyReplace) {
    // Explicitly block the old empty bracket loophole to prevent accidental deletions/overwrites
    result = `The attempted edit of '${filename}' failed because TO_REPLACE was empty. To overwrite or delete a file, you must explicitly use TO_REPLACE:{OVERWRITE_ENTIRE_FILE}. To append to the end of a file, use TO_REPLACE:{APPEND}.`;
    progressUpdate = result;
    worklog = result;
  } else if (isOverwrite) {
    if ((toString || '').trim() === '' && fileExists) {
        context.fileMap.delete(filename);
        result = `'${filename}' has been successfully deleted.`;
        progressUpdate = result;
    } else {
        // CREATE OR OVERWRITE
        if (isLock && fileExists) {
             result = `The attempted edit of '${filename}' failed because it is a machine-generated lock file. Manual edits to existing lock files are prohibited.`;
             progressUpdate = result;
             worklog = result;
        } else {
             context.fileMap.set(filename, toString);
             result = `The requested edit of \`${filename}\` has been successfully completed.`;
             progressUpdate = `${result}\n\`\`\`\`\n${toString}\n\`\`\`\``;
        }
    }
  } else if (isAppend) {
    if (isLock) {
      result = `The attempted edit of '${filename}' failed because it is a machine-generated lock file. Manual edits to lock files are prohibited.`;
      progressUpdate = result;
      worklog = result;
    } else {
      const existingFileContent = context.fileMap.get(filename) || '';
      // Only add a newline if the file already has content
      const newContent = existingFileContent ? `${existingFileContent}\n${toString}` : toString;
      context.fileMap.set(filename, newContent);
      result = `Successfully appended new text to the end of \`${filename}\`.`;
      progressUpdate = `${result}\n\`\`\`\`\n+ ${toString}\n\`\`\`\``;
      worklog = result;
    }
  } else if (!fileExists && (fromString)) {
      result = `The file '${filename}' doesn't exist, so I can't replace an existing string within it. Make sure '${filename}' is the right filename and if so, use the OVERWRITE_ENTIRE_FILE command to apply this edit.`;
      worklog = `Smart Editor requested string replace from a file that doesn't exist.`; 
      progressUpdate = worklog;
  } else {
    if (isLock) {
      result = `The attempted edit of '${filename}' failed because it is a machine-generated lock file. Manual edits to lock files are prohibited.`;
      progressUpdate = result;
      worklog = result;
    } else {
      const existingFileContent = context.fileMap.get(filename);
      const replacementOptions = fuzzyReplace(existingFileContent ?? '', fromString, toString);

      if (!replacementOptions) {
          let editFailureString = `The attempted edit of '${filename}' failed due to an error occuring while trying to replace the string.`;
          worklog = editFailureString;
          progressUpdate = editFailureString;
          editFailureString += ` Please review the following content of '${filename}' carefully before attempting to make further edits:\n${existingFileContent}`;
          result = editFailureString;
      } else if (replacementOptions.error) {
          const editFailureString = `The attempted edit of '${filename}' failed because: ${replacementOptions.error}.`;
          worklog = editFailureString;
          progressUpdate = editFailureString;
          result = editFailureString + ` Please review the following content of '${filename}' carefully before attempting to make further edits:\n${existingFileContent}`;
      } else if (replacementOptions.modifiedString !== undefined) {
          const newFileContent = replacementOptions.modifiedString;
          if ((newFileContent || '').trim() === '' && context.fileMap.has(filename)) {
              context.fileMap.delete(filename);
              result = `'${filename}' has been successfully deleted.`;
              progressUpdate = result;
          } else {
              context.fileMap.set(filename, newFileContent);
              result = `The requested edit of '${filename}' has been successfully completed.`;
              worklog = result;

              try {
                const diff = createTwoFilesPatch(
                  `a/${filename}`,
                  `b/${filename}`,
                  existingFileContent ?? "",
                  newFileContent,
                  '',
                  '',
                  { context: 3 }
                );

                const cleanPatch = diff
                  .split('\n')
                  .filter(line => !line.startsWith('==================================================================='))
                  .join('\n');

                progressUpdate = `${result}\n\`\`\`\`\n${cleanPatch}\n\`\`\`\``;
              } catch { progressUpdate = `${result}\n\`\`\`\`\n${newFileContent}\n\`\`\`\`` }
          }
      } else if (replacementOptions.multipleMatches) { 
          worklog = `Smart Editor: The fuzzy matcher found ${replacementOptions.multipleMatches.length} possible matches for the replacement string requests for '${filename}'. Asking the Smart Replace tool to disambiguate.`;
          progressUpdate = `found ${replacementOptions.multipleMatches.length} possible matches. Disambiguating.`;
          result = `There were ${replacementOptions.multipleMatches.length} potential matches for the string you asked to replace in '${filename}'. I can only change one instance of a matching string at a time, so each request must represent a unique string. As a result, NO edit has been made to the file. Here are each of the potential matches, with additional surrounding anchor text to help disambiguate them and ensure a unique replacement string. Please review the matching strings carefully, considering the intention of your edit, and try again using additional anchor text to identify the single specific string you want to replace with this edit. If you want to replace multiple matching string, you will need to do multiple edits.`;
          let optionNumber = 1;
          replacementOptions.multipleMatches.forEach((option: any) => {
            result += `\n**Possible Matching Replacement String ${optionNumber}:**\n${option}`;
            optionNumber++;
          });
          result = result.trim();
      }
    }
  }
  context.sendMessage(JSON.stringify({
    status: 'WORK_LOG',
    message: worklog ?? result,
  }));

  context.sendMessage({
    type: 'PROGRESS_UPDATE',
    message: progressUpdate,
  });

  return result;
};