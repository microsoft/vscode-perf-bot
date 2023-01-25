/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import { tmpdir } from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { program, Option } from 'commander';
import fetch from 'node-fetch';
import chalk from 'chalk';

interface Opts {
    readonly slackToken: string;
    readonly githubToken: string;

    readonly runtime?: 'web' | 'desktop' | 'vscode.dev';
    readonly verbose?: boolean;
    readonly fast?: number;
    readonly reset?: boolean;
}

const Constants = {
    PERF_FILE: path.join(tmpdir(), 'vscode-perf-bot', "prof-startup.txt"),
    FAST: 2000,
    RUNTIME: 'desktop'
}

async function runPerformanceTest(opts: Opts): Promise<void> {
    console.log(`${chalk.gray('[init]')} storing performance results in ${chalk.green(Constants.PERF_FILE)}`);
    fs.mkdirSync(path.dirname(Constants.PERF_FILE), { recursive: true });

    const args: string[] = [
        'vscode-bisect',
        '-p',
        Constants.PERF_FILE,
        '-c',
        'latest',
        '-r',
        Constants.RUNTIME
    ]

    if (opts.githubToken) {
        args.push('-t', opts.githubToken);
    }
    if (opts.verbose) {
        args.push('-v');
    }
    if (opts.reset) {
        args.push('--reset');
    }

    return new Promise(resolve => {
        const npx = cp.spawn('npx', args, {
            shell: true,
            timeout: 1000 * 60 * 60 * 1, // 1h
        });

        console.log(`${chalk.gray('[exec]')} started npx process with pid ${chalk.green(npx.pid)}`);

        npx.stdout.on('data', data => {
            console.log(`${chalk.gray('[exec]')} ${data.toString().trim()}`);
        });

        npx.stderr.on('data', data => {
            console.error(`${chalk.gray('[exec]')} ${data.toString().trim()}`);
        });

        npx.on('error', error => {
            console.error(`${chalk.gray('[exec]')} failed to execute (${error.toString().trim()})`);
        });

        npx.on('close', (code, signal) => {
            console.log(`${chalk.gray('[exec]')} finished with exit code ${chalk.green(code)} and signal ${chalk.green(signal)}`);

            resolve();
        });
    });
}

function parsePerfFile(): string | undefined {
    const raw = fs.readFileSync(Constants.PERF_FILE, 'utf-8').toString();
    const rawLines = raw.split(/\r?\n/);

    const lines: string[] = [];

    let commitValue = 'unknown';
    let appNameValue = 'unknown';
    let bestDuration: number | undefined = undefined;
    for (const line of rawLines) {
        if (!line) {
            continue;
        }

        const [durationRaw, appName, commit] = line.split('\t');
        const duration = Number(durationRaw);

        appNameValue = appName;
        commitValue = commit;
        if (!bestDuration) {
            bestDuration = duration;
        } else if (duration < bestDuration) {
            bestDuration = duration;
        }

        lines.push(`${duration < Constants.FAST ? 'FAST' : 'SLOW'} ${line}`);
    }

    if (lines.length !== 10) {
        console.error(`${chalk.red('[perf] unexpected number of performance results, refusing to send chat message')}`);

        return undefined;
    }

    console.log(`${chalk.gray('[perf]')} overall result: BEST ${chalk.green(`${bestDuration}ms`)}, VERSION ${chalk.green(commitValue)}, APP ${chalk.green(`${appNameValue}_${Constants.RUNTIME}`)}`);

    return `${bestDuration! < Constants.FAST ? ':rocket:' : ':hankey:'} Summary: BEST \`${bestDuration}ms\`, VERSION \`${commitValue}\`, APP \`${appNameValue}_${Constants.RUNTIME}\` :apple: :vscode-insiders:
\`\`\`${lines.join("\n")}\`\`\``;
}

async function sendSlackMessage(message: string, opts: Opts): Promise<void> {
    try {
        const response = await fetch(`https://hooks.slack.com/services/${opts.slackToken}`, {
            method: 'post',
            body: JSON.stringify({
                text: message,
                mrkdwn: true,
                username: `macOS_${Constants.RUNTIME}`,
            }),
            headers: { 'Content-Type': 'application/json' }
        });

        console.log(`${chalk.gray('[http]')} posting to chat returned with status code ${chalk.green(response.status)}`);
    } catch (error) {
        console.error(`${chalk.red('[http]')} posting to chat failed: ${error}`);
    }
}

module.exports = async function (argv: string[]): Promise<void> {

    program.addHelpText('beforeAll', `Version: ${require('../package.json').version}\n`);

    program
        .addOption(new Option('-r, --runtime <runtime>', 'whether to measure startup performance with a local web, online vscode.dev or local desktop (default) version').choices(['desktop', 'web', 'vscode.dev']))
        .option('--reset', 'deletes the cache folder (use only for troubleshooting)')
        .option('-f, --fast <number>', 'what time is considered a fast performance run')
        .requiredOption('--github-token <token>', `a GitHub token of scopes 'repo', 'workflow', 'user:email', 'read:user' to enable additional performance tests targetting web`)
        .requiredOption('--slack-token <token>', `a Slack token for writing Slack messages`)
        .option('-v, --verbose', 'logs verbose output to the console when errors occur');

    const opts: Opts = program.parse(argv).opts();
    if (opts.fast) {
        Constants.FAST = Number(opts.fast);
    }
    if (opts.runtime) {
        Constants.RUNTIME = opts.runtime;
    }

    // Run performance test and write to prof-startup.txt
    await runPerformanceTest(opts);

    // Parse performance result file
    const message = parsePerfFile();

    // Send message to Slack
    if (message) {
        await sendSlackMessage(message, opts);
    }
}
