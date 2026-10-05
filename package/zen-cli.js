#!/usr/bin/env node

const proc = require('child_process');
const path = require('path');

const nodePath = path.join(__dirname,'/Release/zen-cli.exe');
const workingDirectory = path.join(__dirname,'Release');

function start(args) {
    if (args === undefined)
        args = [];

    let node;

    if (process.platform !== "win32") {
        args.unshift(nodePath);
        node = proc.spawn('mono', args, {
            cwd: workingDirectory,
            stdio: ['inherit', process.stdout, process.stderr]
        });
    }
    else {
        // inherit the console so output is shown and interactive prompts (passwords) work on Windows
        node = proc.spawn(nodePath,args, {
            cwd: workingDirectory,
            stdio: 'inherit'
        });
    }

    return node
}

const node = start(process.argv.slice(2));


node.on('exit', function (code) {
    process.exit(code);
});
