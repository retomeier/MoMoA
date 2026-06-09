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

import { DEFAULT_GEMINI_FLASH_MODEL } from "../config/models.js";
import { GeminiClient } from "../services/geminiClient.js";
import { getAssetString, replaceRuntimePlaceholders } from "../services/promptManager.js";
import { TranscriptManager } from "../services/transcriptManager.js";
import { removeBacktickFences, repairTruncatedJsonArray, replaceContentBetweenMarkers } from "./markdownUtils.js"; 
import { InfrastructureContext, MultiAgentToolContext } from "../momoa_core/types.js"; 
import { parseToolRequest } from "../tools/multiAgentToolParser.js";
import { executeTool, getTool } from "../tools/multiAgentToolRegistry.js";

/**
 * Defines the output structure for a file's relevance to a specific task.
 */
export interface TaskRelevantFile {
  /** The path of the file. */
  filename: string;
  /** A brief explanation of *why* this file is relevant to the *specific* task. */
  description: string;
}

/**
 * Trims all content from the response after the first valid tool call.
 * Handles nested braces and strings within the tool parameters to ensure
 * the cut is made exactly at the end of the JSON object.
 * * @param response The raw string response from the LLM.
 * @returns The response string trimmed immediately after the tool call's closing brace.
 */
function trimResponseAfterToolCall(response: string): string {
  // Find the start of the tool call: @TOOLNAME{
  const toolStartRegex = /(@[a-zA-Z0-9_]+)(\{)/;
  const match = response.match(toolStartRegex);

  // If no tool call pattern is found, return the original response
  if (!match || match.index === undefined) {
    return response;
  }

  const startIndex = match.index + match[1].length; 
  
  let braceDepth = 0;
  let inString = false;
  let isEscaped = false;

  // Iterate through the string starting from the opening brace '{'
  for (let i = startIndex; i < response.length; i++) {
    const char = response[i];

    // Handle escaped characters (e.g., \" inside a string)
    if (isEscaped) {
      isEscaped = false;
      continue;
    }
    if (char === '\\') {
      isEscaped = true;
      continue;
    }

    // Toggle string state when encountering unescaped quotes
    if (char === '"') {
      inString = !inString;
      continue;
    }

    // Only process braces if we are NOT inside a string
    if (!inString) {
      if (char === '{') {
        braceDepth++;
      } else if (char === '}') {
        braceDepth--;
        
        // If depth returns to 0, we found the closing brace of the tool parameters
        if (braceDepth === 0) {
          // Return the substring up to and including the closing brace
          return response.substring(0, i + 1);
        }
      }
    }
  }

  // If the loop finishes without finding a balanced closing brace (malformed JSON),
  // return the original response to allow downstream parsers to handle the error.
  return response;
}

/**
 * Analyzes a user's task to find relevant files and generate task-specific
 * descriptions for them using a dedicated ReAct loop.
 *
 * @param taskDescription The user's task (e.g., "Implement a new authentication endpoint").
 * @param fileMap A Map of all file paths to their string contents.
 * @param binaryFileMap A Map of all binary file paths.
 * @param multiAgentGeminiClient The Gemini client for making LLM calls.
 * @returns A promise that resolves to an array of TaskRelevantFile objects.
 */
export async function analyzeRelevantFilesForTask(
  taskDescription: string,
  assumptions: string,
  fileMap: Map<string, string>,
  binaryFileMap: Map<string, string>,
  infrastructureContext: InfrastructureContext,
  multiAgentGeminiClient: GeminiClient,
  sendMessage: (message: any) => void,
  image?: string,
  imageMimeType?: string
): Promise<TaskRelevantFile[]> {

  const updateLog = async (message: string, updateProgress: boolean = false) => {
    sendMessage(JSON.stringify({
      status: 'WORK_LOG',
      message: message,
    }));

    if (updateProgress) {
      sendMessage({
        type: 'PROGRESS_UPDATE',
        message: message,
      });
    }
  };

  const transcript = new TranscriptManager({ 
        context: infrastructureContext 
      });
  const basePrompt = await getAssetString('task-file-analyzer');
  const fileListSummary = [...fileMap.keys(), ...binaryFileMap.keys()].join('\n');
  const initialPrompt = await replaceRuntimePlaceholders(basePrompt, {
    TaskDescription: taskDescription,
    Assumptions: assumptions,
    FileSummary: fileListSummary.length > 0 ? fileListSummary : "--No files available--",
  });

  if (image && imageMimeType)
    transcript.addImage(initialPrompt, image, imageMimeType);
  else
    transcript.addEntry('user', initialPrompt);
  await updateLog("Analyzing files for relevancy to the task.", true);

  const toolContext: MultiAgentToolContext = {
    fileMap: fileMap,
    binaryFileMap: binaryFileMap,
    editedFilesSet: new Set<string>(), // Not relevant for read-only analysis
    originalFilesSet: new Set<string>([...fileMap.keys(),...binaryFileMap.keys()]),
    originalFileMap: new Map(fileMap), // Use a copy
    originalBinaryFileMap: new Map(binaryFileMap),
    sendMessage: sendMessage,
    experts: [],
    overseer: undefined,
    transcriptsToUpdate: [transcript],
    transcriptForContext: transcript,
    multiAgentGeminiClient: multiAgentGeminiClient,
    saveFileResolver: null,
    infrastructureContext: infrastructureContext,
    sessionTitle: 'File Analysis Session',
    initialPrompt: taskDescription,
    julesBranchName: null,
    saveFiles: false,
    secrets: {} as any,
    toolExecutionEnvironment: ""
  };
  
  const toolPrefix = await getAssetString('tool-prefix');
  const FINISH_TOOL_PREFIX = `${toolPrefix}TOOL_CALL:`; // Kept for the custom FINISH command
  const FINISH_REGEX = new RegExp(`${FINISH_TOOL_PREFIX}FINISH[\\{\\[](.*)[\\}\\]]`, 'sm');

  const fileContentPrefix = await getAssetString('file-content-prefix');
  const fileContentSuffix = await getAssetString('file-content-suffix');
  const urlContentPrefix = await getAssetString('url-content-prefix');
  const urlContentSuffix = await getAssetString('url-content-suffix');
  const logReplacementString = '---CONTENT INTENTIONALLY REMOVED---';

  const maxTurns = 30;
  let turns = 0;
  let isDone = false;

  await updateLog(`## File Analyzer\n`);

  while (!isDone) {
    turns++;

    if (turns > maxTurns) {
      transcript.addEntry('user', `You have run out of turns and MUST use the ${toolPrefix}TOOL_CALL:FINISH tool to return your well formatted and valid JSON array of relevant files and descriptions, even if the list isn't complete.`);
    } else if (turns > maxTurns + 2) {
      isDone = true;
      continue;
    }

    const llmMessage = await multiAgentGeminiClient.sendTranscriptMessage(
      transcript,
      { model: DEFAULT_GEMINI_FLASH_MODEL }
    );
    let rawResponse = llmMessage.text || '';

    rawResponse = await transcript.cleanLLMResponse(rawResponse);
    rawResponse = trimResponseAfterToolCall(rawResponse);
    
    await updateLog(`${rawResponse}\n`);

    const finishMatch = rawResponse.match(FINISH_REGEX);
    if (finishMatch) {
      try {
        let jsonResult = removeBacktickFences(finishMatch[1].trim());
        jsonResult = repairTruncatedJsonArray(jsonResult) || "";
        
        let relevantFiles = JSON.parse(jsonResult) as TaskRelevantFile[];

        // Ensure all returned files actually exist in the project fileMap
        const originalCount = relevantFiles.length;
        relevantFiles = relevantFiles.filter(file => fileMap.has(file.filename) || binaryFileMap.has(file.filename));

        if (relevantFiles.length < originalCount) {
          await updateLog(`(Filtered out ${originalCount - relevantFiles.length} non-existent files from analysis results)`);
        }
        
        await updateLog(`#### Potentially relevant files identified`, true);

        const formattedOutput = relevantFiles
          .map(item => `\`${item.filename}\`\n\n${item.description}`)
          .join('\n\n');

        await updateLog(`${formattedOutput}`, true);

        return relevantFiles; // Success!
      } catch (e: any) {
        const errorMsg = `TOOL_RESPONSE: Error parsing final JSON. ${e.message}. Please provide the full, correct JSON array again.`;
        transcript.addEntry('user', errorMsg);
        await updateLog(`File Analysis Error: ${errorMsg}`);
        continue;
      }
    }

    const toolRequest = await parseToolRequest(rawResponse, toolPrefix, toolContext);
    if (typeof toolRequest === 'string') {
      // Tool parsing error
      const errorMsg = `Tool Parsing Error: ${toolRequest}`;
      transcript.addEntry('user', errorMsg);
      await updateLog(errorMsg);
      continue;
    }
    
    if (toolRequest?.toolName) {
      // A standard tool was found
      const tool = getTool(toolRequest.toolName);
      await updateLog(`'${tool?.displayName || toolRequest.toolName}' Invoked`);

      try {
        // Execute the tool using the standard function
        const toolResult = await executeTool(toolRequest.toolName, toolRequest.params, toolContext);

        // Add to transcript with replacement string (for hiding content)
        transcript.addEntry('user', toolResult.result, { 
          documentId: toolResult.transcriptReplacementID, 
          replacementIfSuperseded: toolResult.transcriptReplacementString
        });
        
        // Log the result, but hide file content
        let toolResponseLogString = toolResult.result;
        toolResponseLogString = replaceContentBetweenMarkers(
          toolResponseLogString, 
          fileContentPrefix, 
          fileContentSuffix, 
          logReplacementString
        );

        // Log the result, but hide URL content
        toolResponseLogString = replaceContentBetweenMarkers(
          toolResponseLogString, 
          urlContentPrefix, 
          urlContentSuffix, 
          logReplacementString
        );
        
        await updateLog(`Tool Result:\n${toolResponseLogString}`);

      } catch (error: any) {
        const errorMessage = `Tool execution failed: ${error.message}`;
        transcript.addEntry('user', errorMessage);
        await updateLog(`Tool Error:\n${errorMessage}`);
      }
      continue;
    }

    // If no FINISH command and no standard tool was parsed, just continue.
    continue;
  }

  console.warn("Task File Analyzer reached max turns without finishing.");
  await updateLog('Reached max turns without finishing.');
  return [];
}