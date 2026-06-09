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

import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { spawn } from 'child_process';
import { Storage } from '@google-cloud/storage';

// --- Interfaces (matching your ExecutionProvider) ---
interface FilePayload {
    path: string;
    content: string; // Base64 encoded
    isBinary: boolean;
}

interface ExecutionRequest {
    command: string;
    args: string[];
    files: FilePayload[];
    envs?: NodeJS.ProcessEnv[];
    timeoutMs: number;
    memoryLimitKb?: number;
    estimatedTaskDurationMs?: number;
    chunkSize?: number;
}

interface ExecutionResponse {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
    generatedFiles: FilePayload[];
    error?: string;
    durationMs?: number;
}

const LARGE_FILE_LIMIT_KB = 100;
const MAX_CONTEXT_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

// --- Helper: Process Execution ---
const runScript = (
    cmd: string, 
    args: string[], 
    cwd: string, 
    env: NodeJS.ProcessEnv, 
    timeoutMs: number
) => {
    return new Promise<{stdout: string, stderr: string, timedOut: boolean, exitCode: number | null}>((resolve, reject) => {
        const child = spawn(cmd, args, { cwd, env });
        
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        
        const MAX_LOG_SIZE = LARGE_FILE_LIMIT_KB * 2 * 1024; 

        const appendLog = (currentLog: string, newData: string) => {
            const combined = currentLog + newData;
            return combined.length > MAX_LOG_SIZE 
                ? `[---Output Truncated Due to Length---]\n${combined.slice(-MAX_LOG_SIZE)}` 
                : combined;
        };

        child.stdout.on('data', (data) => { stdout = appendLog(stdout, data.toString()); });
        child.stderr.on('data', (data) => { stderr = appendLog(stderr, data.toString()); });

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            setTimeout(() => {
                if (!child.killed) try { child.kill('SIGKILL'); } catch (e) {}
            }, 2000);
        }, timeoutMs);

        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, timedOut, exitCode: code });
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
};

// --- Helper: Recursive Directory Scan ---
const getFilesRecursively = async (dir: string): Promise<string[]> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
        const res = path.join(dir, entry.name);
        return entry.isDirectory() ? getFilesRecursively(res) : res;
    }));
    return Array.prototype.concat(...files);
};

// --- Main Worker Logic ---
async function main() {
    console.log("Worker container starting...");

    const executionId = process.env.EXECUTION_ID;
    const bucketName = process.env.BUCKET_NAME;
    const taskIndex = parseInt(process.env.CLOUD_RUN_TASK_INDEX || '0', 10);

    // ==========================================
    // OUTER TRY: Container Initialization
    // ==========================================
    try {
        console.log(`Environment - EXECUTION_ID: ${executionId}, BUCKET_NAME: ${bucketName}, TASK_INDEX: ${taskIndex}`);

        if (!executionId || !bucketName) {
            throw new Error("Missing required environment variables: EXECUTION_ID and BUCKET_NAME");
        }

        const storage = new Storage();
        const bucket = storage.bucket(bucketName);
        const requestUri = `executions/${executionId}/request.json`;
        
        console.log(`Downloading request from gs://${bucketName}/${requestUri}...`);
        const [reqBuffer] = await bucket.file(requestUri).download();
        const request = JSON.parse(reqBuffer.toString('utf-8')) as ExecutionRequest;

        // Calculate chunk bounds
        const chunkSize = parseInt(process.env.CHUNK_SIZE || String(request.chunkSize || 1), 10);
        const totalEnvs = request.envs?.length || 1;
        const startIndex = taskIndex * chunkSize;
        const endIndex = Math.min(startIndex + chunkSize, totalEnvs);

        console.log(`Worker ${taskIndex} processing tasks ${startIndex} to ${endIndex - 1}`);

        // THE CHUNK LOOP
        for (let currentIndex = startIndex; currentIndex < endIndex; currentIndex++) {
            console.log(`--- Starting sub-task ${currentIndex} ---`);
            
            let tempDir = '';
            let taskResponse: ExecutionResponse = {
                stdout: '', stderr: '', exitCode: null, timedOut: false, generatedFiles: []
            };

            // ==========================================
            // INNER TRY: Individual Task Execution
            // ==========================================
            try {
                tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `job-run-${currentIndex}-`));
                const originalFilesMap = new Map<string, string>();

                // Stage Files
                for (const file of request.files) {
                    const destPath = path.join(tempDir, file.path);
                    
                    // Track the original content
                    originalFilesMap.set(path.normalize(file.path), file.content);
                    
                    await fs.mkdir(path.dirname(destPath), { recursive: true });
                    
                    if (file.isBinary) {
                        await fs.writeFile(destPath, Buffer.from(file.content, 'base64'));
                    } else {
                        await fs.writeFile(destPath, Buffer.from(file.content, 'base64').toString('utf8'), 'utf8');
                    }
                }

                // Execute
                const taskSpecificEnv = request.envs && request.envs.length > currentIndex ? request.envs[currentIndex] : {};
                const executionEnv = { ...process.env, ...taskSpecificEnv };
                                
                const startTime = performance.now();
                const execResult = await runScript(request.command, request.args, tempDir, executionEnv, request.timeoutMs);
                const endTime = performance.now();
                
                taskResponse.durationMs = endTime - startTime;

                taskResponse.stdout = execResult.stdout;
                taskResponse.stderr = execResult.stderr;
                taskResponse.exitCode = execResult.exitCode;
                taskResponse.timedOut = execResult.timedOut;

                // Sweep for generated files
                const allFilesInTemp = await getFilesRecursively(tempDir);
                for (const fullPath of allFilesInTemp) {
                    const relativePath = path.relative(tempDir, fullPath);
                    const baseName = path.basename(relativePath);

                    // REMOVED normalizedInputFiles.has(relativePath) from this check
                    if (baseName.startsWith('.') || relativePath.includes('__pycache__') || baseName.endsWith('.pyc') || baseName === 'target' || relativePath.startsWith('target/') || baseName === 'main_bin') continue;

                    const stats = await fs.stat(fullPath);
                    if (stats.isFile() && stats.size <= MAX_CONTEXT_FILE_SIZE_BYTES) {
                        const contentBuffer = await fs.readFile(fullPath);
                        const isBinary = contentBuffer.subarray(0, 1024).includes(0);
                        const isTooLargeForText = contentBuffer.length > (LARGE_FILE_LIMIT_KB * 1024);
                        const treatAsBinary = isBinary || isTooLargeForText;

                        // Calculate the base64 of the current state of the file
                        // (Matching your existing encoding logic for consistency)
                        const newContentBase64 = treatAsBinary 
                            ? contentBuffer.toString('base64') 
                            : Buffer.from(contentBuffer.toString('utf8')).toString('base64');
                            
                        const originalContent = originalFilesMap.get(path.normalize(relativePath));

                        // Only push if it's a new file OR the content has changed
                        if (originalContent === undefined || originalContent !== newContentBase64) {
                            taskResponse.generatedFiles.push({
                                path: relativePath,
                                content: newContentBase64,
                                isBinary: treatAsBinary
                            });
                        }
                    }
                }

            // INNER CATCH: Fails gracefully and writes error to response
            } catch (taskErr: any) {
                console.error(`Execution Error in sub-task ${currentIndex}:`, taskErr);
                taskResponse.error = taskErr.message || String(taskErr);
            
            // INNER FINALLY: Uploads this specific task's result and cleans its temp folder
            } finally {
                if (executionId && bucketName) {
                    try {
                        const responseUri = `executions/${executionId}/results/task_${currentIndex}.json`; 
                        await storage.bucket(bucketName).file(responseUri).save(JSON.stringify(taskResponse));
                        console.log(`Response uploaded for sub-task ${currentIndex}.`);
                    } catch (uploadErr) {
                        console.error(`CRITICAL: Failed to upload response for ${currentIndex}:`, uploadErr);
                    }
                }

                if (tempDir) {
                    try { await fs.rm(tempDir, { recursive: true, force: true }); } 
                    catch (e) { console.error(`Cleanup error for tempDir ${tempDir}:`, e); }
                }
            }
        } // End of chunk loop

    // OUTER CATCH: Fails the entire container if setup goes wrong
    } catch (err: any) {
        console.error("Worker Container Fatal Error Caught:", err);
        // At this level, we can't easily upload a task JSON because we might not even know the executionId
    
    // OUTER FINALLY: Container shutdown
    } finally {
        console.log("Worker container exiting cleanly.");
    }
}

main().catch((err) => {
    console.error("Fatal unhandled exception in main:", err);
    process.exit(1);
});