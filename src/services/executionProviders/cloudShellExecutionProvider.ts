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

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { 
    ExecutionProvider, 
    ExecutionRequest, 
    ExecutionResponse, 
    FilePayload
} from '../executionProvider.js';
import { LARGE_FILE_LIMIT_KB, MAX_CONTEXT_FILE_SIZE_BYTES } from '../../momoa_core/types.js';

export class CloudShellExecutionProvider implements ExecutionProvider {
    providerName = "Google Cloud Shell";
    isPersistentSandbox = false;

    constructor(
        private googleAccessToken: string,
        private gcpProjectId: string
    ) { }

    private log(message: string) {
        console.log(`[CloudShellProvider] ${new Date().toISOString()} - ${message}`);
    }

    async cleanupSandbox(): Promise<void> {

    }

    async stageFiles(_files: FilePayload[], _targetDir: string): Promise<void> {
        
    }

    async execute(request: ExecutionRequest): Promise<ExecutionResponse> {
        this.log("Starting Cloud Shell parallel execution flow...");

        const envsToRun = [...(request.envs && request.envs.length > 0 ? request.envs : [{}])];
        const totalTasks = envsToRun.length;
        
        let processedCount = 0;
        let allSucceeded = true;
        let lastError = '';
        const results: ExecutionResponse[] = new Array(totalTasks);
        let currentIndex = 0;

        const userAccessToken = this.googleAccessToken;
        const userProjectId = this.gcpProjectId;

        if (!userProjectId) {
            const errorString = `Cloud Shell Provider Error (User must specify a GCP Project with Cloud Shell Editor API enabled).`;
            this.log(errorString);
            return {
                stdout: '', stderr: '', exitCode: 1, timedOut: false, generatedFiles: [],
                error: errorString
            } as any;
        }

        let tmpConfigDir: string | undefined;
        
        // Clone process.env. We will ONLY add CLOUDSDK_CONFIG if we have an access token.
        const env: any = { ...process.env };
        
        // Disable prompts safely via env var to avoid mutating the host's global gcloud config
        env.CLOUDSDK_CORE_DISABLE_PROMPTS = '1';

        try {
            // 1. Authenticate
            if (userAccessToken) {
                this.log("Activating provided access token in isolated config...");
                tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gcloud-config-'));
                env.CLOUDSDK_CONFIG = tmpConfigDir; 
                
                const tokenFile = path.join(tmpConfigDir, 'access_token');
                await fs.writeFile(tokenFile, userAccessToken);
                await this.runCommand('gcloud', ['config', 'set', 'auth/access_token_file', tokenFile], env);
                await this.runCommand('gcloud', ['config', 'set', 'account', 'default'], env);

                this.log(`Applying project ID: ${userProjectId}`);
                await this.runCommand('gcloud', ['config', 'set', 'project', userProjectId], env);
                await this.runCommand('gcloud', ['config', 'set', 'billing/quota_project', userProjectId], env);
            } else {
                this.log("No Access Token provided. Falling back to host machine's default gcloud credentials.");
            }

            // 2. Verify Connection
            const projectMetadata = await this.runCommand('gcloud', [
                'projects', 
                'describe', 
                userProjectId
            ], env);
            
            this.log(`Active gcloud project metadata fetched successfully: ${projectMetadata}`);

            const connectionTest = await this.runCommand('gcloud', [
                'cloud-shell', 
                'ssh',
                `--project=${userProjectId}`,
                '--authorize-session',
                '--command=echo "Connected"'
            ], env);

            if (connectionTest.exitCode !== 0) {
                this.log(`Connection test failed. Stdout: ${connectionTest.stdout} Stderr: ${connectionTest.stderr}`);
                throw new Error(`Could not connect to Cloud Shell. Check stderr logs.`);
            }
            this.log("Connection verified successfully.");

            // 3. Ensure GNU 'time' is installed for memory profiling
            this.log("Checking if GNU 'time' is installed...");
            const installTimeCmd = `if [ ! -x "/usr/bin/time" ]; then sudo apt-get update && sudo apt-get install -y time; fi`;
            
            const timeInstallResult = await this.runCommand('gcloud', [
                'cloud-shell', 'ssh',
                `--project=${userProjectId}`,
                '--authorize-session',
                `--command=${installTimeCmd}`
            ], env);

            if (timeInstallResult.exitCode !== 0) {
                this.log(`Warning: Failed to install GNU 'time'. Memory profiling will fallback to defaults. Stderr: ${timeInstallResult.stderr}`);
            } else {
                this.log("GNU 'time' is ready.");
            }

            // 4. Dynamic Concurrency Scaling
            let maxCpuConcurrency = 2; 
            let vmTotalAvailableMemoryMb = 500; 

            try {
                this.log("Probing Cloud Shell hardware for dynamic concurrency scaling...");
                const probeResult = await this.runCommand('gcloud', [
                    'cloud-shell', 'ssh',
                    `--project=${userProjectId}`,
                    '--authorize-session',
                    '--command', 'echo "$(nproc) | $(awk \'/MemTotal/ {print $2}\' /proc/meminfo)"'
                ], env);

                if (probeResult.exitCode === 0 && probeResult.stdout) {
                    const [cpuStr, memKbStr] = probeResult.stdout.trim().split(' | ');
                    const nproc = parseInt(cpuStr, 10) || 1;    
                    maxCpuConcurrency = nproc * 2;
                    
                    const totalKb = parseInt(memKbStr, 10);
                    if (totalKb) {
                        vmTotalAvailableMemoryMb = Math.max(500, Math.floor(totalKb / 1024) - 500); 
                    }
                }
            } catch (err) {
                this.log(`Failed to probe VM hardware, using safe defaults. Error: ${err}`);
            }

            const taskMemoryMb = request.estimatedTaskPeakMemory || 500; 
            const maxMemoryConcurrency = Math.max(1, Math.floor(vmTotalAvailableMemoryMb / taskMemoryMb));

            // Final concurrency is the minimum of CPU-scaled limit and RAM-available limit
            const internalConcurrency = Math.min(maxCpuConcurrency, maxMemoryConcurrency);

            const activeWorkers = Math.min(internalConcurrency, totalTasks);
            this.log(`Hardware detected: ${maxCpuConcurrency / 2} vCPUs. Scaling to ${maxCpuConcurrency} task slots.`);
            this.log(`Memory available: ${vmTotalAvailableMemoryMb}MB. RAM limits concurrency to: ${maxMemoryConcurrency}`);
            this.log(`Final worker count: ${activeWorkers}`);

            // 5. Worker Pool
            const worker = async () => {
                while (currentIndex < totalTasks) {
                    const taskIndex = currentIndex++;
                    const taskEnv = envsToRun[taskIndex];

                    try {
                        const taskResponse = await this.runSingleTask(request, taskEnv, userProjectId, env);
                        
                        if (taskResponse.exitCode !== 0) {
                            allSucceeded = false;
                            if (taskResponse.error || taskResponse.stderr) {
                                lastError = taskResponse.error || taskResponse.stderr;
                            }
                        }

                        // Attach config for the Optimizer tool's grouping logic
                        (taskResponse as any).config = taskEnv;
                        
                        if (request.onTaskComplete) {
                            request.onTaskComplete(taskResponse);
                        }

                        results[taskIndex] = taskResponse;
                    } catch (err: any) {
                        allSucceeded = false;
                        lastError = err.message;
                    }
                    processedCount++;
                }
            };

            this.log(`Starting ${totalTasks} tasks using ${activeWorkers} concurrent workers.`);
            const workers = Array.from({ length: activeWorkers }, () => worker());
            await Promise.all(workers);

            if (totalTasks === 1) return results[0];

            return {
                stdout: `Successfully processed ${processedCount} tasks on Cloud Shell.`,
                stderr: allSucceeded ? '' : `One or more tasks failed. Last error: ${lastError}`,
                exitCode: allSucceeded ? 0 : 1,
                timedOut: false,
                generatedFiles: [],
            };

        } catch (err: any) {
            this.log(`ERROR: ${err.message}`);
            return {
                stdout: '', stderr: '', exitCode: 1, timedOut: false, generatedFiles: [],
                error: `Cloud Shell Provider Error: ${err.message}`
            } as any;
        } finally {
            this.log("Cleaning up global temporary directories...");
            if (tmpConfigDir) {
                await fs.rm(tmpConfigDir, { recursive: true, force: true }).catch(() => {});
            }
        }
    }

    private async runSingleTask(request: ExecutionRequest, taskEnv: Record<string, any>, userProjectId: string, env: any): Promise<any> {
        this.log("Starting Cloud Shell single task execution flow...");

        // 1. Setup local staging
        const localStagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudshell-local-run-'));
        const remoteWorkspace = `~/run_${path.basename(localStagingDir)}`;
        const normalizedInputFiles = new Set<string>();

        try {
            // 2. Stage Files locally
            this.log(`Staging ${request.files?.length ?? 0} files locally...`);
            if (request.files)
                for (const file of request.files) {
                    const destPath = path.join(localStagingDir, file.path);
                    normalizedInputFiles.add(path.normalize(file.path));
                    await fs.mkdir(path.dirname(destPath), { recursive: true });
                    await fs.writeFile(destPath, Buffer.from(file.content, 'base64'));
                }

            // 3. Upload to Cloud Shell (via tar stream over SSH)
            this.log(`Creating remote workspace folder: ${remoteWorkspace}`);
            await this.runCommand('gcloud', [
                'cloud-shell', 'ssh', 
                `--project=${userProjectId}`,
                '--authorize-session',
                '--command', `mkdir -p ${remoteWorkspace}`
            ], env);
            
            this.log("Uploading files via tar stream...");
            const uploadResult = await this.runPipeCommand(
                'tar', ['-czf', '-', '-C', localStagingDir, '.'],
                'gcloud', [
                    'cloud-shell', 'ssh',
                    `--project=${userProjectId}`,
                    '--authorize-session',
                    '--command', `tar -xzf - -C ${remoteWorkspace}`
                ],
                env
            );
            
            if (uploadResult.exitCode !== 0) {
                throw new Error(`Upload failed: ${uploadResult.stderr}`);
            }

            // 4. Execute Remote Command
            const envPrefix = Object.entries(taskEnv)
                .map(([k, v]) => `${k}='${v}'`)
                .join(' ');

            let rawCmdString = request.command;
            if (request.args)
                rawCmdString = request.command === 'sh' && request.args[0] === '-c' 
                    ? request.args[1] 
                    : `${request.command} ${request.args.join(' ')}`;
            
            // Base64 encode the script to avoid SSH quoting/escaping nightmares
            const scriptContent = Buffer.from(`${envPrefix} ${rawCmdString}`).toString('base64');
            
            // Write the script remotely and execute it wrapped in GNU time
            const fullRemoteCommand = `cd ${remoteWorkspace} && ` +
                `echo "${scriptContent}" | base64 -d > .task.sh && ` +
                `if [ -x "/usr/bin/time" ]; then /usr/bin/time -v bash .task.sh; else bash .task.sh; fi`;

            this.log(`Executing remote command: ${request.command}`);
            const sshArgs = [
                'cloud-shell', 'ssh',
                `--project=${userProjectId}`,
                '--authorize-session',
                `--command=${fullRemoteCommand}`
            ];

            const startTime = Date.now();
            const execResult = await this.runCommand('gcloud', sshArgs, env, request.timeoutMs);
            const durationMs = Date.now() - startTime;
            
            this.log(`Execution finished with exit code: ${execResult.exitCode}`);
            
            // Extract peak memory from stderr
            let cleanStderr = execResult.stderr;
            let peakMemory: number | undefined;

            const memoryMatch = cleanStderr.match(/Maximum resident set size \(kbytes\):\s+(\d+)/);
            if (memoryMatch && memoryMatch[1]) {
                const peakMemoryKb = parseInt(memoryMatch[1], 10);
                peakMemory = Math.ceil((peakMemoryKb / 1024) * 1.2); // 20% safety buffer
                
                // Scrub the GNU time output from the logs
                cleanStderr = cleanStderr.replace(/Command being timed:[\s\S]*?(?=Exit status|$)/i, '').trim();
            }

            const response: ExecutionResponse = {
                stdout: execResult.stdout,
                stderr: cleanStderr,
                exitCode: execResult.exitCode,
                timedOut: execResult.timedOut,
                durationMs: durationMs,
                peakMemory: peakMemory,
                generatedFiles: []
            };

            // 5. Download and Sweep Results
            const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudshell-results-'));
            this.log("Downloading generated files for sweeping...");
            
            await this.runPipeCommand(
                'gcloud', [
                    'cloud-shell', 'ssh',
                    `--project=${userProjectId}`,
                    '--authorize-session',
                    '--command', `tar -czf - -C ${remoteWorkspace} .`
                ],
                'tar', ['-xzf', '-', '-C', downloadDir],
                env
            );

            const allFiles = await this.getFilesRecursively(downloadDir);
            for (const fullPath of allFiles) {
                const relativePath = path.relative(downloadDir, fullPath);
                const baseName = path.basename(relativePath);

                if (normalizedInputFiles.has(path.normalize(relativePath)) || 
                    baseName.startsWith('.') || 
                    relativePath.includes('__pycache__') || 
                    baseName === 'target' || 
                    relativePath.startsWith('target/') || 
                    baseName === 'main_bin') continue;

                const stats = await fs.stat(fullPath);
                if (stats.isFile() && stats.size <= MAX_CONTEXT_FILE_SIZE_BYTES) {
                    const contentBuffer = await fs.readFile(fullPath);
                    const isBinary = contentBuffer.subarray(0, 1024).includes(0);
                    const isTooLarge = contentBuffer.length > (LARGE_FILE_LIMIT_KB * 1024);
                    
                    response.generatedFiles.push({
                        path: relativePath,
                        content: contentBuffer.toString('base64'),
                        isBinary: isBinary || isTooLarge
                    });
                }
            }
            this.log(`Sweep complete. Found ${response.generatedFiles.length} new files.`);

            // 6. Remote Cleanup
            this.log("Cleaning up remote workspace...");
            await this.runCommand('gcloud', [
                'cloud-shell', 'ssh',
                `--project=${userProjectId}`,
                '--authorize-session',
                '--command', `rm -rf ${remoteWorkspace}`
            ], env);

            return response;

        } catch (err: any) {
            this.log(`ERROR: ${err.message}`);
            return {
                stdout: '', stderr: '', exitCode: 1, timedOut: false, generatedFiles: [],
                error: `Cloud Shell Provider Error: ${err.message}`
            } as any;
        } finally {
            this.log("Cleaning up local temporary directories...");
            if (localStagingDir) {
                await fs.rm(localStagingDir, { recursive: true, force: true }).catch(() => {});
            }
        }
    }

    private runCommand(cmd: string, args: string[], env: any, timeoutMs: number = 120000) {
        return new Promise<{stdout: string, stderr: string, timedOut: boolean, exitCode: number | null}>((resolve, reject) => {
            const child = spawn(cmd, args, { env });
            let stdout = '', stderr = '', timedOut = false;
            
            const MAX_LOG_SIZE = LARGE_FILE_LIMIT_KB * 2 * 1024;
            const appendLog = (currentLog: string, newData: string) => {
                const combined = currentLog + newData;
                return combined.length > MAX_LOG_SIZE ? `[---Truncated---]\n${combined.slice(-MAX_LOG_SIZE)}` : combined;
            };

            child.stdout.on('data', (d) => { stdout = appendLog(stdout, d.toString()); });
            child.stderr.on('data', (d) => { stderr = appendLog(stderr, d.toString()); });

            const timer = setTimeout(() => {
                timedOut = true;
                this.log(`Command timed out after ${timeoutMs}ms. Killing process...`);
                child.kill('SIGTERM');
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
    }

    private runPipeCommand(cmd1: string, args1: string[], cmd2: string, args2: string[], env: any, timeoutMs: number = 120000) {
        return new Promise<{stdout: string, stderr: string, timedOut: boolean, exitCode: number | null}>((resolve, reject) => {
            const child1 = spawn(cmd1, args1, { env });
            const child2 = spawn(cmd2, args2, { env });
            
            let stdout = '', stderr = '', timedOut = false;

            const MAX_LOG_SIZE = LARGE_FILE_LIMIT_KB * 2 * 1024;
            const appendLog = (currentLog: string, newData: string) => {
                const combined = currentLog + newData;
                return combined.length > MAX_LOG_SIZE ? `[---Truncated---]\n${combined.slice(-MAX_LOG_SIZE)}` : combined;
            };

            // Stream source stdout to destination stdin
            child1.stdout.pipe(child2.stdin);
            
            child2.stdout.on('data', (d) => { stdout = appendLog(stdout, d.toString()); });
            child2.stderr.on('data', (d) => { stderr = appendLog(stderr, d.toString()); });
            child1.stderr.on('data', (d) => { stderr = appendLog(stderr, `[Source] ${d.toString()}`); });

            const timer = setTimeout(() => {
                timedOut = true;
                this.log(`Pipe command timed out after ${timeoutMs}ms. Killing processes...`);
                child1.kill('SIGTERM');
                child2.kill('SIGTERM');
            }, timeoutMs);

            child2.on('close', (code) => {
                clearTimeout(timer);
                resolve({ stdout, stderr, timedOut, exitCode: code });
            });
            child2.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
            child1.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    private async getFilesRecursively(dir: string): Promise<string[]> {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const files = await Promise.all(entries.map(async (entry) => {
            const res = path.join(dir, entry.name);
            return entry.isDirectory() ? this.getFilesRecursively(res) : res;
        }));
        return Array.prototype.concat(...files);
    }
}