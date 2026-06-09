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
import { randomUUID } from 'crypto';
import { 
    LARGE_FILE_LIMIT_KB, 
    MAX_CONTEXT_FILE_SIZE_BYTES } from '../../momoa_core/types.js';

export class CloudWorkstationsExecutionProvider implements ExecutionProvider {
    providerName = "Google Cloud Workstations";
    isPersistentSandbox = false;

    public region?: string;
    public cluster?: string;
    public config?: string;
    public tempWorkspaceFolder: string;
    
    private env: any = { ...process.env };
    private localStagingDir: string | undefined;

    constructor(
        private googleAccessToken: string,
        private gcpProjectId: string,
        private workstationName: string,
        providePersistentSandbox: boolean = false
    ) {
        // Disable prompts safely via env var to avoid mutating the host's global gcloud config
        this.env.CLOUDSDK_CORE_DISABLE_PROMPTS = '1';
        this.isPersistentSandbox = providePersistentSandbox;

        const runId = randomUUID().split('-')[0];
        this.tempWorkspaceFolder = `/tmp/workstation_sandbox_${runId}`;
     }

    async cleanupSandbox(): Promise<void> {
        // 1. Remote Cleanup
        try {
            this.log("Cleaning up remote workspace...");
            await this.runCommand('gcloud', [
                'workstations', 'ssh', this.workstationName,
                `--project=${this.gcpProjectId}`,
                `--region=${this.region}`,
                `--cluster=${this.cluster}`,
                `--config=${this.config}`,
                '--command', `rm -rf ${this.tempWorkspaceFolder}`
            ], this.env);
        } catch (error: any) {
            this.log(`Error cleaning up remote sandbox: ${error.message}`);
        } finally {
            // 2. Trigger Local Cleanup
            await this.cleanupLocalDirectories();
        }
    }

    private async cleanupLocalDirectories(): Promise<void> {
        this.log("Cleaning up local temporary directories...");
        const cleanupTasks: Promise<void>[] = [];

        if (this.localStagingDir) {
            cleanupTasks.push(
                fs.rm(this.localStagingDir, { recursive: true, force: true })
                  .catch((err) => this.log(`Warning: Failed to remove local staging dir: ${err.message}`))
            );
        }
        
        // Wait for all local cleanup tasks to finish
        await Promise.all(cleanupTasks);
        
        // Reset the state
        this.localStagingDir = undefined;
    }

    private workstationDetailsResolved(): boolean {
        let resolved:boolean = false;
        
        if (this.region && this.cluster && this.config)
            resolved = true;

        console.log(`Resolved ${resolved}`);
        return resolved;
    }

    public async resolveWorkstationDetails(env: any): Promise<void> {
        this.log(`Searching project ${this.gcpProjectId} for workstation: ${this.workstationName}...`);
        
        // We use a filter to find the exact workstation across all regions/clusters
        const listResult = await this.runCommand('gcloud', [
            'workstations', 'list',
            `--project=${this.gcpProjectId}`,
            `--filter=name:/workstations/${this.workstationName}`,
            // '--format=value(name)' // Returns the fully qualified resource path
            `--format=json`
        ], env);

        this.log(listResult.stdout);
        this.log(listResult.stderr);

        if (listResult.exitCode !== 0 || !listResult.stdout.trim()) {
            throw new Error(`Could not find workstation '${this.workstationName}' in project '${this.gcpProjectId}'. Ensure the name is correct and the auth token has 'workstations.workstations.list' permissions.`);
        }

        // The output looks like this:
        // projects/MY_PROJECT/locations/us-central1/workstationClusters/dev-cluster/workstationConfigs/my-config/workstations/alice-ws
        const fullPath = listResult.stdout.trim();
        const parts = fullPath.split('/');

        // Extract the variables based on their fixed positions in the GCP resource string
        this.region = parts[3];
        this.cluster = parts[5];
        this.config = parts[7];

        this.log(`Resolved details - Region: ${this.region}, Cluster: ${this.cluster}, Config: ${this.config}`);
    }

    private log(message: string) {
        console.log(`[CloudWorkstationsProvider] ${new Date().toISOString()} - ${message}`);
    }

    private async connectToWorkstation(): Promise<boolean> {
        const env = this.env;
        const userProjectId = this.gcpProjectId;
        const userAccessToken = this.googleAccessToken;
        let tmpConfigDir: string | undefined;
        
        // 2. Authenticate
        if (userAccessToken) {
            this.log("Activating provided access token in isolated config...");
            tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gcloud-config-'));
            this.env.CLOUDSDK_CONFIG = tmpConfigDir; 
            
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

        // 3. Ensure Workstation is Running
        this.log("Checking workstation state...");
        const stateResult = await this.runCommand('gcloud', [
            'workstations', 'describe', this.workstationName,
            `--project=${userProjectId}`,
            `--region=${this.region}`,
            `--cluster=${this.cluster}`,
            `--config=${this.config}`,
            '--format=value(state)'
        ], env);

        const state = stateResult.stdout.trim();
        this.log(`Current workstation state: ${state || 'UNKNOWN'}`);

        if (state !== 'STATE_RUNNING') {
            this.log("Workstation is not running. Initiating startup (this may take a few minutes)...");
            const startResult = await this.runCommand('gcloud', [
                'workstations', 'start', this.workstationName,
                `--project=${userProjectId}`,
                `--region=${this.region}`,
                `--cluster=${this.cluster}`,
                `--config=${this.config}`
            ], env, 300000); // 5 minute timeout to allow for cluster spin-up

            if (startResult.exitCode !== 0) {
                throw new Error(`Failed to start workstation: ${startResult.stderr}`);
            }
            this.log("Workstation started successfully.");
        }

        // 4. Verify Connection
        const connectionTest = await this.runCommand('gcloud', [
            'workstations', 
            'ssh',
            this.workstationName,
            `--project=${userProjectId}`,
            `--region=${this.region}`,
            `--cluster=${this.cluster}`,
            `--config=${this.config}`,
            '--command=echo "Connected"'
        ], env);

        if (connectionTest.exitCode !== 0) {
            this.log(`Connection test failed.\nStdout: ${connectionTest.stdout}\nStderr: ${connectionTest.stderr}`);
            throw new Error(`Could not connect to Cloud Workstation. Check stderr logs.`);
        }
        this.log("Connection verified successfully.");
        return true;
    }

    async stageFiles(files: FilePayload[], targetDir: string): Promise<void> {
        console.log("Staging Files...");
        const env = this.env;

        if (!this.workstationDetailsResolved()) {
            await this.resolveWorkstationDetails(this.env);

            if (!this.gcpProjectId || !this.region || !this.cluster || !this.config || !this.workstationName) {
                const errorString = `Cloud Workstations Provider Error: Missing required connection parameters:
    Region: ${this.region ? "Provided" : "Missing"}
    Cluster: ${this.cluster ? "Provided" : "Missing"}
    `.trim();
                this.log(errorString);
                throw new Error(errorString);
            }
        }

        await this.connectToWorkstation();

        if (!this.localStagingDir || !this.isPersistentSandbox)
            this.localStagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workstations-local-run-'));


        const remoteWorkspace = path.join(this.tempWorkspaceFolder, targetDir);
        const localStagingDir = await fs.mkdtemp(this.localStagingDir);
        const originalFilesMap = new Map<string, string>();

        // 5. Stage Files locally
        this.log(`Staging ${files?.length ?? 0} files locally...`);
        if (files)
            for (const file of files) {
                const destPath = path.join(localStagingDir, file.path);
                originalFilesMap.set(path.normalize(file.path), file.content);
                await fs.mkdir(path.dirname(destPath), { recursive: true });
                await fs.writeFile(destPath, Buffer.from(file.content, 'base64'));
            }

        // 6. Upload to Cloud Workstation (via tar stream over SSH)
        this.log(`Creating remote workspace folder: ${remoteWorkspace}`);
        await this.runCommand('gcloud', [
            'workstations', 'ssh', this.workstationName,
            `--project=${this.gcpProjectId}`,
            `--region=${this.region}`,
            `--cluster=${this.cluster}`,
            `--config=${this.config}`,
            '--command', `mkdir -p ${remoteWorkspace}`
        ], env);
        
        this.log("Uploading files via tar stream...");
        const uploadResult = await this.runPipeCommand(
            'tar', ['-czf', '-', '-C', localStagingDir, '.'],
            'gcloud', [
                'workstations', 'ssh', this.workstationName,
                `--project=${this.gcpProjectId}`,
                `--region=${this.region}`,
                `--cluster=${this.cluster}`,
                `--config=${this.config}`,
                '--command', `tar -xzf - -C ${remoteWorkspace}`
            ],
            env
        );
        
        if (uploadResult.exitCode !== 0) {
            throw new Error(`Upload failed: ${uploadResult.stderr}`);
        }
    }

    async execute(request: ExecutionRequest): Promise<ExecutionResponse> {
        this.log("Starting Cloud Workstations parallel execution flow...");

        this.env = { ...process.env };
        const env = this.env;

        const envsToRun = [...(request.envs && request.envs.length > 0 ? request.envs : [{}])];
        const totalTasks = envsToRun.length;
        
        let processedCount = 0;
        let allSucceeded = true;
        let lastError = '';
        const results: ExecutionResponse[] = new Array(totalTasks);
        let currentIndex = 0;

        const userAccessToken = this.googleAccessToken;
        const userProjectId = this.gcpProjectId;

        if (!userProjectId || !this.workstationName) {
            const errorString = `Cloud Workstations Provider Error. Missing required connection parameters:
ProjectId: ${userProjectId ? "Provided" : "Missing"}
AccessToken: ${userAccessToken ? "Provided" : "Missing"}
Workstation Name: ${this.workstationName ? "Provided" : "Missing"}
`.trim();
            this.log(errorString);
            return {
                stdout: '', stderr: '', exitCode: 1, timedOut: false, generatedFiles: [],
                error: errorString
            } as any;
        }

        // // Disable prompts safely via env var to avoid mutating the host's global gcloud config
        // env.CLOUDSDK_CORE_DISABLE_PROMPTS = '1';

        // // 3. Resolve Missing Routing Parameters dynamically
        if (!this.workstationDetailsResolved())
           await this.resolveWorkstationDetails(env);

        if (!userProjectId || !this.region || !this.cluster || !this.config || !this.workstationName) {
            const errorString = `Cloud Workstations Provider Error (Missing required connection parameters):
Region: ${this.region ? "Provided" : "Missing"}
Cluster: ${this.cluster ? "Provided" : "Missing"}
`.trim();
            this.log(errorString);
            return {
                stdout: '', stderr: '', exitCode: 1, timedOut: false, generatedFiles: [],
                error: errorString
            } as any;
        }

            await this.connectToWorkstation();

            // 4.5 Ensure GNU 'time' is installed for memory profiling
            this.log("Checking if GNU 'time' is installed...");
            const installTimeCmd = `if [ ! -x "/usr/bin/time" ]; then sudo apt-get update && sudo apt-get install -y time; fi`;
            
            const timeInstallResult = await this.runCommand('gcloud', [
                'workstations', 'ssh', this.workstationName,
                `--project=${userProjectId}`,
                `--region=${this.region}`,
                `--cluster=${this.cluster}`,
                `--config=${this.config}`,
                `--command=${installTimeCmd}`
            ], env);

            if (timeInstallResult.exitCode !== 0) {
                this.log(`Warning: Failed to install GNU 'time'. Memory profiling will fallback to defaults. Stderr: ${timeInstallResult.stderr}`);
            } else {
                this.log("GNU 'time' is ready.");
            }

            let maxCpuConcurrency = 2; 
            let vmTotalAvailableMemoryMb = 500; 

            try {
                this.log("Probing Workstation hardware for dynamic concurrency scaling...");
                const probeResult = await this.runCommand('gcloud', [
                    'workstations', 'ssh', this.workstationName,
                    `--project=${userProjectId}`,
                    `--region=${this.region}`,
                    `--cluster=${this.cluster}`,
                    `--config=${this.config}`,
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

        const worker = async () => {
            while (currentIndex < totalTasks) {
                const taskIndex = currentIndex++;
                const taskEnv = envsToRun[taskIndex];

                try {
                    // Call the renamed original method for a single task execution
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
            stdout: `Successfully processed ${processedCount} tasks on workstation.`,
            stderr: allSucceeded ? '' : `One or more tasks failed. Last error: ${lastError}`,
            exitCode: allSucceeded ? 0 : 1,
            timedOut: false,
            generatedFiles: [],
        };
    }

    private async runSingleTask(request: ExecutionRequest, taskEnv: Record<string, any>, userProjectId: string, env: any): Promise<any> {
        this.log("Starting Cloud Workstations execution flow...");

        // 1. Setup local staging
        // const localStagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workstations-local-run-'));
        const remoteWorkspace = '';//this.tempWorkspaceFolder; //`~/run_${path.basename(localStagingDir)}`;
        const originalFilesMap = new Map<string, string>();

        let downloadDir: string | undefined;

        try {
            await this.stageFiles(request.files || [], remoteWorkspace);

            // 7. Execute Remote Command
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
            const fullRemoteCommand = `cd ${this.tempWorkspaceFolder} && ` +
                `echo "${scriptContent}" | base64 -d > .task.sh && ` +
                `if [ -x "/usr/bin/time" ]; then /usr/bin/time -v bash .task.sh; else bash .task.sh; fi`;

            this.log(`Executing remote command: ${request.command}`);
            const sshArgs = [
                'workstations', 'ssh', this.workstationName,
                `--project=${userProjectId}`,
                `--region=${this.region}`,
                `--cluster=${this.cluster}`,
                `--config=${this.config}`,
                `--command=${fullRemoteCommand}`
            ];

            console.log(`Command: ${fullRemoteCommand}`);

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

            // 8. Download and Sweep Results
            const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workstations-results-'));
            await fs.mkdir(downloadDir, { recursive: true });

            this.log("Downloading generated files for sweeping...");
            
            await this.runPipeCommand(
                'gcloud', [
                    'workstations', 'ssh', this.workstationName,
                    `--project=${userProjectId}`,
                    `--region=${this.region}`,
                    `--cluster=${this.cluster}`,
                    `--config=${this.config}`,
                    '--command', `tar -czf - -C ${this.tempWorkspaceFolder} .`
                ],
                'tar', ['-xzf', '-', '-C', downloadDir],
                env
            );

            const allFiles = await this.getFilesRecursively(downloadDir);
            for (const fullPath of allFiles) {
                const relativePath = path.relative(downloadDir, fullPath);
                const baseName = path.basename(relativePath);

                if (
                    // normalizedInputFiles.has(path.normalize(relativePath)) || 
                    baseName.startsWith('.') || 
                    relativePath.includes('__pycache__') || 
                    relativePath.includes('node_modules') ||
                    baseName === 'target' || 
                    relativePath.includes('dist') ||
                    relativePath.startsWith('target/') || 
                    baseName === 'main_bin') continue;

                const stats = await fs.stat(fullPath);
                if (stats.isFile() && stats.size <= MAX_CONTEXT_FILE_SIZE_BYTES) {
                    const contentBuffer = await fs.readFile(fullPath);
                    const isBinary = contentBuffer.subarray(0, 1024).includes(0);
                    const isTooLarge = contentBuffer.length > (LARGE_FILE_LIMIT_KB * 1024);

                    const newContentBase64 = contentBuffer.toString('base64');
                    const originalContent = originalFilesMap.get(path.normalize(relativePath));
                    
                    if (originalContent === undefined || originalContent !== newContentBase64) {
                        response.generatedFiles.push({
                            path: relativePath,
                            content: contentBuffer.toString('base64'),
                            isBinary: isBinary || isTooLarge
                        });
                    }
                }
            }
            this.log(`Sweep complete. Found ${response.generatedFiles.length} new files.`);

            if (!this.isPersistentSandbox)
                await this.cleanupSandbox();

            return response;

        } catch (err: any) {
            this.log(`ERROR: ${err.message}`);
            return {
                stdout: '', stderr: '', exitCode: 1, timedOut: false, generatedFiles: [],
                error: `Cloud Workstations Provider Error: ${err.message}`
            } as any;
        } finally {
            // We need to clean up the specific downloadDir for this task run
            if (downloadDir) {
                await fs.rm(downloadDir, { recursive: true, force: true })
                    .catch(err => this.log(`Warning: Failed to clean up downloadDir: ${err.message}`));
            }

            // Only run the full sandbox cleanup if persistent sandbox is disabled
            if (!this.isPersistentSandbox) {
                await this.cleanupSandbox(); 
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