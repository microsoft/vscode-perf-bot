/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import { tmpdir } from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { program, Option } from 'commander';
import chalk from 'chalk';
import { Octokit } from '@octokit/rest';
import { WebClient, LogLevel, ChatPostMessageArguments } from '@slack/web-api';

interface Opts {
    readonly runtime?: 'desktop' | 'web';
    readonly quality?: 'stable' | 'insider' | 'exploration';
    readonly commit?: string;

    readonly folder?: string;
    readonly file?: string;

    readonly githubToken?: string;
    readonly gist?: string;

    readonly slackToken?: string;
    readonly slackMessageThreads?: string;

    readonly fast?: number;

    readonly verbose?: boolean;
    readonly runtimeTrace?: boolean;

    readonly disableCachedData?: boolean;
}

const Constants = {
    PERF_FILE: path.join(tmpdir(), 'vscode-perf-bot', 'prof-startup.txt'),
    FAST: 2000,
    RUNTIME: 'desktop',
    DATE: new Date(),
    TIMEOUT: 1000 * 60 * 60 * 1, // 1h
}

interface ILogEntry {
    date: Date;
    message: string;
}

const logEntries: ILogEntry[] = [];
const ansicolors = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
function log(message: string, asError = false): void {
    if (asError) {
        console.error(message);
    } else {
        console.log(message);
    }

    logEntries.push({
        date: new Date(),
        message: message.replace(ansicolors, '') // remove ANSI escape codes
    });
}

async function logGist(opts: Opts): Promise<void> {
    if (!opts.gist || !opts.githubToken) {
        return;
    }

    log(`${chalk.gray('[http]')} posting logs to Gist`);

    const octokit = new Octokit({
        auth: opts.githubToken,
        userAgent: 'vscode-perf-bot',
    });

    await octokit.gists.update({
        gist_id: opts.gist,
        files: {
            [`output-${Constants.DATE.toISOString().replace(/:/g, '-')}.log`]: {
                content: logEntries.map(entry => `${entry.date.toISOString()} ${entry.message}`).join('\n')
            }
        }
    });
}

async function runPerformanceTest(opts: Opts, enableHeapStatistics: boolean, runs: number): Promise<void> {
    let build: string;
    if (opts.runtime === 'web') {
        if (opts.quality === 'stable') {
            if (opts.githubToken) {
                build = 'https://vscode.dev/github/microsoft/vscode/blob/main/package.json';
            } else {
                build = 'https://vscode.dev';
            }
        } else {
            if (opts.githubToken) {
                build = 'https://insiders.vscode.dev/github/microsoft/vscode/blob/main/package.json';
            } else {
                build = 'https://insiders.vscode.dev';
            }
        }
    } else {
        build = opts.quality || 'insider';
    }

    const args: string[] = [
        '--yes',
        '@vscode/vscode-perf@latest',
        '--build',
        build,
        '--runtime',
        Constants.RUNTIME,
        '--prof-append-timers',
        Constants.PERF_FILE,
        '--runs',
        `${runs}`
    ]

    if (enableHeapStatistics) {
        args.push('--prof-append-heap-statistics');
    }

    if (build === 'insider') {

        // we pause insider builds for automated releases before releasing
        // the next stable version for a few days. history has proven that
        // performance regressions can come in during this time due to debt
        // work starting. as such, we want performance testing to run even
        // over unreleased builds from the `main` branch. the `--unreleased`
        // command line argument ensures this

        args.push('--unreleased');
    }
    if (opts.commit) {
        args.push('--commit', opts.commit);
    }
    if (opts.folder) {
        args.push('--folder', opts.folder);
    }
    if (opts.file) {
        args.push('--file', opts.file);
    }
    if (opts.githubToken) {
        args.push('--token', opts.githubToken);
    }
    if (opts.verbose) {
        args.push('--verbose');
    }
    if (opts.runtimeTrace) {
        // Collects metrics for loading, navigation and v8 script compilation phases.
        args.push('--runtime-trace-categories="base,browser,content,loading,navigation,mojom,renderer_host,renderer,startup,toplevel,v8,blink,gpu,cc,disabled-by-default-v8.compile"');
    }
    if (opts.disableCachedData) {
        args.push('--disable-cached-data');
    }

    return new Promise(resolve => {
        const npx = cp.spawn('npx', args, {
            shell: true,
            timeout: Constants.TIMEOUT
        });

        log(`${chalk.gray('[exec]')} started npx process with pid ${chalk.green(npx.pid)}`);

        npx.stdout.on('data', data => {
            log(`${chalk.gray('[exec]')} ${data.toString().trim()}`);
        });

        npx.stderr.on('data', data => {
            log(`${chalk.gray('[exec]')} ${data.toString().trim()}`, true);
        });

        npx.on('error', error => {
            log(`${chalk.gray('[exec]')} failed to execute (${error.toString().trim()})`, true);
        });

        npx.on('close', (code, signal) => {
            log(`${chalk.gray('[exec]')} finished with exit code ${chalk.green(code)} and signal ${chalk.green(signal)}`);

            resolve();
        });
    });
}

type PerfData = {
    readonly commit: string;
    readonly appName: string;

    readonly bestDuration: number;

    readonly bestHeapUsed: number | undefined;
    readonly bestHeapGarbage: number | undefined;
    readonly bestMajorGCs: number | undefined;
    readonly bestMinorGCs: number | undefined;
    readonly bestGCDuration: number | undefined;
    readonly bestTraceFile: TraceFile | undefined;

    readonly lines: string[];
}

type TraceFile = {
    readonly name: string;
    readonly path: string;
    readonly timestamp: number;
    readonly stats: fs.Stats;
}

function parsePerfFile(collectRuntimTrace: boolean): PerfData | undefined {
    const raw = fs.readFileSync(Constants.PERF_FILE, 'utf-8').toString();
    const rawLines = raw.split(/\r?\n/);

    const lines: string[] = [];

    let commitValue = 'unknown';
    let appNameValue = 'unknown';
    let bestDuration: number = Number.MAX_SAFE_INTEGER;
    let bestHeapUsed: number = Number.MAX_SAFE_INTEGER;
    let bestHeapGarbage: number = 0;
    let bestMajorGCs: number = 0;
    let bestMinorGCs: number = 0;
    let bestGCDuration: number = 0;
    let bestDurationIndex: number = 0;
    let bestTraceFile: TraceFile | undefined;
    for (const line of rawLines) {
        if (!line) {
            continue;
        }

        const [durationRaw, appName, commit, sessionId, info, perfBaseline, heap] = line.split('\t');
        const duration = Number(durationRaw);

        appNameValue = appName;
        commitValue = commit;
        if (duration < bestDuration) {
            bestDuration = duration;
        } else {
            bestDurationIndex += 1;
        }

        if (heap) {
            const res = /Heap: (\d+)MB \(used\) (\d+)MB \(garbage\) (\d+) \(MajorGC\) (\d+) \(MinorGC\) (\d+)ms \(GC duration\)/.exec(heap);
            if (res) {
                const [, used, garbage, majorGC, minorGC, gcDuration] = res;
                if ((Number(used) + Number(garbage)) < (bestHeapUsed + bestHeapGarbage)) {
                    bestHeapUsed = Number(used);
                    bestHeapGarbage = Number(garbage);
                    bestMajorGCs = Number(majorGC);
                    bestMinorGCs = Number(minorGC);
                    bestGCDuration = Number(gcDuration);
                }
            }
        }

        lines.push(`${duration < Constants.FAST ? 'FAST' : 'SLOW'} ${line}`);
    }

    if (lines.length < 1) {
        log(`${chalk.red('[perf] found no performance results, refusing to send chat message')}`, true);

        return undefined;
    }

    if (collectRuntimTrace) {
        const runtimeTracesDir = path.join(tmpdir(), 'vscode-perf', 'vscode-runtime-traces');

        try {
            // Check if directory exists
            if (fs.existsSync(runtimeTracesDir)) {
                // Find all chrome trace files
                const traceFiles = fs.readdirSync(runtimeTracesDir)
                    .filter(file => file.startsWith('chrometrace_'))
                    .map(file => {
                        // Extract timestamp from filename
                        const timestamp = parseInt(file.replace('chrometrace_', '').split('.')[0]);
                        return {
                            name: file,
                            path: path.join(runtimeTracesDir, file),
                            timestamp: timestamp,
                            stats: fs.statSync(path.join(runtimeTracesDir, file))
                        };
                    })
                    .filter(file => file.stats.isFile() && !isNaN(file.timestamp))
                    .sort((a, b) => b.timestamp - a.timestamp);

                if (traceFiles.length === 0) {
                    log(`${chalk.yellow('[perf]')} no runtime trace files found in ${runtimeTracesDir}`);
                } else {
                    // Get the best trace file
                    bestTraceFile = traceFiles[bestDurationIndex];
                    log(`${chalk.gray('[perf]')} best runtime trace file: ${bestTraceFile.name}`);
                }
            }
        } catch (err) {
            log(`${chalk.red('[perf]')} error reading runtime trace files: ${err}`, true);
        }
    }

    return {
        commit: commitValue,
        appName: appNameValue,
        bestDuration,
        bestHeapUsed,
        bestHeapGarbage,
        bestMajorGCs,
        bestMinorGCs,
        bestGCDuration,
        bestTraceFile,
        lines
    }
}

async function sendSlackMessage(data: PerfData, opts: Opts): Promise<void> {
    if (!opts.slackToken) {
        return;
    }

    // try to load message threads
    let messageThreadsByCommit = new Map<string, string>();
    if (opts.slackMessageThreads) {
        const filepath = path.resolve(opts.slackMessageThreads);
        try {
            const data = await fs.promises.readFile(filepath, 'utf-8');
            messageThreadsByCommit = new Map(JSON.parse(data));
        } catch (err) {
            log(`${chalk.gray('[perf]')} failed to load message threads from ${chalk.green(filepath)}`);
        }
    }

    const { commit, bestDuration, bestHeapUsed, bestHeapGarbage, bestMajorGCs, bestMinorGCs, bestGCDuration, bestTraceFile, lines } = data;

    const slack = new WebClient(opts.slackToken, { logLevel: LogLevel.ERROR });

    let platformIcon: string;
    if (opts.runtime === 'web') {
        platformIcon = ':chrome:';
    } else if (process.platform === 'darwin') {
        platformIcon = ':macos:';
    } else if (process.platform === 'win32') {
        platformIcon = ':win-10:';
    } else {
        platformIcon = ':linux:';
    }

    let qualityIcon: string;
    if (opts.quality === 'stable') {
        qualityIcon = ':vscode-stable:';
    } else if (opts.quality === 'exploration') {
        qualityIcon = ':vscode-exploration:';
    } else {
        qualityIcon = ':vscode-insider:';
    }

    const stub: ChatPostMessageArguments = {
        channel: 'C3NBSM7K3',
        username: 'Bot'
    }

    let summary = `${platformIcon} ${qualityIcon} ${bestDuration! < Constants.FAST ? ':rocket:' : ':hankey:'} Summary: BEST \`${bestDuration}ms\`, VERSION \`${commit}\``;
    if (opts.runtime === 'web') {
        summary += `, SCENARIO \`${opts.githubToken ? 'standard remote' : 'empty window'}\``;
    }
    if (bestHeapUsed && bestHeapGarbage) {
        summary += `, HEAP \`${bestHeapUsed}MB (used) ${bestHeapGarbage}MB (garbage) ${Math.round(bestHeapGarbage / (bestHeapUsed + bestHeapGarbage) * 100)}% (ratio)\``;
    }
    if (bestMajorGCs && bestMinorGCs && bestGCDuration) {
        summary += `, GCs \`${bestMajorGCs + bestMinorGCs} blocking ${bestGCDuration}ms\``;
    }

    const detail = `\`\`\`${lines.join('\n')}\`\`\``;

    // goal: one message-thread per commit.
    // check for an existing thread and post a reply to it. 
    // update the thread main message to the fastest run.
    let thread_ts: string | undefined = undefined;
    let bestThreadRun: number | undefined = undefined;
    const messageMetadata = messageThreadsByCommit.get(commit)?.split('|');
    if (messageMetadata) {
        thread_ts = messageMetadata[0];
        bestThreadRun = Number(messageMetadata[1]);
    }

    if (!thread_ts) {
        const result = await slack.chat.postMessage({
            ...stub,
            text: summary
        });

        if (result.ts) {
            thread_ts = result.ts
            messageThreadsByCommit.set(commit, [thread_ts, bestDuration].join('|'));
        }
    } else {
        if (typeof bestThreadRun === 'number' && bestDuration < bestThreadRun) {
            await slack.chat.update({
                channel: stub.channel,
                ts: thread_ts,
                text: summary
            });

            messageThreadsByCommit.set(commit, [thread_ts, bestDuration].join('|'));
        }
    }

    await slack.chat.postMessage({
        ...stub,
        text: `${summary}\n${detail}`,
        thread_ts
    });

    // Upload runtime trace file if tracing was enabled
    if (opts.runtimeTrace) {
        if (bestTraceFile) {
            log(`${chalk.gray('[perf]')} uploading trace file for best run (${bestDuration}ms): ${bestTraceFile.name}`);

            try {
                // Get file content as buffer
                const fileContent = fs.readFileSync(bestTraceFile.path);

                // Get upload URL from Slack
                const uploadUrlResponse = await slack.files.getUploadURLExternal({
                    filename: bestTraceFile.name,
                    length: bestTraceFile.stats.size
                });

                if (!uploadUrlResponse.ok || !uploadUrlResponse.upload_url) {
                    log(`${chalk.red('[perf]')} failed to get upload URL for ${bestTraceFile.name}`, true);
                    return;
                }

                // Upload file to the provided URL
                const uploadResponse = await fetch(uploadUrlResponse.upload_url, {
                    method: 'POST',
                    body: fileContent,
                    headers: {
                        'Content-Type': 'application/octet-stream'
                    }
                });

                if (!uploadResponse.ok) {
                    log(`${chalk.red('[perf]')} failed to upload file ${bestTraceFile.name}`, true);
                    return;
                }

                // Complete the upload process by calling files.completeUploadExternal
                const completeResponse = await slack.files.completeUploadExternal({
                    files: [{
                        id: uploadUrlResponse.file_id!,
                        title: `Runtime trace for best run (${bestDuration}ms): ${bestTraceFile.name}`,
                    }],
                    channel_id: stub.channel,
                    thread_ts
                });

                if (completeResponse.ok) {
                    log(`${chalk.gray('[perf]')} successfully uploaded trace file ${bestTraceFile.name}`);
                } else {
                    log(`${chalk.red('[perf]')} failed to complete upload for ${bestTraceFile.name}`, true);
                }
            } catch (err) {
                log(`${chalk.red('[perf]')} error uploading trace file ${bestTraceFile.name}: ${err}`, true);
            }
        }
    }

    if (opts.slackMessageThreads) {
        const raw = JSON.stringify([...messageThreadsByCommit]);
        await fs.promises.writeFile(opts.slackMessageThreads, raw, 'utf-8');
    }
}

module.exports = async function (argv: string[]): Promise<void> {

    program.addHelpText('beforeAll', `Version: ${require('../package.json').version}\n`);

    program
        .addOption(new Option('-r, --runtime <runtime>', 'whether to measure startup performance with vscode.dev or local desktop (default) version').choices(['desktop', 'web']))
        .addOption(new Option('-q, --quality <quality>', 'the quality to test (insiders by default)').choices(['stable', 'insider', 'exploration']))
        .option('-c, --commit <commit|latest>', 'commit hash of a specific build to test or "latest" published build (default)')
        .option('--folder <folder path>', 'a folder path to open (desktop only)')
        .option('--file <file path>', 'a file path to open (desktop only)')
        .option('--github-token <token>', `a GitHub token of scopes 'repo', 'workflow', 'user:email', 'read:user', 'gist' to enable additional performance tests targetting web and logging to a Gist`)
        .option('--gist <id>', 'a Gist ID to write all log messages to')
        .option('--slack-token <token>', `a Slack token for writing Slack messages`)
        .option('--slack-message-threads <filepath>', `a file in which commit -> message thread mappings are stored`)
        .option('-f, --fast <number>', 'what time is considered a fast performance run')
        .option('-v, --verbose', 'logs verbose output to the console when errors occur')
        .option('--runtime-trace', 'enable startup tracing of the runtime')
        .option('--disable-cached-data', 'Disable V8 code caching (desktop only)');

    const opts: Opts = program.parse(argv).opts();
    if (opts.fast) {
        Constants.FAST = Number(opts.fast);
    }
    if (opts.runtime) {
        Constants.RUNTIME = opts.runtime;
    }

    const timeoutHandle = setTimeout(() => {
        log(`${chalk.yellow('[perf]')} already half of the timeout reached!`);
        logGist(opts);
    }, Constants.TIMEOUT / 2);

    try {
        log(`${chalk.gray('[init]')} storing performance results in ${chalk.green(Constants.PERF_FILE)}`);

        fs.mkdirSync(path.dirname(Constants.PERF_FILE), { recursive: true });
        if (fs.existsSync(Constants.PERF_FILE)) {
            fs.truncateSync(Constants.PERF_FILE);
        }

        // Run performance test and write to prof-startup.txt. Split into 2 runs
        // with and without heap statistics because that can make execution slower
        await runPerformanceTest(opts, false /* without heap statistics */, 10 /* runs */);
        await runPerformanceTest(opts, true /* with heap statistics */, 5 /* runs */);

        // Parse performance result file
        const data = parsePerfFile(opts.runtimeTrace ?? false);

        // Send message to Slack
        if (data) {
            log(`${chalk.gray('[perf]')} overall result: BEST ${chalk.green(`${data.bestDuration}ms`)}, VERSION ${chalk.green(data.commit)}, APP ${chalk.green(`${data.appName}_${Constants.RUNTIME}`)}`);
            await sendSlackMessage(data, opts);
        }
    } catch (e) {
        log(`${chalk.red('[perf]')} failed to run performance test: ${e}`, true);
    }

    clearTimeout(timeoutHandle);

    // Write all logs to Gist
    await logGist(opts);
}
