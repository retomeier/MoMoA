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

import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { SimpleGit, simpleGit } from 'simple-git';
import {
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_LITE_MODEL,
} from '../config/models.js';
import { GeminiClient } from '../services/geminiClient.js';
import { getAssetString, getExpertPrompt, replaceRuntimePlaceholders } from '../services/promptManager.js';
import { TranscriptManager } from '../services/transcriptManager.js';
import { ServerMode, UserSecrets } from '../shared/model.js';
import { PROJECT_DIFF_ID } from '../tools/implementations/revertFileTool.js';
import { parseToolRequest } from '../tools/multiAgentToolParser.js';
import { executeTool, getTool } from '../tools/multiAgentToolRegistry.js';
import { generateDiff, generateDiffString } from '../utils/diffGenerator.js';
import { getFAQs } from '../utils/faqs.js';
import { analyzeAndSetTaskRelevantFiles, analyzeFiles, getTaskRelevantFileDescriptions } from '../utils/fileAnalysis.js';
import { removeBacktickFences, replaceContentBetweenMarkers } from '../utils/markdownUtils.js';
import { enrichPrompt } from '../utils/promptEnrichment.js';
import { Overseer } from './overseer.js';
import { MultiAgentToolContext, ToolConfirmationOutcome, GuidanceType, InfrastructureContext, ToolExecutionEnvironmentType } from './types.js';
import { WorkPhase } from './workPhase.js';
import { LlmBlockedError } from '../shared/errors.js';
import { generateSessionTitle } from '../utils/sessionTitleGenerator.js';
import { withDeadline } from '../utils/timeoutHelper.js';
import { CleanFormattedDateTime } from '../utils/dateTimeStrings.js';

const EXISTING_FILES_ID = "EXISTING_FILES_ID";
const EXISTING_FAQ_ID = "EXISTING_FAQ_ID";
const PROJECT_DEFINITION_ID = 'project-definition';
const FORCE_NO_HITL = false;

/**
 * The Orchestrator class manages the multi-agent system,
 * coordinating interactions between different experts and tools.
 */
export class Orchestrator {
  private originalFileMap: Map<string, string>;
  private originalBinaryFileMap: Map<string, string>;
  private transcriptManager: TranscriptManager;
  private infrastructureContext: InfrastructureContext;
  private multiAgentGeminiClient: GeminiClient;
  private sendMessage: (message: any) => void;
  private fileMap: Map<string, string>;
  private binaryFileMap: Map<string, string>; 
  private editedFileList: Set<string>;
  private originalFilesSet: Set<string>;
  private initialPrompt: string;
  private initialImage?: string;
  private initialImageMimeType?: string;
  private overseer: Overseer | undefined;
  private assumptions: string;
  private projectSpecification?: string;
  private environmentInstructions?: string;
  private notWorkingBuild?: boolean;
  private maxTurns: number;
  private toolContext: MultiAgentToolContext;
  private hitlResolver: ((response: string) => void) | null = null;
  private saveFiles: boolean; 
  private sessionTitle: string;
  private signal?: AbortSignal;
  private mode?: ServerMode;
  private startTime: number = 0;
  private maxDurationMs?: number;
  private gracePeriodMs?: number;
  private hasWarnedTimeLow: boolean = false;
  private toolExecutionEnvironment: string;

  /**
   * Initializes a new instance of the Orchestrator.
   * @param initialPrompt The initial prompt for the orchestrator.
   * @param initialImage Optional Base64 encoded image data associated with the initial prompt.
   * @param initialImageMimeType Optional MIME type of the attached image.
   * @param fileMap A map where keys are file paths and values are file contents.
   * @param binaryFileMap A map for binary file contents.
   * @param multiAgentGeminiClient An instance of MultiAgentGeminiClient for LLM communication.
   * @param sendMessage A callback function to send messages to the UI or other components.
   * @param assumptions Assumptions provided for the agent
   * @param baseModelName The base model name for the session.
   * @param secrets User secrets containing API keys.
   * @param signal Optional AbortSignal for cancellation.
   */
  constructor(
    initialPrompt: string,
    initialImage: string | undefined,
    initialImageMimeType: string | undefined, 
    fileMap: Map<string, string>,
    binaryFileMap: Map<string, string>, 
    multiAgentGeminiClient: GeminiClient,
    sendMessage: (message: any) => void,
    assumptions: string,
    _baseModelName: string = DEFAULT_GEMINI_FLASH_MODEL, 
    saveFiles: boolean,
    private secrets: UserSecrets,
    infrastructureContext: InfrastructureContext, 
    sessionTitle: string = 'Untitled Session',
    projectSpecification?: string, 
    environmentInstructions?: string,
    notWorkingBuild?: boolean,
    signal?: AbortSignal,
    mode?: ServerMode,
    maxDurationMs?: number,
    gracePeriodMs?: number,
    toolExecutionEnvironment?: string,
  ) {
    this.initialPrompt = initialPrompt;
    this.initialImage = initialImage;
    this.initialImageMimeType = initialImageMimeType;
    this.fileMap = fileMap;
    this.originalFileMap = new Map(fileMap);
    this.binaryFileMap = binaryFileMap; 
    this.originalBinaryFileMap = new Map(binaryFileMap);
    this.editedFileList = new Set<string>();
    this.originalFilesSet = new Set<string>([...fileMap.keys(), ...binaryFileMap.keys()]); 
    this.multiAgentGeminiClient = multiAgentGeminiClient;
    this.sendMessage = sendMessage;
    this.assumptions = assumptions;
    this.infrastructureContext = infrastructureContext;
    this.projectSpecification = projectSpecification; 
    this.environmentInstructions = environmentInstructions;
    this.notWorkingBuild = notWorkingBuild;
    this.transcriptManager = new TranscriptManager({ context: infrastructureContext });
    this.overseer = undefined;
    this.maxTurns = 20;
    this.signal = signal;
    this.saveFiles = saveFiles;
    this.sessionTitle = sessionTitle;

    this.signal?.addEventListener('abort', () => {
      this.updateLog('Orchestrator received abort signal from user.');
      this.sendMessage({
        type: 'PROGRESS_UPDATE',
        message: '# Project shutdown initiated',
      });
    });

    this.mode = mode;

    this.maxDurationMs = maxDurationMs ?? undefined; 
    this.gracePeriodMs = gracePeriodMs ?? undefined;

    this.toolExecutionEnvironment = toolExecutionEnvironment ?? ToolExecutionEnvironmentType.Local;

    this.toolContext = {
      fileMap: this.fileMap,
      binaryFileMap: this.binaryFileMap,
      editedFilesSet: this.editedFileList,
      originalFilesSet: this.originalFilesSet,
      originalFileMap: this.originalFileMap,
      originalBinaryFileMap: this.originalBinaryFileMap,
      sendMessage: this.sendMessage,
      experts: [],
      overseer: this.overseer,
      transcriptsToUpdate: [this.transcriptManager],
      transcriptForContext: this.transcriptManager,
      multiAgentGeminiClient: this.multiAgentGeminiClient,
      saveFileResolver: null,
      infrastructureContext: this.infrastructureContext,
      julesBranchName: null,
      julesSessionSummaries: [],
      saveFiles: this.saveFiles,
      initialPrompt: this.initialPrompt,
      initialImage: this.initialImage,
      initialImageMimeType: this.initialImageMimeType,
      assumptions: this.assumptions,
      secrets: this.secrets,
      projectSpecification: this.projectSpecification,
      environmentInstructions: this.environmentInstructions,
      notWorkingBuild: this.notWorkingBuild,
      toolExecutionEnvironment: this.toolExecutionEnvironment,
      sessionTitle: this.sessionTitle,
    };
  }


  public resolveHitl(response: string): void {
    if (this.hitlResolver) {
      this.hitlResolver(response);
      this.hitlResolver = null;
    } else if (this.overseer) {
      // If no HITL is pending, treat the message as unsolicited user input
      // and inject it as Overseer guidance.
      this.overseer.forceGuidance(response);
    }
  }

  // Simplified resolver method, no messageId needed.
  public resolveSaveFile(outcome: ToolConfirmationOutcome): void {
    if (this.toolContext.saveFileResolver) {
      this.toolContext.saveFileResolver(outcome);
      this.toolContext.saveFileResolver = null;
    }
  }

  private async updateProgressLog(message: string | Promise<string>) {
    this.sendMessage({
      type: 'PROGRESS_UPDATE',
      message: message,
    });
  }

  private async updateLog(message: string, updateOverseerLog: boolean = true) {
    this.sendMessage(JSON.stringify({
      status: 'WORK_LOG',
      message: message,
    }));

    if (updateOverseerLog && this.overseer)
      this.overseer.addLog(message);
  }

  private async generateProjectSummary(): Promise<{result: string; retrospective: string; feedback: string}> {
    let response;

    this.updateLog(`Generating Project Summary.`)

    // Get the string containing all the files and docs
    const fileListString = (this.editedFileList?.size && Array.from(this.editedFileList).join('\n')) 
                           || '--No Files Created or Edited';

    const orchestratorResultPrompt = await replaceRuntimePlaceholders(
      await getAssetString('orchestrator-result-prompt'),
      { EditedFiles: fileListString });
    const retrospectivePrompt = await getAssetString('summarize-project-work-prompt');
    const userFeedbackPrompt = await getAssetString('provide-user-feedback-prompt');

    this.transcriptManager.addEntry('user', orchestratorResultPrompt);
    response = await this.multiAgentGeminiClient.sendTranscriptMessage(
      this.transcriptManager, 
      { model: DEFAULT_GEMINI_LITE_MODEL, signal: this.signal }
    );
    let result = response.text || '--- No Result Provided ---';
    result = await this.transcriptManager.cleanLLMResponse(result);

    this.transcriptManager.addEntry('user', retrospectivePrompt);
    response = await this.multiAgentGeminiClient.sendTranscriptMessage(
      this.transcriptManager, 
      { model: DEFAULT_GEMINI_LITE_MODEL, signal: this.signal }
    );
    let retrospective = response.text || '--- No Retrospective Provided ---';
    retrospective = await this.transcriptManager.cleanLLMResponse(retrospective);

    this.transcriptManager.addEntry('user', userFeedbackPrompt);
    response = await this.multiAgentGeminiClient.sendTranscriptMessage(
      this.transcriptManager, 
      { model: DEFAULT_GEMINI_LITE_MODEL, signal: this.signal }
    );
    let feedback = response.text || '--- No Feedback Provided ---';
    feedback = await this.transcriptManager.cleanLLMResponse(feedback);
    
    return {result: result, retrospective: retrospective, feedback: feedback};
  }

  private async summarizeOrchestratorUpdate(lastOrchestratorResponse: string): Promise<string> {
    let current_status_message = "Trying to solve this problem."

    const completed_status_message_prompt = await replaceRuntimePlaceholders(await getAssetString("summarize-progress-start"), {
      LastOrchestratorResponse: lastOrchestratorResponse
    });
    
    try {
      current_status_message = (await this.multiAgentGeminiClient.sendOneShotMessage(
        completed_status_message_prompt,
        { model: DEFAULT_GEMINI_LITE_MODEL, signal: this.signal }
      ))?.text || current_status_message;
    } catch (_error) {
      // Intentionally empty: error during summarization should not halt the orchestrator
    }

    return current_status_message;
  }

  /**
   * Runs the orchestrator loop.
   */
  public async run(): Promise<void> {
    this.startTime = Date.now();

    this.toolContext.projectDeadlineMs = this.maxDurationMs ? (this.startTime + (this.maxDurationMs)) : undefined;
    this.toolContext.gracePeriodMs = this.gracePeriodMs;
    this.hasWarnedTimeLow = false;

    const sessionTitle = await generateSessionTitle(this.initialPrompt.trim(), this.multiAgentGeminiClient) ?? "New Task";
    this.sessionTitle = sessionTitle;
    this.toolContext.sessionTitle = sessionTitle;
    this.updateProgressLog(`# ${sessionTitle}\n`);
    this.updateProgressLog("## Agentic Loop Initialization");


    try {
      const prefix = await getAssetString('file-content-prefix');
      const suffix = await getAssetString('file-content-suffix');
      const urlPrefix = await getAssetString('url-content-prefix');
      const urlSuffix = await getAssetString('url-content-suffix');
      const logReplacementString = '---FILE CONTENT INTENTIONALLY REMOVED---';
      
      // Reset the per-job values.
      this.editedFileList.clear();
      this.transcriptManager = new TranscriptManager({ context: this.infrastructureContext });
      this.toolContext.transcriptsToUpdate = [this.transcriptManager];
      this.toolContext.transcriptForContext = this.transcriptManager;

      // Instantiate Overseer
      const OVERSEER_FREQUENCY_MINS = 15;
      this.overseer = await Overseer.createAndStart(OVERSEER_FREQUENCY_MINS * 60 * 1000, this.assumptions, this.multiAgentGeminiClient);
      this.toolContext.overseer = this.overseer;
      this.updateProgressLog(`Initiating Project Overseer with ${OVERSEER_FREQUENCY_MINS} minute frequency.`)

      if (this.maxDurationMs)
        this.updateProgressLog(`This deployment is limited to ${(this.maxDurationMs / 60 / 1000)} minutes per task session.`);
      else 
        this.updateProgressLog(`This deployment doesn't have a time limit per task.`);
      
      let { preamble } = await getExpertPrompt('orchestrator');
      preamble = await replaceRuntimePlaceholders(preamble,
        {
          Assumptions: this.assumptions,
          MaxWorkphases: String(this.maxTurns)
        }
      )

      this.transcriptManager.addEntry('user', preamble);

      const welcomeMessagePrompt = await getAssetString('welcome-message-prompt');
      const welcomeMessage = welcomeMessagePrompt.split('\n')[1];

      try {
        const welcomeMessagePromise = this.multiAgentGeminiClient.sendOneShotMessage(
          welcomeMessagePrompt,
          { model: DEFAULT_GEMINI_LITE_MODEL, signal: this.signal }
        ).then(msg => msg.text || welcomeMessage);

        this.sendMessage({
          type: 'PROGRESS_UPDATE',
          message: welcomeMessagePromise,
        });
      } catch {
        console.log("Error creating welcome message.");
      }
      
      if (this.mode && this.mode != ServerMode.ORCHESTRATOR)
        await this.updateLog(`# Mode: ${this.mode}`);        

      let uploadFilesLog = `Uploaded Files:\n`;
      if (this.fileMap.size > 0) {
        uploadFilesLog += '* ' + Array.from(this.fileMap.keys()).join('\n* ');
        uploadFilesLog += "\n";
      }
      if (this.binaryFileMap.size > 0) 
        uploadFilesLog += '* ' + Array.from(this.binaryFileMap.keys()).join('\n* ')

      uploadFilesLog = uploadFilesLog.trim();

      await this.updateLog(uploadFilesLog, false);

      if ((this.binaryFileMap.size + this.fileMap.size) > 0)
        this.updateProgressLog(uploadFilesLog);

      // Enrich the initial prompt.
      this.updateProgressLog('\n## Enriched Research User Prompt\n----');

      // Research Project-specific prompt
      // const researchPrompt = await replaceRuntimePlaceholders(await getAssetString("researcher_enricher"), {
      //   ResearchProblem : this.initialPrompt.trim()
      // });
      // this.initialPrompt = researchPrompt;

      const recommendations = await enrichPrompt("prompt-enricher", this.initialPrompt.trim(), this.assumptions, this.projectSpecification ?? "---No specification provided---", this.multiAgentGeminiClient, this.sendMessage, this.initialImage, this.initialImageMimeType);

      const dateTimeString = CleanFormattedDateTime(new Date());
      this.initialPrompt = `${recommendations}\n\nThe current date and time is: ${dateTimeString}`;

      this.updateProgressLog(`\`\`\`\`\n${this.initialPrompt}\n\`\`\`\``);
      this.updateProgressLog('----\n');

      await this.updateLog(`# Enriched SDLC Agent Task Request:\n${this.initialPrompt}`);

      this.updateProgressLog("## Attachment Analysis")

      this.sendMessage({
        type: 'PROGRESS_UPDATE',
        message: '### Checking for an attached image',
      });

      // Add any image that was attached.
      if (this.initialImageMimeType && this.initialImage) {
        this.transcriptManager.addImage(`The user has provided the following image that has been attached to their prompt.`, this.initialImage, this.initialImageMimeType);
        await this.updateLog(`\n# Added the attached ${this.initialImageMimeType}`);
        this.updateProgressLog(`Added image prompt attachement: ${this.initialImageMimeType}`);
      } else {
        await this.updateLog(`\n# No Image Attachment Provided`);
      }

      // Now we're going to add the existing FAQs
      let faqString = "### Expert Answers to Frequently Asked Questions:\n";
      faqString += "--No FAQS have been added--";
      this.transcriptManager.addEntry('user', faqString, { documentId: EXISTING_FAQ_ID, replacementIfSuperseded: faqString });

      // Analyze the files
      this.updateProgressLog("### Analyzing provided project files")
      await analyzeFiles(this.fileMap, this.multiAgentGeminiClient);

      await analyzeAndSetTaskRelevantFiles(
        this.initialPrompt,
        this.assumptions,
        this.fileMap,
        this.binaryFileMap,
        this.infrastructureContext,
        this.multiAgentGeminiClient,
        this.sendMessage,
        this.initialImage,
        this.initialImageMimeType
      );

      // Add the files
      const existingFilesString = `# ${getTaskRelevantFileDescriptions()}\n\n**Binary File Summary:**\n* ${this.binaryFileMap.size} binary files.`;

      this.transcriptManager.addEntry('user', existingFilesString, { documentId: EXISTING_FILES_ID, replacementIfSuperseded: existingFilesString });

      const initialDiffBlock = generateDiffString(this.toolContext, true);
      this.transcriptManager.addEntry(
        'user',
        initialDiffBlock,
        { documentId: PROJECT_DIFF_ID, replacementIfSuperseded: initialDiffBlock }
      );

      // Now add the project definition
      const initialProjectDefinition = `# Project Definition\n${this.initialPrompt}`;
      this.transcriptManager.addEntry('user', initialProjectDefinition, { documentId: PROJECT_DEFINITION_ID, replacementIfSuperseded: initialProjectDefinition });

      let isDone = false;
      let turnCount = 1;
      const maxOrchestratorTurns = this.maxTurns*4;

      this.updateProgressLog("\n## Primary Orchestration loop")

      while (!isDone) {
        if (this.signal?.aborted) {
          await this.updateLog('Exiting Orchestrator.');

          this.sendMessage({
            type: 'PROGRESS_UPDATE',
            message: '## Cancelling Project\n\nThe Orchestrator has received a cancellation request. Shutting down.'
          });

          isDone = true;
          await this.endOrchestrator();
          continue;
        }

        const now = Date.now();
        if (this.toolContext.projectDeadlineMs && this.toolContext.gracePeriodMs) {
          const timeRemaining = this.toolContext.projectDeadlineMs - now;

          // Hard Deadline: Out of time, force shut down immediately
          if (timeRemaining <= 0) {
            await this.updateLog('Hard time limit reached. Forcing Orchestrator shutdown.');
            this.sendMessage({
              type: 'PROGRESS_UPDATE',
              message: '## Time Limit Exceeded\n\nThe allocated time for this run has expired. Shutting down.'
            });
            isDone = true;
            await this.endOrchestrator();
            continue;
          } 
          // Soft Deadline: Under grace period mins, force wrap-up
          else if (timeRemaining <= this.toolContext.gracePeriodMs && !this.hasWarnedTimeLow) {
            this.hasWarnedTimeLow = true;
            const timeWarning = `CRITICAL WARNING: The project environment will force shut down within the next 3 turns. You MUST immediately cease starting new work phases and return your final output using @RETURN.`;
            
            this.transcriptManager.addEntry('user', timeWarning);
            await this.updateLog(`# Time Warning Triggered:\n${timeWarning}`, false);
            this.updateProgressLog(`\n### System Alert\nApproaching time limit. Forcing completion.`);
          }
        }

        turnCount++;

        this.toolContext.transcriptForContext = this.transcriptManager;

        // Refresh the file list in the Orchestrator's transcript
        const updatedFilesString = `# ${getTaskRelevantFileDescriptions()}\n\nBinary File Summary:\n* ${this.binaryFileMap.size} binary files.`;
        this.transcriptManager.replaceEntry(
          EXISTING_FILES_ID,
          updatedFilesString
        );
        
        // Refresh the FAQ list in the Orchestrator's transcript
        let updatedFaqString = "### Expert Answers to Frequently Asked Questions:\n";
        updatedFaqString += getFAQs();// "--No FAQS have been added--"; // Placeholder
        this.transcriptManager.replaceEntry(
          EXISTING_FAQ_ID,
          updatedFaqString
        );
        
        // *** NEW: Refresh the diff block in the Orchestrator's transcript ***
        const newDiffBlock = generateDiffString(this.toolContext, true);
        this.transcriptManager.replaceEntry(
          PROJECT_DIFF_ID,
          newDiffBlock
        );

        if (turnCount > maxOrchestratorTurns + 1) {
          this.transcriptManager.addEntry('user', `You have run out of turns and MUST return a final output. You must NOT start any new Work Phases. You must now provide your best response to try and solve the project definition you were assigned.`);
        }
        else if (turnCount > maxOrchestratorTurns + 2) {
          isDone = true;
          await this.endOrchestrator();
          continue;
        }

        // Check for Overseer Feedback first
        const feedback = this.overseer?.peekPendingFeedback();
        if (feedback) {
          this.overseer?.commitAndClearPendingFeedback(feedback);
          switch (feedback.action) {
            case 'RESTART':
              this.updateLog(`Overseer has ordered a RESTART with guidance.`, false);
              this.sendMessage({
                type: 'PROGRESS_UPDATE',
                message: `\n### Overseer\nThe Overseer has ordered a restart. Resetting state and restarting the project.`,
              });

              // 1. Revert all files to their original state
              this.fileMap = new Map(this.originalFileMap);
              this.binaryFileMap = new Map(this.originalBinaryFileMap);
              this.editedFileList.clear();

              // 2. Re-point the toolContext to the fresh maps
              this.toolContext.fileMap = this.fileMap;
              this.toolContext.binaryFileMap = this.binaryFileMap;
              this.toolContext.editedFilesSet = this.editedFileList;

              // 3. Clear the Orchestrator transcript
              this.transcriptManager = new TranscriptManager({ context: this.infrastructureContext });
              this.toolContext.transcriptForContext = this.transcriptManager;
              this.toolContext.transcriptsToUpdate = [];

              // 4. Re-add the orchestrator's preamble
              // 'preamble' is from earlier in the run() method
              this.transcriptManager.addEntry('user', preamble);

              // 5. Re-add the (now original) file list
              const originalFilesString = `# ${getTaskRelevantFileDescriptions() ?? "--No files available--"}\n\nBinary File Summary:\n* ${this.binaryFileMap.size} binary files.`;
              this.transcriptManager.addEntry('user', originalFilesString, { documentId: EXISTING_FILES_ID, replacementIfSuperseded: originalFilesString });
              
              // 6. Re-add the FAQ list
              // 'faqString' is from earlier in the run() method
              this.transcriptManager.addEntry('user', faqString, { documentId: EXISTING_FAQ_ID, replacementIfSuperseded: faqString });
              
              const emptyDiffBlock = generateDiffString(this.toolContext, true);
              this.transcriptManager.addEntry(
                'user',
                emptyDiffBlock,
                { documentId: PROJECT_DIFF_ID, replacementIfSuperseded: emptyDiffBlock }
              );

              // 7. Append the Overseer's restart guidance
              const restartGuidance = `The project has been RESTARTED by the Overseer. You MUST follow this new guidance:\n${feedback.guidance}`;
              this.transcriptManager.addEntry('user', restartGuidance);
              
              // 8. Re-add the initial project definition
              this.transcriptManager.addEntry('user', `\n**Project Definition:**\n${this.initialPrompt}`);
              
              // 9. Reset the turn count
              turnCount = 1;

              // 10. Clear the overseer's log for the new run
              this.overseer?.clearWorklog();
              
              // 11. Continue to the next loop iteration, skipping the rest of this turn
              continue;

            case 'GUIDE':
              if (feedback.guidance && feedback.type === GuidanceType.ForcedUserGuidance) {
                const heading = '\n\n**Correction / Clarification:**';
                const newBullet = `\n* ${feedback.guidance}`;

                if (this.toolContext.initialPrompt.includes(heading)) {
                  this.toolContext.initialPrompt += newBullet;
                } else {
                  this.toolContext.initialPrompt += `${heading}${newBullet}`;
                }

                // Update the transcript entry for the project definition
                const updatedProjectDefinition = `# Project Definition\n${this.toolContext.initialPrompt}`;
                this.transcriptManager.replaceEntry(PROJECT_DEFINITION_ID, updatedProjectDefinition);
              }

              // This is the logic that was already in place
              const guidanceMessage = `${feedback.reasoning}${feedback.guidance ? `\nGuidance: ${feedback.guidance}` : ''}`;
              this.transcriptManager.addEntry('user', `Overseer Feedback:\n${guidanceMessage}`);
              this.updateLog(`# Overseer Feedback:\n${guidanceMessage}`, false);

              this.updateProgressLog(`\n### Overseer\n${guidanceMessage}`);
              break; // Break and continue the loop to let the LLM see the guidance

            case 'ABANDON':
              // As defined in the overseer prompt, this is a catastrophic action
              this.updateLog('The overseer has decided to abandon the project.', false);
              this.sendMessage({
                type: 'PROGRESS_UPDATE',
                message: '\n### Overseer\nThe project overseer has abandoned the project.',
              });
              isDone = true; // This will terminate the `while (!isDone)` loop
              continue; // Skip the rest of this turn

            case 'CONTINUE':
            default:
              // For 'CONTINUE', just log the reasoning (if any) and clear the log
              const continueMessage = `Overseer Feedback:\n${feedback.reasoning}`;
              this.updateLog(`# ${continueMessage}`, false);
              this.updateProgressLog(`\n### Overseer\n${continueMessage}`);
              break; // Break and continue the loop
          }
        }

        const response = await this.multiAgentGeminiClient.sendTranscriptMessage(
          this.transcriptManager, 
          { model: DEFAULT_GEMINI_FLASH_MODEL, signal: this.signal }
        );

        let responseText = response.text || '';
        responseText = await this.transcriptManager.cleanLLMResponse(responseText);

        await this.updateLog(`\n# Orchestrator\n${responseText}`)

        if (!responseText) {
          this.transcriptManager.addEntry('user', `I wasn't able to see your response to my last message.`);
          continue;
        }

        const statusMessagePromise = this.summarizeOrchestratorUpdate(responseText)
          .then(msg => `\n### Orchestrator (Turn ${turnCount-1})\n${msg}`);
        this.updateProgressLog(statusMessagePromise);


        // 1. Check for \u0040STARTWORKPHASE
        if (/^\u0040STARTWORKPHASE/m.test(responseText)) {
          const parts = responseText.split(/^\u0040STARTWORKPHASE/im);
          let workPhaseTask = parts.length > 1 ? parts.pop()?.trim() ?? undefined : undefined;
          if (workPhaseTask) {
            workPhaseTask = removeBacktickFences(workPhaseTask);
            this.updateLog(`Starting new Work Phase:\n${workPhaseTask}`); // Log start of Work Phase

            const filesEditedBeforeWorkPhase = new Set(this.editedFileList);


            const workPhase = new WorkPhase(
              workPhaseTask ?? "No Task Defined",
              this.initialPrompt,
              responseText,
              this.assumptions,
              this.overseer,
              this.toolContext,
              this.maxTurns,
              this.signal,
            );
            try {
              const {result, retrospective } = await workPhase.run();

              for (const filename of this.editedFileList) {
                if (!filesEditedBeforeWorkPhase.has(filename)) {
                  this.transcriptManager.supersedeEntry(filename);
                  this.updateLog(`Orchestrator context updated: Entry for '${filename}' was marked as stale after Work Phase modification.`);
                }
              }

              const workPhaseResult = `The Work Phase has completed the task you assigned it and has returned the following result:\n${result}`;
              this.transcriptManager.addEntry('user', workPhaseResult);
              this.updateLog(`Work Phase result:\n${result}`);

              let taskOutcome = "---Unspecified---";
              let nextSteps = "---Unspecified---";
              let positiveObservations = "---Unspecified---";

              if (retrospective) {
                let retrospectiveText;
                try {
                  const retrospectiveObject = JSON.parse(retrospective.trim());

                  taskOutcome = retrospectiveObject.key_outcome_achieved ?? '---None---';
                  nextSteps = retrospectiveObject.recommended_direct_next_steps ?? '---None---';
                  positiveObservations = retrospectiveObject.positive_aspects ?? "---None---";

                  retrospectiveText = `**Task Outcome:**
${retrospectiveObject.key_outcome_achieved} We have **${retrospectiveObject.confidence_score}** confidence that the task was successfully completed.

**Recommended Next Steps from the Work Phase:
${retrospectiveObject.recommended_direct_next_steps || '--None--'}

**Task Completion Observations:
Difficulties encountered and unresolved issues:
${retrospectiveObject.difficulties_or_unresolved_issues_within_task || '--None--'}

Other notes and observations from the Work Phase:
${retrospectiveObject.other_pertinent_notes || '--None--'}`.trim();

                } catch (error: unknown) {
                  retrospectiveText = retrospective;
                  this.updateLog(`Error parsing Work Phase retrospective: ${error instanceof Error ? error.message : String(error)}`);
                }

                const workPhaseRetrospective = `The following is a retrospective of the work done by the experts who completed the task:\n${retrospectiveText}`;
                this.transcriptManager.addEntry('user', workPhaseRetrospective);
                this.updateLog(`Work Phase retrospective:\n${retrospectiveText}`);
              }

              let updateText = "I can't summarize what happened. Sorry!";
              const completed_status_message_prompt = await replaceRuntimePlaceholders(await getAssetString("summarize-progress-done"), {
                LastOrchestratorResponse: workPhaseResult,
                TaskOutcome: taskOutcome,
                NextSteps: nextSteps,
                PositiveObservations: positiveObservations
              });
              try {
                updateText = (await this.multiAgentGeminiClient.sendOneShotMessage(
                  completed_status_message_prompt,
                  { model: DEFAULT_GEMINI_LITE_MODEL, signal: this.signal }
                ))?.text || await statusMessagePromise;
              } catch (_error) {
              }

              updateText = `This Work Phase is complete. ${updateText}`

              this.sendMessage({
                type: 'PROGRESS_UPDATE',
                message: updateText
              });

            } catch (error: unknown) {
              const errorMessage = `An Error happened within the Work Phase: ${error instanceof Error ? error.message : String(error)}`;
              this.transcriptManager.addEntry('user', errorMessage);
              this.updateLog(errorMessage);
            }
          } else {
            const errorMessage = `Attempted to start a new Work Phase but couldn't find a task to complete.`;
            this.transcriptManager.addEntry('user', errorMessage);
            this.updateLog(errorMessage);
          }
          continue;
        }

        // 2. Check for Tool Invocations
        const toolRequest = await parseToolRequest(responseText, await getAssetString('tool-prefix'), this.toolContext);

        if (typeof toolRequest === 'string') {
          this.updateLog(`Tool identifier found but parsing error: ${toolRequest}`);
          this.transcriptManager.addEntry('user', toolRequest);
          continue;
        } else
        if (toolRequest?.toolName) {
          const tool = getTool(toolRequest.toolName);

          await this.updateLog(`Invoking Tool: '${tool?.displayName}' with parameters:\n${JSON.stringify(toolRequest.params)}`);
          this.updateProgressLog(`\n### '${tool?.displayName}' Invoked`);

          try {
            const toolResult = await withDeadline(
              executeTool(toolRequest.toolName, toolRequest.params, this.toolContext),
              this.toolContext.projectDeadlineMs,
              this.signal
            );
            
            this.transcriptManager.addEntry('user', toolResult.result, { documentId: toolResult.transcriptReplacementID, replacementIfSuperseded: toolResult.transcriptReplacementString});
            
            let toolResponseLogString = toolResult.result;
            toolResponseLogString = replaceContentBetweenMarkers(toolResponseLogString, prefix, suffix, logReplacementString);
            toolResponseLogString = replaceContentBetweenMarkers(toolResponseLogString, urlPrefix, urlSuffix, logReplacementString);
                      
            await this.updateLog(`Tool Result:\n${toolResponseLogString}`);

            let toolResultArray = toolResult.result.trim().split('\n');
            toolResultArray = toolResultArray.slice(1,-1);
            if (toolResultArray[0].startsWith("---"))
              toolResultArray = toolResultArray.slice(1,-1);
          } catch (error: unknown) {
            const errorMessage = `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`;
            this.transcriptManager.addEntry('user', errorMessage);
            this.updateLog(`Tool Error:\n${errorMessage}`);
            this.sendMessage({
              type: 'PROGRESS_UPDATE',
              message: `The ${tool?.displayName} tool failed with the following error:\n${errorMessage}`,
            });
          }
          continue;
        }

        // 3. Check for HitL
        if (/^\u0040HITL{/m.test(responseText)) {
          const parts = responseText.split(/^\u0040HITL{/im);
          let hitlQuestion = parts.length > 1 ? parts.pop()?.trim() ?? undefined : undefined;

          if (hitlQuestion) {
            let hitlResponse = "Use your best judgement.";
            if (!FORCE_NO_HITL) {
              hitlQuestion = hitlQuestion.trim().slice(0, -1).trim();
              // Create a promise and store its resolver in our class property.
              const hitlPromise = new Promise<string>((resolve) => {
                this.hitlResolver = resolve;
              });

              // Send the question to the UI, no ID needed.
              this.sendMessage(JSON.stringify({
                status: 'HITL_QUESTION',
                message: hitlQuestion,
              }));
              this.updateLog(`Waiting for user response to HitL question...`);
              
              // Pause the orchestrator's run loop until the promise is resolved.
              hitlResponse = await hitlPromise;
            }

            this.sendMessage({
              type: 'PROGRESS_UPDATE',
              message: `Thinking about your answer...`,
            });

            this.updateLog(`HITL response:\n${hitlResponse}`);
            this.transcriptManager.addEntry('user', hitlResponse);
          }
          continue;
        }

        // 4. Check for \u0040RETURN
        if (/^\u0040RETURN/m.test(responseText)) {
          isDone = true;
          await this.endOrchestrator();
          continue;
        }

        // 5. Handle one-sided conversations.
        this.transcriptManager.addEntry('user', 'Thanks! You have to use a tool, start a workphase or return a result.'); 
        this.updateLog(`Orchstrator didn't invoke a tool, start a workphase, or return a result`);
      }
    } catch (error: unknown) {
      if (error instanceof LlmBlockedError) {
        await this.emergencyShutdown(error.message);
      } else {
        // Re-throw other errors if they are critical and not handled by emergencyShutdown
        throw error;
      }
    }
  }

  private async emergencyShutdown(reason: string) {
    this.updateLog(`\n# Orchestrator Emergency Shutdown: ${reason}`);
    if (this.overseer)
      this.overseer.stop();

    if (this.toolContext.julesBranchName) {
      const branchName = this.toolContext.julesBranchName;
      this.updateLog(`Session complete. Cleaning up Jules scratchpad branch: ${branchName}`);
      const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'jules-cleanup-'));
      try {
        const git: SimpleGit = simpleGit(tempDir);
        const GITHUB_TOKEN = this.secrets.githubToken || process.env.GITHUB_TOKEN;
        if (!GITHUB_TOKEN) {
            throw new Error('GITHUB_TOKEN environment variable not set. It is required for private repositories.');
        }
        const scratchpadRepoUrl = `https://${GITHUB_TOKEN}@github.com/${this.secrets.githubScratchPadRepo}.git`;
        await git.clone(scratchpadRepoUrl, tempDir);
        
        await git.push(['origin', '--delete', branchName]);
        this.updateLog(`Successfully deleted remote branch: ${branchName}`);
      } catch (error: any) {
        this.updateLog(`Warning: Failed to delete Jules scratchpad branch '${branchName}': ${error.message}`);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }

    // Fallback Summary Generation (No LLM calls)
    const result = `Project execution was halted due to a critical API failure: ${reason}`;
    const retrospective = `The Orchestrator encountered a non-recoverable error (${reason}) indicating the LLM API was blocked or unavailable for an extended period. All execution was stopped immediately to ensure a graceful exit and resource cleanup. No further work was performed.`;
    const feedback = `The system performed an emergency shutdown. Please check the LLM API status and retry the project later.`;

    // 1. Calculate total time
    const endTime = Date.now();
    const totalTimeMs = endTime - (this.startTime || endTime); 
    const totalTimeSeconds = (totalTimeMs / 1000).toFixed(2);

    // 2. Get token usage
    const tokenUsage = this.multiAgentGeminiClient.getTokenUsage();
    let tokenUsageXml = '';
    if (tokenUsage.size === 0) {
      tokenUsageXml = '    <models>No token usage data available.</models>';
    } else {
      for (const [model, stats] of tokenUsage.entries()) {
        tokenUsageXml += `
    <model name="${model}">
      <inputTokens>${stats.inputTokens}</inputTokens>
      <outputTokens>${stats.outputTokens}</outputTokens>
      <cachedInputTokens>${stats.cachedInputTokens}</cachedInputTokens>
    </model>`;
      }
    }

    // 3. Create summary.xml content
    const summaryXmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<summary>
  <executionTime totalMs="${totalTimeMs}" totalSeconds="${totalTimeSeconds}">${totalTimeSeconds} seconds</executionTime>
  <content>
    <result><![CDATA[${result}]]></result>
    <retrospective><![CDATA[${retrospective}]]></retrospective>
    <feedback><![CDATA[${feedback}]]></feedback>
  </content>
  <tokenUsage>
${tokenUsageXml.trim()}
  </tokenUsage>
</summary>
    `;

    // Create combined maps for diff generation
    const binaryFilePlaceholder = "[binary file content]";
    const combinedOriginalFileMap = new Map<string, string>([
        ...this.originalFileMap,
        ...Array.from(this.originalBinaryFileMap.keys()).map(key => [key, binaryFilePlaceholder] as [string, string])
    ]);
    const combinedFinalFileMap = new Map<string, string>([
        ...this.fileMap,
        ...Array.from(this.binaryFileMap.keys()).map(key => [key, binaryFilePlaceholder] as [string, string])
    ]);

    const allBinaryFiles = new Set([
        ...this.originalBinaryFileMap.keys(),
        ...this.binaryFileMap.keys()
    ]);

    const diffString = generateDiff(
        combinedOriginalFileMap, 
        combinedFinalFileMap, 
        this.editedFileList,
        allBinaryFiles,
        false
    );

    const filesToSend = [{
        name: 'project.diff',
        content: Buffer.from(diffString).toString('base64'),
    }];

    filesToSend.push({
      name: 'summary.xml',
      content: Buffer.from(summaryXmlContent).toString('base64'),
    });

    for (const filename of this.editedFileList) {
      // 1. ALWAYS send binary files.
      // Diffs cannot patch binary files reliably, so we must send the full file 
      // content to the client to overwrite/create the file directly.
      if (this.binaryFileMap.has(filename)) {
        const fileContent = this.binaryFileMap.get(filename) || '';
        filesToSend.push({
          name: filename,
          content: fileContent, // content is already base64 in binaryFileMap
        });
      } 
      // 2. ONLY send text files if saveFiles is true.
      // Otherwise, the client relies on applying 'project.diff' for text changes.
      else if (this.saveFiles && this.fileMap.has(filename)) {
        const fileContent = this.fileMap.get(filename) || '';
        filesToSend.push({
          name: filename,
          content: Buffer.from(fileContent).toString('base64'),
        });
      }
    }

    const filesPayload = JSON.stringify(filesToSend);

    this.sendMessage(JSON.stringify({
      status: 'COMPLETE_RESULT',
      data: {
        result: result,
        retrospective: retrospective,
        feedback: feedback,
        files: filesPayload
      },
    }));
  }

  private async endOrchestrator() {
    await this.updateLog(`\n# Orchestrator is finshed.`); // Log Orchestrator completion
    this.updateProgressLog(`### Orchestrator\nOrchestration loop has completed.`)
    if (this.overseer) {
      this.updateProgressLog("Shutting down Overseer.");
      this.overseer.stop(); // Stop the Overseer when the Orchestrator is done
    }

    // Jules scratchpad cleanup logic
    if (this.toolContext.julesBranchName) {
      const branchName = this.toolContext.julesBranchName;
      await this.updateLog(`Session complete. Cleaning up Jules scratchpad branch: ${branchName}`);
      this.updateProgressLog(`Removing ephemeral GitHub Scratchpad \`${branchName}\``);
      const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'jules-cleanup-'));
      try {
        // We need a local clone to issue the remote delete command
        const git: SimpleGit = simpleGit(tempDir);
        const GITHUB_TOKEN = this.secrets.githubToken || process.env.GITHUB_TOKEN;
        if (!GITHUB_TOKEN) {
            throw new Error('GITHUB_TOKEN environment variable not set. It is required for private repositories.');
        }
        const scratchpadRepoUrl = `https://${GITHUB_TOKEN}@github.com/${this.secrets.githubScratchPadRepo}.git`;
        await git.clone(scratchpadRepoUrl, tempDir);
        
        await git.push(['origin', '--delete', branchName]);
        this.updateLog(`Successfully deleted remote branch: ${branchName}`);
      } catch (error: any) {
        // Log the error but don't stop the orchestrator from finishing
        this.updateLog(`Warning: Failed to delete Jules scratchpad branch '${branchName}': ${error.message}`);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }

    const {result, retrospective, feedback } = await this.generateProjectSummary();

    this.updateProgressLog(`\n## Project Result Summary\n${retrospective}`);

    // 1. Calculate total time
    const endTime = Date.now();
    // Use startTime, fallback to endTime if startTime wasn't set (e.g., if run() failed early)
    const totalTimeMs = endTime - (this.startTime || endTime); 
    const totalTimeSeconds = (totalTimeMs / 1000).toFixed(2);

    // 2. Get token usage (this requires the GeminiClient modification)
    const tokenUsage = this.multiAgentGeminiClient.getTokenUsage();
    let tokenUsageXml = '';
    if (tokenUsage.size === 0) {
      tokenUsageXml = '    <models>No token usage data available.</models>';
    } else {
      // --- THIS LOOP IS UPDATED ---
      // It now reads all three stats properties from the map
      for (const [model, stats] of tokenUsage.entries()) {
        tokenUsageXml += `
    <model name="${model}">
      <inputTokens>${stats.inputTokens}</inputTokens>
      <outputTokens>${stats.outputTokens}</outputTokens>
      <cachedInputTokens>${stats.cachedInputTokens}</cachedInputTokens>
    </model>`;
      }
    }

    // 3. Create summary.xml content
    // We use <![CDATA[...]]> to safely embed text that might contain XML characters.
    const summaryXmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<summary>
  <executionTime totalMs="${totalTimeMs}" totalSeconds="${totalTimeSeconds}">${totalTimeSeconds} seconds</executionTime>
  <content>
    <result><![CDATA[${result}]]></result>
    <retrospective><![CDATA[${retrospective}]]></retrospective>
    <feedback><![CDATA[${feedback}]]></feedback>
  </content>
  <tokenUsage>
${tokenUsageXml.trim()}
  </tokenUsage>
</summary>
    `;

    // Create combined maps for diff generation to include binary files.
    // Use a placeholder for binary content as we only care about file existence/path for the diff.
    const binaryFilePlaceholder = "[binary file content]"; // Define a non-empty placeholder
    const combinedOriginalFileMap = new Map<string, string>([
        ...this.originalFileMap,
        ...Array.from(this.originalBinaryFileMap.keys()).map(key => [key, binaryFilePlaceholder] as [string, string])
    ]);
    const combinedFinalFileMap = new Map<string, string>([
        ...this.fileMap,
        ...Array.from(this.binaryFileMap.keys()).map(key => [key, binaryFilePlaceholder] as [string, string])
    ]);

    const allBinaryFiles = new Set([
        ...this.originalBinaryFileMap.keys(),
        ...this.binaryFileMap.keys()
    ]);

    const diffString = generateDiff(
        combinedOriginalFileMap, 
        combinedFinalFileMap, 
        this.editedFileList,
        allBinaryFiles,
        false
    );

    const filesToSend = [{
        name: 'project.diff',
        content: Buffer.from(diffString).toString('base64'),
    }];

    filesToSend.push({
      name: 'summary.xml',
      content: Buffer.from(summaryXmlContent).toString('base64'),
    });

    for (const filename of this.editedFileList) {
      // 1. ALWAYS send binary files.
      // Diffs cannot patch binary files reliably, so we must send the full file 
      // content to the client to overwrite/create the file directly.
      if (this.binaryFileMap.has(filename)) {
        const fileContent = this.binaryFileMap.get(filename) || '';
        filesToSend.push({
          name: filename,
          content: fileContent, // content is already base64 in binaryFileMap
        });
      } 
      // 2. ONLY send text files if saveFiles is true.
      // Otherwise, the client relies on applying 'project.diff' for text changes.
      else if (this.saveFiles && this.fileMap.has(filename)) {
        const fileContent = this.fileMap.get(filename) || '';
        filesToSend.push({
          name: filename,
          content: Buffer.from(fileContent).toString('base64'),
        });
      }
    }

    const filesPayload = JSON.stringify(filesToSend);

    this.sendMessage(JSON.stringify({
      status: 'COMPLETE_RESULT',
      data: {
        result: result,
        retrospective: retrospective,
        feedback: feedback,
        files: filesPayload
      },
    }));
  }
}