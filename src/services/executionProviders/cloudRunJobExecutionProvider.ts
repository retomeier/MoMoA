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

import { v2 } from '@google-cloud/run';
import { getStorage } from 'firebase-admin/storage';
import { randomUUID } from 'crypto';
import { ExecutionProvider, ExecutionRequest, ExecutionResponse, FilePayload } from '../executionProvider.js';
import { UNDEFINED_PROJECT_ID } from '../../cloudrun-config.js';

const { JobsClient } = v2;

export class CloudRunJobProvider implements ExecutionProvider {
    private jobsClient = new JobsClient();
    isPersistentSandbox = false;
    
    constructor(
        private projectId: string,
        private location: string,
        private jobName: string,
        private bucketName: string
    ) {
        if (projectId === UNDEFINED_PROJECT_ID)
            throw new Error("You must update the cloudrun-config.ts file with valid GCP project configuration values.");
    }

    providerName = "Cloud Run Job";

    async cleanupSandbox(): Promise<void> {
      throw new Error("Cloud Run Jobs execution environment is ephemeral. Not cleanup required.");
    }

    async stageFiles(_files: FilePayload[], _targetDir: string): Promise<void> {
      throw new Error("Cloud Run Jobs execution environment isn't interactive. Files are staged as part of execution.");    
    }

    async execute(request: ExecutionRequest): Promise<ExecutionResponse> {
        const executionId = randomUUID();
        const totalTasks = request.envs?.length || 1;
        const bucket = getStorage().bucket(this.bucketName);

        const targetDurationMs = 60000; 
        const estimatedDurationMs = request.estimatedTaskDurationMs || 60000; 
        const chunkSize = Math.max(1, Math.floor(targetDurationMs / estimatedDurationMs));

        const taskCount = Math.ceil(totalTasks / chunkSize);

        const executionPath = `executions/${executionId}`;
        const requestUri = `${executionPath}/request.json`;

        let pollingInterval: NodeJS.Timeout | undefined;

        try {
            // 1. Upload the execution request
            await bucket.file(requestUri).save(JSON.stringify(request));

            // 2. Trigger the Cloud Run Job
            const totalSeconds = Math.floor((request.timeoutMs || 600000) / 1000);
            const nanos = ((request.timeoutMs || 600000) % 1000) * 1000000;

            const jobPath = this.jobsClient.jobPath(this.projectId, this.location, this.jobName);
            const [operation] = await this.jobsClient.runJob({
                name: jobPath,
                overrides: {
                    taskCount: taskCount,
                    timeout: {
                        seconds: totalSeconds,
                        nanos: nanos
                    },
                    containerOverrides: [{
                        env: [
                            { name: 'EXECUTION_ID', value: executionId },
                            { name: 'BUCKET_NAME', value: this.bucketName },
                            { name: 'CHUNK_SIZE', value: chunkSize.toString() }
                        ]
                    }]
                }
            });

            // =========================================================
            // PATH A: SINGLE TASK (Simplified Logic)
            // =========================================================
            if (totalTasks === 1) {
                // Wait for completion
                const [executionResult] = await operation.promise();
                const isSuccessful = (executionResult.succeededCount || 0) > 0; 

                if (!isSuccessful) {
                    const completedCondition = executionResult.conditions?.find(c => c.type === 'Completed');
                    const failReason = completedCondition?.reason || 'UnknownReason';
                    const failMessage = completedCondition?.message || 'The job execution failed without a specific message.';
                    const logsUrl = executionResult.logUri || 'No logs URL available';

                    console.warn(`Execution ${executionResult.name} failed. Reason: ${failReason} - ${failMessage}: ${logsUrl}`);
                    
                    return {
                        stdout: '',
                        stderr: `Job execution failed (${failReason}): ${failMessage}`,
                        exitCode: 1, 
                        timedOut: completedCondition?.reason === "PROGRESS_DEADLINE_EXCEEDED",
                        generatedFiles: []
                    };
                }

                // Download and parse the response
                // Note: Checking both paths defensively in case the worker script 
                // outputs to task_0.json even on single runs.
                let responseBuffer;
                try {
                    [responseBuffer] = await bucket.file(`${executionPath}/response.json`).download();
                } catch {
                    [responseBuffer] = await bucket.file(`${executionPath}/results/task_0.json`).download();
                }

                const response = JSON.parse(responseBuffer.toString()) as ExecutionResponse;

                (response as any).config = request.envs?.[0] || {};

                if (request.onTaskComplete) request.onTaskComplete(response);
                
                return response;
            }

            // =========================================================
            // PATH B: MULTIPLE TASKS (Fast Polling Logic)
            // =========================================================
            const resultsPrefix = `${executionPath}/results/`;
            const processedTasks = new Set<string>();

            // Create a polling loop that resolves EARLY as soon as all tasks are processed
            const waitForResults = new Promise<ExecutionResponse>((resolve) => {
                pollingInterval = setInterval(async () => {
                    try {
                        const [files] = await bucket.getFiles({ prefix: resultsPrefix });

                        for (const file of files) {
                            if (!processedTasks.has(file.name)) {
                                processedTasks.add(file.name);

                                const [content] = await file.download();
                                const response = JSON.parse(content.toString()) as ExecutionResponse;

                                const match = file.name.match(/task_(\d+)\.json/);
                                if (match && request.onTaskComplete) {
                                    const taskIndex = parseInt(match[1], 10);
                                    (response as any).config = request.envs?.[taskIndex] || {};
                                    request.onTaskComplete(response);
                                }
                            }
                        }

                        // EARLY EXIT: All tasks reported in, skip the Job spin-down delay!
                        if (processedTasks.size === taskCount) {
                            clearInterval(pollingInterval);
                            pollingInterval = undefined;
                            resolve({
                                stdout: `Successfully processed ${processedTasks.size} parallel tasks.`,
                                stderr: '',
                                exitCode: 0,
                                timedOut: false,
                                generatedFiles: [],
                            });
                        }
                    } catch (err) {
                        console.warn(`[CloudRun] Error polling results for ${executionId}:`, err);
                    }
                }, 1000); // Polling every 2s for snappier responses
            });

            // Wait for either all results to arrive, OR the operation to finish/fail
            const operationFinished = operation.promise().then(async ([executionResult]) => {
                if (pollingInterval) clearInterval(pollingInterval);
                pollingInterval = undefined;

                // Final catch-up poll
                try {
                    const [files] = await bucket.getFiles({ prefix: resultsPrefix });
                    for (const file of files) {
                        if (!processedTasks.has(file.name)) {
                            processedTasks.add(file.name);
                            const [content] = await file.download();
                            const response = JSON.parse(content.toString()) as ExecutionResponse;

                            const match = file.name.match(/task_(\d+)\.json/);
                            if (match && request.onTaskComplete) {
                                const taskIndex = parseInt(match[1], 10);
                                (response as any).config = request.envs?.[taskIndex] || {};
                                request.onTaskComplete(response);
                            }
                        }
                    }
                } catch(e) {}

                const isSuccessful = (executionResult.succeededCount || 0) === taskCount;
                return {
                    stdout: `Successfully processed ${processedTasks.size} parallel tasks.`,
                    stderr: isSuccessful ? '' : `Job finished, but ${taskCount - (executionResult.succeededCount || 0)} tasks failed.`,
                    exitCode: isSuccessful ? 0 : 1,
                    timedOut: false,
                    generatedFiles: [],
                };
            });

            // Whichever finishes first wins, allowing the orchestrator to keep moving
            return await Promise.race([waitForResults, operationFinished]);

        } finally {
            // =========================================================
            // UNIFIED CLEANUP
            // =========================================================
            if (pollingInterval) clearInterval(pollingInterval);
            try {
                // Wipe the entire execution directory (request + all task results)
                await bucket.deleteFiles({ prefix: executionPath });
            } catch (e) {
                console.error(`[CloudRun] Failed to cleanup execution directory ${executionPath}:`, e);
            }
        }
    }
}